// Speech interface.
//
// * `AsrProvider` turns one utterance into text; `TtsProvider` turns text into a stream of PCM
//   chunks. Both are mono, 16-bit.
// * `SpeechService` holds a fallback chain of each, built from `[speech]` config through
//   registered `AsrFactory` / `TtsFactory`s, and is provided as a service by the `speech` module.
//
// Third-party models (Qwen3-ASR, SenseVoice, Qwen3-TTS, GPT-SoVITS, ...) usually run as separate
// worker processes; providers here are clients.

import {
  type Counter,
  errorMessage,
  getLogger,
  type MetricsRegistry,
  metrics,
} from "@miyoria/kernel";
import { type JsonValue, serviceKey } from "@miyoria/types";

const log = getLogger("speech");

/** Mono 16-bit PCM. */
export interface AudioBuf {
  sampleRate: number;
  samples: Int16Array;
}

/** Length of `audio` in whole milliseconds (0 when the rate is 0). */
export function durationMs(audio: AudioBuf): number {
  if (audio.sampleRate === 0) return 0;
  return Math.floor((audio.samples.length * 1000) / audio.sampleRate);
}

export interface AsrHint {
  /** Expected language (`zh`, `ja`, `en`, ...); `null` = auto-detect. */
  language: string | null;
  /** Vocabulary / context hint (names, game terms), if the model supports it. */
  prompt: string | null;
}

export const NO_HINT: Readonly<AsrHint> = Object.freeze({ language: null, prompt: null });

export interface Transcript {
  text: string;
  language: string | null;
  emotion: string | null;
  /** Non-speech events (laughter, applause, BGM, ...). */
  audio_events: string[];
}

export interface AsrProvider {
  /** Instance name from config, e.g. `"local"`. */
  readonly name: string;
  transcribe(audio: AudioBuf, hint: AsrHint, signal?: AbortSignal): Promise<Transcript>;
}

export interface TtsRequest {
  text: string;
  language: string | null;
  /** Emotion tag from the agent (`happy`, `annoyed`, ...). */
  emotion: string | null;
  /** Natural-language style instruction, if the model supports one. */
  instruct: string | null;
  /** Voice / speaker id understood by the provider (e.g. a cloned voice). */
  voice: string | null;
  /**
   * `now`: she says it next; `ahead`: synthesized in advance, it gives way to a `now` line on a
   * worker that queues requests. Left out means `now`.
   */
  priority?: TtsPriority;
}

export type TtsPriority = "now" | "ahead";

/** A `TtsRequest` with every optional field `null`. */
export function ttsRequest(
  text: string,
  fields: Partial<Omit<TtsRequest, "text">> = {},
): TtsRequest {
  return {
    text,
    language: fields.language ?? null,
    emotion: fields.emotion ?? null,
    instruct: fields.instruct ?? null,
    voice: fields.voice ?? null,
  };
}

/** A chunk of synthesized audio. Chunks of one stream share a sample rate. */
export type AudioChunk = AudioBuf;

/**
 * Synthesized audio as it is produced. Stop early with `break` (or `return()` on the
 * iterator); that releases the underlying connection. `queueMs`: what a worker reports having
 * waited for its GPU before it started on this request.
 */
export type AudioStream = AsyncIterable<AudioChunk> & { queueMs?: number };

export interface TtsProvider {
  readonly name: string;
  synthesize(request: TtsRequest, signal?: AbortSignal): Promise<AudioStream>;
}

/** `[speech.asr.<name>]` / `[speech.tts.<name>]` entry: `kind` plus free-form settings. */
export interface ProviderConfig {
  kind: string;
  settings: Record<string, JsonValue>;
}

export interface AsrFactory {
  readonly kinds: readonly string[];
  /** Throws on invalid settings. */
  build(name: string, config: ProviderConfig): AsrProvider;
}

export interface TtsFactory {
  readonly kinds: readonly string[];
  /** Throws on invalid settings. */
  build(name: string, config: ProviderConfig): TtsProvider;
}

