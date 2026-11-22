// One service under supervision: its state machine (docs/design/v5-hostd.md §4), port, probes,
// restarts with backoff and give-up, and its log.
//
//   stopped → starting → running → stopping → stopped
//   starting/running → backoff (a failure, restarted after `backoff_s`) → starting
//   backoff → failed (`give_up.failures` failures within `give_up.window_s`; until started again)
//   foreign: something already answers on the service's port; left alone.
//   external: a program hostd does not own; only probed.
//   disabled: it cannot run here (the reason says why).
//
// A crash restart never asks anybody; the guard applies only to stops and restarts someone asked
// for (the daemon checks it before calling `stop`).

import { randomBytes } from "node:crypto";
import type {
  HostServiceEvent,
  HostServiceRouting,
  HostServiceState,
  HostServiceStatus,
} from "@miyoria/contracts/host";
import { execa } from "execa";
import type { Logger } from "pino";
import type { ServiceLog } from "./logs.js";
import { freePort, localAddress, PORT_DENIED_HINT, probePort, urlHost } from "./ports.js";
import { httpHealthy, httpProbe, tcpHealthy } from "./probe.js";
import { type ExitInfo, type ServiceProcess, spawnService } from "./process.js";
import {
  checkPlan,
  expandService,
  filesProblem,
  type LiveValues,
  localUrl,
  type ResolveContext,
  ResolveError,
  type ServicePlan,
  type UsedLinks,
} from "./resolve.js";
import { type LoadReading, loadOf, loadStatus } from "./routing.js";

/** Timings that tests shorten. */
export interface Timing {
  /** How often a starting service is probed. */
  pollMs: number;
  /** How long a service with only a process probe must stay alive to count as running. */
  processSettleMs: number;
  /** Failed probes in a row that make a running service fail. */
  failedProbes: number;
  /** How often an external service is probed. */
  externalMs: number;
}

export const DEFAULT_TIMING: Timing = {
  pollMs: 500,
  processSettleMs: 2000,
  failedProbes: 3,
  externalMs: 10_000,
};

/** What a service needs from the daemon. */
export interface ServiceHost {
  readonly ctx: ResolveContext;
  /** `[network] advertise`. */
  readonly advertise: string | undefined;
  /** The Core this host reports to runs on this machine (the cluster address is loopback). */
  coreIsLocal(): boolean;
  readonly timing: Timing;
  readonly log: Logger;
  hostdUrl(): string;
  hostToken(): string;
  offloadUrls(): string;
  /** `host.toml [gpu] arbiter`: who shares the card (`SING_GPU_ARBITER` for the holder). */
  gpuArbiter(): "worker" | "hostd";
  /** Whether the service holds a lease of the card now. */
  leased(name: string): boolean;
  /** What Core told this host about its node links now (`{link:...}`). */
  links(): LiveValues["links"];
  service(name: string): ManagedService | undefined;
  emit(event: HostServiceEvent): void;
  /** Called on every change of what `status` returns. */
  changed(): void;
  /** Called when a process was spawned, for the reverse stop order. */
  spawned(name: string): void;
  /**
   * Its `[routing]` as it applies on this host (readiness, variant, the owner's limits); absent
   * without the table. Optional: stand-ins made before routing leave it out.
   */
  routing?(service: ManagedService): HostServiceRouting | undefined;
  /** Why it is held up from outside now (the card is lent to another service), or `undefined`. */
  outside?(name: string): string | undefined;
  /**
   * Its base URL on each route of `routes.toml` (v5-hostd §16); `undefined` on a host without the
   * file. Optional: stand-ins made before routes leave it out.
   */
  reach?(service: ManagedService, port: number): Record<string, string> | undefined;
}

/** States in which a service is on its way up and others may wait for it. */
const STARTING: ReadonlySet<HostServiceState> = new Set(["starting"]);

