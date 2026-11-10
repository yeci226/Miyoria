// The core-side half of the task contract (v2 §3.8): one `ProxyExecutor` per extension that
// registered an executor (`tasks.register` / `contributions.executor`), kept in the
// `TaskExecutorRegistry` the `extensions` module provides as `TaskExecutorsKey`.
//
// What the proxy guarantees on top of the extension:
//
// - `start` / `cancel` / `observe` are RPC calls (`task.start`, `task.cancel`, `task.observe`)
//   with the host's call timeout and the caller's `AbortSignal` (aborting sends
//   `$/cancelRequest`; aborting a `start` also cancels the task).
// - Every task it started ends with exactly one terminal event, even when the extension never
//   says so: `budget_s` plus `task_grace_ms` without one → `failed` / `timeout` (and a
//   `task.cancel`); the process ends → `failed` / `crashed` (it died) or `disconnected` (the
//   host stopped it). Events of tasks that already ended are dropped (stale work is harmless).
// - `steer` exists only when the extension declared it (`ExecutorDecl.steer`), so an extension
//   without it looks exactly like an executor with no `steer` and the core answers
//   `unsupported` (cancel, then start). It is an RPC call (`task.steer`) that returns once the
//   extension accepted the patch; the outcome is a `steered` event. A `steered` answering a steer
//   the proxy sent is always passed on, even when its task has already ended (that is `too_late`)
//   or was never known (`rejected`): the one case where an event of an ended task is not stale.
// - Every event is published on the bus as `<owner>.task.<type>` (payload: the `TaskEvent`).

import { errorMessage, getLogger } from "@miyoria/kernel";
import {
  isStructuredStateLike,
  isTaskFailureCode,
  isTaskSpec,
  isTerminalTaskEvent,
  type JsonObject,
  type JsonValue,
  parseTaskEvent,
  type RegisteredTaskExecutor,
  type StructuredState,
  type TaskEvent,
  type TaskExecutorInfo,
  type TaskExecutors,
  type TaskFailureCode,
  type TaskId,
  type TaskSpec,
  type TaskSteer,
  toTimestamp,
} from "@miyoria/types";
import { CLOSED, type Peer, RpcError, TIMEOUT } from "./rpc.js";

const log = getLogger("ext_host.tasks");

/** A `start` the executor did not accept (or an `observe` that failed), with the code. */
export class TaskCallError extends Error {
  override readonly name = "TaskCallError";

  constructor(
    readonly code: TaskFailureCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** The failure code of a failed RPC call to an executor. */
export function callFailureCode(error: unknown): TaskFailureCode {
  if (error instanceof RpcError) {
    const data = error.data;
    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      const code = (data as JsonObject).code;
      if (isTaskFailureCode(code)) return code;
    }
    if (error.code === TIMEOUT) return "timeout";
    if (error.code === CLOSED) return "disconnected";
    return "internal";
  }
  if (error instanceof TaskCallError) return error.code;
  if (error instanceof Error && error.name === "AbortError") return "cancelled";
  return "cancelled";
}

/** Ended task ids remembered (late events and duplicate starts are dropped). */
const MAX_ENDED = 512;

/** Steers sent and not answered yet remembered. */
const MAX_STEERS = 256;

interface Tracked {
  /** Watchdog of a task started through the proxy (none for ones the extension started). */
  timer: ReturnType<typeof setTimeout> | null;
}

/** Fan-out: every `events()` call is its own stream from that moment on. */
class Streams {
  readonly #streams = new Set<{ items: TaskEvent[]; wake: (() => void) | null }>();
  #closed = false;

  push(event: TaskEvent): void {
    for (const s of this.#streams) {
      s.items.push(event);
      if (s.items.length > 4096) s.items.shift();
      s.wake?.();
    }
  }

