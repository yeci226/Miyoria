// The gate and its neighbours (docs/design/v5-contracts.md §3, K12a): a decision on an action
// request, an outcome nobody's ledger took, the emergency stop, and moderation's blocks and
// flagged inputs. Each type is the bus topic it is published on, and its payload is that event's
// data.
//
// Tiers (v5-data §2.5): decisions and outcomes are the debugging record of what she may do, kept
// 90 days (`short`); the audit log holds the permanent copy of a decision. A decision, a stop and
// a moderation record name capabilities, rules and who pressed what: for the owner (`owner`). The
// emergency stop and the blocked outputs are safety actions, kept (`keep`). An outcome belongs to
// the session it happened in (no default scope).

import { z } from "zod";
import {
  AccountRefSchema,
  ContextKeySchema,
  JsonValueSchema,
  TimestampSchema,
} from "../../wire/src/index.js";
import { ImpulseSourceSchema } from "./arbiter.js";
import { defineEvent } from "./registry.js";

export const PrincipalKindSchema = z
  .enum(["self", "user", "command", "panel", "director"])
  .meta({ id: "EventsPrincipalKind" });

/** On whose behalf an action runs. */
export const PrincipalSchema = z
  .object({
    kind: PrincipalKindSchema,
    /** The account that asked: the speaker, the invoker, or whoever suggested it. */
    requester: AccountRefSchema.nullable(),
    /** Where the request came from. */
    context: ContextKeySchema.nullable(),
    /** `command` only: her own judgment was skipped. */
    override: z.boolean(),
    /** `panel`: the API actor (`api`, `discord:<id>`); `null` otherwise. */
    actor: z.string().nullable(),
  })
  .meta({ id: "EventsPrincipal" });

/** Where the gate decided. */
export const GateStageSchema = z
  .enum([
    "unknown",
    "args",
    "directive",
    "pause",
    "prohibition",
    "consent",
    "permission",
    "budget",
    "risk",
    "rate",
    "review",
    "escalation",
  ])
  .meta({ id: "EventsGateStage" });

/** One gate decision: `gate.decision`. */
export const GateDecisionSchema = z
  .object({
    id: z.string(),
    at: TimestampSchema,
    capability: z.string(),
    /** `null` for a capability nobody registered. */
    risk: z.enum(["low", "medium", "high"]).nullable(),
    principal: PrincipalSchema,
    args: JsonValueSchema,
    /** Why she (or whoever) wanted it. */
    why: z.string().nullable(),
    turn: z.string().nullable(),
    allowed: z.boolean(),
    stage: GateStageSchema,
    reason: z.string(),
    /** `self` or the owner who answered (`discord:<id>`) at the review and escalation stages. */
    reviewer: z.string().nullable(),
  })
  .meta({ id: "EventsGateDecision" });
export type GateDecisionData = z.output<typeof GateDecisionSchema>;

/** What an action came to, when no Arbiter keeps the ledger: `actions.outcome`. */
export const ActionOutcomeSchema = z
  .object({
    kind: z.enum(["impulse", "turn", "task", "notice"]),
    source: ImpulseSourceSchema,
    context: ContextKeySchema.nullable(),
    person: z.string().nullable(),
    /** What the capability does, short. */
    summary: z.string(),
    outcome: z.enum(["pending", "ok", "ignored", "failed", "denied"]),
    detail: z.string().nullable(),
    impulse: z.string().nullable(),
    turn: z.string().nullable(),
    task: z.string().nullable(),
    capability: z.string(),
    status: z.enum(["done", "denied", "failed"]),
    at: TimestampSchema,
  })
  .meta({ id: "EventsActionOutcome" });
export type ActionOutcomeData = z.output<typeof ActionOutcomeSchema>;

export const EmergencyStepNameSchema = z
  .enum(["pause", "silence", "song", "stream", "voice", "game", "resume"])
  .meta({ id: "EventsEmergencyStepName" });

