import { z } from "zod";
import { TimestampSchema } from "./ids.js";
import { AccountRefSchema, AuthorSchema, ContextKeySchema } from "./platform.js";

/** Someone in a voice channel she is in. */
export const VoiceParticipantSchema = z
  .object({
    account: AccountRefSchema,
    display_name: z.string(),
    /** One of her own accounts. */
    is_self: z.boolean(),
    muted: z.boolean(),
    deafened: z.boolean(),
  })
  .meta({ id: "WireVoiceParticipant" });
export type VoiceParticipant = z.output<typeof VoiceParticipantSchema>;

/** How a speaker's turn ended. */
export const VoiceTurnEndSchema = z
  .object({
    /** `turn`: the model says they are done; `timeout`: the longest silence; else silence or cap. */
    ended_by: z.string(),
    /** The model's last answer; `null` when it did not give one. */
    probability: z.number().nullable(),
  })
  .meta({ id: "WireVoiceTurnEnd" });
export type VoiceTurnEnd = z.output<typeof VoiceTurnEndSchema>;

/** One finished, transcribed utterance of one speaker. */
export const VoiceUtteranceSchema = z
  .object({
    id: z.string(),
    /** Kind `voice`; `scope` = guild, `channel` = voice channel. */
    context: ContextKeySchema,
    speaker: AuthorSchema,
    text: z.string(),
    language: z.string().nullable(),
    /** Emotion tag from the ASR model, if it reports one (e.g. SenseVoice). */
    emotion: z.string().nullable(),
    /** Non-speech events detected in the audio (laughter, applause, ...). */
    audio_events: z.array(z.string()),
    started_at: TimestampSchema,
    ended_at: TimestampSchema,
    /** Time from end of speech to transcript, in ms. */
    asr_ms: z.number(),
    /** How the turn was judged over, when a model judges it (`turn_engine = "smart-turn"`). */
    turn: VoiceTurnEndSchema.optional(),
  })
  .meta({ id: "WireVoiceUtterance" });
export type VoiceUtterance = z.output<typeof VoiceUtteranceSchema>;

/** Her own speech playback. `interrupted`: stopped early, e.g. someone talked over her. */
export const PlaybackStateSchema = z
  .enum(["started", "finished", "interrupted", "failed"])
  .meta({ id: "WirePlaybackState" });
export type PlaybackState = z.output<typeof PlaybackStateSchema>;
