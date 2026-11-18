// The Arbiter (docs/design/v5-contracts.md §3, K12a): impulses that want her to speak or act,
// its decision on each, and the ledger of what she did and tried. Each type is the bus topic it is
// published on, and its payload is that event's data. The game director, songs and followups
// publish impulses; the Arbiter publishes the rest.
//
// Turn internals: kept 90 days (`short`), no default scope (the session decides; an impulse aimed
// at a DM stays in it).

import { z } from "zod";
import {
  AccountRefSchema,
  ContextKeySchema,
  JsonObjectSchema,
  TimestampSchema,
  TurnIdSchema,
} from "../../wire/src/index.js";
import { defineEvent } from "./registry.js";

/** Where an impulse comes from. Only `plan` and `agenda` are her own initiative. */
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
  .meta({ id: "EventsImpulseSource" });

/** The scheduler's priorities, most urgent first. */
export const PrioritySchema = z
  .enum(["system", "direct", "request", "initiative", "idle"])
  .meta({ id: "EventsPriority" });

/** The rows of the floor's claim order, first row first. */
export const FloorClaimKindSchema = z
  .enum(["addressed", "reply", "result", "urgent", "notable", "wish", "ambient"])
  .meta({ id: "EventsFloorClaimKind" });

/** What a line nobody asked for is about, so she does not say it twice. */
export const ImpulseAttentionSchema = z
  .object({
    /** Names the thing, not the words (`game:craft:stone_pickaxe`). */
    key: z.string(),
    repeat_after_ms: z.number(),
    revision: z.number().optional(),
  })
  .meta({ id: "EventsImpulseAttention" });

/** Who and where an impulse is aimed at. */
export const ImpulseTargetSchema = z
  .object({
    /** `null`: wherever fits. */
    context: ContextKeySchema.nullable(),
    /** The handle of the person it is for or about. */
    person: z.string().nullable(),
    account: AccountRefSchema.nullable(),
  })
  .meta({ id: "EventsImpulseTarget" });

/** Something that wants her to speak (`speak`) or act (`act`): `arbiter.impulse`. */
export const ImpulseSchema = z
  .object({
    id: z.string(),
    source: ImpulseSourceSchema,
    kind: z.enum(["speak", "act"]),
    target: ImpulseTargetSchema,
    /** `act`: the capability; `speak`: `null` (or `chat.start`, `chat.dm`). */
    capability: z.string().nullable(),
    args: JsonObjectSchema,
    priority: PrioritySchema,
    /** Dropped after this, recorded as `expired`. */
    expires_at: TimestampSchema,
    why: z.string(),
    /** `speak`: what she might bring up (may quote others: data). */
    hint: z.string().nullable(),
    about: z.array(AccountRefSchema),
    /** Impulses with the same key are merged, the newest wins. */
    coalesce_key: z.string().nullable(),
    /** The goal it carries out, if any. */
    goal: z.string().nullable(),
    created_at: TimestampSchema,
    /** Set on narration only. */
    attention: ImpulseAttentionSchema.nullable().optional(),
    /** Which row of the claim order it is; default: from its source. */
    claim: FloorClaimKindSchema.optional(),
  })
  .meta({ id: "EventsImpulse" });
export type ImpulseData = z.output<typeof ImpulseSchema>;

export const ArbiterVerdictSchema = z
  .enum(["accepted", "merged", "deferred", "rejected", "preempted", "expired"])
  .meta({ id: "EventsArbiterVerdict" });

/** The floor or rule behind a verdict that is not `accepted`. */
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
  .meta({ id: "EventsArbiterReason" });

/** The Arbiter's decision on one impulse: `arbiter.decision`. */
export const ArbiterDecisionSchema = z
  .object({
    impulse: z.string(),
    source: ImpulseSourceSchema,
    verdict: ArbiterVerdictSchema,
    /** `null` for `accepted` and `merged`. */
    reason: ArbiterReasonSchema.nullable(),
    /** Short explanation she can read. */
    detail: z.string(),
    /** When it may work (`deferred`, a rate-limited `rejected`). */
    retry_at: TimestampSchema.nullable(),
    merged_into: z.string().nullable(),
    /** The turn it opened, if any. */
    turn: TurnIdSchema.nullable(),
    /** The task it started, if any. */
    task: z.string().nullable(),
    at: TimestampSchema,
  })
  .meta({ id: "EventsArbiterDecision" });
export type ArbiterDecisionData = z.output<typeof ArbiterDecisionSchema>;

/** One thing she did or tried, new or updated: `arbiter.ledger`. */
export const LedgerEntrySchema = z
  .object({
    id: z.string(),
    at: TimestampSchema,
    kind: z.enum(["impulse", "turn", "task", "notice"]),
    source: ImpulseSourceSchema,
    /** Counted as her own initiative. */
    self_initiated: z.boolean(),
    context: ContextKeySchema.nullable(),
    person: z.string().nullable(),
    /** What it was, short. */
    summary: z.string(),
    outcome: z.enum(["pending", "ok", "ignored", "failed", "denied"]),
    detail: z.string().nullable(),
    impulse: z.string().nullable(),
    turn: TurnIdSchema.nullable(),
    task: z.string().nullable(),
    updated_at: TimestampSchema,
  })
  .meta({ id: "EventsLedgerEntry" });
export type LedgerEntryData = z.output<typeof LedgerEntrySchema>;

export const ArbiterImpulse = defineEvent({
  type: "arbiter.impulse",
  v: 1,
  data: ImpulseSchema,
  tier: "short",
});

export const ArbiterDecided = defineEvent({
  type: "arbiter.decision",
  v: 1,
  data: ArbiterDecisionSchema,
  tier: "short",
});

export const ArbiterLedger = defineEvent({
  type: "arbiter.ledger",
  v: 1,
  data: LedgerEntrySchema,
  tier: "short",
});

/** Every Arbiter type. */
export const ARBITER_EVENTS = [ArbiterImpulse, ArbiterDecided, ArbiterLedger] as const;
