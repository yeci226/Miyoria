// Task events (docs/design/v5-contracts.md §3, K12a): the lifecycle of one task, published on
// `<owner>.task.<type>` (`taskTopic` in @miyoria/types). The owner is one word or more
// (`worklane`, `game.minecraft`, `ext.<id>` with dots in the id), so the topics are registered as
// families, one per event type: `**.task.done` covers `worklane.task.done` and
// `game.minecraft.task.done`. Publishers: the agent's work lane, activity steering and the
// extension host for extension executors (whose events are parsed with the same shape,
// `ExtTaskEventSchema` in @miyoria/contracts/ext, before they are published).
//
// Turn internals: kept 90 days (`short`), no default scope (the session decides).

import { z } from "zod";
import { EXT_STEER_OUTCOMES, EXT_TASK_FAILURE_CODES } from "../../ext/src/tasks.js";
import { JsonValueSchema, TimestampSchema } from "../../wire/src/index.js";
import { defineEvent } from "./registry.js";

/** Why a task failed. Callers branch on the code only; `detail` is for logs and notices. */
export const TaskFailureCodeSchema = z
  .enum(EXT_TASK_FAILURE_CODES)
  .meta({ id: "EventsTaskFailureCode" });

/** How a steer went: it took effect, the executor refused it, or the task was already over. */
export const SteerOutcomeSchema = z.enum(EXT_STEER_OUTCOMES).meta({ id: "EventsSteerOutcome" });

const task = z.string();

export const TaskStartedSchema = z
  .object({ type: z.literal("started"), task, goal: z.string(), at: TimestampSchema })
  .meta({ id: "EventsTaskStarted" });

export const TaskProgressSchema = z
  .object({
    type: z.literal("progress"),
    task,
    /** 0 to 1 when the executor can tell, else `null`. */
    progress: z.number().nullable(),
    /** Short neutral description of the step. */
    detail: z.string(),
    at: TimestampSchema,
  })
  .meta({ id: "EventsTaskProgress" });

export const TaskDoneSchema = z
  .object({
    type: z.literal("done"),
    task,
    detail: z.string(),
    /** Structured result, executor-defined (`null`: none). */
    data: JsonValueSchema,
    at: TimestampSchema,
  })
  .meta({ id: "EventsTaskDone" });

export const TaskFailedSchema = z
  .object({
    type: z.literal("failed"),
    task,
    code: TaskFailureCodeSchema,
    detail: z.string(),
    at: TimestampSchema,
  })
  .meta({ id: "EventsTaskFailed" });

export const TaskSteeredSchema = z
  .object({
    type: z.literal("steered"),
    task,
    /** The steer's id. */
    steer: z.string(),
    outcome: SteerOutcomeSchema,
    /** Why it was refused, what changed. */
    detail: z.string(),
    at: TimestampSchema,
  })
  .meta({ id: "EventsTaskSteered" });

/** Any task event. Exactly one of `done` and `failed` ends a task. */
export const TaskEventSchema = z
  .discriminatedUnion("type", [
    TaskStartedSchema,
    TaskProgressSchema,
    TaskDoneSchema,
    TaskFailedSchema,
    TaskSteeredSchema,
  ])
  .meta({ id: "EventsTaskEvent" });
export type TaskEventData = z.output<typeof TaskEventSchema>;

const PAYLOADS = {
  started: TaskStartedSchema,
  progress: TaskProgressSchema,
  done: TaskDoneSchema,
  failed: TaskFailedSchema,
  steered: TaskSteeredSchema,
} as const;

function family<const Type extends keyof typeof PAYLOADS>(type: Type) {
  return defineEvent({ type: `**.task.${type}`, v: 1, data: PAYLOADS[type] });
}

export const TaskStarted = family("started");
export const TaskProgress = family("progress");
export const TaskDone = family("done");
export const TaskFailed = family("failed");
export const TaskSteered = family("steered");

/** Every task event family. */
export const TASK_EVENTS = [TaskStarted, TaskProgress, TaskDone, TaskFailed, TaskSteered] as const;