/** The emergency stop, or its lifting: `autonomy.emergency`. */
export const EmergencyReportSchema = z
  .object({
    /** She is stopped after this. */
    paused: z.boolean(),
    /** Who pressed it (`panel:<actor>`, `command:discord:1`). */
    by: z.string(),
    at: TimestampSchema,
    steps: z.array(
      z.object({
        step: EmergencyStepNameSchema,
        ok: z.boolean(),
        /** What happened, for whoever pressed the button. */
        detail: z.string(),
      }),
    ),
  })
  .meta({ id: "EventsEmergencyReport" });
export type EmergencyReportData = z.output<typeof EmergencyReportSchema>;

export const ModerationCategorySchema = z
  .enum(["hate", "minors", "self_harm", "doxxing", "secrets", "custom"])
  .meta({ id: "EventsModerationCategory" });

export const OutputPathSchema = z
  .enum(["reply", "fallback", "translation", "tts", "aside", "game_chat", "other"])
  .meta({ id: "EventsOutputPath" });

/** One blocked output: `moderation.block`. It names the rule, never the text. */
export const ModerationBlockSchema = z
  .object({
    /** Which text of the line was checked. */
    field: z.enum(["visible", "voice"]),
    category: ModerationCategorySchema,
    /** Rule id (`hate.en.n-word`), or `<provider>:<category>`. */
    rule: z.string(),
    layer: z.enum(["rules", "provider"]),
    at: TimestampSchema,
    path: OutputPathSchema,
    /** Characters of the blocked text. */
    chars: z.number(),
    /** Keyed hash of the blocked text; the key changes on every start. */
    fingerprint: z.string(),
    context: ContextKeySchema.nullable(),
    turn: z.string().nullable(),
  })
  .meta({ id: "EventsModerationBlock" });
export type ModerationBlockData = z.output<typeof ModerationBlockSchema>;

export const InputSourceSchema = z
  .enum(["chat", "voice", "game_chat", "web", "tool", "other"])
  .meta({ id: "EventsInputSource" });

export const InputActionSchema = z
  .enum(["pass", "mark", "rate_limit", "ignore"])
  .meta({ id: "EventsInputAction" });

export const InputFlagSchema = z
  .enum(["injection", "flood", "bait", "impersonation"])
  .meta({ id: "EventsInputFlag" });

/** An input that was not passed as it is: `moderation.input`. No text either. */
export const InputVerdictSchema = z
  .object({
    at: TimestampSchema,
    source: InputSourceSchema,
    /** Who wrote it; `null` for content nobody wrote. */
    author: z.string().nullable(),
    action: InputActionSchema,
    flags: z.array(InputFlagSchema),
    /** Rule ids that matched. */
    reasons: z.array(z.string()),
    owner: z.boolean(),
  })
  .meta({ id: "EventsInputVerdict" });
export type InputVerdictData = z.output<typeof InputVerdictSchema>;

export const GateDecision = defineEvent({
  type: "gate.decision",
  v: 1,
  data: GateDecisionSchema,
  scope: "owner",
  tier: "short",
});

export const ActionsOutcome = defineEvent({
  type: "actions.outcome",
  v: 1,
  data: ActionOutcomeSchema,
  tier: "short",
});

export const AutonomyEmergency = defineEvent({
  type: "autonomy.emergency",
  v: 1,
  data: EmergencyReportSchema,
  scope: "owner",
  tier: "keep",
});

export const ModerationBlocked = defineEvent({
  type: "moderation.block",
  v: 1,
  data: ModerationBlockSchema,
  scope: "owner",
  tier: "keep",
});

export const ModerationInput = defineEvent({
  type: "moderation.input",
  v: 1,
  data: InputVerdictSchema,
  scope: "owner",
  tier: "short",
});

/** Every gate and moderation type. */
export const GATE_EVENTS = [
  GateDecision,
  ActionsOutcome,
  AutonomyEmergency,
  ModerationBlocked,
  ModerationInput,
] as const;
