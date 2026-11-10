// The task contract for activity-type extensions (docs/design/v2-architecture.md §3.8).
//
// A copy of `@miyoria/types` `task.ts` (the SDK does not depend on the core packages; the JSON
// shapes are identical and a test in `@miyoria/ext-host` compares them), plus `TaskRunner`: the
// typed way to implement `TaskExecutor`. The runner owns the lifecycle so an extension only
// writes `run(spec, task)`:
//
// - `start(spec)` accepts the task and emits `started`; exactly one of `done` / `failed`
//   follows, never both and never twice.
// - `budget_s` is enforced: when it runs out the task's signal aborts and it fails `timeout`.
// - `cancel(id)` aborts it (`cancelled`); a new task on the same resource aborts the running one
//   (`superseded`); `close()` ends everything (`disconnected`).
// - Whatever `run` does after its signal aborted is ignored: a stale task is harmless.
// - `run` resolving = `done` with its detail; throwing `TaskFailure(code, detail)` = `failed`
//   with that code; anything else thrown = `failed` / `internal`.

/** A task's id: chosen by whoever starts it. */
export type TaskId = string;

/** What a caller asks an executor to do. */
export interface TaskSpec {
  id: TaskId;
  /** The goal in a stable, executor-defined form (`"obtain"`, `"goto"`, `"launch"`). */
  goal: string;
  /** Goal arguments (validated by the executor). */
  args: Record<string, unknown>;
  /** Seconds the task may take before the executor gives up with `timeout`. */
  budget_s: number;
}

/** Why a task failed (same list and order as `@miyoria/types`). */
export const TASK_FAILURE_CODES = [
  "timeout",
  "cancelled",
  "superseded",
  "busy",
  "invalid",
  "not_found",
  "unreachable",
  "precondition",
  "disconnected",
  "crashed",
  "died",
  "denied",
  "internal",
] as const;

export type TaskFailureCode = (typeof TASK_FAILURE_CODES)[number];

export function isTaskFailureCode(value: unknown): value is TaskFailureCode {
  return typeof value === "string" && (TASK_FAILURE_CODES as readonly string[]).includes(value);
}

/** How a steer went: it took effect, the executor refused it, or the task was already over. */
export type SteerOutcome = "applied" | "rejected" | "too_late";

/**
 * A change of direction for a running task, keeping its progress (docs/design/v3-architecture.md
 * §10.6; same shape as `TaskSteer` of `@miyoria/types`).
 */
export interface TaskSteer {
  id: string;
  task: TaskId;
  /** The goal arguments to change (the executor validates them). */
  patch: Record<string, unknown>;
  why: string;
  cause: string;
}

/** Lifecycle events of one task. Exactly one of `done` / `failed` ends it. */
export type TaskEvent =
  | { type: "started"; task: TaskId; goal: string; at: string }
  | { type: "progress"; task: TaskId; progress: number | null; detail: string; at: string }
  | { type: "done"; task: TaskId; detail: string; data: unknown; at: string }
  | { type: "failed"; task: TaskId; code: TaskFailureCode; detail: string; at: string }
  /** How a steer went (not a lifecycle end: the task keeps running after it). */
  | { type: "steered"; task: TaskId; steer: string; outcome: SteerOutcome; detail: string; at: string };

export type TaskEventType = TaskEvent["type"];

export function isTerminalTaskEvent(event: TaskEvent): event is Extract<TaskEvent, { type: "done" | "failed" }> {
  return event.type === "done" || event.type === "failed";
}

/** Bus topic of a task event: `<owner>.task.<type>` (`game.minecraft.task.done`). */
export function taskTopic(owner: string, type: TaskEventType): string {
  return `${owner}.task.${type}`;
}

/** What `observe()` returns: structured state, never a text that has to be parsed again. */
export interface StructuredState {
  at: string;
  state: Record<string, unknown>;
  /** The task running now, if any. */
  task: TaskId | null;
  summary: string;
}

/** What an activity-type executor implements. */
export interface TaskExecutor {
  observe(signal?: AbortSignal): Promise<StructuredState>;
  /** Returns once the task is accepted; its outcome comes as events. */
  start(task: TaskSpec, signal?: AbortSignal): Promise<void>;
  /** Cancels `id` (a `failed` / `cancelled` event follows); unknown or finished ids are ignored. */
  cancel(id: TaskId): Promise<void>;
  /** Every task event of this executor, in order (each call is its own stream). */
  events(): AsyncIterable<TaskEvent>;
  /**
   * Optional. Changes the goal of running task `steer.task` and keeps its progress. Returns once
   * the steer is accepted; a `steered` event (`applied` / `rejected` / `too_late`) follows, and
   * the patch is read at the next safe point. An executor without it is cancelled and started
   * again instead, so leave it out unless progress can really be kept.
   */
  steer?(steer: TaskSteer): Promise<void>;
}

