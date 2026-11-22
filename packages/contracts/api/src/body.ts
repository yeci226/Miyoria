// What she is doing and what stopped her, read-only: the ActivityManager's snapshot and its recent
// transition tasks, and the arbiter's ledger and verdicts. Changes go through the gate (stage,
// voice, game), not through these routes.

import { z } from "zod";
import { AccountRefSchema, ContextKeySchema, TimestampSchema } from "../../wire/src/index.js";
import { route } from "./route.js";
import { DigitsQuery } from "./shared.js";

export const TaskFailureCodeSchema = z
  .enum([
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
  ])
  .meta({ id: "ApiTaskFailureCode" });
export type TaskFailureCode = z.output<typeof TaskFailureCodeSchema>;

export const ActivityResourceSchema = z
  .enum(["presence", "broadcast", "activity"])
  .meta({ id: "ApiActivityResource" });
export type ActivityResource = z.output<typeof ActivityResourceSchema>;

export const ActivityTypeSchema = z
  .enum(["idle", "chatting", "singing", "game", "browse"])
  .meta({ id: "ApiActivityType" });
export type ActivityType = z.output<typeof ActivityTypeSchema>;

export const ActivityPhaseSchema = z
  .enum(["starting", "running", "stopping", "failed"])
  .meta({ id: "ApiActivityPhase" });
export type ActivityPhase = z.output<typeof ActivityPhaseSchema>;

/** Why an activity (or another transition) failed. */
export const ActivityFailureSchema = z
  .object({
    code: TaskFailureCodeSchema,
    /** Short neutral detail (`OBS 沒開`). */
    detail: z.string(),
    at: TimestampSchema,
  })
  .meta({ id: "ApiActivityFailure" });
export type ActivityFailure = z.output<typeof ActivityFailureSchema>;

/** Her presence in voice: `none`, then joining, in, leaving a voice channel. */
export const HerPresenceSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("none") }),
    z.object({
      type: z.literal("joining"),
      channel: ContextKeySchema,
      task: z.string(),
      since: TimestampSchema,
    }),
    z.object({ type: z.literal("in"), channel: ContextKeySchema, since: TimestampSchema }),
    z.object({
      type: z.literal("leaving"),
      channel: ContextKeySchema,
      task: z.string(),
      since: TimestampSchema,
    }),
  ])
  .meta({ id: "ApiHerPresence" });
export type HerPresence = z.output<typeof HerPresenceSchema>;

/** Her broadcast: Discord Go Live and OBS streaming are two steps of the one broadcast. */
export const HerBroadcastSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("off") }),
    z.object({
      type: z.enum(["starting", "live", "stopping"]),
      /** The guild whose voice channel she goes live in. */
      guild: z.string(),
      /** Discord Go Live is up. */
      golive: z.boolean(),
      /** OBS is streaming. */
      obs: z.boolean(),
      /** The transition in flight (`null` while steadily live). */
      task: z.string().nullable(),
      since: TimestampSchema,
    }),
  ])
  .meta({ id: "ApiHerBroadcast" });
export type HerBroadcast = z.output<typeof HerBroadcastSchema>;

/** What she is busy with. `failed` stays until the next request so everything sees why. */
export const HerActivitySchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("idle"), since: TimestampSchema }),
    z.object({
      type: z.enum(["chatting", "singing", "game", "browse"]),
      /** The song id, game id or site; `null` for chatting. */
      target: z.string().nullable(),
      phase: ActivityPhaseSchema,
      /** The transition in flight, or the one that failed. */
      task: z.string().nullable(),
      /** Set in phase `failed`. */
      failure: ActivityFailureSchema.nullable(),
      since: TimestampSchema,
    }),
  ])
  .meta({ id: "ApiHerActivity" });
export type HerActivity = z.output<typeof HerActivitySchema>;

/** Her timed scene override. */
export const SceneOverrideSchema = z
  .object({
    scene: z.string(),
    until: TimestampSchema,
    /** Who set it. */
    by: z.string(),
  })
  .meta({ id: "ApiSceneOverride" });
export type SceneOverride = z.output<typeof SceneOverrideSchema>;

/** The whole body state. `version` increases by one on every change. */
export const ActivitySnapshotSchema = z
  .object({
    version: z.number(),
    at: TimestampSchema,
    presence: HerPresenceSchema,
    broadcast: HerBroadcastSchema,
    activity: HerActivitySchema,
    override: SceneOverrideSchema.nullable(),
    /** The scene the rules pick; `null`: no OBS or no rule. */
    scene: z.string().nullable(),
  })
  .meta({ id: "ApiActivitySnapshot" });
