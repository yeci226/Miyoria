// The task contract of activity-type extensions (games, the browser): the core starts a task
// `{ id, goal, args, budget_s }`, the extension accepts it, and it ends with exactly one `done`
// or `failed { code }`. Methods `task.start`, `task.cancel`, `task.observe` and `task.steer` go
// host to extension; `task.event` goes the other way. The executor is declared with
// `tasks.register` or `contributions.executor`.

import { z } from "zod";
import { JsonObjectSchema, JsonValueSchema, TimestampSchema } from "../../wire/src/index.js";
import { EXT_LIMITS } from "./protocol.js";

/** Why a task failed. Callers branch on the code only; `detail` is for logs and notices. */
export const EXT_TASK_FAILURE_CODES = [
  /** Its `budget_s` ran out. */
  "timeout",
  /** `task.cancel` was called, or the caller gave up waiting. */
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
  /** A precondition is missing (not in voice, not logged in, missing materials). */
  "precondition",
  /** The executor's connection went away mid-task. */
  "disconnected",
  /** The executor crashed or its process ended. */
  "crashed",
  /** In a game: she died or lost while doing it. */
  "died",
  /** The gate or a policy refused it. */
  "denied",
  /** Anything else (see `detail`). */
  "internal",
] as const;

export const ExtTaskFailureCodeSchema = z
  .enum(EXT_TASK_FAILURE_CODES)
  .meta({ id: "ExtTaskFailureCode" });
export type ExtTaskFailureCode = z.output<typeof ExtTaskFailureCodeSchema>;

/** How a steer went: it took effect, the executor refused it, or the task was already over. */
export const EXT_STEER_OUTCOMES = ["applied", "rejected", "too_late"] as const;

export const ExtSteerOutcomeSchema = z.enum(EXT_STEER_OUTCOMES).meta({ id: "ExtSteerOutcome" });
export type ExtSteerOutcome = z.output<typeof ExtSteerOutcomeSchema>;

/** A task's id: chosen by whoever starts it. */
export const ExtTaskIdSchema = z.string().min(1).max(EXT_LIMITS.TASK_ID_MAX_LENGTH);
export type ExtTaskId = z.output<typeof ExtTaskIdSchema>;

/** What a caller asks an executor to do (`task.start`). */
export const ExtTaskSpecSchema = z
  .object({
    id: ExtTaskIdSchema,
    /** The goal in a stable, executor-defined form (`"obtain"`, `"goto"`, `"launch"`). */
    goal: z.string().min(1),
    /** Goal arguments; the executor validates them. */
    args: JsonObjectSchema,
    /** Seconds the task may take before the executor gives up with `timeout`. */
    budget_s: z.number().positive().max(EXT_LIMITS.TASK_BUDGET_MAX_S),
  })
  .meta({ id: "ExtTaskSpec" });
export type ExtTaskSpec = z.output<typeof ExtTaskSpecSchema>;

/**
 * A change of direction for a running task, keeping its progress (`task.steer`). The words were
 * turned into a structured patch before; the executor only sees the patch.
 */
export const ExtTaskSteerSchema = z
  .object({
    /** Chosen by the caller. */
    id: ExtTaskIdSchema,
    task: ExtTaskIdSchema,
    /** The goal arguments to change; the executor validates it against its current goal. */
    patch: JsonObjectSchema,
    /** Short neutral sentence for the panel and the log. */
    why: z.string().max(EXT_LIMITS.STEER_WHY_MAX_LENGTH),
    /** The event that triggered the change. */
    cause: z.string().max(EXT_LIMITS.STEER_CAUSE_MAX_LENGTH),
  })
  .meta({ id: "ExtTaskSteer" });
export type ExtTaskSteer = z.output<typeof ExtTaskSteerSchema>;

/**
 * Lifecycle events of one task (`task.event`). Exactly one of `done` and `failed` ends it;
 * `steered` is not an end, the task keeps running.
 */