  close(): void {
    this.#closed = true;
    for (const s of this.#streams) s.wake?.();
  }

  stream(): AsyncIterable<TaskEvent> {
    const streams = this.#streams;
    const closed = () => this.#closed;
    return {
      [Symbol.asyncIterator](): AsyncIterator<TaskEvent> {
        const s: { items: TaskEvent[]; wake: (() => void) | null } = { items: [], wake: null };
        streams.add(s);
        return {
          async next(): Promise<IteratorResult<TaskEvent>> {
            for (;;) {
              const item = s.items.shift();
              if (item) return { value: item, done: false };
              if (closed()) {
                streams.delete(s);
                return { value: undefined, done: true };
              }
              await new Promise<void>((resolve) => {
                s.wake = resolve;
              });
              s.wake = null;
            }
          },
          async return(): Promise<IteratorResult<TaskEvent>> {
            streams.delete(s);
            return { value: undefined, done: true };
          },
        };
      },
    };
  }
}

export interface ProxyExecutorOptions {
  /** Timeout of `task.start` / `task.cancel` / `task.observe` (the host's `call_timeout_ms`). */
  callTimeoutMs: number;
  /** How long after its budget a task may still report its end (`task_grace_ms`). */
  graceMs: number;
  /** Publishes one event on the bus (`<owner>.task.<type>`). */
  publish: (event: TaskEvent) => void;
  now?: () => number;
  /** The extension implements `task.steer` (`ExecutorDecl.steer`); off for older extensions. */
  steer?: boolean;
}

/** `TaskExecutor` of one extension process. */
export class ProxyExecutor implements RegisteredTaskExecutor {
  readonly info: TaskExecutorInfo;
  readonly #peer: Peer;
  readonly #opts: ProxyExecutorOptions;
  readonly #now: () => number;
  readonly #running = new Map<TaskId, Tracked>();
  readonly #ended = new Set<TaskId>();
  readonly #streams = new Streams();
  /** Steers sent whose `steered` has not come yet: steer id → task. */
  readonly #steers = new Map<string, TaskId>();
  #closed = false;
  /** Present only when the extension can steer (see the file header). */
  readonly steer?: (steer: TaskSteer) => Promise<void>;

  constructor(peer: Peer, info: TaskExecutorInfo, opts: ProxyExecutorOptions) {
    this.#peer = peer;
    this.info = info;
    this.#opts = opts;
    this.#now = opts.now ?? Date.now;
    if (opts.steer === true) this.steer = (steer) => this.#steer(steer);
  }

