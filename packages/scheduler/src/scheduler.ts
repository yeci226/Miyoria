import { errorMessage, type ModuleContext } from "@miyoria/kernel";
import {
  ACTION_SETTLED_TOPIC,
  type Action,
  type ActionPayload,
  type ActionSettled,
  type ActionSink,
  type ActuatorExecutor,
  ActuatorExecutorKey,
  actionPlatform,
  customEvent,
  isActionExpired,
  type JsonValue,
  type LaneKey,
  MouthKey,
  MUTED,
  NOT_MAIN_LINE,
  type PlatformSink,
  PlatformSinksKey,
  PRIORITY_RANK,
  type SentMessage,
  type TurnId,
  timestampMs,
  type VoiceSink,
  VoiceSinkKey,
} from "@miyoria/types";
import type { SchedulerConfig } from "./config.js";

interface Queued {
  seq: number;
  /** `action.created_at` in epoch ms, parsed once. */
  createdMs: number;
  action: Action;
}

type WakeResult = "notified" | "timeout" | "aborted";

/** Wakes a sleeping lane worker (Rust `tokio::sync::Notify`, without the stored permit). */
class Wake {
  #resolve: ((result: WakeResult) => void) | null = null;

  notify(): void {
    const resolve = this.#resolve;
    this.#resolve = null;
    resolve?.("notified");
  }

  /**
   * Waits for `notify`, `ms` to pass or `signal` to abort. Nothing is lost between the
   * worker's queue check and this call: both run in the same synchronous step.
   */
  wait(ms: number, signal: AbortSignal): Promise<WakeResult> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve("aborted");
        return;
      }
      const settle = (result: WakeResult) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.#resolve = null;
        resolve(result);
      };
      const onAbort = () => settle("aborted");
      const timer = setTimeout(() => settle("timeout"), ms);
      signal.addEventListener("abort", onAbort, { once: true });
      this.#resolve = settle;
    });
  }
}

interface Lane {
  queue: Queued[];
  wake: Wake;
}

type Target =
  | { kind: "platform"; sink: PlatformSink }
  | { kind: "voice"; sink: VoiceSink }
  | { kind: "actuator"; executor: ActuatorExecutor };

interface Outcome {
  message: SentMessage | null;
  interrupted: boolean;
}

type Completion = { ok: true; message: SentMessage | null } | { ok: false; error: string };

type Bounded<T> = { kind: "done"; value: T } | { kind: "timeout" } | { kind: "cancelled" };

/**
 * Runs `fn` until it settles, `timeoutMs` pass or `parent` aborts. The signal given to `fn` is
 * aborted afterwards in every case, so a call that lost the race can stop early.
 */
async function runBounded<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parent: AbortSignal,
): Promise<Bounded<T>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const interrupt = new Promise<Bounded<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    onAbort = () => resolve({ kind: "cancelled" });
    if (parent.aborted) onAbort();
    else parent.addEventListener("abort", onAbort, { once: true });
  });
  const work = (async () => fn(controller.signal))().then(
    (value): Bounded<T> => ({ kind: "done", value }),
  );
  // If `interrupt` wins, a later rejection of `work` is expected and must not go unhandled.
  work.catch(() => undefined);
  try {
    return await Promise.race([work, interrupt]);
  } finally {
    clearTimeout(timer);
    if (onAbort) parent.removeEventListener("abort", onAbort);
    controller.abort();
  }
}

/** Thrown by `submit` once the scheduler's module is stopping. */
export class SchedulerStoppedError extends Error {
  override readonly name = "SchedulerStoppedError";

  constructor() {
    super("scheduler is stopped");
  }
}

/**
 * Per-lane action queues. Each lane has its own worker task that runs the lane's actions one at
 * a time, most urgent first (priority, then `created_at`, then submission order), through the
 * `PlatformSinks` service (`VoiceSink` for `speak`, `ActuatorExecutor` for `actuate`). Idle
 * workers exit.
 */
export class Scheduler implements ActionSink {
  readonly #ctx: ModuleContext;
  readonly #config: SchedulerConfig;
  /** A lane is present exactly while its worker is alive. */
  readonly #lanes = new Map<LaneKey, Lane>();
  /** What runs right now, by turn: what `interruptTurn` stops. */
  readonly #running = new Map<TurnId, AbortController>();
  /** Everything running that is hers to say or show: what `silence` stops. */
  readonly #going = new Set<AbortController>();
  #seq = 0;

  constructor(ctx: ModuleContext, config: SchedulerConfig) {
    this.#ctx = ctx;
    this.#config = config;
  }

