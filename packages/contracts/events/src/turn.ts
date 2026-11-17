// How a turn went (docs/design/v5-data.md §2.7, §8 step 6): her attention decision and how the
// turn ended. Both are bus events today, so each type keeps its dotted bus topic and its payload
// is that bus event's data:
//
// - `agent.decision`: why she did or did not respond (the agent's `DecisionTrace`);
// - `agent.turn.outcome`: how a turn ended, sent, silence, cancelled or error (the agent's
//   `TurnOutcomeRecord`). One per turn; a turn written again is a new event, and readers take the
//   latest of its turn.
//
// Turn internals: kept 90 days (`short`). No default scope: the session decides, so a decision
// about a DM stays in that DM. `turn` on the envelope is the turn's id, `parent` the event the
// decision answered when the writer knows it.

import { z } from "zod";
import {
  ContextKeySchema,
  MessageRefSchema,
  TimestampSchema,
  TurnIdSchema,
} from "../../wire/src/index.js";
import { defineEvent } from "./registry.js";

/** Why the agent did or did not respond: the `agent.decision` bus event's data. */
export const DecisionTraceSchema = z
  .object({
    turn: TurnIdSchema,
    context: ContextKeySchema,
    respond: z.boolean(),
    score: z.number(),
    reasons: z.array(z.string()),
  })
  .meta({ id: "EventsDecisionTrace" });
export type DecisionTraceData = z.output<typeof DecisionTraceSchema>;

/** Why a turn exists. */
export const TurnReasonSchema = z
  .enum(["addressed", "reply_to_her", "ambient", "initiative", "notice"])
  .meta({ id: "EventsTurnReason" });

/** What cancelled a turn. */
export const TurnCancelCauseSchema = z
  .enum(["input", "barge_in", "superseded", "expired", "floor", "shutdown"])
  .meta({ id: "EventsTurnCancelCause" });

/** How a turn ended. */
export const TurnOutcomeSchema = z
  .discriminatedUnion("type", [
    /** She said something (messages sent, sentences spoken). */
    z.object({ type: z.literal("sent"), parts: z.number() }),
    /** She chose silence. */
    z.object({ type: z.literal("silence") }),
    /** `by`: the handle of the person whose input or voice caused it, when one did. */
    z.object({
      type: z.literal("cancelled"),
      cause: TurnCancelCauseSchema,
      by: z.string().nullable(),
    }),
    z.object({ type: z.literal("error"), error: z.string() }),
  ])
  .meta({ id: "EventsTurnOutcome" });

/** A voice turn's latency split by where it went (ms; `null` where a boundary is unknown). */
export const VoiceTurnStagesSchema = z
  .object({
    heard_ms: z.number().nullable(),
    wait_ms: z.number().nullable(),
    decide_ms: z.number().nullable(),
    context_ms: z.number().nullable(),
    prompt_ms: z.number().nullable(),
    first_token_ms: z.number().nullable(),
    held_ms: z.number().nullable(),
    first_sentence_ms: z.number().nullable(),
    speculative: z.boolean(),
  })
  .meta({ id: "EventsVoiceTurnStages" });

/** How a turn ended and what led to it: the `agent.turn.outcome` bus event's data. */
export const TurnOutcomeRecordSchema = z
  .object({
    turn: TurnIdSchema,
    context: ContextKeySchema,
    reason: TurnReasonSchema,
    outcome: TurnOutcomeSchema,
    /** Handles of who it answered. */
    addressed_by: z.array(z.string()),
    focus: z.array(MessageRefSchema),
    restarts: z.number(),
    /** Reasoning level the reply was generated with (`null`: no generation). */
    reasoning: z.enum(["off", "low", "medium", "high"]).nullable(),
    /** From the last focus input to her first output (`null`: nothing went out). */
    latency_ms: z.number().nullable(),
    at: TimestampSchema,
    /** How often each correction fired, for a turn that reached the model. */
    corrections: z.record(z.string(), z.number()).optional(),
    /** A voice turn's latency split by stage. */
    voice_stages: VoiceTurnStagesSchema.optional(),
  })
  .meta({ id: "EventsTurnOutcomeRecord" });
export type TurnOutcomeData = z.output<typeof TurnOutcomeRecordSchema>;

/** Her attention decision on a turn. */
export const AgentDecision = defineEvent({
  type: "agent.decision",
  v: 1,
  data: DecisionTraceSchema,
  tier: "short",
});

/** How a turn ended. */
export const AgentTurnOutcome = defineEvent({
  type: "agent.turn.outcome",
  v: 1,
  data: TurnOutcomeRecordSchema,
  tier: "short",
});

/** Every turn record type. */
export const TURN_EVENTS = [AgentDecision, AgentTurnOutcome] as const;