/** One goal an executor understands, as shown to the model that picks goals. */
export interface TaskGoalSpec {
  name: string;
  description: string;
  /** JSON Schema of the goal's `args`. */
  parameters?: Record<string, unknown>;
  /** Suggested budget (seconds); the caller's default when missing. */
  budget_s?: number;
}

/** What an extension says about its executor when it registers it (`ctx.tasks.register`). */
export interface TaskExecutorInfoInput {
  /** Display name (`Minecraft`). */
  name: string;
  goals: TaskGoalSpec[];
  /** How to pick goals, appended to the goal-picking prompt. */
  guide?: string;
}

/** Largest accepted `budget_s` (one day). */
export const MAX_TASK_BUDGET_S = 86_400;

/** Thrown by `TaskWorker.run` (or used as an abort reason) to fail a task with a code. */
export class TaskFailure extends Error {
  override name = "TaskFailure";
  constructor(
    readonly code: TaskFailureCode,
    message: string,
  ) {
    super(message);
  }
}

/** A running task, as `TaskWorker.run` sees it. */
export interface TaskContext {
  readonly spec: TaskSpec;
  /** Aborts on cancel, timeout, superseded and close; its `reason` is a `TaskFailure`. */
  readonly signal: AbortSignal;
  /** Reports a step (`progress` 0..1 when known). Ignored once the task ended. */
  progress(detail: string, progress?: number | null): void;
  /** Milliseconds left of the budget. */
  remainingMs(): number;
}

export interface TaskResult {
  /** Short neutral description of the result. */
  detail: string;
  data?: unknown;
}

/** What an extension implements to get a `TaskExecutor` from `TaskRunner`. */
export interface TaskWorker {
  /** Structured state for `observe()` (the runner adds `at` and `task`). */
  observe(signal?: AbortSignal): Promise<{ state: Record<string, unknown>; summary: string }>;
  /** Does the task. Resolve = `done`; throw `TaskFailure` = `failed` with its code. */
  run(spec: TaskSpec, task: TaskContext): Promise<TaskResult>;
  /**
   * The resource a task occupies: a new task on the same resource supersedes the running one.
   * `null`: none (it runs alongside, e.g. a chat line). Default `"default"`.
   */
  resource?(spec: TaskSpec): string | null;
}

interface Running {
  spec: TaskSpec;
  resource: string | null;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  deadline: number;
  ended: boolean;
}

/** Ids of ended tasks remembered, so late `cancel`s and duplicate starts stay harmless. */
const MAX_ENDED = 256;

/** Fan-out queue of task events: every `events()` call gets its own stream. */
class EventStreams {
  readonly #streams = new Set<{ items: TaskEvent[]; wake: (() => void) | null }>();
  #closed = false;

  push(event: TaskEvent): void {
    for (const s of this.#streams) {
      s.items.push(event);
      if (s.items.length > 1024) s.items.shift();
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
          async next() {
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
          async return() {
            streams.delete(s);
            return { value: undefined, done: true };
          },
        };
      },
    };
  }
}

export interface TaskRunnerOptions {
  /** Clock of the event timestamps (ms). */
  now?: () => number;
}

/** `TaskExecutor` on top of a `TaskWorker` (see the file comment for the guarantees). */
export class TaskRunner implements TaskExecutor {
  readonly #worker: TaskWorker;
  readonly #now: () => number;
  readonly #running = new Map<TaskId, Running>();
  readonly #ended = new Set<TaskId>();
  readonly #events = new EventStreams();
  #closed = false;

  constructor(worker: TaskWorker, options: TaskRunnerOptions = {}) {
    this.#worker = worker;
    this.#now = options.now ?? Date.now;
  }

  #at(): string {
    return new Date(this.#now()).toISOString();
  }

