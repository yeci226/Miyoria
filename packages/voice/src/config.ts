// `[modules.voice]` config and the profile's `voice.toml`.

import { type JsonObject, voiceClips } from "@miyoria/types";
import { z } from "zod";
import { DEFAULT_SEGMENTER, type SegmenterConfig, type TurnTiming } from "./segment.js";

/**
 * What happens when someone talks over her: `selective` (default: the turn's focus person, her
 * name or substantive content for her stops her; anybody else only ducks her volume), `stop`
 * (anybody talking long enough stops her, the pre-v2 behaviour) or `ignore`.
 */
export const BargeInModeSchema = z.enum(["selective", "stop", "ignore"]);
export type BargeInMode = z.output<typeof BargeInModeSchema>;

/** `[modules.voice]` config section. */
export const VoiceConfigSchema = z.object({
  /** `opt-out` (default): listen unless a user opted out. `opt-in`: only users who opted in. */
  consent: z.enum(["opt-out", "opt-in"]).default("opt-out"),
  /** Low energy for this long ends an utterance. Default 600. */
  end_silence_ms: z.number().int().nonnegative().default(600),
  /** Utterances are cut at this length. Default 15 000. */
  max_utterance_ms: z.number().int().nonnegative().default(15_000),
  /** Shorter utterances are dropped. Default 300. */
  min_utterance_ms: z.number().int().nonnegative().default(300),
  /** Utterances with less voiced audio are dropped. Default 200. */
  min_voiced_ms: z.number().int().nonnegative().default(200),
  /** Convert transcripts to Traditional Chinese (Taiwan). Default true. */
  to_traditional: z.boolean().default(true),
  /** Concurrent ASR requests across speakers. Default 2. */
  asr_concurrency: z.number().int().nonnegative().default(2),
  /** ASR language hint (`zh`, ...). Default auto-detect. */
  asr_language: z.string().nullable().default(null),
  /** Vocabulary hint for ASR (her name, nicknames, game terms). */
  asr_prompt: z.string().nullable().default(null),
  /**
   * What ASR hears → what was said, applied to every transcript before anything reads it (`咪o` →
   * `Miyo`): a model that ignores hints can still call her by name. Empty by default.
   */
  asr_aliases: z.record(z.string(), z.string()).default({}),
  /**
   * Keep sending utterances to ASR while a song has the GPU. For an `asr_chain` with a provider
   * that stays up then (a CPU worker); with none every utterance fails at once. Replies made
   * meanwhile wait for her voice (`speech_hold_max_ms`), hence off by default.
   */
  asr_while_paused: z.boolean().default(false),
  /** Append the display names of people in the channel to the ASR prompt. Default false. */
  asr_prompt_participants: z.boolean().default(false),
  /** Extra hallucination phrases to drop (substring match). */
  hallucinations: z.array(z.string()).default([]),
  /** Barge-in behaviour. Default `selective`. */
  barge_in: BargeInModeSchema.default("selective"),
  /**
   * The turn's focus person must talk this long over her before she pauses (`stop` mode: before
   * anybody stops her). Default 600.
   */
  barge_in_ms: z.number().int().nonnegative().default(600),
  /** Fade-out when stopping for barge-in. Default 150. */
  barge_in_fade_ms: z.number().int().nonnegative().default(150),
  /** Somebody else talking this long ducks her volume (`selective`). Default 250. */
  barge_in_duck_ms: z.number().int().nonnegative().default(250),
  /** Her volume while ducked, 0..1. Default 0.3. */
  barge_in_duck_gain: z.number().min(0).max(1).default(0.3),
  /** The focus person who talks this long stops her without waiting for ASR. Default 3000. */
  barge_in_focus_stop_ms: z.number().int().nonnegative().default(3_000),
  /**
   * Words that mean somebody is calling her (her name and nicknames): a transcript with one
   * stops her whoever says it. The profile's names are added by the module when it knows them.
   */
  names: z.array(z.string()).default([]),
  /**
   * While a song plays, only utterances that call her by name count as speech (the song, and
   * people singing along, are not turns). Default true.
   */
  music_gate: z.boolean().default(true),
  /** A transcript that repeats her own words this long after she spoke is an echo. Default 5000. */
  self_echo_tail_ms: z.number().int().nonnegative().default(5_000),
  /**
   * Voice activity detector: `energy` (default) or `silero` (runs in the end-of-turn worker at
   * `turn_url`; the energy detector takes over whenever the worker cannot answer).
   */
  vad_engine: z.enum(["energy", "silero"]).default("energy"),
  /** Model path for an engine of your own registered with `registerVadEngine`. */
  vad_silero_model: z.string().nullable().default(null),
  /** Silero speech probability above which a frame is speech. Default 0.5. */
  vad_silero_threshold: z.number().min(0).max(1).default(0.5),
  /**
   * What ends a turn: `silence` (default): `end_silence_ms` of quiet, or the voice node closing the
   * stream; `smart-turn`: the model in the end-of-turn worker judges the speaker's audio after
   * `turn_stop_ms`, with `turn_max_silence_ms` as the timeout. Without an answer in
   * `turn_timeout_ms` that utterance falls back to `end_silence_ms`.
   */
  turn_engine: z.enum(["silence", "smart-turn"]).default("silence"),
  /** The end-of-turn worker (workers/turn). */
  turn_url: z.string().default("http://127.0.0.1:8006"),
  /** Silence before the model is asked. Default 200. */
  turn_stop_ms: z.number().int().positive().default(200),
  /** The model has this long to answer. Default 150. */
  turn_timeout_ms: z.number().int().positive().default(150),
  /** Silence that ends a turn whatever the model said. Default 1500. */
  turn_max_silence_ms: z.number().int().positive().default(1_500),
  /**
   * Her reply starts synthesizing only once the people it answers stayed quiet this long after
   * their turn closed (the LLM runs meanwhile). Default 400.
   */
  turn_confirm_ms: z.number().int().nonnegative().default(400),
  /** Her reply waits for that at most this long. Default 2000. */
  turn_gate_max_ms: z.number().int().nonnegative().default(2_000),
  /**
   * While the model says the speaker is not done, transcribe what they said so far: when they
   * really were done, the transcript is ready at the timeout. Costs an ASR run per pause.
   */
  turn_early_asr: z.boolean().default(false),
  /**
   * Keep what is needed to compare ASR models and calibrate Smart Turn: WAV clips of the people
   * who consented, in this folder. Members' voices on disk: off by default, the owner's decision.
   */
  clip_dir: z.string().nullable().default(null),
  /**
   * Lines synthesized ahead while the previous one plays (TTS runs concurrently on at most this
   * many lines). 0 turns the prefetch off. Default 2.
   */
  tts_prefetch: z.number().int().nonnegative().default(2),
  /** A prefetched line nobody asked for is dropped after this long. Default 30 000. */
  tts_prefetch_ttl_ms: z.number().int().nonnegative().default(30_000),
  /**
   * Her line waits this long while a song or the GPU loan holds the floor, then it is dropped
   * (it would be stale by then). Default 90 000.
   */
  speech_hold_max_ms: z.number().int().nonnegative().default(90_000),
  /**
   * Each line's subtitle goes up this long before the line plays (`voice.upcoming`), so it lands
   * with her voice where the picture runs late: Go Live measured 0.58 s behind on 2026-11-09. The
   * first line of a reply is announced from the learned TTS wait, later ones this long before the
   * line before them ends. 0: subtitles start with the audio. Default 600.
   */
  subtitle_lead_ms: z.number().int().nonnegative().max(5_000).default(600),
  /** Language hint sent to TTS. Default `Chinese`. */
  tts_language: z.string().default("Chinese"),
  /**
   * Speak in this language (e.g. `Japanese`): every line is translated by the LLM right before
   * TTS and sent to TTS with this language; subtitles, the chat log and memory keep the original.
   * Default null (speak what she wrote).
   */
  tts_translate: z.string().nullable().default(null),
  /** LLM purpose used for `tts_translate`. Default `fast`. */
  tts_translate_purpose: z.string().default("fast"),
  /**
   * Where the broadcast encoder (OBS) pushes for Discord Go Live. The voice node's ffmpeg is the
   * RTMP server (`-listen 1`) unless the URL asks otherwise. Default matches the documented OBS
   * setup (server `rtmp://127.0.0.1:1935/live`, key `miyoria`).
   */
  golive_source: z.string().default("rtmp://127.0.0.1:1935/live/miyoria"),
  /**
   * The node's ffmpeg is the server OBS pushes to (`-listen 1` for RTMP, `mode=listener` for SRT
   * without `mode=`). False: another server (MediaMTX, `workers/mediamtx/`) takes OBS's stream
   * and ffmpeg pulls the source from it. Applies to every Go Live source. Default true.
   */
  golive_listen: z.boolean().default(true),
  /**
   * 墊話 (v4 §7.5): when she was addressed and nothing of hers is heard `filler_after_ms` after her
   * turn started, one short sound of hers plays so the silence has an owner. Never over her own
   * speech, for a turn she passes on, or once her first sentence is written; never the same twice
   * in a row; not a line (not in her history or the Floor's budget). Default true.
   */
  filler: z.boolean().default(true),
  /**
   * How long after her turn started the silence gets a filler. Default 600: the model's first
   * sentence alone took longer than that on most turns measured 2026-11-07 to 11-10.
   */
  filler_after_ms: z.number().int().nonnegative().default(600),
  /**
   * The filler sounds by the language she is heard in (`tts_translate`, else `tts_language`); a
   * language without a list gets none. Short and neutral: each must fit before any answer (a
   * laugh does not fit before a refusal). Synthesized once per voice and cached in `filler_dir`.
   */
  filler_lines: z.record(z.string(), z.array(z.string().min(1))).default({
    Chinese: ["嗯?", "欸~", "蛤?", "等等"],
    Japanese: ["ん?", "え~", "え?", "えっと"],
  }),
  /** Cache of the synthesized fillers (one folder per voice). Default `data/voice/fillers`. */
  filler_dir: z.string().default("data/voice/fillers"),
  /** A synthesized filler longer than this is not used. Default 1500. */
  filler_max_ms: z.number().int().positive().default(1_500),
});
export type VoiceConfig = z.output<typeof VoiceConfigSchema>;