export const ExtTaskEventSchema = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("started"),
      task: ExtTaskIdSchema,
      goal: z.string(),
      at: TimestampSchema,
    }),
    z.object({
      type: z.literal("progress"),
      task: ExtTaskIdSchema,
      /** 0 to 1 when the executor can tell, else `null`. */
      progress: z.number().nullable(),
      /** Short neutral description of the step. */
      detail: z.string(),
      at: TimestampSchema,
    }),
    z.object({
      type: z.literal("done"),
      task: ExtTaskIdSchema,
      /** Short neutral description of the result. */
      detail: z.string(),
      /** Structured result, executor-defined (`null`: none). */
      data: JsonValueSchema,
      at: TimestampSchema,
    }),
    z.object({
      type: z.literal("failed"),
      task: ExtTaskIdSchema,
      code: ExtTaskFailureCodeSchema,
      detail: z.string(),
      at: TimestampSchema,
    }),
    z.object({
      type: z.literal("steered"),
      task: ExtTaskIdSchema,
      /** `ExtTaskSteer.id`. */
      steer: ExtTaskIdSchema,
      outcome: ExtSteerOutcomeSchema,
      detail: z.string(),
      at: TimestampSchema,
    }),
  ])
  .meta({ id: "ExtTaskEvent" });
export type ExtTaskEvent = z.output<typeof ExtTaskEventSchema>;

/** `task.observe` result: structured state, never a text that has to be parsed again. */
export const ExtStructuredStateSchema = z
  .object({
    at: TimestampSchema,
    /** Executor-defined state (health, position, inventory, page, ...). */
    state: JsonObjectSchema,
    /** The task running now, if any. */
    task: ExtTaskIdSchema.nullable(),
    /** Short neutral summary for her prompt. It is data and may hold untrusted text. */
    summary: z.string(),
  })
  .meta({ id: "ExtStructuredState" });
export type ExtStructuredState = z.output<typeof ExtStructuredStateSchema>;

/** One goal an executor understands, as shown to the model that picks goals. */
export const ExtGoalDeclSchema = z
  .object({
    name: z.string().regex(EXT_LIMITS.GOAL_NAME),
    description: z.string().max(EXT_LIMITS.GOAL_DESCRIPTION_MAX_LENGTH),
    /** JSON Schema of the goal's `args`; `null`: none given. */
    parameters: JsonValueSchema.nullable().default(null),
    /** Suggested budget in seconds; `null`: the caller's default. */
    budget_s: z.number().positive().max(EXT_LIMITS.TASK_BUDGET_MAX_S).nullable().default(null),
  })
  .meta({ id: "ExtGoalDecl" });
export type ExtGoalDecl = z.output<typeof ExtGoalDeclSchema>;
export type ExtGoalDeclIn = z.input<typeof ExtGoalDeclSchema>;

/** An extension's task executor (`tasks.register`, `contributions.executor`). */
export const ExtExecutorDeclSchema = z
  .object({
    /** Display name (`Minecraft`). */
    name: z.string().min(1).max(EXT_LIMITS.EXECUTOR_NAME_MAX_LENGTH),
    goals: z.array(ExtGoalDeclSchema).max(EXT_LIMITS.EXECUTOR_GOALS_MAX).default([]),
    /** How to pick goals, appended to the goal-picking prompt. */
    guide: z.string().max(EXT_LIMITS.EXECUTOR_GUIDE_MAX_LENGTH).nullable().default(null),
    /** The executor implements `task.steer`. Missing (an older extension) means it does not. */
    steer: z.boolean().default(false),
  })
  .meta({ id: "ExtExecutorDecl" });
export type ExtExecutorDecl = z.output<typeof ExtExecutorDeclSchema>;
export type ExtExecutorDeclIn = z.input<typeof ExtExecutorDeclSchema>;

/** `task.start` params. The answer is `{}`: accepted; the outcome comes as events. */
export const ExtTaskStartParamsSchema = z
  .object({ task: ExtTaskSpecSchema })
  .meta({ id: "ExtTaskStartParams" });
export type ExtTaskStartParams = z.output<typeof ExtTaskStartParamsSchema>;

/** `task.cancel` params. Unknown or finished ids are ignored. */
export const ExtTaskCancelParamsSchema = z
  .object({ task: ExtTaskIdSchema })
  .meta({ id: "ExtTaskCancelParams" });
export type ExtTaskCancelParams = z.output<typeof ExtTaskCancelParamsSchema>;

/** `task.steer` params. The answer is `{}`: accepted; the outcome comes as a `steered` event. */
export const ExtTaskSteerParamsSchema = z
  .object({ steer: ExtTaskSteerSchema })
  .meta({ id: "ExtTaskSteerParams" });
export type ExtTaskSteerParams = z.output<typeof ExtTaskSteerParamsSchema>;

/** `task.event` params. */
export const ExtTaskEventParamsSchema = z
  .object({ event: ExtTaskEventSchema })
  .meta({ id: "ExtTaskEventParams" });
export type ExtTaskEventParams = z.output<typeof ExtTaskEventParamsSchema>;
