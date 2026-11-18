// Voice rooms and her speech (docs/design/v5-contracts.md §3, K12a): she joined or left a voice
// room, who is in it and who is talking, her Go Live state, what happened to her speech when
// somebody talked over her, her lines on their way to being heard, the speech pause while a song
// holds the GPU, and the latency measurements of the voice path. Each type is the bus topic it is
// published on, and its payload is that event's data. What people say (`voice.utterance`) and what
// she says (`voice.playback`) are chat lines (`chat.ts`).
//
// Tiers (v5-data §2.5): who is in a room and who is speaking are ambient observations; joining,
// leaving, Go Live and the rest of her speech's way are turn internals, 90 days. Latency
// measurements are metrics for the owner (`owner`). Events of a room have no default scope (the
// session decides); a Go Live state is the guild's (`space`); the speech pause is her own (`self`).

import { z } from "zod";
import {
  AccountRefSchema,
  ContextKeySchema,
  PlatformIdSchema,
  TurnIdSchema,
  VoiceParticipantSchema,
} from "../../wire/src/index.js";
import { defineEvent } from "./registry.js";

/** She joined a voice room: `voice.joined`. */
export const VoiceJoinedSchema = z
  .object({ context: ContextKeySchema, participants: z.array(VoiceParticipantSchema) })
  .meta({ id: "EventsVoiceJoined" });
export type VoiceJoinedData = z.output<typeof VoiceJoinedSchema>;

/** She left a voice room: `voice.left`. */
export const VoiceLeftSchema = z
  .object({ context: ContextKeySchema, reason: z.string().nullable() })
  .meta({ id: "EventsVoiceLeft" });
export type VoiceLeftData = z.output<typeof VoiceLeftSchema>;

/** Who is in the voice room changed: `voice.participants`. */
export const VoiceParticipantsSchema = z
  .object({ context: ContextKeySchema, participants: z.array(VoiceParticipantSchema) })
  .meta({ id: "EventsVoiceParticipants" });
export type VoiceParticipantsData = z.output<typeof VoiceParticipantsSchema>;

/** Someone started or stopped speaking, before ASR: `voice.speaking`. */
export const VoiceSpeakingSchema = z
  .object({ context: ContextKeySchema, account: AccountRefSchema, speaking: z.boolean() })
  .meta({ id: "EventsVoiceSpeaking" });
export type VoiceSpeakingData = z.output<typeof VoiceSpeakingSchema>;

/**
 * Go Live as the voice node reports it: `starting` (waiting for the source, connecting), `live`
 * (frames are being sent), `stopped`, `failed` (see `error`).
 */
export const GoLiveStateSchema = z
  .enum(["starting", "live", "stopped", "failed"])
  .meta({ id: "EventsGoLiveState" });

/** Her Go Live state in a guild changed: `voice.golive`. */
export const VoiceGoLiveSchema = z
  .object({
    platform: PlatformIdSchema,
    guild: z.string(),
    state: GoLiveStateSchema,
    /** Why it failed (`failed`). */
    error: z.string().nullable(),
    /** Why it ended (`stopped`), e.g. "source ended". */
    reason: z.string().nullable(),
  })
  .meta({ id: "EventsVoiceGoLive" });
export type VoiceGoLiveData = z.output<typeof VoiceGoLiveSchema>;

/**
 * Her watching of somebody's Go Live stream, as the voice node reports it: `starting`
 * (connecting to the stream), `live` (pictures are arriving), `stopped`, `failed` (see `error`).
 */
export const WatchStateSchema = z
  .enum(["starting", "live", "stopped", "failed"])
  .meta({ id: "EventsWatchState" });

/** Her watching of `user_id`'s stream in a guild changed: `voice.watch`. */
export const VoiceWatchSchema = z
  .object({
    platform: PlatformIdSchema,
    guild: z.string(),
    /** Whose stream. */
    user_id: z.string(),
    state: WatchStateSchema,
    /** Why it failed (`failed`). */
    error: z.string().nullable(),
    /** Why it ended (`stopped`), e.g. "stream ended". */
    reason: z.string().nullable(),
  })
  .meta({ id: "EventsVoiceWatch" });
export type VoiceWatchData = z.output<typeof VoiceWatchSchema>;

/**
 * What an interruption did to her speech: `duck` (volume down), `pause` (the rest of her line
 * waits), `resume`, `stop` (the rest of the turn's speech is dropped).
 */
export const VoiceBargeInActionSchema = z
  .enum(["duck", "pause", "resume", "stop"])
  .meta({ id: "EventsVoiceBargeInAction" });

/**
 * Why: `focus` (the turn's focus person talks), `name` (somebody said her name), `substantive`,
 * `other`, `no_focus`, `short_reply`, `echo`, `music`, `timeout`, `legacy` (anyone stops her),
 * `floor` (a song or the GPU held the floor too long).
 */