/** The filler lines for the language she is heard in (`[]`: none). */
export function fillerLines(config: VoiceConfig, language: string): readonly string[] {
  const want = language.trim().toLowerCase();
  for (const [name, lines] of Object.entries(config.filler_lines)) {
    if (name.trim().toLowerCase() === want) return lines;
  }
  return [];
}

/** Smart Turn takes this much of the end of a turn. */
const TURN_AUDIO_MS = 8_000;

/** The model's timing, `null` when the silence alone ends a turn. */
export function turnTiming(config: VoiceConfig): TurnTiming | null {
  if (config.turn_engine !== "smart-turn") return null;
  return {
    stopMs: config.turn_stop_ms,
    maxSilenceMs: Math.max(config.turn_max_silence_ms, config.turn_stop_ms),
    audioMs: TURN_AUDIO_MS,
  };
}

/** Segmenter settings from the config (sample rate left at the default). */
export function segmenterConfig(config: VoiceConfig): SegmenterConfig {
  return {
    ...DEFAULT_SEGMENTER,
    turn: turnTiming(config),
    endSilenceMs: Math.max(20, config.end_silence_ms),
    maxUtteranceMs: Math.max(500, config.max_utterance_ms),
    minUtteranceMs: config.min_utterance_ms,
    minVoicedMs: config.min_voiced_ms,
  };
}

