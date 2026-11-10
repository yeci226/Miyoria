// Where the core finds the task executors of activity-type extensions (v2 §3.8, W8).
//
// The extension host registers one `RegisteredTaskExecutor` per extension that declared an
// executor (every game adapter does: `@miyoria/sdk` registers it from `registerAdapter`). Its
// owner is the topic prefix its task events are published under (`game.<id>` for a game
// adapter: `game.minecraft.task.done`). Consumers (the game director, `game.act`, the
// ActivityManager's game start) look it up by owner, start tasks with an id + budget and learn
// the outcome from the task events, never from event names or result texts.

import type { JsonObject, JsonValue } from "./json.js";
import { serviceKey } from "./service-key.js";
import {
  isSteerOutcome,
  isTaskFailureCode,
  type TaskEvent,
  type TaskExecutor,
  type TaskId,
  type TaskSpec,
  type TaskSteer,
} from "./task.js";

/** One goal an executor understands (shown to the model that picks goals). */
export interface TaskGoalSpec {
  /** Stable goal name (`"obtain"`, `"goto"`, `"launch"`). */
  name: string;
  /** One line for the model (Traditional Chinese). */
  description: string;
  /** JSON Schema of `TaskSpec.args`, if any. */
  parameters: JsonValue | null;
  /** The budget the executor suggests for this goal (seconds), `null`: the caller's default. */
  budget_s: number | null;
}

/** What an executor says about itself when it registers. */
export interface TaskExecutorInfo {
  /** Topic prefix of its task events (`game.minecraft`). */
  owner: string;
  /** Display name (`Minecraft`). */
  name: string;
  goals: TaskGoalSpec[];
  /** How to pick goals (progression, rules of thumb), for the goal-picking prompt. */
  guide: string | null;
}

/** A task executor known to the core, with what it registered. */
export interface RegisteredTaskExecutor extends TaskExecutor {
  readonly info: TaskExecutorInfo;
}

/** Provided by the extension host (`extensions` module) while it runs. */
export interface TaskExecutors {
  get(owner: string): RegisteredTaskExecutor | undefined;
  list(): RegisteredTaskExecutor[];
}

export const TaskExecutorsKey = serviceKey<TaskExecutors>("TaskExecutors");

/** Owner (topic prefix) of a game adapter's executor: `game.<id>`. */
export function gameTaskOwner(game: string): string {
  return `game.${game}`;
}

/** Largest budget a task may ask for (one day). */
export const MAX_TASK_BUDGET_S = 86_400;

/** Whether `spec` is well formed (id, goal, object args, a positive finite budget). */
export function isTaskSpec(value: unknown): value is TaskSpec {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    v.id.length > 0 &&
    v.id.length <= 64 &&
    typeof v.goal === "string" &&
    v.goal.length > 0 &&
    typeof v.args === "object" &&
    v.args !== null &&
    !Array.isArray(v.args) &&
    typeof v.budget_s === "number" &&
    Number.isFinite(v.budget_s) &&
    v.budget_s > 0 &&
    v.budget_s <= MAX_TASK_BUDGET_S
  );
}

/** Whether `value` is a well formed `TaskSteer` (ids, an object patch, short texts). */
export function isTaskSteer(value: unknown): value is TaskSteer {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const id = (x: unknown, max: number): x is string =>
    typeof x === "string" && x.length > 0 && x.length <= max;
  return (
    id(v.id, 64) &&
    id(v.task, 64) &&
    typeof v.patch === "object" &&
    v.patch !== null &&
    !Array.isArray(v.patch) &&
    typeof v.why === "string" &&
    v.why.length <= 400 &&
    typeof v.cause === "string" &&
    v.cause.length <= 64
  );
}

/**
 * A `TaskEvent` read from the wire or the bus, or `null` when it is not one. Untrusted input:
 * every field is checked (a bad failure code becomes `null`, not `internal`).
 */
export function parseTaskEvent(value: unknown): TaskEvent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const task = v.task;
  const at = v.at;
  if (typeof task !== "string" || task === "" || task.length > 64) return null;
  if (typeof at !== "string" || Number.isNaN(Date.parse(at))) return null;
  const detail = typeof v.detail === "string" ? v.detail : "";
  switch (v.type) {
    case "started":
      return typeof v.goal === "string" ? { type: "started", task, goal: v.goal, at } : null;
    case "progress": {
      const p = v.progress;
      const progress =
        typeof p === "number" && Number.isFinite(p) ? Math.min(Math.max(p, 0), 1) : null;
      return { type: "progress", task, progress, detail, at };
    }
    case "done":
      return { type: "done", task, detail, data: (v.data ?? null) as JsonValue, at };
    case "failed":
      return isTaskFailureCode(v.code) ? { type: "failed", task, code: v.code, detail, at } : null;
    case "steered":
      return typeof v.steer === "string" &&
        v.steer !== "" &&
        v.steer.length <= 64 &&
        isSteerOutcome(v.outcome)
        ? { type: "steered", task, steer: v.steer, outcome: v.outcome, detail, at }
        : null;
    default:
      return null;
  }
}

/** `StructuredState` JSON check (the state must be an object). */
export function isStructuredStateLike(
  value: unknown,
): value is { at: string; state: JsonObject; task: TaskId | null; summary: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.at === "string" &&
    typeof v.summary === "string" &&
    (v.task === null || typeof v.task === "string") &&
    typeof v.state === "object" &&
    v.state !== null &&
    !Array.isArray(v.state)
  );
}