export type ActivitySnapshot = z.output<typeof ActivitySnapshotSchema>;

const StartableActivitySchema = z.enum(["chatting", "singing", "game", "browse"]);

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
      activity: StartableActivitySchema,
      target: z.string().nullable(),
      goal: z.string().nullable(),
    }),
    z.object({ type: z.literal("stop"), activity: StartableActivitySchema.nullable() }),
    z.object({ type: z.literal("scene_override"), scene: z.string(), duration_ms: z.number() }),
    z.object({ type: z.literal("clear_override") }),
  ])
  .meta({ id: "ApiActivityRequest" });
export type ActivityRequest = z.output<typeof ActivityRequestSchema>;

/** One transition task, as the manager tracks it. */
export const ActivityTaskSchema = z
  .object({
    id: z.string(),
    resource: ActivityResourceSchema,
    request: ActivityRequestSchema,
    /** Who asked. */
    by: z.string(),
    turn: z.string().nullable(),
    context: ContextKeySchema.nullable(),
    status: z.enum(["queued", "running", "done", "failed"]),
    created_at: TimestampSchema,
    ended_at: TimestampSchema.nullable(),
    /** Set when failed. */
    failure: ActivityFailureSchema.nullable(),
    /** Short neutral result when done. */
    detail: z.string().nullable(),
  })
  .meta({ id: "ApiActivityTask" });
export type ActivityTask = z.output<typeof ActivityTaskSchema>;

export const ImpulseSourceSchema = z
  .enum([
    "message",
    "plan",
    "agenda",
    "followup",
    "notice",
    "game",
    "watch",
    "song",
    "world",
    "command",
    "panel",
  ])
  .meta({ id: "ApiImpulseSource" });
export type ImpulseSource = z.output<typeof ImpulseSourceSchema>;

export const LedgerKindSchema = z
  .enum(["impulse", "turn", "task", "notice"])
  .meta({ id: "ApiLedgerKind" });
export type LedgerKind = z.output<typeof LedgerKindSchema>;

export const LedgerOutcomeSchema = z
  .enum(["pending", "ok", "ignored", "failed", "denied"])
  .meta({ id: "ApiLedgerOutcome" });
export type LedgerOutcome = z.output<typeof LedgerOutcomeSchema>;

/** One thing she did or tried. */
export const LedgerEntrySchema = z
  .object({
    id: z.string(),
    at: TimestampSchema,
    kind: LedgerKindSchema,
    source: ImpulseSourceSchema,
    /** Counted as her own initiative. */
    self_initiated: z.boolean(),
    context: ContextKeySchema.nullable(),
    person: z.string().nullable(),
    /** What it was, short. */
    summary: z.string(),
    outcome: LedgerOutcomeSchema,
    /** Why (the verdict's detail, the task's failure, ...). */
    detail: z.string().nullable(),
    impulse: z.string().nullable(),
    turn: z.string().nullable(),
    task: z.string().nullable(),
    updated_at: TimestampSchema,
  })
  .meta({ id: "ApiLedgerEntry" });
export type LedgerEntry = z.output<typeof LedgerEntrySchema>;

/** The limits that apply to her right now. */
export const LedgerLimitsSchema = z
  .object({
    /** Self-initiated starts today and the daily cap (`null`: no cap). */
    initiatives_today: z.number(),
    initiative_cap: z.number().nullable(),
    /** Her self-initiated starts in a row that nobody picked up. */
    unanswered_streak: z.number(),
    /** When she may start something on her own again (`null`: now). */
    next_initiative_at: TimestampSchema.nullable(),
    quiet_hours: z
      .object({ start_hour: z.number(), end_hour: z.number(), active: z.boolean() })
      .nullable(),
    /** Autonomy paused by the owner. */
    paused: z.boolean(),
    /** Capabilities on hold and why, with when they may work. */
    blocked: z.array(
      z.object({
        capability: z.string(),
        reason: z.string(),
        until: TimestampSchema.nullable(),
      }),
    ),
    /** The unanswered limit was reached here: she starts nothing until a person speaks. */
    waiting_for_response: z.boolean().optional(),
    /** What did not work lately (a task that failed after the gate let it run), until when. */
    failed: z
      .array(
        z.object({
          capability: z.string(),
          reason: z.string(),
          at: TimestampSchema,
          until: TimestampSchema,
        }),
      )
      .optional(),
  })
  .meta({ id: "ApiLedgerLimits" });
export type LedgerLimits = z.output<typeof LedgerLimitsSchema>;