  /** Tasks it believes are running (tests, status). */
  get running(): TaskId[] {
    return [...this.#running.keys()];
  }

  async observe(signal?: AbortSignal): Promise<StructuredState> {
    let value: JsonValue;
    try {
      value = await this.#peer.request("task.observe", {}, this.#opts.callTimeoutMs, signal);
    } catch (error) {
      throw new TaskCallError(callFailureCode(error), `observe failed: ${errorMessage(error)}`, {
        cause: error,
      });
    }
    if (!isStructuredStateLike(value)) {
      throw new TaskCallError(
        "internal",
        "observe returned something that is not a StructuredState",
      );
    }
    return {
      at: value.at,
      state: value.state as JsonObject,
      task: value.task,
      summary: value.summary,
    };
  }

  async start(spec: TaskSpec, signal?: AbortSignal): Promise<void> {
    if (this.#closed) throw new TaskCallError("disconnected", "the extension is not running");
    if (!isTaskSpec(spec)) throw new TaskCallError("invalid", "malformed task spec");
    if (this.#running.has(spec.id) || this.#ended.has(spec.id)) return;
    const graceMs = Math.max(this.#opts.graceMs, 0);
    const timer = setTimeout(
      () => {
        log.warn({ owner: this.info.owner, task: spec.id }, "task overran its budget; failing it");
        this.#synthesize(spec.id, "timeout", `沒有在 ${spec.budget_s} 秒內回報結束`);
        this.#sendCancel(spec.id);
      },
      spec.budget_s * 1000 + graceMs,
    );
    timer.unref?.();
    this.#running.set(spec.id, { timer });
    try {
      await this.#peer.request(
        "task.start",
        { task: spec as unknown as JsonValue },
        this.#opts.callTimeoutMs,
        signal,
      );
    } catch (error) {
      const code = callFailureCode(error);
      // Not accepted (or the caller gave up): no outcome will be reported for it.
      const tracked = this.#running.get(spec.id);
      if (tracked) {
        if (tracked.timer !== null) clearTimeout(tracked.timer);
        this.#running.delete(spec.id);
        this.#remember(spec.id);
      }
      if (signal?.aborted || code === "timeout") this.#sendCancel(spec.id);
      throw new TaskCallError(code, `start refused: ${errorMessage(error)}`, { cause: error });
    }
  }

  async cancel(id: TaskId): Promise<void> {
    if (this.#closed) return;
    try {
      await this.#peer.request("task.cancel", { task: id }, this.#opts.callTimeoutMs);
    } catch (error) {
      log.debug({ owner: this.info.owner, task: id, err: errorMessage(error) }, "cancel failed");
    }
  }

  events(): AsyncIterable<TaskEvent> {
    return this.#streams.stream();
  }

  async #steer(steer: TaskSteer): Promise<void> {
    if (this.#closed) throw new TaskCallError("disconnected", "the extension is not running");
    // Registered first: the extension may answer with `steered` before the call returns.
    this.#steers.set(steer.id, steer.task);
    if (this.#steers.size > MAX_STEERS) {
      const oldest = this.#steers.keys().next().value;
      if (oldest !== undefined) this.#steers.delete(oldest);
    }
    try {
      await this.#peer.request(
        "task.steer",
        { steer: steer as unknown as JsonValue },
        this.#opts.callTimeoutMs,
      );
    } catch (error) {
      this.#steers.delete(steer.id);
      throw new TaskCallError(callFailureCode(error), `steer refused: ${errorMessage(error)}`, {
        cause: error,
      });
    }
  }

  /** A `task.event` notification from the extension. */
  onEvent(raw: JsonValue): void {
    if (this.#closed) return;
    const payload =
      typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as JsonObject) : {};
    const event = parseTaskEvent(payload.event);
    if (event === null) {
      log.warn({ owner: this.info.owner }, "malformed task event dropped");
      return;
    }
    if (event.type === "steered" && this.#steers.delete(event.steer)) {
      this.#emit(event); // the answer to a steer we sent, whatever became of its task
      return;
    }
    if (this.#ended.has(event.task)) return; // a stale task's late word
    if (!this.#running.has(event.task)) {
      if (event.type !== "started") return; // never started (or started elsewhere and lost)
      this.#running.set(event.task, { timer: null }); // the extension's own task
    }
    if (event.type === "steered") return; // nobody asked: not ours to report
    if (isTerminalTaskEvent(event)) this.#finish(event.task);
    this.#emit(event);
  }

  /** The extension went away: everything running fails with `code`; streams end. */
  close(code: TaskFailureCode, detail: string): void {
    if (this.#closed) return;
    for (const id of [...this.#running.keys()]) this.#synthesize(id, code, detail);
    this.#closed = true;
    this.#streams.close();
  }

  #synthesize(id: TaskId, code: TaskFailureCode, detail: string): void {
    if (!this.#running.has(id)) return;
    this.#finish(id);
    this.#emit({ type: "failed", task: id, code, detail, at: toTimestamp(this.#now()) });
  }

  #finish(id: TaskId): void {
    const tracked = this.#running.get(id);
    if (tracked?.timer) clearTimeout(tracked.timer);
    this.#running.delete(id);
    this.#remember(id);
  }

  #remember(id: TaskId): void {
    this.#ended.add(id);
    if (this.#ended.size > MAX_ENDED) {
      const oldest = this.#ended.values().next().value;
      if (oldest !== undefined) this.#ended.delete(oldest);
    }
  }

  #emit(event: TaskEvent): void {
    try {
      this.#opts.publish(event);
    } catch (error) {
      log.warn(
        { owner: this.info.owner, err: errorMessage(error) },
        "publishing a task event failed",
      );
    }
    this.#streams.push(event);
  }

  #sendCancel(id: TaskId): void {
    void this.cancel(id);
  }
}

/** Every registered executor, by owner (`TaskExecutorsKey`). */
export class TaskExecutorRegistry implements TaskExecutors {
  readonly #byOwner = new Map<string, RegisteredTaskExecutor>();

  get(owner: string): RegisteredTaskExecutor | undefined {
    return this.#byOwner.get(owner);
  }

  list(): RegisteredTaskExecutor[] {
    return [...this.#byOwner.values()];
  }

  /** Adds `executor`; throws when another one has the owner. */
  register(executor: RegisteredTaskExecutor): void {
    const current = this.#byOwner.get(executor.info.owner);
    if (current !== undefined && current !== executor) {
      throw new Error(`an executor for \`${executor.info.owner}\` is already registered`);
    }
    this.#byOwner.set(executor.info.owner, executor);
  }

  /** Removes `executor` if it is still the registered one. */
  unregister(executor: RegisteredTaskExecutor): void {
    if (this.#byOwner.get(executor.info.owner) === executor) {
      this.#byOwner.delete(executor.info.owner);
    }
  }
}