const RawProfileSchema = z.object({
  provider: z.string().nullable().optional(),
  voice: z.string().nullable().optional(),
  clone: z.record(z.string(), z.unknown()).nullable().optional(),
  emotion: z.object({ instruct: z.record(z.string(), z.string()).default({}) }).prefault({}),
  design: z
    .object({ bank: z.record(z.string(), z.record(z.string(), z.unknown())).default({}) })
    .prefault({}),
});

export class VoiceProfileError extends Error {
  override name = "VoiceProfileError";
}

/** The parts of a profile's `voice.toml` this module uses. */
export class VoiceProfile {
  /**
   * Preferred TTS provider kind (informational; the speech fallback chain decides which
   * provider runs).
   */
  readonly provider: string | null;
  /** Voice name registered with the TTS worker. Defaults to the profile id. */
  readonly voice: string;
  /** The profile has a cloned voice (`[clone]`). */
  readonly cloned: boolean;
  /** `[emotion.instruct]`: emotion → style instruction (keys lower-case, ascending). */
  readonly instruct: ReadonlyMap<string, string>;
  /** `[design.bank.<language>]`: the clips of her emotion voice bank, in any language. */
  readonly clips: ReadonlySet<string>;

  constructor(init: {
    provider: string | null;
    voice: string;
    cloned: boolean;
    instruct: ReadonlyMap<string, string>;
    clips?: ReadonlySet<string>;
  }) {
    this.provider = init.provider;
    this.voice = init.voice;
    this.cloned = init.cloned;
    this.instruct = init.instruct;
    this.clips = init.clips ?? new Set();
  }

  /** Parses `voice.toml` (`null` when the profile has none). */
  static parse(profileId: string, table: JsonObject | null): VoiceProfile {
    const result = RawProfileSchema.safeParse(table ?? {});
    if (!result.success) {
      throw new VoiceProfileError(`invalid voice.toml: ${z.prettifyError(result.error)}`, {
        cause: result.error,
      });
    }
    const raw = result.data;
    const voice = raw.voice?.trim() || profileId;
    const instruct = Object.entries(raw.emotion.instruct)
      .map(([k, v]): [string, string] => [k.toLowerCase(), v.trim()])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return new VoiceProfile({
      provider: raw.provider ?? null,
      voice,
      cloned: raw.clone !== undefined && raw.clone !== null,
      instruct: new Map(instruct),
      clips: new Set(
        Object.values(raw.design.bank).flatMap((lines) =>
          Object.keys(lines).map((k) => k.toLowerCase()),
        ),
      ),
    });
  }

  /**
   * What to tell the TTS worker a line sounds like: the first clip her bank has of the ones that
   * fit `emotion` (`voiceClips`). A profile that lists no bank leaves it to the worker. Whatever
   * the worker does not have falls through its own chain (`neutral`, then the plain reference),
   * and with `TTS_VOICE_BANK` off this picks nothing.
   */
  referenceFor(emotion: string | null): string | null {
    if (emotion === null) return null;
    const name = emotion.trim().toLowerCase();
    if (name === "") return null;
    const fitting = voiceClips(name);
    return fitting.find((clip) => this.clips.has(clip)) ?? fitting[0] ?? name;
  }

  /** Style instruction for `emotion`, if the profile defines one. */
  instructFor(emotion: string | null): string | null {
    if (emotion === null) return null;
    const s = this.instruct.get(emotion.trim().toLowerCase());
    return s ? s : null;
  }
}
