// The one way to change a running task's goal without losing its progress (docs/design/v3-
// architecture.md §10.6). The ActivityManager implements it and the `activity` module provides it;
// only the main line calls it (rule 1: chat and the panel produce Observations, never a steer).
//
// `steer` answers with a receipt: `accepted` only means the executor took the patch. It takes
// effect at the executor's next safe point and the outcome (`applied` / `rejected` / `too_late`)
// arrives as the `<owner>.task.steered` event (a `TaskEvent`, also written to the EventLog). She
// must not say "changed" before that. A steer that is refused or too late also gets that event, so
// every steer ends with exactly one of them (`unsupported` is the one exception: nothing was
// tried, and the caller decides about `cancel` then `start`).

import type { Principal } from "./actuator.js";
import type { JsonObject } from "./json.js";
import { serviceKey } from "./service-key.js";
import type { SteerOutcome, TaskId, TaskSpec, TaskSteer } from "./task.js";
import type { Timestamp } from "./time.js";

/** What the main line asks for. */
export interface SteerRequest {
  steer: TaskSteer;
  /** The executor's topic prefix (`game.minecraft`, `sing`): where the task runs. */
  owner: string;
  /** Who asks. Only `Principals.self` is the main line; any other kind is refused. */
  principal: Principal;
}

/**
 * The `body` of the `steer` line that records a request (source `activity`; its id is the
 * steer's, its cause the trigger's).
 */
export interface SteerRequestBody {
  phase: "request";
  /** The executor's topic prefix. */
  owner: string;
  task: TaskId;
  /** The goal arguments to change. */
  patch: JsonObject;
  /** Why she steers, in her words. */
  why: string;
  /** Who asked: the `kind` of the principal (`self`: the main line). */
  by: Principal["kind"];
}

/**
 * The `body` of the `steer` line that records how a steer went (source: the executor's topic
 * prefix; its cause the steer's id).
 */
export interface SteerOutcomeBody {
  phase: "outcome";
  task: TaskId;
  /** `TaskSteer.id`. */
  steer: string;
  outcome: SteerOutcome;
  /** Short neutral description: why it was refused, what changed. */
  detail: string;
}

/** What a `steer` line says; `phase` tells which. */
export type SteerBody = SteerRequestBody | SteerOutcomeBody;

/** Why a steer was refused before (or by) the executor. */
export const STEER_REFUSALS = [
  /** The caller is not the main line. */
  "not_main_line",
  /** The request or the patch is malformed, or it tries to touch the budget or the clock. */
  "invalid",
  /** No such task is known for that owner. */
  "unknown_task",
  /** A rule (a hold on the capability) forbids the patched goal. */
  "rule",
  /** The gate refused it. */
  "denied",
  /** The executor refused or failed. */
  "failed",
] as const;

export type SteerRefusal = (typeof STEER_REFUSALS)[number];

export type SteerReceipt =
  /** The executor took it; `steered` follows. `budget_s` / `started_at`: kept as they were. */
  | {
      status: "accepted";
      steer: string;
      task: TaskId;
      budget_s: number | null;
      started_at: Timestamp | null;
    }
  /** Refused (and a `steered` / `rejected` event was published). */
  | { status: "rejected"; steer: string; task: TaskId; reason: SteerRefusal; detail: string }
  /** The task was already over (and a `steered` / `too_late` event was published). */
  | { status: "too_late"; steer: string; task: TaskId; detail: string }
  /**
   * This task cannot be steered (the executor has no `steer`, or it is a single step such as a
   * scene switch). Nothing was tried and no event follows: cancel and start again, knowing the
   * progress is lost.
   */
  | {
      status: "unsupported";
      steer: string;
      task: TaskId;
      detail: string;
      fallback: "cancel_then_start";
      progress_lost: true;
    };

/** A task as the manager knows it: its goal and current arguments. */
export interface SteerableTask {
  goal: string;
  args: JsonObject;
}

/**
 * How an in-process executor that is not a `TaskExecutor` (the song list) takes part: the
 * manager gates the steer as `capability` (whose `execute` applies it and answers with
 * `{outcome, detail}` as its data), after its own checks.
 */
export interface SteerRoute {
  capability: string;
  /** The task if it is running (open) now, `"over"` if it is known but finished, else `null`. */
  live(task: TaskId): SteerableTask | "over" | null;
  /** The capability's arguments for `steer` on `task` (the patch is already checked). */
  args(steer: TaskSteer, task: SteerableTask): JsonObject;
}

/** Provided by the `activity` module. */
export interface TaskSteerService {
  /** Changes the goal of a running task, keeping progress, budget and start time. */
  steer(request: SteerRequest): Promise<SteerReceipt>;
  /** Tells the manager the spec of a task an executor accepted (so a steer keeps its budget). */
  track(owner: string, spec: TaskSpec, at?: Timestamp): void;
  /** Makes tasks of `owner` steerable through `route`; returns the function that removes it. */
  registerRoute(owner: string, route: SteerRoute): () => void;
}

export const TaskSteerKey = serviceKey<TaskSteerService>("TaskSteer");