  #emit(event: TaskEvent): void {
    this.#events.push(event);
  }

  /** Tasks running now (ids). */
  get running(): TaskId[] {
    return [...this.#running.keys()];
  }

  async observe(signal?: AbortSignal): Promise<StructuredState> {
    const { state, summary } = await this.#worker.observe(signal);
    const current = [...this.#running.values()].find((r) => r.resource !== null) ?? [...this.#running.values()][0];
    return { at: this.#at(), state, task: current?.spec.id ?? null, summary };
  }

  async start(spec: TaskSpec): Promise<void> {
    if (this.#closed) throw new TaskFailure("disconnected", "the executor is closed");
    if (!validSpec(spec)) throw new TaskFailure("invalid", "a task needs an id, a goal, object args and 0 < budget_s <= 86400");
    if (this.#running.has(spec.id) || this.#ended.has(spec.id)) return; // the same start again
    let resource: string | null;
    try {
      resource = this.#worker.resource ? this.#worker.resource(spec) : "default";
    } catch {
      resource = "default";
    }
    if (resource !== null) {
      for (const other of [...this.#running.values()]) {
        if (other.resource === resource) this.#abort(other, new TaskFailure("superseded", `replaced by ${spec.goal}`));
      }
    }
    const controller = new AbortController();
    const budgetMs = spec.budget_s * 1000;
    const r: Running = {
      spec,
      resource,
      controller,
      deadline: this.#now() + budgetMs,
      ended: false,
      timer: setTimeout(() => this.#abort(r, new TaskFailure("timeout", `took longer than ${spec.budget_s} s`)), budgetMs),
    };
    (r.timer as { unref?: () => void }).unref?.();
    this.#running.set(spec.id, r);
    this.#emit({ type: "started", task: spec.id, goal: spec.goal, at: this.#at() });
    const ctx: TaskContext = {
      spec,
      signal: controller.signal,
      progress: (detail, progress = null) => {
        if (r.ended) return;
        const p = typeof progress === "number" && Number.isFinite(progress) ? Math.min(Math.max(progress, 0), 1) : null;
        this.#emit({ type: "progress", task: spec.id, progress: p, detail, at: this.#at() });
      },
      remainingMs: () => Math.max(r.deadline - this.#now(), 0),
    };
    let running: Promise<TaskResult>;
    try {
      running = Promise.resolve(this.#worker.run(spec, ctx));
    } catch (error) {
      running = Promise.reject(error);
    }
    running.then(
      (result) => this.#end(r, { type: "done", task: spec.id, detail: result?.detail ?? "", data: result?.data ?? null, at: this.#at() }),
      (error: unknown) => {
        const failure = asFailure(controller.signal.aborted ? controller.signal.reason : error);
        this.#end(r, { type: "failed", task: spec.id, code: failure.code, detail: failure.message, at: this.#at() });
      },
    );
  }

  async cancel(id: TaskId): Promise<void> {
    const r = this.#running.get(id);
    if (r) this.#abort(r, new TaskFailure("cancelled", "cancelled"));
  }

  events(): AsyncIterable<TaskEvent> {
    return this.#events.stream();
  }

  /** Ends every task (`code`, default `disconnected`) and the event streams. */
  close(code: TaskFailureCode = "disconnected", detail = "the executor stopped"): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const r of [...this.#running.values()]) this.#abort(r, new TaskFailure(code, detail));
    this.#events.close();
  }

  /** Ends `r` at once with the abort's code; `run`'s own late result is ignored. */
  #abort(r: Running, reason: TaskFailure): void {
    if (r.ended) return;
    r.controller.abort(reason);
    this.#end(r, { type: "failed", task: r.spec.id, code: reason.code, detail: reason.message, at: this.#at() });
  }

  #end(r: Running, event: Extract<TaskEvent, { type: "done" | "failed" }>): void {
    if (r.ended) return;
    r.ended = true;
    clearTimeout(r.timer);
    this.#running.delete(r.spec.id);
    this.#ended.add(r.spec.id);
    if (this.#ended.size > MAX_ENDED) {
      const oldest = this.#ended.values().next().value;
      if (oldest !== undefined) this.#ended.delete(oldest);
    }
    this.#emit(event);
  }
}

function validSpec(spec: TaskSpec): boolean {
  return (
    typeof spec === "object" &&
    spec !== null &&
    typeof spec.id === "string" &&
    spec.id.length > 0 &&
    spec.id.length <= 64 &&
    typeof spec.goal === "string" &&
    spec.goal.length > 0 &&
    typeof spec.args === "object" &&
    spec.args !== null &&
    !Array.isArray(spec.args) &&
    typeof spec.budget_s === "number" &&
    Number.isFinite(spec.budget_s) &&
    spec.budget_s > 0 &&
    spec.budget_s <= MAX_TASK_BUDGET_S
  );
}

function asFailure(error: unknown): TaskFailure {
  if (error instanceof TaskFailure) return error;
  const e = error as { code?: unknown; message?: unknown } | null;
  if (e && isTaskFailureCode(e.code)) return new TaskFailure(e.code, String(e.message ?? e.code));
  if (error instanceof Error && error.name === "AbortError") return new TaskFailure("cancelled", "cancelled");
  return new TaskFailure("internal", error instanceof Error ? error.message : String(error));
}
