// What she is doing (docs/design/v5-contracts.md §3, K12a): the ActivityManager's whole body state
// on every change, the lifecycle of each transition task it runs, and how a game session the last
// run left open was settled. Each type is the bus topic it is published on, and its payload is that
// event's data.
//
// Kept 90 days (`short`). The snapshot and the restore are her own state (`self`); a transition
// task was asked for somewhere, so the session decides.

import { z } from "zod";
import {
  AccountRefSchema,
  ContextKeySchema,
  JsonValueSchema,
  TimestampSchema,
  TurnIdSchema,
} from "../../wire/src/index.js";
import { defineEvent } from "./registry.js";
import { TaskFailureCodeSchema } from "./task.js";

/** The three resources; each has its own mutex. */
export const ActivityResourceSchema = z
  .enum(["presence", "broadcast", "activity"])
  .meta({ id: "EventsActivityResource" });

/** What she can be busy with besides nothing. */
export const BusyActivityTypeSchema = z
  .enum(["chatting", "singing", "game", "browse"])
  .meta({ id: "EventsBusyActivityType" });

export const ActivityPhaseSchema = z
  .enum(["starting", "running", "stopping", "failed"])
  .meta({ id: "EventsActivityPhase" });

/** Why an activity, or another transition, failed. */
export const ActivityFailureSchema = z
  .object({
    code: TaskFailureCodeSchema,
    /** Short neutral detail; may be shown to her. */
    detail: z.string(),
    at: TimestampSchema,
  })
  .meta({ id: "EventsActivityFailure" });

const task = z.string();

/** Her presence in voice; `channel` is a voice context. */
export const HerPresenceSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("none") }),
    z.object({
      type: z.literal("joining"),
      channel: ContextKeySchema,
      task,
      since: TimestampSchema,
    }),
    z.object({ type: z.literal("in"), channel: ContextKeySchema, since: TimestampSchema }),
    z.object({
      type: z.literal("leaving"),
      channel: ContextKeySchema,
      task,
      since: TimestampSchema,
    }),
  ])
  .meta({ id: "EventsHerPresence" });

/** Her broadcast: Discord Go Live and OBS streaming are two sub-steps of one broadcast. */
export const HerBroadcastSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("off") }),
    z.object({
      type: z.enum(["starting", "live", "stopping"]),
      /** The guild whose voice channel she goes live in. */
      guild: z.string(),
      golive: z.boolean(),
      obs: z.boolean(),
      /** The transition in flight (`null` while steadily `live`). */
      task: task.nullable(),
      since: TimestampSchema,
    }),
  ])
  .meta({ id: "EventsHerBroadcast" });

/** What she is busy with; `failed` stays until the next request so everything sees why. */
export const HerActivitySchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("idle"), since: TimestampSchema }),
    z.object({
      type: BusyActivityTypeSchema,
      /** The song, the game (`minecraft`) or the site (`threads`); `null` for `chatting`. */
      target: z.string().nullable(),
      phase: ActivityPhaseSchema,
      /** The transition in flight, or the one that failed. */
      task: task.nullable(),
      failure: ActivityFailureSchema.nullable(),
      since: TimestampSchema,
    }),
  ])
  .meta({ id: "EventsHerActivity" });

/** Her timed scene override. */
export const SceneOverrideSchema = z
  .object({
    scene: z.string(),
    until: TimestampSchema,
    /** Who set it. */
    by: z.string(),
  })
  .meta({ id: "EventsSceneOverride" });

/** The whole body state, on every change: `activity.changed`. */
export const ActivitySnapshotSchema = z
  .object({
    /** One more on every change. */
    version: z.number(),
    at: TimestampSchema,
    presence: HerPresenceSchema,
    broadcast: HerBroadcastSchema,
    activity: HerActivitySchema,
    override: SceneOverrideSchema.nullable(),
    /** The scene the rule picks; `null`: no OBS, no rule. */
    scene: z.string().nullable(),
  })
  .meta({ id: "EventsActivitySnapshot" });
