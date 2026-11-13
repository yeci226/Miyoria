import {
  type Clock,
  type JsonValue,
  KERNEL_MODULE,
  type ModuleId,
  type ModuleStateKind,
  serviceKey,
  systemClock,
} from "@miyoria/types";
import { errorMessage, SerialQueue, withTimeout } from "./async.js";
import { EventBus } from "./bus.js";
import { type ContextHost, ModuleContext } from "./context.js";
import { getLogger, type Logger } from "./log.js";
import type { Module } from "./module.js";
import { ServiceRegistry } from "./services.js";

export const STOP_TIMEOUT_MS = 5_000;
export const RESTART_WINDOW_MS = 600_000;
export const MAX_RESTARTS_IN_WINDOW = 5;
export const MAX_BACKOFF_MS = 60_000;

/** Delay before restart attempt `attempts` (1-based): 2 s, 4 s, 8 s, ... capped at 60 s. */
export function restartBackoffMs(attempts: number): number {
  return Math.min(1000 * 2 ** Math.min(attempts, 6), MAX_BACKOFF_MS);
}

/** Legacy JSON shape (`miyoria module list`, Admin API). */
export interface ModuleStatus {
  id: ModuleId;
  name: string;
  description: string;
  enabled: boolean;
  state: ModuleStateKind;
  reason: string | null;
  recent_restarts: number;
}

export class SupervisorError extends Error {
  override readonly name = "SupervisorError";
}

interface Running {
  controller: AbortController;
  tasks: Set<Promise<void>>;
}

interface Slot {
  module: Module;
  config: JsonValue | null;
  enabled: boolean;
  state: ModuleStateKind;
  reason: string | null;
  generation: number;
  running: Running | null;
  /** Epoch ms of recent failures. */
  restarts: number[];
}

export interface SupervisorOptions {
  bus?: EventBus;
  services?: ServiceRegistry;
  clock?: Clock;
  logger?: Logger;
  /** How long `stop` waits for a module's tasks. Default `STOP_TIMEOUT_MS`. */
  stopTimeoutMs?: number;
}

/**
 * Owns every module's lifecycle: starts modules in dependency order, cascades stops along
 * `requires`, restarts failed modules with exponential backoff (at most 5 failures per
 * 10 minutes, then `failed` until restarted by hand) and publishes `system.module.state`.
 *
 * Lifecycle operations are serialized. A module must not call back into the supervisor from
 * inside `start` / `stop` (from its spawned tasks is fine).
 */
export class Supervisor {
  readonly bus: EventBus;
  readonly services: ServiceRegistry;
  readonly #clock: Clock;
  readonly #log: Logger;
  readonly #stopTimeoutMs: number;
  readonly #slots = new Map<ModuleId, Slot>();
  readonly #queue = new SerialQueue();
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(options: SupervisorOptions = {}) {
    this.bus = options.bus ?? new EventBus();
    this.services = options.services ?? new ServiceRegistry();
    this.#clock = options.clock ?? systemClock;
    this.#log = options.logger ?? getLogger("kernel.supervisor");
    this.#stopTimeoutMs = options.stopTimeoutMs ?? STOP_TIMEOUT_MS;
  }

