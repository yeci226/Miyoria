// How well she takes part: how each turn ended (sent, silence, cancelled and by whom, error;
// newest first) and the per-day measures of her participation (`GET /api/turns/metrics`). Both are
// read-only.

import { z } from "zod";
import {
  ContextKeySchema,
  MessageRefSchema,
  TimestampSchema,
  TurnIdSchema,
} from "../../wire/src/index.js";
import { ReasoningLevelSchema } from "./prompts.js";
import { route } from "./route.js";
import { DigitsQuery } from "./shared.js";

/** Why a turn exists. */
export const TurnReasonSchema = z
  .enum(["addressed", "reply_to_her", "ambient", "initiative", "notice"])
  .meta({ id: "ApiTurnReason" });
export type TurnReason = z.output<typeof TurnReasonSchema>;

/** What cancelled a turn. */
export const TurnCancelCauseSchema = z
  .enum(["input", "barge_in", "superseded", "expired", "floor", "shutdown"])
  .meta({ id: "ApiTurnCancelCause" });
export type TurnCancelCause = z.output<typeof TurnCancelCauseSchema>;

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
  .meta({ id: "ApiTurnOutcome" });
export type TurnOutcome = z.output<typeof TurnOutcomeSchema>;

/** The outcome kinds of a turn (`TurnOutcome["type"]`). */
export type TurnOutcomeKind = TurnOutcome["type"];

/** The after-the-fact corrections of her output. */
export const CorrectionKindSchema = z
  .enum([
    "claim_held",
    "claim_parked",
    "claim_dropped",
    "claim_reask",
    "tool_text_reask",
    "tool_text_commit",
    "promise_commit",
    "leak_dropped",
    "wait_line",
    "fallback_line",
    "keep_hint",
    "ground_args",
    "repeat_cut",
    "noted_callback",
    "self_talk_cut",
    "prohibition_written",
  ])
  .meta({ id: "ApiCorrectionKind" });
export type CorrectionKind = z.output<typeof CorrectionKindSchema>;

/** One turn's outcome, with the corrections that fired when the row carries them. */
export const TurnOutcomeRecordSchema = z
  .object({
    turn: TurnIdSchema,
    context: ContextKeySchema,
    reason: TurnReasonSchema,
    outcome: TurnOutcomeSchema,
    /** The people the reply was for (handles). */
    addressed_by: z.array(z.string()),
    focus: z.array(MessageRefSchema),
    restarts: z.number(),
    /** Reasoning level the reply was generated with (`null`: no generation). */
    reasoning: ReasoningLevelSchema.nullable(),
    /** From the last focus input to her first output (`null`: nothing went out). */
    latency_ms: z.number().nullable(),
    at: TimestampSchema,
    /** How often each correction fired; kinds that did not fire are left out. */
    corrections: z.partialRecord(CorrectionKindSchema, z.number()).optional(),
  })
  .meta({ id: "ApiTurnOutcomeRecord" });
export type TurnOutcomeRecord = z.output<typeof TurnOutcomeRecordSchema>;

// ---- the measures ------------------------------------------------------------------------

/** `sent / total`; `rate` is `null` with no samples, never 0. */
export const MetricRatioSchema = z
  .object({ sent: z.number(), total: z.number(), rate: z.number().nullable() })
  .meta({ id: "ApiMetricRatio" });
export type MetricRatio = z.output<typeof MetricRatioSchema>;

/** Why a follow-up she did not answer stopped. */
export const FollowupStopReasonsSchema = z
  .object({
    /** Her share of the recent messages was over the cap. */
    anti_spam: z.number(),
    /** The score was under the level's minimum. */
    low_score: z.number(),
    /** The gate passed it on and the dice said no. */
    lost_roll: z.number(),
    /** The floor (the microphone or the channel) was refused. */
    floor: z.number(),
    /** Handed to the model, which chose silence. */
    passed_silent: z.number(),
    /** Anything else. */
    other: z.number(),
  })
  .meta({ id: "ApiFollowupStopReasons" });
export type FollowupStopReasons = z.output<typeof FollowupStopReasonsSchema>;

