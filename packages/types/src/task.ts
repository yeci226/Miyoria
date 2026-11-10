// The task contract (docs/design/v2-architecture.md §3.8): how every activity-type extension
// (games, the browser) and the ActivityManager (§3.2) report work that takes time.
//
// One task = one id from `started` to exactly one terminal event (`done` or `failed`). Nobody
// guesses completion from event names, "失敗" prefixes or settle timers any more: the executor
// that does the work says when it is over and why. A stale task (cancelled, superseded, timed
// out) must be harmless: its late events are ignored by id.
//
// On the bus a task owner `<owner>` (e.g. `game.minecraft`, `activity`) publishes
// `<owner>.task.started|progress|done|failed|steered` custom events (`taskTopic`) whose payload is
// the `TaskEvent` (internally tagged by `type`). `steered` is not a lifecycle end: it reports how
// a change of direction (`TaskSteer`, docs/design/v3-architecture.md §10.6) went. `@miyoria/sdk` carries its own copy of these shapes
// for extensions (it does not depend on this package).

import type { JsonObject, JsonValue } from "./json.js";
import type { Timestamp } from "./time.js";

/** A task's id: a ULID chosen by whoever starts it (`newId()`). */
export type TaskId = string;

/** What a caller asks an executor to do. */
export interface TaskSpec {
  id: TaskId;
  /** The goal in a stable, executor-defined form (`"obtain"`, `"goto"`, `"launch"`). */
  goal: string;
  /** Goal arguments (validated by the executor). */
  args: JsonObject;
  /** Seconds the task may take before the executor gives up with `timeout`. */
  budget_s: number;
}

/**
 * Why a task failed. Executors use the closest code and put specifics in `detail`; callers
 * branch on the code only (never on `detail`, which is for logs and her notice).
 */
export const TASK_FAILURE_CODES = [
  /** Its `budget_s` ran out. */
  "timeout",
  /** `cancel(id)` was called, or the caller's `AbortSignal` aborted. */
  "cancelled",
  /** A newer task for the same resource replaced it. */
  "superseded",
  /** The resource is busy with something that may not be interrupted. */
  "busy",
  /** The goal or its arguments are not understood. */
  "invalid",
  /** Something it needs is not there (item, target, player, scene, song). */
  "not_found",
  /** It cannot get there or reach it (no path, out of range). */
  "unreachable",
  /** A precondition is missing (not in voice, no OBS, not logged in, missing materials). */
  "precondition",
  /** The executor's connection went away mid-task (game disconnected, node offline). */
  "disconnected",
  /** The executor crashed or its process ended. */
  "crashed",
  /** In a game: she died / lost while doing it. */
  "died",
  /** The gate or a policy refused it. */
  "denied",
  /** Anything else (see `detail`). */
  "internal",
] as const;

export type TaskFailureCode = (typeof TASK_FAILURE_CODES)[number];

export function isTaskFailureCode(value: unknown): value is TaskFailureCode {
  return typeof value === "string" && (TASK_FAILURE_CODES as readonly string[]).includes(value);
}

/** Lifecycle events of one task. Exactly one of `done` / `failed` ends it. */
export type TaskEvent =
  | { type: "started"; task: TaskId; goal: string; at: Timestamp }
  | {
      type: "progress";
      task: TaskId;
      /** 0..1 when the executor can tell, else `null`. */
      progress: number | null;
      /** Short neutral description of the step (`"走到 (12, 64, -3)"`). */
      detail: string;
      at: Timestamp;
    }
  | {
      type: "done";
      task: TaskId;
      /** Short neutral description of the result. */
      detail: string;
      /** Structured result, executor-defined (`null`: none). */
      data: JsonValue;
      at: Timestamp;
    }
  | { type: "failed"; task: TaskId; code: TaskFailureCode; detail: string; at: Timestamp }
  | {
      type: "steered";
      task: TaskId;
      /** `TaskSteer.id`. */
      steer: string;
      outcome: SteerOutcome;
      /** Short neutral description (why it was refused, what changed). */
      detail: string;
      at: Timestamp;
    };

export type TaskEventType = TaskEvent["type"];

/** `done` and `failed` end a task. */
export function isTerminalTaskEvent(
  event: TaskEvent,
): event is Extract<TaskEvent, { type: "done" | "failed" }> {
  return event.type === "done" || event.type === "failed";
}

/** Bus topic of a task event: `<owner>.task.<type>` (`game.minecraft.task.done`). */
export function taskTopic(owner: string, type: TaskEventType): string {
  return `${owner}.task.${type}`;
}

/** Inverse of `taskTopic`: `{owner, type}` of a task topic, or `null`. */
export function parseTaskTopic(topic: string): { owner: string; type: TaskEventType } | null {
  const m = /^(.+)\.task\.(started|progress|done|failed|steered)$/.exec(topic);
  if (m === null) return null;
  return { owner: m[1] as string, type: m[2] as TaskEventType };
}

/**
 * Changing a running task's goal without losing its progress (v3 §10.6). The words are turned
 * into a structured patch by the main line; the executor only ever sees the patch.
 */
export interface TaskSteer {
  /** A ULID chosen by the caller. Also the id of the log line that records the request. */
  id: string;
  task: TaskId;
  /** The goal arguments to change; the executor validates it against its current goal. */
  patch: JsonObject;
  /** Short neutral sentence for the panel and the log. */
  why: string;
  /** The EventLog event that triggered the change. */
  cause: string;
}

/** How a steer went: it took effect, the executor refused it, or the task was already over. */
export const STEER_OUTCOMES = ["applied", "rejected", "too_late"] as const;

export type SteerOutcome = (typeof STEER_OUTCOMES)[number];

export function isSteerOutcome(value: unknown): value is SteerOutcome {
  return typeof value === "string" && (STEER_OUTCOMES as readonly string[]).includes(value);
}

/** What `observe()` returns: structured state, never a text that has to be parsed again. */
export interface StructuredState {
  at: Timestamp;
  /** Executor-defined structured state (health, position, inventory, page, ...). */
  state: JsonObject;
  /** The task running now, if any. */
  task: TaskId | null;
  /** Short neutral summary for her prompt (data: may contain untrusted text). */
  summary: string;
}

/**
 * What an activity-type executor implements (core-side proxy of an extension, or an in-process
 * executor). `start` returns once the task is accepted (its outcome comes as events); it throws
 * only when the task cannot even be accepted.
 */
export interface TaskExecutor {
  observe(signal?: AbortSignal): Promise<StructuredState>;
  start(task: TaskSpec, signal?: AbortSignal): Promise<void>;
  /** Cancels `id` (a `failed` / `cancelled` event follows); unknown or finished ids are ignored. */
  cancel(id: TaskId): Promise<void>;
  /** Every task event of this executor, in order; ends when the executor goes away. */
  events(): AsyncIterable<TaskEvent>;
  /**
   * Changes the goal of running task `steer.task` and keeps its progress. Optional: without it
   * the caller cancels and starts again (the progress is lost). Returns once the steer is
   * accepted; `steered` follows with the outcome, and the patch is read at the next safe point,
   * never in the middle of an action. Budget and start time stay as they were.
   */
  steer?(steer: TaskSteer): Promise<void>;
}
