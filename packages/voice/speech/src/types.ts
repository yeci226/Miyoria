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
} from "@miyoria/runtime/kernel";
import { type JsonValue, serviceKey } from "@miyoria/types";
import type { EndpointSource } from "./endpoints.js";

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
  /**
   * `now`: an utterance that ended, a reply waits for it; `ahead`: transcribed before the turn is
   * known to be over, it gives way to `now` on a worker that queues requests. Left out means `now`.
   */
  priority?: SpeechPriority;
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

/** How soon a worker that queues requests should serve one: `now` before `ahead`. */
export type SpeechPriority = "now" | "ahead";

export type TtsPriority = SpeechPriority;

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

/** What a provider may use besides its settings. */
export interface ProviderEnv {
  /** Core's endpoint registry: where the `http-worker` providers' workers are. */
  endpoints: EndpointSource | null;
}

export const NO_ENV: Readonly<ProviderEnv> = Object.freeze({ endpoints: null });

export interface AsrFactory {
  readonly kinds: readonly string[];
  /** Throws on invalid settings. */
  build(name: string, config: ProviderConfig, env?: ProviderEnv): AsrProvider;
}

export interface TtsFactory {
  readonly kinds: readonly string[];
  /** Throws on invalid settings. */
  build(name: string, config: ProviderConfig, env?: ProviderEnv): TtsProvider;
}

export class SpeechError extends Error {
  override name = "SpeechError";
}

export interface SpeechServiceOptions {
  /** Where request counts go. Default: the process-wide `metrics`. */
  metrics?: MetricsRegistry;
  /**
   * After a provider fails, the chain starts at the next one for this long (ms), so a worker that
   * hangs costs one timeout, not one per request. Default 30 000; 0 = always start at the first.
   */
  retryMs?: number;
  /** Clock of `retryMs`. Default `Date.now`. */
  now?: () => number;
}

const DEFAULT_RETRY_MS = 30_000;

/**
 * The provider turned this request down (a 4xx: punctuation only, too long, a bad voice): it
 * works, the request does not. 408 and 429 say the service is behind, not the request.
 */
function refused(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return (
    typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429
  );
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
  readonly #retryMs: number;
  readonly #now: () => number;
  /** Providers that failed lately, until when they are tried last. */
  readonly #downUntil = new Map<AsrProvider | TtsProvider, number>();

  constructor(
    asr: readonly AsrProvider[],
    tts: readonly TtsProvider[],
    options: SpeechServiceOptions = {},
  ) {
    this.#asr = [...asr];
    this.#tts = [...tts];
    this.#retryMs = Math.max(0, options.retryMs ?? DEFAULT_RETRY_MS);
    this.#now = options.now ?? Date.now;
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
  transcribe(audio: AudioBuf, hint: AsrHint, signal?: AbortSignal): Promise<[string, Transcript]> {
    return this.#chain(
      "ASR",
      this.#asr,
      this.#asrRequests,
      (p) => p.transcribe(audio, hint, signal),
      signal,
    );
  }

  /** Tries each TTS provider in order until one starts a stream. Returns `[provider, stream]`. */
  synthesize(request: TtsRequest, signal?: AbortSignal): Promise<[string, AudioStream]> {
    return this.#chain(
      "TTS",
      this.#tts,
      this.#ttsRequests,
      (p) => p.synthesize({ ...request }, signal),
      signal,
    );
  }

  /** The chain in the order to try it now: providers that failed lately go last. */
  #order<P extends AsrProvider | TtsProvider>(providers: readonly P[]): P[] {
    const now = this.#now();
    const up: P[] = [];
    const down: P[] = [];
    for (const p of providers) {
      const until = this.#downUntil.get(p);
      if (until === undefined || until <= now) {
        this.#downUntil.delete(p);
        up.push(p);
      } else down.push(p);
    }
    return [...up, ...down];
  }

  async #chain<P extends AsrProvider | TtsProvider, T>(
    what: "ASR" | "TTS",
    providers: readonly P[],
    counter: Counter,
    attempt: (p: P) => Promise<T>,
    signal: AbortSignal | undefined,
  ): Promise<[string, T]> {
    let last: unknown;
    const chain = this.#order(providers);
    for (const p of chain) {
      try {
        const result = await attempt(p);
        counter.inc({ provider: p.name, outcome: "ok" });
        this.#downUntil.delete(p);
        return [p.name, result];
      } catch (error) {
        counter.inc({ provider: p.name, outcome: failure(signal) });
        if (signal?.aborted) throw error;
        const err = errorMessage(error);
        // A worker that gave the GPU to the song worker says so at once; that is expected, and it
        // comes back by itself.
        if (isOffloaded(err)) log.debug({ provider: p.name, err }, `${what} failed, trying next`);
        else {
          log.warn({ provider: p.name, err }, `${what} failed, trying next`);
          if (this.#retryMs > 0 && chain.length > 1 && !refused(error)) {
            this.#downUntil.set(p, this.#now() + this.#retryMs);
          }
        }
        last = error;
      }
    }
    throw last ?? new SpeechError(`no ${what} provider configured`);
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