/** How often one correction fired in one channel: firings, and the turns it fired in. */
export const CorrectionCountSchema = z
  .object({ events: z.number(), turns: z.number() })
  .meta({ id: "ApiCorrectionCount" });
export type CorrectionCount = z.output<typeof CorrectionCountSchema>;

/** One correction, in voice and in text. */
export const CorrectionStatSchema = z
  .object({ voice: CorrectionCountSchema, text: CorrectionCountSchema })
  .meta({ id: "ApiCorrectionStat" });
export type CorrectionStat = z.output<typeof CorrectionStatSchema>;

export const CorrectionsBucketSchema = z
  .object({
    /** Turns that reached the model and carry their corrections, by channel. */
    measured: z.object({ voice: z.number(), text: z.number() }),
    /** Every kind, zeros included. */
    kinds: z.record(CorrectionKindSchema, CorrectionStatSchema),
  })
  .meta({ id: "ApiCorrectionsBucket" });
export type CorrectionsBucket = z.output<typeof CorrectionsBucketSchema>;

export const TurnMetricsBucketSchema = z
  .object({
    /** Turns counted (outcomes plus refused gate decisions). */
    turns: z.number(),
    /** Someone replied to what she said: how often she answered. */
    followup: MetricRatioSchema,
    /** Nobody called her: how often she joined in. */
    ambient: MetricRatioSchema,
    /** Someone called her. */
    addressed: MetricRatioSchema,
    /** Voice, addressed turns that made sound: last focus input to her first output. */
    voice_latency: z.object({
      p50_ms: z.number().nullable(),
      p90_ms: z.number().nullable(),
      samples: z.number(),
    }),
    /** Voice turns that made sound: she started them, or she was answering. */
    voice_origin: z.object({ self_started: z.number(), answering: z.number() }),
    /** Turns by how they ended; a refused gate decision counts as `silence`. */
    outcomes: z.object({
      sent: z.number(),
      silence: z.number(),
      cancelled: z.number(),
      error: z.number(),
    }),
    /** Follow-ups that got no answer, by why. */
    followup_stopped: FollowupStopReasonsSchema,
    /** What the code changed of her output after the model wrote it. */
    corrections: CorrectionsBucketSchema,
  })
  .meta({ id: "ApiTurnMetricsBucket" });
export type TurnMetricsBucket = z.output<typeof TurnMetricsBucketSchema>;

export const TurnMetricsDaySchema = z
  .object({
    ...TurnMetricsBucketSchema.shape,
    /** Local date, `YYYY-MM-DD`. */
    day: z.string(),
  })
  .meta({ id: "ApiTurnMetricsDay" });
export type TurnMetricsDay = z.output<typeof TurnMetricsDaySchema>;

/** `GET /api/turns/metrics`. */
export const TurnMetricsSchema = z
  .object({
    days: z.number(),
    /** ISO time the window starts (the local midnight `days - 1` days ago). */
    from: z.string(),
    /** The read cap was hit inside the window: its oldest day may be partial. */
    truncated: z.boolean(),
    overall: TurnMetricsBucketSchema,
    /** Oldest first, one per local day of the window, empty days included. */
    daily: z.array(TurnMetricsDaySchema),
  })
  .meta({ id: "ApiTurnMetrics" });
export type TurnMetrics = z.output<typeof TurnMetricsSchema>;

export const turns = {
  /**
   * How turns ended, newest first. `context` is a JSON-encoded context key that the server decodes
   * (not JSON: 400); `outcome` is one of `sent`, `silence`, `cancelled`, `error` (the server says
   * `400` for another); `limit` defaults to 50 and is held to 1..500.
   */
  outcomes: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/turns/outcomes" })
    .input(
      z.object({
        query: z.object({
          context: z.string().optional(),
          outcome: z.string().optional(),
          limit: DigitsQuery.optional(),
        }),
      }),
    )
    .output(z.array(TurnOutcomeRecordSchema)),
  /** The last `days` local days (default 7, held to 1..30). */
  metrics: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/turns/metrics" })
    .input(z.object({ query: z.object({ days: DigitsQuery.optional() }) }))
    .output(TurnMetricsSchema),
};
