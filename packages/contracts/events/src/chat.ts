// The raw record of conversation (docs/design/v5-data.md §2.7, decision D2): what people say in
// text and voice, and what she says and sends, one event per line. Each type keeps the dotted bus
// topic the line arrives on today, and its payload is that bus event's data, so a line reads back
// as the platform delivered it:
//
// - `platform.message.created`: a text message, people's and hers (the platform echoes what she
//   sends). `self` marks hers;
// - `voice.utterance`: one transcribed utterance of someone in a voice room;
// - `voice.playback`: a sentence of hers starting to play in a voice room.
//
// Kept 365 days (`long`): later layers are derived from them again. No default scope: the session
// decides (`room` in a guild, `dm` in a DM). Place, person and account are on the envelope,
// resolved through identity when the line is stored.

import { z } from "zod";
import {
  AuthorSchema,
  ContextKeySchema,
  IncomingMessageSchema,
  PlaybackStateSchema,
  TurnIdSchema,
  VoiceUtteranceSchema,
} from "../../wire/src/index.js";
import { defineEvent } from "./registry.js";

/** A text message as the platform delivered it, and whose it is. */
export const PlatformMessageSchema = IncomingMessageSchema.extend({
  /** Written by one of her own accounts (her echoed message). Missing: someone else's. */
  self: z.boolean().optional(),
}).meta({ id: "EventsPlatformMessage" });
export type PlatformMessage = z.output<typeof PlatformMessageSchema>;

/** A sentence of hers in a voice room: the `voice.playback` bus event's data. */
export const VoicePlaybackSchema = z
  .object({
    context: ContextKeySchema,
    turn: TurnIdSchema.nullable(),
    state: PlaybackStateSchema,
    text: z.string(),
    /**
     * What was sent to TTS when it is not `text`: its translation (`tts_translate`). On `started`
     * only; missing when she said the text as it is written.
     */
    said: z.string().optional(),
    /** Emotion the sentence is spoken with (`null`: none). */
    emotion: z.string().nullable().optional(),
    /** How much of it was audible, in ms (`interrupted`, `finished`). */
    heard_ms: z.number().nullable().optional(),
    /** How long all of it is, in ms; `null`: it was still being synthesized. */
    total_ms: z.number().nullable().optional(),
    /** Moderation replaced what she meant (the rule). */
    blocked: z.string().nullable().optional(),
    /**
     * Her account in that room and the name it goes by, as the recorder knew it (the bus event
     * names no speaker). Missing when it was not known.
     */
    speaker: AuthorSchema.optional(),
  })
  .meta({ id: "EventsVoicePlayback" });
export type VoicePlayback = z.output<typeof VoicePlaybackSchema>;

/** A text message, people's or hers. */
export const PlatformMessageCreated = defineEvent({
  type: "platform.message.created",
  v: 1,
  data: PlatformMessageSchema,
  tier: "long",
});

/** What someone said in a voice room, transcribed. */
export const VoiceUtteranceEvent = defineEvent({
  type: "voice.utterance",
  v: 1,
  data: VoiceUtteranceSchema,
  tier: "long",
});

/** What she said in a voice room (recorded when it starts playing). */
export const VoicePlaybackEvent = defineEvent({
  type: "voice.playback",
  v: 1,
  data: VoicePlaybackSchema,
  tier: "long",
});

/** Every chat line type, the raw record of conversation. */
export const CHAT_EVENTS = [
  PlatformMessageCreated,
  VoiceUtteranceEvent,
  VoicePlaybackEvent,
] as const;

/** The type names of `CHAT_EVENTS`. */
export const CHAT_EVENT_TYPES: readonly string[] = CHAT_EVENTS.map((d) => d.type);