  activeLanes(): LaneKey[] {
    return [...this.#lanes.keys()];
  }

  /** Number of queued (not yet started) actions over all lanes. */
  queued(): number {
    let total = 0;
    for (const lane of this.#lanes.values()) total += lane.queue.length;
    return total;
  }

  async submit(action: Action): Promise<void> {
    if (this.#ctx.signal.aborted) throw new SchedulerStoppedError();
    if (this.#notTheMainLine(action)) {
      this.#ctx.log.warn(
        { action: action.id, turn: action.turn },
        "a line went around the main line",
      );
      this.#complete(action, { ok: false, error: NOT_MAIN_LINE });
      return;
    }
    const queued: Queued = {
      seq: this.#seq++,
      createdMs: timestampMs(action.created_at),
      action,
    };
    let replaced: Action | null = null;
    let lane = this.#lanes.get(action.lane);
    const isNew = lane === undefined;
    if (lane === undefined) {
      lane = { queue: [], wake: new Wake() };
      this.#lanes.set(action.lane, lane);
    }
    const key = action.coalesce_key;
    if (key !== null) {
      const pos = lane.queue.findIndex((q) => q.action.coalesce_key === key);
      if (pos >= 0) replaced = (lane.queue.splice(pos, 1)[0] as Queued).action;
    }
    lane.queue.push(queued);
    lane.wake.notify();
    if (isNew) {
      const laneKey = action.lane;
      const { wake } = lane;
      this.#ctx.spawn("lane", (signal) => this.#runLane(laneKey, wake, signal));
    }
    if (replaced) this.#complete(replaced, { ok: false, error: "coalesced" });
  }

  /** V3: only the main line opens her mouth. `MouthKey` is only there under V3. */
  #notTheMainLine(action: Action): boolean {
    const type = action.payload.type;
    if (type !== "speak" && type !== "send_message") return false;
    const mouth = this.#ctx.services.get(MouthKey);
    return mouth !== undefined && !mouth.owns(action.turn);
  }

  async interruptTurn(turn: TurnId): Promise<void> {
    this.#running.get(turn)?.abort();
  }

  async silence(): Promise<number> {
    const removed: Action[] = [];
    for (const lane of this.#lanes.values()) {
      removed.push(...lane.queue.map((q) => q.action));
      lane.queue = [];
    }
    for (const action of removed) this.#complete(action, { ok: false, error: MUTED });
    const going = [...this.#going];
    for (const stop of going) stop.abort();
    return removed.length + going.length;
  }

  /** The emergency stop: nothing of hers goes out. */
  #muted(action: Action): boolean {
    if (action.payload.type === "actuate") return false;
    return this.#ctx.services.get(ActuatorExecutorKey)?.paused === true;
  }

  async cancelTurn(turn: TurnId): Promise<void> {
    const removed: Action[] = [];
    for (const lane of this.#lanes.values()) removed.push(...takeTurn(lane, turn));
    for (const action of removed) this.#complete(action, { ok: false, error: "cancelled" });
  }

  async #runLane(laneKey: LaneKey, wake: Wake, signal: AbortSignal): Promise<void> {
    this.#ctx.log.debug({ lane: laneKey }, "lane worker started");
    while (!signal.aborted) {
      const action = this.#pop(laneKey);
      if (action) {
        await this.#execute(action, signal);
        continue;
      }
      const result = await wake.wait(this.#config.lane_idle_ms, signal);
      if (result === "aborted") break;
      if (result === "timeout" && this.#removeIfIdle(laneKey)) {
        this.#ctx.log.debug({ lane: laneKey }, "lane worker idle, exiting");
        return;
      }
    }
    // Stopping: drop whatever is still queued in this lane.
    const leftover = this.#lanes.get(laneKey)?.queue ?? [];
    this.#lanes.delete(laneKey);
    for (const q of leftover) this.#complete(q.action, { ok: false, error: "cancelled" });
  }

  #pop(laneKey: LaneKey): Action | null {
    const queue = this.#lanes.get(laneKey)?.queue;
    if (!queue || queue.length === 0) return null;
    let best = 0;
    for (let i = 1; i < queue.length; i++) {
      if (isBefore(queue[i] as Queued, queue[best] as Queued)) best = i;
    }
    return (queue.splice(best, 1)[0] as Queued).action;
  }

  #removeIfIdle(laneKey: LaneKey): boolean {
    const lane = this.#lanes.get(laneKey);
    if (lane && lane.queue.length === 0) {
      this.#lanes.delete(laneKey);
      return true;
    }
    return false;
  }

  async #execute(action: Action, signal: AbortSignal): Promise<void> {
    if (isActionExpired(action, this.#ctx.clock.now())) {
      this.#complete(action, { ok: false, error: "expired" });
      return;
    }
    if (this.#muted(action)) {
      this.#complete(action, { ok: false, error: MUTED });
      return;
    }
    const target = this.#targetFor(action.payload);
    if (typeof target === "string") {
      this.#complete(action, { ok: false, error: target });
      return;
    }
    // Speech runs as long as playback lasts; give it more room.
    const timeoutMs =
      target.kind === "voice" ? this.#config.speak_timeout_ms : this.#config.execute_timeout_ms;
    let completion: Completion;
    const stop = new AbortController();
    const turn = action.turn;
    if (turn !== null) this.#running.set(turn, stop);
    const hers = action.payload.type !== "actuate";
    if (hers) this.#going.add(stop);
    try {
      const bounded = await runBounded(
        (s) => run(target, action, s),
        timeoutMs,
        AbortSignal.any([signal, stop.signal]),
      );
      if (bounded.kind === "done") {
        const { message, interrupted } = bounded.value;
        if (interrupted && action.turn !== null) {
          // The rest of an interrupted turn must not be spoken.
          this.#dropQueuedTurn(action.lane, action.turn);
        }
        completion = { ok: true, message };
      } else {
        completion = {
          ok: false,
          error: bounded.kind === "timeout" ? "timed out" : "cancelled",
        };
      }
    } catch (error) {
      completion = { ok: false, error: errorMessage(error) };
    }
    if (turn !== null && this.#running.get(turn) === stop) this.#running.delete(turn);
    if (hers) this.#going.delete(stop);
    this.#complete(action, completion);
  }

  #dropQueuedTurn(laneKey: LaneKey, turn: TurnId): void {
    const lane = this.#lanes.get(laneKey);
    if (!lane) return;
    for (const action of takeTurn(lane, turn)) {
      this.#complete(action, { ok: false, error: "cancelled" });
    }
  }