export class SpeechError extends Error {
  override name = "SpeechError";
}

export interface SpeechServiceOptions {
  /** Where request counts go. Default: the process-wide `metrics`. */
  metrics?: MetricsRegistry;
}

/** `aborted` when the caller cancelled, else `error`. */
function failure(signal: AbortSignal | undefined): string {
  return signal?.aborted ? "aborted" : "error";
}

/**
 * Fallback chains of ASR and TTS providers. Every attempt is counted in
 * `miyoria_asr_requests_total` / `miyoria_tts_requests_total` by provider and outcome (`ok`,
 * `error`, `aborted`); a TTS attempt is `ok` once its stream started.
 */
export class SpeechService {
  readonly #asr: readonly AsrProvider[];
  readonly #tts: readonly TtsProvider[];
  readonly #asrRequests: Counter;
  readonly #ttsRequests: Counter;

  constructor(
    asr: readonly AsrProvider[],
    tts: readonly TtsProvider[],
    options: SpeechServiceOptions = {},
  ) {
    this.#asr = [...asr];
    this.#tts = [...tts];
    const registry = options.metrics ?? metrics;
    this.#asrRequests = registry.counter("miyoria_asr_requests_total", {
      help: "ASR requests by provider and outcome (ok, error, aborted).",
      labels: ["provider", "outcome"],
    });
    this.#ttsRequests = registry.counter("miyoria_tts_requests_total", {
      help: "TTS requests by provider and outcome (ok, error, aborted).",
      labels: ["provider", "outcome"],
    });
  }

  hasAsr(): boolean {
    return this.#asr.length > 0;
  }

  hasTts(): boolean {
    return this.#tts.length > 0;
  }

  /** Tries each ASR provider in order until one succeeds. Returns `[provider, transcript]`. */
  async transcribe(
    audio: AudioBuf,
    hint: AsrHint,
    signal?: AbortSignal,
  ): Promise<[string, Transcript]> {
    let last: unknown;
    for (const p of this.#asr) {
      try {
        const transcript = await p.transcribe(audio, hint, signal);
        this.#asrRequests.inc({ provider: p.name, outcome: "ok" });
        return [p.name, transcript];
      } catch (error) {
        this.#asrRequests.inc({ provider: p.name, outcome: failure(signal) });
        if (signal?.aborted) throw error;
        const err = errorMessage(error);
        // A worker that gave the GPU to the song worker says so; that is expected.
        if (isOffloaded(err)) log.debug({ provider: p.name, err }, "ASR failed, trying next");
        else log.warn({ provider: p.name, err }, "ASR failed, trying next");
        last = error;
      }
    }
    throw last ?? new SpeechError("no ASR provider configured");
  }

  /** Tries each TTS provider in order until one starts a stream. Returns `[provider, stream]`. */
  async synthesize(request: TtsRequest, signal?: AbortSignal): Promise<[string, AudioStream]> {
    let last: unknown;
    for (const p of this.#tts) {
      try {
        const stream = await p.synthesize({ ...request }, signal);
        this.#ttsRequests.inc({ provider: p.name, outcome: "ok" });
        return [p.name, stream];
      } catch (error) {
        this.#ttsRequests.inc({ provider: p.name, outcome: failure(signal) });
        if (signal?.aborted) throw error;
        const err = errorMessage(error);
        if (isOffloaded(err)) log.debug({ provider: p.name, err }, "TTS failed, trying next");
        else log.warn({ provider: p.name, err }, "TTS failed, trying next");
        last = error;
      }
    }
    throw last ?? new SpeechError("no TTS provider configured");
  }
}

export const SpeechServiceKey = serviceKey<SpeechService>("SpeechService");

/**
 * The worker answered 503 `offloaded`: it dropped its model while the song worker has the GPU
 * (`POST /offload`), so the failure is expected and comes back by itself.
 */
export function isOffloaded(message: string): boolean {
  return /\boffloaded\b/i.test(message);
}