export const VoiceBargeInReasonSchema = z
  .enum([
    "focus",
    "name",
    "substantive",
    "other",
    "no_focus",
    "short_reply",
    "echo",
    "music",
    "timeout",
    "legacy",
    "floor",
  ])
  .meta({ id: "EventsVoiceBargeInReason" });

/** Somebody talked while she spoke, and what it did to her speech: `voice.barge_in`. */
export const VoiceBargeInSchema = z
  .object({
    context: ContextKeySchema,
    /** The turn whose speech was playing (`null` when unknown). */
    turn: TurnIdSchema.nullable(),
    /** Who talked (`null` when nobody did: `floor`, `timeout`). */
    account: AccountRefSchema.nullable(),
    action: VoiceBargeInActionSchema,
    reason: VoiceBargeInReasonSchema,
  })
  .meta({ id: "EventsVoiceBargeIn" });
export type VoiceBargeInData = z.output<typeof VoiceBargeInSchema>;

/** A line of hers is about to play; its subtitle goes up now: `voice.upcoming`. */
export const VoiceUpcomingSchema = z
  .object({
    context: ContextKeySchema,
    turn: TurnIdSchema.nullable(),
    text: z.string(),
    emotion: z.string().nullable(),
  })
  .meta({ id: "EventsVoiceUpcoming" });
export type VoiceUpcomingData = z.output<typeof VoiceUpcomingSchema>;

/** A line of hers was sent to TTS; its `voice.playback` follows: `voice.synthesis`. */
export const VoiceSynthesisSchema = z
  .object({ context: ContextKeySchema, turn: TurnIdSchema.nullable() })
  .meta({ id: "EventsVoiceSynthesis" });
export type VoiceSynthesisData = z.output<typeof VoiceSynthesisSchema>;

/** Her speech is off while something else has the GPU, or back on: `speech.pause`. */
export const SpeechPauseSchema = z
  .object({
    paused: z.boolean(),
    /** Why (`song`); `null` when speech is back on. */
    reason: z.string().nullable(),
  })
  .meta({ id: "EventsSpeechPause" });
export type SpeechPauseData = z.output<typeof SpeechPauseSchema>;

// ---- voice.latency ------------------------------------------------------------------------------

/** How a speaker's turn ended, as the turn model judged it. */
export const LatencyTurnEndSchema = z
  .object({ ended_by: z.string(), probability: z.number().nullable() })
  .meta({ id: "EventsLatencyTurnEnd" });

/** Why an `e2e` measurement is incomplete. */
export const E2eReasonSchema = z
  .enum([
    "barge_in",
    "interrupted",
    "cancelled",
    "floor",
    "tts_failed",
    "playback_failed",
    "speech_end_unknown",
    "expired",
  ])
  .meta({ id: "EventsE2eReason" });

/** The seven segments of `speech_end → first_audio_played` (ms; `null`: a boundary is unknown). */
export const E2eSegmentsSchema = z
  .object({
    endpoint: z.number().nullable(),
    asr: z.number().nullable(),
    prepare: z.number().nullable(),
    llm_first: z.number().nullable(),
    tts_queue: z.number().nullable(),
    tts_first: z.number().nullable(),
    playback: z.number().nullable(),
  })
  .meta({ id: "EventsE2eSegments" });

/** The agent's segments split by its marks (ms, `null` where a mark is missing). */
export const E2ePartsSchema = z
  .object({
    prepare: z.object({
      wait: z.number().nullable(),
      decide: z.number().nullable(),
      context: z.number().nullable(),
      prompt: z.number().nullable(),
    }),
    llm_first: z.object({
      first_token: z.number().nullable(),
      held: z.number().nullable(),
      first_sentence: z.number().nullable(),
    }),
  })
  .meta({ id: "EventsE2eParts" });

/**
 * One `voice.latency` measurement, by `stage`:
 * - `asr`: an utterance transcribed (the voice module);
 * - `turn`: the turn model's verdict on a pause, `turn_resumed`: they went on after a judged end;
 * - `llm`: the first token of her first reply in a voice turn (the agent);
 * - `speculation`: what a turn started early came to (the agent);
 * - `tts`: the first audio of one of her lines;
 * - `filler`: a short sound of hers filled the silence;
 * - `e2e`: speech end to her first audio, split into segments, once per reply to human speech.
 */