  /** Adds a module. `config` is its `[modules.<id>]` section (see `Config.module`). */
  register(module: Module, config: JsonValue | null, enabled: boolean): Promise<void> {
    return this.#queue.run(async () => {
      this.#slots.set(module.manifest.id, {
        module,
        config,
        enabled,
        state: enabled ? "stopped" : "disabled",
        reason: null,
        generation: 0,
        running: null,
        restarts: [],
      });
    });
  }

  /** Starts every enabled module in dependency order. Rejects on a dependency cycle. */
  startAll(): Promise<void> {
    return this.#queue.run(async () => {
      for (const id of this.#topoOrder()) await this.#tryStart(id);
    });
  }

  /** Stops everything in reverse dependency order and cancels pending restarts. */
  stopAll(): Promise<void> {
    return this.#queue.run(async () => {
      for (const timer of this.#timers) clearTimeout(timer);
      this.#timers.clear();
      let order: ModuleId[];
      try {
        order = this.#topoOrder();
      } catch {
        return;
      }
      for (const id of order.reverse()) {
        const slot = this.#slot(id);
        await this.#stopOne(id, slot.enabled ? "stopped" : "disabled", null);
      }
    });
  }

  /** Snapshot of every module, ordered by id. */
  list(): ModuleStatus[] {
    const now = this.#clock.now();
    return this.#sortedIds().map((id) => {
      const s = this.#slot(id);
      const m = s.module.manifest;
      return {
        id,
        name: m.name,
        description: m.description,
        enabled: s.enabled,
        state: s.state,
        reason: s.reason,
        recent_restarts: s.restarts.filter((t) => now - t < RESTART_WINDOW_MS).length,
      };
    });
  }

  /** Enables a module and starts it (and anything waiting for it). Rejects if it did not start. */
  enable(id: ModuleId): Promise<void> {
    return this.#queue.run(async () => {
      const slot = this.#slot(id);
      slot.enabled = true;
      slot.restarts = [];
      if (slot.running === null) slot.state = "stopped";
      await this.#startPending();
      if (slot.state !== "running") {
        throw new SupervisorError(
          `module \`${id}\` did not start: ${slot.reason ?? "unknown reason"}`,
        );
      }
    });
  }

  /** Stops a module and everything that requires it; it stays `disabled`. */
  disable(id: ModuleId): Promise<void> {
    return this.#queue.run(async () => {
      this.#slot(id);
      for (const dep of this.#dependents(id)) {
        await this.#stopOne(dep, "stopped", `dependency \`${id}\` disabled`);
      }
      this.#slot(id).enabled = false;
      await this.#stopOne(id, "disabled", null);
    });
  }

  /** Stops a module (and its dependents) and starts it again. Clears the failure history. */
  async restart(id: ModuleId): Promise<void> {
    await this.#queue.run(async () => {
      const slot = this.#slot(id);
      if (!slot.enabled) throw new SupervisorError(`module \`${id}\` is disabled`);
      slot.restarts = [];
      await this.#stopWithDependents(id, null);
    });
    await this.enable(id);
  }

  /**
   * Stops the running modules among `ids` (with their dependents, in the order given), runs
   * `fn` while they are down, then starts every enabled, stopped module again. For changing
   * data a module caches and saves on stop: restarting after the change would let `stop` write
   * the old state back. Other lifecycle operations wait until this is done; `fn` must not call
   * back into the supervisor. `failed` lists the stopped modules that did not come back.
   */
  pause<T>(
    ids: readonly ModuleId[],
    fn: () => Promise<T>,
  ): Promise<{ value: T; failed: ModuleId[] }> {
    return this.#queue.run(async () => {
      const stopped: ModuleId[] = [];
      for (const id of ids) {
        const slot = this.#slots.get(id);
        if (!slot?.enabled || slot.running === null) continue;
        for (const dep of this.#dependents(id)) {
          if (this.#slots.get(dep)?.running && !stopped.includes(dep)) stopped.push(dep);
        }
        slot.restarts = [];
        await this.#stopWithDependents(id, null);
        if (!stopped.includes(id)) stopped.push(id);
      }
      let value: T;
      try {
        value = await fn();
      } finally {
        await this.#startPending();
      }
      const failed = stopped.filter((id) => this.#slots.get(id)?.state !== "running");
      return { value, failed };
    });
  }

  // ---- internals (run inside the queue) -------------------------------------------------

  #slot(id: ModuleId): Slot {
    const slot = this.#slots.get(id);
    if (!slot) throw new SupervisorError(`unknown module \`${id}\``);
    return slot;
  }

  #sortedIds(): ModuleId[] {
    return [...this.#slots.keys()].sort();
  }

  #report(id: ModuleId, generation: number, error: string): void {
    void this.#queue
      .run(() => this.#handleFailure(id, generation, error))
      .catch((err: unknown) => this.#log.error({ err, module: id }, "failure handling failed"));
  }

  async #handleFailure(id: ModuleId, generation: number, error: string): Promise<void> {
    const slot = this.#slots.get(id);
    if (!slot || slot.generation !== generation || slot.running === null) return; // stale
    const now = this.#clock.now();
    slot.restarts = slot.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
    slot.restarts.push(now);
    const attempts = slot.restarts.length;

    this.#log.warn({ module: id, reason: error }, "module failed");
    await this.#stopWithDependents(id, error);
    slot.state = "failed";
    slot.reason = error;
    this.#emit(id, "failed", error);

    if (attempts > MAX_RESTARTS_IN_WINDOW) {
      this.#log.warn({ module: id }, "too many failures, giving up until manually restarted");
      return;
    }
    const backoff = restartBackoffMs(attempts);
    this.#log.info({ module: id, backoff_ms: backoff, attempts }, "scheduling restart");
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      void this.#queue
        .run(async () => {
          const s = this.#slots.get(id);
          if (s?.enabled && s.state === "failed" && s.generation === generation) {
            s.state = "stopped";
            await this.#startPending();
          }
        })
        .catch((err: unknown) => this.#log.error({ err, module: id }, "restart failed"));
    }, backoff);
    this.#timers.add(timer);
  }

  /** Starts every enabled, stopped module whose requirements are running. */
  async #startPending(): Promise<void> {
    let order: ModuleId[];
    try {
      order = this.#topoOrder();
    } catch {
      return;
    }
    for (const id of order) {
      const s = this.#slot(id);
      if (s.enabled && s.running === null && s.state !== "failed") await this.#tryStart(id);
    }
  }

  async #tryStart(id: ModuleId): Promise<void> {
    const slot = this.#slot(id);
    if (!slot.enabled || slot.running !== null) return;
    const missing = slot.module.manifest.requires.find(
      (r) => this.#slots.get(r)?.state !== "running",
    );
    if (missing !== undefined) {
      const reason = `required module \`${missing}\` is not running`;
      slot.state = "stopped";
      slot.reason = reason;
      this.#emit(id, "stopped", reason);
      return;
    }

    slot.generation += 1;
    slot.state = "starting";
    slot.reason = null;
    const running: Running = { controller: new AbortController(), tasks: new Set() };
    slot.running = running;
    const generation = slot.generation;
    const host: ContextHost = {
      id,
      generation,
      bus: this.bus,
      services: this.services,
      config: slot.config,
      clock: this.#clock,
      log: this.#log.child({ module: id }),
      controller: running.controller,
      tasks: running.tasks,
      fail: (gen, error) => this.#report(id, gen, error),
    };
    this.#emit(id, "starting", null);

    try {
      await slot.module.start(new ModuleContext(host));
      slot.state = "running";
      this.#log.info({ module: id }, "module running");
      this.#emit(id, "running", null);
    } catch (error) {
      // Already inside the queue: handled now, so whoever asked for the start (`enable`,
      // `restart`) sees the module failed and why, not a `starting` module with no reason.
      await this.#handleFailure(id, generation, `start failed: ${errorMessage(error)}`).catch(
        (err: unknown) => this.#log.error({ err, module: id }, "failure handling failed"),
      );
    }
  }

  async #stopWithDependents(id: ModuleId, reason: string | null): Promise<void> {
    for (const dep of this.#dependents(id)) {
      await this.#stopOne(dep, "stopped", `dependency \`${id}\` stopped`);
    }
    await this.#stopOne(id, "stopped", reason);
  }

  async #stopOne(id: ModuleId, finalState: ModuleStateKind, reason: string | null): Promise<void> {
    const slot = this.#slots.get(id);
    if (!slot) return;
    const running = slot.running;
    if (running !== null) {
      slot.running = null;
      slot.state = "stopping";
      this.#emit(id, "stopping", null);
      try {
        await slot.module.stop?.();
      } catch (error) {
        this.#log.warn({ module: id, err: error }, "module stop hook failed");
      }
      running.controller.abort();
      const settled = await withTimeout(
        Promise.allSettled([...running.tasks]).then(() => true),
        this.#stopTimeoutMs,
      );
      if (!settled) this.#log.warn({ module: id }, "module tasks did not stop in time");
      this.services.removeOwnedBy(id);
    }
    slot.state = finalState;
    slot.reason = reason;
    this.#emit(id, finalState, reason);
  }

  #emit(id: ModuleId, state: ModuleStateKind, reason: string | null): void {
    this.bus.publish(KERNEL_MODULE, {
      type: "module_state_changed",
      data: { module: id, state, reason },
    });
  }

  /** Dependency order over `requires` + `optional` among registered modules. */
  #topoOrder(): ModuleId[] {
    const order: ModuleId[] = [];
    const done = new Set<ModuleId>();
    const visiting = new Set<ModuleId>();
    const visit = (id: ModuleId): void => {
      if (done.has(id)) return;
      if (visiting.has(id))
        throw new SupervisorError(`module dependency cycle involving \`${id}\``);
      visiting.add(id);
      const m = this.#slot(id).module.manifest;
      for (const dep of [...m.requires, ...m.optional]) {
        if (this.#slots.has(dep)) visit(dep);
      }
      visiting.delete(id);
      done.add(id);
      order.push(id);
    };
    for (const id of this.#sortedIds()) visit(id);
    return order;
  }

  /** Modules that (transitively) require `id`, deepest dependents first. */
  #dependents(id: ModuleId): ModuleId[] {
    const out: ModuleId[] = [];
    const frontier = [id];
    for (let cur = frontier.pop(); cur !== undefined; cur = frontier.pop()) {
      for (const other of this.#sortedIds()) {
        if (this.#slot(other).module.manifest.requires.includes(cur) && !out.includes(other)) {
          out.push(other);
          frontier.push(other);
        }
      }
    }
    return out.reverse();
  }
}

/** The supervisor itself, provided by the app for admin modules (Rust `SupervisorHandle`). */
export const SupervisorKey = serviceKey<Supervisor>("SupervisorHandle");
