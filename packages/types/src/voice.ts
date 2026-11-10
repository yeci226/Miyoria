import type { TurnId } from "./ids.js";
import type { AccountRef, Author, ContextKey } from "./platform.js";
import { serviceKey } from "./service-key.js";
import type { Timestamp } from "./time.js";

/** Someone in a voice channel she is in. */
export interface VoiceParticipant {
  account: AccountRef;
  display_name: string;
  /** One of her own accounts. */
  is_self: boolean;
  muted: boolean;
  deafened: boolean;
}

/** One finished, transcribed utterance of one speaker. */
export interface VoiceUtterance {
  id: string;
  /** Kind `voice`; `scope` = guild, `channel` = voice channel. */
  context: ContextKey;
  speaker: Author;
  text: string;
  language: string | null;
  /** Emotion tag from the ASR model, if it reports one (e.g. SenseVoice). */
  emotion: string | null;
  /** Non-speech events detected in the audio (laughter, applause, ...). */
  audio_events: string[];
  started_at: Timestamp;
  ended_at: Timestamp;
  /** Time from end of speech to transcript, in ms. */
  asr_ms: number;
  /** How the turn was judged over, when a model judges it (`turn_engine = "smart-turn"`). */
  turn?: VoiceTurnEnd;
}

/** How a speaker's turn ended. */
export interface VoiceTurnEnd {
  /** `turn`: the model says they are done; `timeout`: the longest silence; else silence or cap. */
  ended_by: string;
  /** The model's last answer; `null` when it did not give one. */
  probability: number | null;
}

/** Her own speech playback. `interrupted`: stopped early, e.g. someone talked over her. */
export type PlaybackState = "started" | "finished" | "interrupted" | "failed";

export type SpeakOutcome = "completed" | "interrupted";

/**
 * Provided by the voice module. The scheduler executes `speak` actions through it; the call
 * resolves once playback finished or was interrupted.
 */
export interface VoiceSink {
  /**
   * The language she is heard in when it differs from the one she writes (`tts_translate`);
   * `null` or absent when she speaks what she writes. A reply can then carry the spoken words
   * itself (`prepare`'s `spoken`), which saves the translation.
   */
  readonly speaksIn?: string | null;
  /**
   * Hint that `text` will be spoken in `context` soon (it was just queued), so slow preparation
   * such as translating it can start before its turn. `spoken`: the words to say for it in
   * `speaksIn`, when the reply already has them. Optional; never required before `speak`.
   */
  prepare?(context: ContextKey, text: string, spoken?: string, emotion?: string | null): void;
  speak(
    context: ContextKey,
    text: string,
    emotion: string | null,
    turn: TurnId | null,
    signal?: AbortSignal,
  ): Promise<SpeakOutcome>;
  /** The emergency stop: what plays stops now and nothing prepared stays. Optional. */
  silence?(): void;
}

export const VoiceSinkKey = serviceKey<VoiceSink>("VoiceSink");

/** One chunk of a sound she plays that is not her speech (`VoicePlayer`). */
export interface PlayChunk {
  /** PCM s16 mono at the playback's sample rate. */
  samples: Int16Array;
  /**
   * Same length as `samples`: what the avatar's mouth follows instead of the sound itself (the
   * vocal stem of a song, so drums do not move her lips). Only used when the playback was
   * started with `levels`.
   */
  levels?: Int16Array;
}

/** A playback started with `VoicePlayer.play`. */
export interface PlayHandle {
  /** `null` until the node reports that it is audible. */
  state(): PlaybackState | null;
  /** Resolves once it finished, was stopped or failed. */
  wait(): Promise<PlaybackState>;
  /** Fades out over `fadeMs` (0 = cut). */
  stop(fadeMs: number): void;
}

/**
 * Plays audio that is not her speech (songs) in the voice channel she is in. Provided by the
 * `voice.link` module. Unlike `VoiceSink.speak` there is no TTS, no barge-in and no subtitles: the
 * caller owns the playback and stops it. The voice node buffers about a minute, so the caller
 * paces `audio` close to real time.
 */
export interface VoicePlayer {
  /** The voice channel she is in, in `guild`. */
  channel(guild: string): string | null;
  play(
    guild: string,
    sampleRate: number,
    audio: AsyncIterable<PlayChunk>,
    options?: { levels?: boolean },
  ): Promise<PlayHandle>;
}

export const VoicePlayerKey = serviceKey<VoicePlayer>("VoicePlayer");

/**
 * Something other than her speech holds the voice channel of a guild, e.g. a song she is
 * singing. Her speech there is dropped meanwhile (it would wait behind the song in the node's
 * queue and come out minutes late). Provided by the module that plays it (`sing`).
 */
export interface VoiceFloor {
  /** What holds `guild`'s voice channel (`"song"`), or `null` when her speech may play. */
  holder(guild: string): string | null;
  /** Songs still to sing in `guild` (preparing, ready or playing). */
  pending?(guild: string): number;
  /** Those songs, with the numbers `sing.play` takes. */
  setlist?(guild: string): SetlistLine[];
}

/** One song on her set list. `label` names it (someone else's text: data, not instructions). */
export interface SetlistLine {
  no: number;
  label: string;
  /** She can sing it now. */
  ready: boolean;
}

export const VoiceFloorKey = serviceKey<VoiceFloor>("VoiceFloor");

/**
 * Her speech is off for a while because something else has the GPU (the song worker converts a
 * song, and the TTS / ASR workers dropped their models for it). Meanwhile the voice module does
 * not send her lines to TTS nor utterances to ASR, and failures that say `offloaded` are
 * expected. Provided by `sing`; changes are published as `SPEECH_PAUSE_TOPIC`
 * (`{paused, reason}`).
 */
export interface SpeechPause {
  /** Why speech is off now (`"song"`), or `null`. */
  paused(): string | null;
}

export const SpeechPauseKey = serviceKey<SpeechPause>("SpeechPause");

/** Topic of `{paused: boolean, reason: string | null}` custom events. */
export const SPEECH_PAUSE_TOPIC = "speech.pause";

/**
 * Topic of `{context, turn}` custom events: a line of hers was sent to TTS. Its `voice_playback`
 * `started` (first audio playing) or `failed` follows.
 */
export const SPEECH_SYNTH_TOPIC = "voice.synthesis";

/**
 * Topic of `{context, turn, text, emotion}` custom events: a line of hers is about to play, about
 * `subtitle_lead_ms` from now (`[modules.voice]`). Its subtitle goes up now, so that where the
 * picture runs late (Go Live) it still arrives with her voice. Its `voice_playback` `started`
 * follows, or nothing if it is dropped first (a barge-in).
 */
export const VOICE_UPCOMING_TOPIC = "voice.upcoming";