export const VoiceLatencySchema = z
  .discriminatedUnion("stage", [
    z.object({
      stage: z.literal("asr"),
      context: ContextKeySchema,
      speaker: AccountRefSchema,
      provider: z.string(),
      audio_ms: z.number(),
      transcribe_ms: z.number(),
      asr_ms: z.number(),
    }),
    z.object({
      stage: z.literal("turn"),
      context: ContextKeySchema,
      verdict: z.enum(["complete", "incomplete", "unknown"]),
      probability: z.number().nullable(),
      judge_ms: z.number(),
    }),
    z.object({
      stage: z.literal("turn_resumed"),
      context: ContextKeySchema,
      /** From the judged end to the speech going on. */
      after_ms: z.number(),
      /** The judged end, clock ms. */
      at: z.number(),
      probability: z.number().nullable(),
    }),
    z.object({
      stage: z.literal("llm"),
      context: ContextKeySchema,
      turn: TurnIdSchema,
      model: z.string(),
      first_token_ms: z.number(),
    }),
    z.object({
      stage: z.literal("speculation"),
      context: ContextKeySchema,
      turn: TurnIdSchema,
      result: z.enum(["confirmed", "dropped"]),
      /** From the early start to this. */
      ms: z.number(),
      /** It asked the model. */
      model: z.boolean(),
    }),
    z.object({
      stage: z.literal("tts"),
      context: ContextKeySchema,
      turn: TurnIdSchema.nullable(),
      provider: z.string().nullable(),
      chars: z.number(),
      first_audio_ms: z.number(),
      prefetched: z.boolean(),
    }),
    z.object({
      stage: z.literal("filler"),
      context: ContextKeySchema,
      turn: TurnIdSchema.nullable(),
      text: z.string(),
      ms: z.number(),
    }),
    z.object({
      stage: z.literal("e2e"),
      context: ContextKeySchema,
      turn: TurnIdSchema.nullable(),
      /** The `voice.utterance` id the reply answers. */
      utterance: z.string(),
      complete: z.boolean(),
      reason: E2eReasonSchema.nullable(),
      /** `null` when incomplete. */
      total_ms: z.number().nullable(),
      segments: E2eSegmentsSchema,
      unattributed_ms: z.number().nullable(),
      /** The first line came from a TTS prefetch. */
      prefetched: z.boolean(),
      provider: z.string().nullable(),
      turn_end: LatencyTurnEndSchema.optional(),
      parts: E2ePartsSchema.optional(),
      /** The turn started before the wait after the utterance was over (with `parts`). */
      speculative: z.boolean().optional(),
      /** Speech end to a filler sound of hers (absent when none played). */
      filler_ms: z.number().optional(),
    }),
  ])
  .meta({ id: "EventsVoiceLatency" });
export type VoiceLatencyData = z.output<typeof VoiceLatencySchema>;

export const VoiceJoined = defineEvent({
  type: "voice.joined",
  v: 1,
  data: VoiceJoinedSchema,
  tier: "short",
});

export const VoiceLeft = defineEvent({ type: "voice.left", v: 1, data: VoiceLeftSchema });

export const VoiceParticipants = defineEvent({
  type: "voice.participants",
  v: 1,
  data: VoiceParticipantsSchema,
  tier: "ambient",
});

export const VoiceSpeaking = defineEvent({
  type: "voice.speaking",
  v: 1,
  data: VoiceSpeakingSchema,
  tier: "ambient",
});

export const VoiceGoLive = defineEvent({
  type: "voice.golive",
  v: 1,
  data: VoiceGoLiveSchema,
  scope: "space",
  tier: "short",
});

export const VoiceWatch = defineEvent({
  type: "voice.watch",
  v: 1,
  data: VoiceWatchSchema,
  scope: "space",
  tier: "short",
});

export const VoiceBargeIn = defineEvent({
  type: "voice.barge_in",
  v: 1,
  data: VoiceBargeInSchema,
  tier: "short",
});

/** Her line itself is recorded by `voice.playback`; this is its way there. */
export const VoiceUpcoming = defineEvent({
  type: "voice.upcoming",
  v: 1,
  data: VoiceUpcomingSchema,
  tier: "short",
});

export const VoiceSynthesis = defineEvent({
  type: "voice.synthesis",
  v: 1,
  data: VoiceSynthesisSchema,
  tier: "short",
});

export const SpeechPause = defineEvent({
  type: "speech.pause",
  v: 1,
  data: SpeechPauseSchema,
  scope: "self",
  tier: "short",
});

/** Metrics, like LLM call metadata: the owner's. */
export const VoiceLatency = defineEvent({
  type: "voice.latency",
  v: 1,
  data: VoiceLatencySchema,
  scope: "owner",
  tier: "short",
});

/** Every voice type besides the chat lines. */
export const VOICE_EVENTS = [
  VoiceJoined,
  VoiceLeft,
  VoiceParticipants,
  VoiceSpeaking,
  VoiceGoLive,
  VoiceWatch,
  VoiceBargeIn,
  VoiceUpcoming,
  VoiceSynthesis,
  SpeechPause,
  VoiceLatency,
] as const;