export type ActivitySnapshotData = z.output<typeof ActivitySnapshotSchema>;

/** A transition request. */
export const ActivityRequestSchema = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("ensure_voice"),
      platform: z.string(),
      guild: z.string(),
      channel: z.string().nullable(),
      follow: AccountRefSchema.nullable(),
    }),
    z.object({ type: z.literal("leave_voice") }),
    z.object({
      type: z.literal("ensure_live"),
      platform: z.string(),
      guild: z.string(),
      source: z.string().nullable(),
    }),
    z.object({ type: z.literal("stop_live") }),
    z.object({
      type: z.literal("start"),
      activity: BusyActivityTypeSchema,
      target: z.string().nullable(),
      /** First goal for game and browse activities. */
      goal: z.string().nullable(),
    }),
    z.object({ type: z.literal("stop"), activity: BusyActivityTypeSchema.nullable() }),
    z.object({
      type: z.literal("scene_override"),
      scene: z.string(),
      duration_ms: z.number(),
    }),
    z.object({ type: z.literal("clear_override") }),
  ])
  .meta({ id: "EventsActivityRequest" });

const transition = {
  task,
  resource: ActivityResourceSchema,
  request: ActivityRequestSchema,
  turn: TurnIdSchema.nullable(),
} as const;

/** A transition task started: `activity.started`. */
export const ActivityStartedSchema = z
  .object({ type: z.literal("started"), ...transition, at: TimestampSchema })
  .meta({ id: "EventsActivityStarted" });
export type ActivityStartedData = z.output<typeof ActivityStartedSchema>;

/** A transition task ended well: `activity.done`. */
export const ActivityDoneSchema = z
  .object({
    type: z.literal("done"),
    ...transition,
    detail: z.string(),
    data: JsonValueSchema,
    at: TimestampSchema,
  })
  .meta({ id: "EventsActivityDone" });
export type ActivityDoneData = z.output<typeof ActivityDoneSchema>;

/** A transition task failed: `activity.failed`. */
export const ActivityFailedSchema = z
  .object({
    type: z.literal("failed"),
    ...transition,
    code: TaskFailureCodeSchema,
    detail: z.string(),
    at: TimestampSchema,
  })
  .meta({ id: "EventsActivityFailed" });
export type ActivityFailedData = z.output<typeof ActivityFailedSchema>;

/**
 * A game session the last run left open was settled: `activity.restore`. `resumed`: it runs again;
 * `gone`: it did not come back in time; `dropped`: something else was asked for meanwhile.
 */
export const ActivityRestoreSchema = z
  .object({ game: z.string(), outcome: z.enum(["resumed", "gone", "dropped"]) })
  .meta({ id: "EventsActivityRestore" });
export type ActivityRestoreData = z.output<typeof ActivityRestoreSchema>;

export const ActivityChanged = defineEvent({
  type: "activity.changed",
  v: 1,
  data: ActivitySnapshotSchema,
  scope: "self",
  tier: "short",
});

export const ActivityStarted = defineEvent({
  type: "activity.started",
  v: 1,
  data: ActivityStartedSchema,
  tier: "short",
});

export const ActivityDone = defineEvent({
  type: "activity.done",
  v: 1,
  data: ActivityDoneSchema,
  tier: "short",
});

export const ActivityFailed = defineEvent({
  type: "activity.failed",
  v: 1,
  data: ActivityFailedSchema,
  tier: "short",
});

export const ActivityRestored = defineEvent({
  type: "activity.restore",
  v: 1,
  data: ActivityRestoreSchema,
  scope: "self",
  tier: "short",
});

/** Every activity type. */
export const ACTIVITY_EVENTS = [
  ActivityChanged,
  ActivityStarted,
  ActivityDone,
  ActivityFailed,
  ActivityRestored,
] as const;