function exitText(info: ExitInfo): string {
  if (info.error !== undefined) return `無法啟動:${info.error}`;
  if (info.signal !== null) return `被訊號 ${info.signal} 結束`;
  return `結束了(代碼 ${info.code ?? "?"})`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Whether a program of that image name runs (`[probe] process` of an external service). */
async function processRunning(name: string): Promise<boolean> {
  if (process.platform === "win32") {
    const r = await execa("tasklist", ["/FI", `IMAGENAME eq ${name}`, "/NH", "/FO", "CSV"], {
      reject: false,
      timeout: 5000,
      windowsHide: true,
      stdin: "ignore",
    });
    return !r.failed && String(r.stdout).toLowerCase().includes(`"${name.toLowerCase()}"`);
  }
  const r = await execa("pgrep", ["-x", name], { reject: false, timeout: 5000, stdin: "ignore" });
  return r.exitCode === 0;
}

export class ManagedService {
  readonly plan: ServicePlan;
  readonly logs: ServiceLog;
  readonly #host: ServiceHost;

  #state: HostServiceState;
  #since = Date.now();
  #reason: string | undefined;
  #healthy = false;
  #port: number | undefined;
  #token: string | undefined;
  /** The `{link:...}` values the running process was started with. */
  #links: UsedLinks = {};
  #child: ServiceProcess | null = null;
  /** Epoch ms of failures within the give-up window. */
  #failures: number[] = [];
  /** Bumped by every start and stop; a loop or timer of an older generation does nothing. */
  #generation = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #stopping: Promise<void> | null = null;
  /** Processes hostd is ending itself; their exit is not another failure. */
  readonly #ending = new WeakSet<ServiceProcess>();
  /** The last load its health answer reported (`[routing] queue`); `null` while there is none. */
  #load: LoadReading | null = null;

  constructor(plan: ServicePlan, logs: ServiceLog, host: ServiceHost) {
    this.plan = plan;
    this.logs = logs;
    this.#host = host;
    this.#port = typeof plan.port === "number" ? plan.port : undefined;
    this.#state =
      plan.disabled !== null ? "disabled" : plan.kind === "external" ? "external" : "stopped";
    this.#reason = plan.disabled ?? undefined;
  }

  get name(): string {
    return this.plan.name;
  }

  get state(): HostServiceState {
    return this.#state;
  }

  get reason(): string | undefined {
    return this.#reason;
  }

  get port(): number | undefined {
    return this.#port;
  }

  get pid(): number | undefined {
    return this.#child !== null && !this.#child.hasExited() ? this.#child.pid : undefined;
  }

  get token(): string | undefined {
    return this.#token;
  }

  /** The `{link:...}` values its process was started with (empty when it uses none). */
  get usedLinks(): UsedLinks {
    return this.#links;
  }

  /** Sets the reason shown in its status without changing its state (until the next change). */
  note(reason: string | undefined): void {
    this.#set(this.#state, reason);
  }

  /** Whether a process of ours runs (or is about to) for this service. */
  get active(): boolean {
    return (
      this.#state === "starting" ||
      this.#state === "running" ||
      this.#state === "stopping" ||
      (this.#child !== null && !this.#child.hasExited())
    );
  }

  get #run() {
    return this.plan.entry?.descriptor.run;
  }

  /** The last load reading, while the service runs and reports one. */
  get load(): LoadReading | null {
    return this.#state === "running" ? this.#load : null;
  }

  status(withToken: boolean): HostServiceStatus {
    const port = this.#port;
    const routing = this.#host.routing?.(this);
    const load = this.load;
    const local = localAddress(this.#host.ctx.bind);
    // What Core may call directly: the advertised address, or this machine's own when Core is
    // here too. A joined machine with neither is reached through the control link only.
    const reach = this.#host.advertise ?? (this.#host.coreIsLocal() ? local : undefined);
    const routes = port === undefined ? undefined : this.#host.reach?.(this, port);
    const gpuPolicy = this.plan.gpuPolicy;
    const resident = this.plan.entry?.descriptor.gpu?.vram_mb?.resident;
    return {
      name: this.name,
      kind: this.plan.kind,
      provides: this.plan.provides,
      state: this.#state,
      since: this.#since,
      ...(this.pid !== undefined ? { pid: this.pid } : {}),
      ...(port !== undefined ? { port, url: `http://${urlHost(local)}:${port}` } : {}),
      ...(port !== undefined && reach !== undefined
        ? { advertised: `http://${urlHost(reach)}:${port}` }
        : {}),
      ...(routes !== undefined ? { reach: routes } : {}),
      healthy: this.#healthy,
      restarts: this.#recentFailures().length,
      ...(this.#reason !== undefined ? { reason: this.#reason } : {}),
      ...(withToken && this.#token !== undefined ? { token: this.#token } : {}),
      ...(gpuPolicy !== undefined
        ? {
            gpu: {
              policy: gpuPolicy,
              ...(resident !== undefined ? { resident_mb: resident } : {}),
              leased: this.#host.leased(this.name),
            },
          }
        : {}),
      ...(routing !== undefined ? { routing } : {}),
      ...(load !== null
        ? { load: loadStatus(load, Date.now(), this.#host.outside?.(this.name)) }
        : {}),
    };
  }

  /** Whether its health answer is read for its load (`[routing] queue` with an HTTP probe). */
  get #reportsLoad(): boolean {
    return (
      this.plan.entry?.descriptor.routing?.queue === true && this.#run?.health.http !== undefined
    );
  }

  /** Keeps the load of a health answer; tells the daemon when it changed. */
  #readLoad(body: unknown): void {
    const found = loadOf(body);
    const before = this.#load;
    this.#load = found === null ? null : { ...found, at: Date.now() };
    const same =
      (before === null && found === null) ||
      (before !== null &&
        found !== null &&
        before.running === found.running &&
        before.queued === found.queued);
    // A new reading of the same load is not a change: its age shows in the next report anyway.
    if (!same) this.#host.changed();
  }

  #recentFailures(): number[] {
    const windowMs = (this.#run?.restart.give_up.window_s ?? 600) * 1000;
    const now = Date.now();
    return this.#failures.filter((t) => now - t < windowMs);
  }

  #set(state: HostServiceState, reason?: string, logTail?: string[]): void {
    const previous = this.#state;
    const changed = previous !== state || this.#reason !== reason;
    this.#state = state;
    this.#reason = reason;
    if (previous !== state) {
      this.#since = Date.now();
      this.#host.log.info({ service: this.name, state, previous, reason }, "service state");
      this.#host.emit({
        service: this.name,
        state,
        previous,
        at: this.#since,
        ...(reason !== undefined ? { reason } : {}),
        ...(logTail !== undefined ? { log_tail: logTail } : {}),
      });
    }
    if (changed) this.#host.changed();
  }

  #setHealthy(healthy: boolean): void {
    if (this.#healthy === healthy) return;
    this.#healthy = healthy;
    this.#host.changed();
  }

  #clearTimer(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  // ---- external ------------------------------------------------------------------------------

  /** Starts probing an external service now and every `externalMs`. */
  watchExternal(): void {
    if (this.plan.kind !== "external" || this.#state !== "external") return;
    const generation = this.#generation;
    const tick = async () => {
      const healthy = await this.#probeExternal();
      if (generation !== this.#generation) return;
      this.#setHealthy(healthy);
      this.#timer = setTimeout(() => void tick(), this.#host.timing.externalMs);
      this.#timer.unref?.();
    };
    void tick();
  }

  async #probeExternal(): Promise<boolean> {
    const probe = this.plan.entry?.descriptor.probe;
    if (probe === undefined) return false;
    const port = this.#port;
    try {
      if (probe.http !== undefined && port !== undefined) {
        return await httpHealthy(`${localUrl("127.0.0.1", port)}${probe.http}`, {
          timeoutMs: 3000,
        });
      }
      if (port !== undefined) return await tcpHealthy("127.0.0.1", port, 3000);
      if (probe.process !== undefined) return await processRunning(probe.process);
    } catch {
      return false;
    }
    return false;
  }

  // ---- start -----------------------------------------------------------------------------------

  /**
   * Starts the service unless it runs. Returns at once with the state it is in (`starting`
   * while it comes up); a manual start forgets earlier failures.
   */
  async start(): Promise<HostServiceState> {
    if (this.plan.kind === "external") return this.#state;
    if (this.#stopping !== null) await this.#stopping;
    if (this.#state === "disabled") {
      // A disabled service may have become startable (an environment was installed since).
      if (this.plan.override.enabled && this.plan.entry !== null) {
        this.plan.disabled = checkPlan(this.plan, this.#host.ctx);
      }
      if (this.plan.disabled !== null) {
        this.#set("disabled", this.plan.disabled);
        return this.#state;
      }
    }
    if (this.#state === "starting" || this.#state === "running") return this.#state;
    // A file it needs may have gone since it was planned (`models gc`, a hand): it is not started.
    const files = filesProblem(this.plan, this.#host.ctx);
    if (files !== null) {
      this.plan.disabled = files;
      this.#set("disabled", files);
      return this.#state;
    }
    this.#clearTimer();
    this.#failures = [];
    const generation = ++this.#generation;
    this.#set("starting");
    void this.#launch(generation).catch((error: unknown) => {
      this.#host.log.error({ service: this.name, err: error }, "start failed unexpectedly");
      if (generation === this.#generation) {
        this.#set(
          "failed",
          `hostd 內部錯誤:${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
    return this.#state;
  }

  /** Waits for the `after` services of this host that are on their way up. */
  async #waitForAfter(generation: number): Promise<void> {
    const deps = (this.#run?.after ?? [])
      .map((name) => this.#host.service(name))
      .filter((s): s is ManagedService => s !== undefined && STARTING.has(s.state));
    if (deps.length === 0) return;
    this.#set("starting", `等待 ${deps.map((d) => d.name).join("、")} 就緒`);
    const limitMs = Math.max(
      ...deps.map((d) => (d.plan.entry?.descriptor.run?.health.startup_s ?? 180) * 1000),
    );
    const until = Date.now() + limitMs;
    while (
      generation === this.#generation &&
      Date.now() < until &&
      deps.some((d) => STARTING.has(d.state))
    ) {
      await sleep(this.#host.timing.pollMs);
    }
    if (generation === this.#generation) this.#set("starting");
  }

  /** Something already answers the service's own probe on `port`. */
  async #answers(port: number): Promise<boolean> {
    const health = this.#run?.health;
    const timeoutMs = (health?.timeout_s ?? 3) * 1000;
    if (health?.http !== undefined) {
      return httpHealthy(`${localUrl(this.#host.ctx.bind, port)}${health.http}`, { timeoutMs });
    }
    return tcpHealthy(localAddress(this.#host.ctx.bind), port, timeoutMs);
  }

  /** The port to start on, or `null` when the start ended here (foreign, or a failure). */
  async #takePort(generation: number): Promise<number | undefined | null> {
    const wanted = this.plan.port;
    if (wanted === undefined) return undefined;
    const bind = this.#host.ctx.bind;
    if (wanted === "auto") {
      try {
        return await freePort(bind);
      } catch (error) {
        await this.#failure(
          generation,
          `拿不到空的埠:${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      }
    }
    const state = await probePort(wanted, bind);
    if (generation !== this.#generation) return null;
    if (state === "free") return wanted;
    if (state === "in-use") {
      if (await this.#answers(wanted)) {
        if (generation !== this.#generation) return null;
        this.#port = wanted;
        this.#setHealthy(true);
        this.#set("foreign", `埠 ${wanted} 上已經有在回應的服務,不是這個 hostd 啟動的;不會動它`);
        return null;
      }
      await this.#failure(
        generation,
        `埠 ${wanted} 已被別的程式佔用(in-use),而且那裡沒有健康的回應;hostd 不會結束別人的程式`,
      );
      return null;
    }
    if (state === "denied") {
      await this.#failure(generation, `埠 ${wanted} 綁不上(denied)。${PORT_DENIED_HINT}`);
      return null;
    }
    await this.#failure(generation, `埠 ${wanted} 無法檢查(${bind})`);
    return null;
  }

  async #launch(generation: number): Promise<void> {
    await this.#waitForAfter(generation);
    if (generation !== this.#generation) return;
    const port = await this.#takePort(generation);
    if (port === null || generation !== this.#generation) return;
    this.#port = port;

    const token = randomBytes(24).toString("base64url");
    let spec: ReturnType<typeof expandService>;
    try {
      spec = expandService(this.plan, this.#host.ctx, {
        port,
        offloadUrls: this.#host.offloadUrls(),
        gpuArbiter: this.#host.gpuArbiter(),
        token,
        hostToken: this.#host.hostToken(),
        hostdUrl: this.#host.hostdUrl(),
        links: this.#host.links(),
      });
    } catch (error) {
      if (!(error instanceof ResolveError)) throw error;
      this.plan.disabled = error.message;
      this.#set("disabled", error.message);
      return;
    }

    this.#token = token;
    this.#links = spec.links;
    this.#load = null;
    this.logs.line(
      `--- ${new Date().toISOString()} hostd 啟動 ${this.name}${port !== undefined ? `(埠 ${port})` : ""} ---`,
    );
    const child = spawnService(spec, this.logs);
    this.#child = child;
    this.#setHealthy(false);
    this.#host.spawned(this.name);
    this.#host.changed();
    void child.exited.then((info) => this.#exited(generation, child, info));

    const health = this.#run?.health;
    const startupMs = (health?.startup_s ?? 180) * 1000;
    const spawnedAt = Date.now();
    while (generation === this.#generation && !child.hasExited()) {
      if (await this.#probe(child, spawnedAt)) {
        if (generation !== this.#generation || child.hasExited()) return;
        this.#setHealthy(true);
        this.#set("running");
        this.#watch(generation, child);
        return;
      }
      if (generation !== this.#generation || child.hasExited()) return;
      if (Date.now() - spawnedAt >= startupMs) {
        await this.#failure(
          generation,
          `${Math.round(startupMs / 1000)} 秒內沒有通過健康檢查${this.#probeText()}`,
        );
        return;
      }
      await sleep(this.#host.timing.pollMs);
    }
  }

  #probeText(): string {
    const health = this.#run?.health;
    if (health?.http !== undefined && this.#port !== undefined) {
      return `(GET ${localUrl(this.#host.ctx.bind, this.#port)}${health.http})`;
    }
    if (health?.tcp === true && this.#port !== undefined) return `(TCP 埠 ${this.#port})`;
    return "";
  }

  /** One probe of our own process. */
  async #probe(child: ServiceProcess, spawnedAt: number): Promise<boolean> {
    if (child.hasExited()) return false;
    const health = this.#run?.health;
    const port = this.#port;
    const timeoutMs = (health?.timeout_s ?? 3) * 1000;
    if (health?.http !== undefined && port !== undefined) {
      const answer = await httpProbe(`${localUrl(this.#host.ctx.bind, port)}${health.http}`, {
        timeoutMs,
        ...(this.#token !== undefined
          ? { headers: { authorization: `Bearer ${this.#token}` } }
          : {}),
      });
      if (this.#reportsLoad && answer.healthy) this.#readLoad(answer.body);
      return answer.healthy;
    }
    if (health?.tcp === true && port !== undefined) {
      return tcpHealthy(localAddress(this.#host.ctx.bind), port, timeoutMs);
    }
    // `process = true`, or no probe: alive for a moment.
    return Date.now() - spawnedAt >= this.#host.timing.processSettleMs && !child.hasExited();
  }

  /** Probes a running service every `interval_s`; `failedProbes` misses in a row are a failure. */
  #watch(generation: number, child: ServiceProcess): void {
    const intervalMs = (this.#run?.health.interval_s ?? 10) * 1000;
    let misses = 0;
    const tick = async () => {
      if (generation !== this.#generation || child.hasExited()) return;
      const ok = await this.#probe(child, 0);
      if (generation !== this.#generation || child.hasExited()) return;
      if (ok) {
        misses = 0;
        this.#setHealthy(true);
      } else {
        misses += 1;
        this.#setHealthy(false);
        if (misses >= this.#host.timing.failedProbes) {
          await this.#failure(generation, `連續 ${misses} 次健康檢查失敗${this.#probeText()}`);
          return;
        }
      }
      this.#timer = setTimeout(() => void tick(), intervalMs);
    };
    this.#timer = setTimeout(() => void tick(), intervalMs);
  }

  #exited(generation: number, child: ServiceProcess, info: ExitInfo): void {
    this.logs.line(`--- ${new Date().toISOString()} ${this.name} ${exitText(info)} ---`);
    if (generation !== this.#generation || this.#child !== child) return;
    if (this.#state === "stopping" || this.#ending.has(child)) return;
    this.#setHealthy(false);
    // Descendants it left behind (Unix only: Windows cannot find them once it exited).
    child.kill();
    const policy = this.#run?.restart.policy ?? "on-failure";
    if (this.#state === "running" && info.code === 0 && policy === "on-failure") {
      this.#token = undefined;
      this.#set("stopped", `自己結束了(代碼 0)`);
      return;
    }
    const what = this.#state === "starting" ? `啟動後${exitText(info)}` : exitText(info);
    void this.#failure(generation, what);
  }

  /** A failed start, a crash or failed probes: backoff and restart by policy, or give up. */
  async #failure(generation: number, reason: string): Promise<void> {
    if (generation !== this.#generation) return;
    const child = this.#child;
    if (child !== null && !child.hasExited()) {
      // A start that timed out or a service that stopped answering: end its tree first.
      this.#ending.add(child);
      child.kill();
      await child.exited;
      if (generation !== this.#generation) return;
    }
    this.#token = undefined;
    this.#setHealthy(false);
    const run = this.#run;
    const now = Date.now();
    this.#failures = [...this.#recentFailures(), now];
    const count = this.#failures.length;
    const tail = this.logs.tail(20);
    const policy = run?.restart.policy ?? "on-failure";
    const giveUp = run?.restart.give_up ?? { failures: 5, window_s: 600 };
    if (policy === "never") {
      this.#set("failed", `${reason};restart 是 never,不會自動重啟`, tail);
      return;
    }
    if (count >= giveUp.failures) {
      this.#host.log.warn({ service: this.name, failures: count }, "too many failures, giving up");
      this.#set(
        "failed",
        `${reason};${giveUp.window_s} 秒內失敗 ${count} 次,不再自動重啟(up 或 restart 會再試)`,
        tail,
      );
      return;
    }
    const backoff = run?.restart.backoff_s ?? [1, 5, 30];
    const delayS = backoff[Math.min(count - 1, backoff.length - 1)] ?? 1;
    this.#set("backoff", `${reason};${delayS} 秒後重試(第 ${count} 次失敗)`, tail);
    this.#clearTimer();
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (generation !== this.#generation || this.#state !== "backoff") return;
      const next = ++this.#generation;
      this.#set("starting");
      void this.#launch(next).catch((error: unknown) => {
        this.#host.log.error({ service: this.name, err: error }, "restart failed unexpectedly");
      });
    }, delayS * 1000);
  }

  // ---- stop ------------------------------------------------------------------------------------

  /**
   * Stops the service and its process tree; waits until it is gone. A foreign, external or
   * disabled service is left as it is.
   */
  async stop(): Promise<HostServiceState> {
    if (this.#stopping !== null) {
      await this.#stopping;
      return this.#state;
    }
    if (this.#state === "foreign" || this.#state === "external" || this.#state === "disabled") {
      return this.#state;
    }
    this.#generation += 1;
    this.#clearTimer();
    const child = this.#child;
    if (child === null || child.hasExited()) {
      this.#token = undefined;
      this.#setHealthy(false);
      this.#set("stopped");
      return this.#state;
    }
    this.#set("stopping");
    const graceMs = (this.#run?.stop.grace_s ?? 10) * 1000;
    this.#stopping = child.stop(graceMs).finally(() => {
      this.#stopping = null;
    });
    await this.#stopping;
    this.#token = undefined;
    this.#setHealthy(false);
    this.#set("stopped", child.hasExited() ? undefined : "停止後行程還在,可能要手動結束");
    return this.#state;
  }

  /** Stops the probes of an external service (the daemon is closing). */
  close(): void {
    this.#generation += 1;
    this.#clearTimer();
  }
}