/** Something she brought up on her own, and what became of it. */
export const RaisedTopicSchema = z
  .object({
    /** What she said (her words, short). */
    text: z.string(),
    context: ContextKeySchema.nullable(),
    at: TimestampSchema,
    status: z.enum(["waiting", "engaged", "ignored"]),
  })
  .meta({ id: "ApiRaisedTopic" });
export type RaisedTopic = z.output<typeof RaisedTopicSchema>;

/** `GET /api/arbiter/ledger`. */
export const LedgerViewSchema = z
  .object({
    at: TimestampSchema,
    /** Newest first. */
    entries: z.array(LedgerEntrySchema),
    limits: LedgerLimitsSchema,
    /** Topics she raised on her own that nobody picked up, newest first. */
    unanswered: z.array(RaisedTopicSchema),
  })
  .meta({ id: "ApiLedgerView" });
export type LedgerView = z.output<typeof LedgerViewSchema>;

export const ArbiterVerdictSchema = z
  .enum(["accepted", "merged", "deferred", "rejected", "preempted", "expired"])
  .meta({ id: "ApiArbiterVerdict" });
export type ArbiterVerdict = z.output<typeof ArbiterVerdictSchema>;

export const ArbiterReasonSchema = z
  .enum([
    "budget",
    "rate",
    "cooldown",
    "quiet_hours",
    "consent",
    "paused",
    "ceiling",
    "busy",
    "unanswered",
    "repeat",
    "nobody",
    "superseded",
    "expired",
    "denied",
  ])
  .meta({ id: "ApiArbiterReason" });
export type ArbiterReason = z.output<typeof ArbiterReasonSchema>;

/** One arbiter verdict with what the ledger knows about its impulse. */
export const ArbiterDecisionViewSchema = z
  .object({
    impulse: z.string(),
    source: ImpulseSourceSchema,
    verdict: ArbiterVerdictSchema,
    /** `null` for accepted and merged. */
    reason: ArbiterReasonSchema.nullable(),
    /** Short explanation she can read. */
    detail: z.string(),
    /** Deferred, or rate-limited: when it may work. */
    retry_at: TimestampSchema.nullable(),
    merged_into: z.string().nullable(),
    /** The turn it opened, if any. */
    turn: z.string().nullable(),
    /** The task it started, if any. */
    task: z.string().nullable(),
    at: TimestampSchema,
    /** Where the impulse was aimed (`null`: unknown or anywhere). */
    context: ContextKeySchema.nullable(),
    /** What it was, when the ledger still has it. */
    summary: z.string().nullable(),
  })
  .meta({ id: "ApiArbiterDecisionView" });
export type ArbiterDecisionView = z.output<typeof ArbiterDecisionViewSchema>;

/** `GET /api/arbiter/decisions`: decisions seen since the API module started, newest first. */
export const ArbiterDecisionsViewSchema = z
  .object({ decisions: z.array(ArbiterDecisionViewSchema) })
  .meta({ id: "ApiArbiterDecisionsView" });
export type ArbiterDecisionsView = z.output<typeof ArbiterDecisionsViewSchema>;

/** `limit` is held to 1..200 (default 20); a bad one is a 400. */
const TasksQuery = z.object({ limit: DigitsQuery.optional() });

/**
 * `context` is a JSON-encoded context key (`400` when it is not one); `limit` is held to 1..300
 * (default 50).
 */
const LedgerQuery = z.object({ context: z.string().optional(), limit: DigitsQuery.optional() });

/**
 * `limit` is held to 1..500 (default 50); `context` is a JSON-encoded context key and `verdict`
 * one of the verdicts, both read by the handler (`400` for a bad one).
 */
const DecisionsQuery = z.object({
  limit: DigitsQuery.optional(),
  context: z.string().optional(),
  verdict: z.string().optional(),
});

export const activity = {
  /** The whole body state: presence, broadcast, activity and the scene override. */
  snapshot: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/activity" })
    .output(ActivitySnapshotSchema),
  /** Recent transition tasks, newest first. */
  tasks: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/activity/tasks" })
    .input(z.object({ query: TasksQuery }))
    .output(z.array(ActivityTaskSchema)),
};

export const arbiter = {
  /** What she did or tried, her limits and the topics nobody picked up. */
  ledger: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/arbiter/ledger" })
    .input(z.object({ query: LedgerQuery }))
    .output(LedgerViewSchema),
  /** The arbiter's recent verdicts with their reasons, newest first. */
  decisions: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/arbiter/decisions" })
    .input(z.object({ query: DecisionsQuery }))
    .output(ArbiterDecisionsViewSchema),
};