  /** The sink for the payload, or the failure text. */
  #targetFor(payload: ActionPayload): Target | string {
    if (payload.type === "speak") {
      const voice = this.#ctx.services.get(VoiceSinkKey);
      return voice ? { kind: "voice", sink: voice } : "no voice sink";
    }
    if (payload.type === "actuate") {
      const executor = this.#ctx.services.get(ActuatorExecutorKey);
      return executor ? { kind: "actuator", executor } : "no actuator executor";
    }
    const platform = actionPlatform(payload);
    const sink = this.#ctx.services.get(PlatformSinksKey)?.get(platform);
    return sink ? { kind: "platform", sink } : `no sink for platform ${platform}`;
  }

  #complete(action: Action, result: Completion): void {
    if (!result.ok && action.payload.type === "actuate") {
      // Settles the gate's waiting caller; a no-op when the executor already answered it.
      this.#ctx.services.get(ActuatorExecutorKey)?.dropped(action.payload.ticket, result.error);
    }
    if (!result.ok) {
      const fields = { action: action.id, lane: action.lane, error: result.error };
      if (["expired", "cancelled", "coalesced", MUTED].includes(result.error)) {
        this.#ctx.log.debug(fields, "action dropped");
      } else {
        this.#ctx.log.warn(fields, "action failed");
      }
    }
    this.#ctx.publish(
      {
        type: "action_completed",
        data: {
          action: action.id,
          turn: action.turn,
          ok: result.ok,
          error: result.ok ? null : result.error,
          message: result.ok ? result.message : null,
        },
      },
      { turn: action.turn },
    );
    this.#publishSettled(action, result);
  }

  /** Which line of hers this was: `action_completed` only says that an action ended. */
  #publishSettled(action: Action, result: Completion): void {
    const { payload } = action;
    let text: string;
    if (payload.type === "send_message") text = payload.message.text;
    else if (payload.type === "speak") text = payload.text;
    else return;
    const blocked = action.blocked ?? (result.ok ? result.message?.blocked : undefined) ?? null;
    const settled: ActionSettled = {
      action: action.id,
      turn: action.turn,
      type: payload.type,
      context: payload.context,
      text,
      ok: result.ok,
      error: result.ok ? null : result.error,
      message: result.ok ? result.message : null,
      ...(blocked === null ? {} : { blocked }),
    };
    this.#ctx.publish(customEvent(ACTION_SETTLED_TOPIC, settled as unknown as JsonValue), {
      turn: action.turn,
    });
  }
}

/** Removes and returns the queued actions of `turn` from `lane`. */
function takeTurn(lane: Lane, turn: TurnId): Action[] {
  const dropped: Action[] = [];
  lane.queue = lane.queue.filter((q) => {
    if (q.action.turn !== turn) return true;
    dropped.push(q.action);
    return false;
  });
  return dropped;
}

/** (priority, created_at, submission order) ordering: true when `a` runs before `b`. */
function isBefore(a: Queued, b: Queued): boolean {
  const byPriority = PRIORITY_RANK[a.action.priority] - PRIORITY_RANK[b.action.priority];
  if (byPriority !== 0) return byPriority < 0;
  if (a.createdMs !== b.createdMs) return a.createdMs < b.createdMs;
  return a.seq < b.seq;
}

async function run(target: Target, action: Action, signal: AbortSignal): Promise<Outcome> {
  const { payload } = action;
  if (target.kind === "platform") {
    switch (payload.type) {
      case "send_message": {
        const message = await target.sink.send(payload.context, payload.message, signal);
        return { message, interrupted: false };
      }
      case "react":
        await target.sink.react(payload.message, payload.emoji, signal);
        return { message: null, interrupted: false };
      case "typing":
        await target.sink.typing(payload.context, signal);
        return { message: null, interrupted: false };
      default:
        break;
    }
  } else if (target.kind === "actuator" && payload.type === "actuate") {
    await target.executor.run(payload.ticket, signal);
    return { message: null, interrupted: false };
  } else if (target.kind === "voice" && payload.type === "speak") {
    const outcome = await target.sink.speak(
      payload.context,
      payload.text,
      payload.emotion,
      action.turn,
      signal,
    );
    return { message: null, interrupted: outcome === "interrupted" };
  }
  throw new Error("action payload does not match its target");
}
