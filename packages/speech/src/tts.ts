// TTS providers: the Miyoria inference-worker protocol, OpenAI-compatible `/audio/speech`,
// vLLM-Omni (true streaming for Qwen3-TTS) and GPT-SoVITS (api_v2).

import type { JsonValue } from "@miyoria/types";
import { z } from "zod";
import { bearerHeaders, idleTimer, joinUrl, parseSettings, post } from "./http.js";
import { parseU32, pcmStream, rateFromContentType } from "./pcm.js";
import {
  type AudioStream,
  type ProviderConfig,
  SpeechError,
  type TtsFactory,
  type TtsProvider,
  type TtsRequest,
} from "./types.js";

const DEFAULT_TIMEOUT_SECS = 30;

const timeoutSecs = () => z.number().int().nonnegative().default(DEFAULT_TIMEOUT_SECS);

function nonEmpty(s: string | null): string | null {
  return s !== null && s.trim() !== "" ? s : null;
}

/**
 * POSTs `body` as JSON and streams the raw PCM response. The timeout applies while waiting for
 * response headers and between body chunks (not to the whole stream), so long utterances are
 * fine. `rateOf` picks the sample rate from the response (and may reject it).
 */
async function streamPcm(
  url: string,
  headers: Record<string, string>,
  body: JsonValue,
  timeout: number,
  rateOf: (response: Response) => number,
  signal: AbortSignal | undefined,
): Promise<AudioStream> {
  const idle = idleTimer(timeout);
  let response: Response;
  try {
    response = await post(url, {
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
      idle,
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    idle.clear();
    throw error;
  }
  const stream = response.body;
  try {
    if (!stream) throw new SpeechError("TTS response has no body");
    const audio = pcmStream(stream, rateOf(response), idle);
    const queueMs = Number(response.headers.get("x-tts-queue-ms") ?? Number.NaN);
    if (Number.isFinite(queueMs) && queueMs >= 0) audio.queueMs = queueMs;
    return audio;
  } catch (error) {
    idle.clear();
    await stream?.cancel().catch(() => undefined);
    throw error;
  }
}

function header(response: Response, name: string): string | null {
  return response.headers.get(name);
}

// ---------------------------------------------------------------- http-worker

/**
 * Settings of `HttpWorkerTts` (`kind = "http-worker"`).
 *
 * ```toml
 * [speech.tts.qwen]
 * kind = "http-worker"
 * url = "http://127.0.0.1:8102"
 * voice = "deepseek-chan"   # optional default voice
 * timeout_secs = 30         # optional, idle timeout
 * ```
 */
export const HttpWorkerTtsConfigSchema = z.object({
  /** Worker root; `POST {url}/tts`. */
  url: z.string(),
  /** Used when the request names no voice. */
  voice: z.string().nullable().default(null),
  timeout_secs: timeoutSecs(),
});
export type HttpWorkerTtsConfig = z.output<typeof HttpWorkerTtsConfigSchema>;

/** TTS client for an inference worker (see `docs/protocols/voice-link.md`). */
export class HttpWorkerTts implements TtsProvider {
  readonly name: string;
  readonly #url: string;
  readonly #voice: string | null;
  readonly #timeoutSecs: number;

  constructor(name: string, config: HttpWorkerTtsConfig) {
    this.name = name;
    this.#url = joinUrl(config.url, "tts");
    this.#voice = nonEmpty(config.voice);
    this.#timeoutSecs = config.timeout_secs;
  }

  synthesize(request: TtsRequest, signal?: AbortSignal): Promise<AudioStream> {
    // `None` fields are left out (`skip_serializing_if`).
    const body: Record<string, JsonValue> = { text: request.text };
    if (request.language !== null) body.language = request.language;
    if (request.emotion !== null) body.emotion = request.emotion;
    if (request.instruct !== null) body.instruct = request.instruct;
    const voice = request.voice ?? this.#voice;
    if (voice !== null) body.voice = voice;
    if (request.priority !== undefined) body.priority = request.priority;
    return streamPcm(
      this.#url,
      {},
      body,
      this.#timeoutSecs,
      (response) => {
        const fromHeader = header(response, "x-sample-rate");
        const contentType = header(response, "content-type");
        const rate =
          (fromHeader === null ? null : parseU32(fromHeader.trim())) ??
          (contentType === null ? null : rateFromContentType(contentType));
        if (rate === null) throw new SpeechError("TTS worker sent no sample rate");
        return rate;
      },
      signal,
    );
  }
}

/** `TtsFactory` for `http-worker`. */
export class HttpWorkerTtsFactory implements TtsFactory {
  readonly kinds = ["http-worker"] as const;

  build(name: string, config: ProviderConfig): TtsProvider {
    return new HttpWorkerTts(name, parseSettings(HttpWorkerTtsConfigSchema, config));
  }
}

// --------------------------------------------------------------------- openai

/** Sample rate of OpenAI's `pcm` response format. */
const OPENAI_PCM_RATE = 24_000;

/**
 * Settings of `OpenAiTts` (`kind = "openai"`).
 *
 * ```toml
 * [speech.tts.cloud]
 * kind = "openai"
 * api_key = "${OPENAI_API_KEY}"
 * model = "tts-1"
 * voice = "nova"
 * ```
 */
export const OpenAiTtsConfigSchema = z.object({
  base_url: z.string().default("https://api.openai.com/v1"),
  api_key: z.string().nullable().default(null),
  model: z.string().default("tts-1"),
  /** Used when the request names no voice. */
  voice: z.string().default("alloy"),
  timeout_secs: timeoutSecs(),
});
export type OpenAiTtsConfig = z.output<typeof OpenAiTtsConfigSchema>;

/**
 * Client for OpenAI-compatible `POST {base_url}/audio/speech`, requesting `pcm` (24 kHz s16le
 * mono) and streaming it.
 */
export class OpenAiTts implements TtsProvider {
  readonly name: string;
  readonly #url: string;
  readonly #model: string;
  readonly #voice: string;
  readonly #headers: Record<string, string>;
  readonly #timeoutSecs: number;

  constructor(name: string, config: OpenAiTtsConfig) {
    this.name = name;
    this.#url = joinUrl(config.base_url, "audio/speech");
    this.#model = config.model;
    this.#voice = config.voice;
    this.#headers = bearerHeaders(config.api_key);
    this.#timeoutSecs = config.timeout_secs;
  }

  synthesize(request: TtsRequest, signal?: AbortSignal): Promise<AudioStream> {
    const body = {
      model: this.#model,
      input: request.text,
      voice: request.voice ?? this.#voice,
      response_format: "pcm",
    };
    return streamPcm(
      this.#url,
      this.#headers,
      body,
      this.#timeoutSecs,
      () => OPENAI_PCM_RATE,
      signal,
    );
  }

  /** Keeps the API key out of logs. */
  toJSON(): { name: string; url: string; model: string } {
    return { name: this.name, url: this.#url, model: this.#model };
  }
}

/** `TtsFactory` for `openai`. */
export class OpenAiTtsFactory implements TtsFactory {
  readonly kinds = ["openai"] as const;

  build(name: string, config: ProviderConfig): TtsProvider {
    return new OpenAiTts(name, parseSettings(OpenAiTtsConfigSchema, config));
  }
}

// ------------------------------------------------------------------ vllm-omni

/** Native rate of Qwen3-TTS, used when the server sends no rate header. */
const VLLM_OMNI_DEFAULT_RATE = 24_000;

const JsonMapSchema = z.record(z.string(), z.custom<JsonValue>()).default({});

/**
 * Settings of `VllmOmniTts` (`kind = "vllm-omni"`).
 *
 * vLLM-Omni serves Qwen3-TTS (and CosyVoice3, Fish Speech, ...) with real streaming: audio
 * arrives per decoded codec chunk instead of per sentence.
 *
 * ```toml
 * [speech.tts.qwen]
 * kind = "vllm-omni"
 * base_url = "http://127.0.0.1:8091/v1"
 * voice = "deepseek-chan"        # uploaded with POST /v1/audio/voices
 * language = "Chinese"           # default "Auto"
 * # instructions = true          # send emotion instructions (CustomVoice / VoiceDesign only)
 * # initial_codec_chunk_frames = 4
 * # extra = { seed = 7 }         # extra request fields, merged last
 * ```
 */
export const VllmOmniTtsConfigSchema = z.object({
  base_url: z.string(),
  api_key: z.string().nullable().default(null),
  /** Must match the served model when set; omitted otherwise. */
  model: z.string().nullable().default(null),
  /** Used when the request names no voice. */
  voice: z.string().nullable().default(null),
  language: z.string().default("Auto"),
  /** `CustomVoice` / `VoiceDesign` / `Base`; inferred by the server when unset. */
  task_type: z.string().nullable().default(null),
  /**
   * Forward `TtsRequest.instruct` as `instructions`. Qwen3-TTS only honours them for
   * CustomVoice / VoiceDesign, not for cloned (Base) voices.
   */
  instructions: z.boolean().default(false),
  /** Smaller first chunk = earlier first audio. */
  initial_codec_chunk_frames: z.number().int().nonnegative().nullable().default(null),
  extra: JsonMapSchema,
  timeout_secs: timeoutSecs(),
});
export type VllmOmniTtsConfig = z.output<typeof VllmOmniTtsConfigSchema>;

/**
 * Client for vLLM-Omni `POST {base_url}/audio/speech` with `stream_format = "audio"` (raw PCM
 * bytes as they are decoded).
 */
export class VllmOmniTts implements TtsProvider {
  readonly name: string;
  readonly #url: string;
  readonly #config: VllmOmniTtsConfig;
  readonly #headers: Record<string, string>;

  constructor(name: string, config: VllmOmniTtsConfig) {
    this.name = name;
    this.#url = joinUrl(config.base_url, "audio/speech");
    this.#headers = bearerHeaders(config.api_key);
    this.#config = config;
  }

  /** The request body (exposed for tests). */
  body(request: TtsRequest): Record<string, JsonValue> {
    const c = this.#config;
    const body: Record<string, JsonValue> = {
      input: request.text,
      response_format: "pcm",
      stream: true,
      stream_format: "audio",
      language: request.language ?? c.language,
    };
    const voice = request.voice ?? c.voice;
    if (voice !== null) body.voice = voice;
    if (c.model !== null) body.model = c.model;
    if (c.task_type !== null) body.task_type = c.task_type;
    if (c.instructions && request.instruct !== null && request.instruct.trim() !== "") {
      body.instructions = request.instruct;
    }
    if (c.initial_codec_chunk_frames !== null) {
      body.initial_codec_chunk_frames = c.initial_codec_chunk_frames;
    }
    Object.assign(body, c.extra);
    return body;
  }

  synthesize(request: TtsRequest, signal?: AbortSignal): Promise<AudioStream> {
    return streamPcm(
      this.#url,
      this.#headers,
      this.body(request),
      this.#config.timeout_secs,
      (response) => {
        const rateHeader = header(response, "x-audio-sample-rate");
        const rate =
          (rateHeader === null ? null : parseU32(rateHeader.trim())) ?? VLLM_OMNI_DEFAULT_RATE;
        const channelsHeader = header(response, "x-audio-channels");
        const channels = (channelsHeader === null ? null : parseU32(channelsHeader.trim())) ?? 1;
        if (channels !== 1) {
          throw new SpeechError(
            `vLLM-Omni returned ${channels}-channel audio; only mono is supported`,
          );
        }
        return rate;
      },
      signal,
    );
  }

  /** Keeps the API key out of logs. */
  toJSON(): { name: string; url: string } {
    return { name: this.name, url: this.#url };
  }
}

/** `TtsFactory` for `vllm-omni`. */
export class VllmOmniTtsFactory implements TtsFactory {
  readonly kinds = ["vllm-omni"] as const;

  build(name: string, config: ProviderConfig): TtsProvider {
    return new VllmOmniTts(name, parseSettings(VllmOmniTtsConfigSchema, config));
  }
}

// ----------------------------------------------------------------- gpt-sovits

/**
 * Settings of `GptSovitsTts` (`kind = "gpt-sovits"`).
 *
 * ```toml
 * [speech.tts.sovits]
 * kind = "gpt-sovits"
 * url = "http://127.0.0.1:9880"
 * ref_audio_path = "refs/miyoria.wav"   # path as seen by the GPT-SoVITS server
 * prompt_text = "reference transcript"
 * prompt_lang = "zh"
 * text_lang = "zh"                      # default
 * sample_rate = 32000                   # default; must match the model
 * # params = { speed_factor = 1.1 }     # extra api_v2 fields, merged last
 * ```
 */
export const GptSovitsConfigSchema = z.object({
  url: z.string(),
  ref_audio_path: z.string(),
  prompt_text: z.string().default(""),
  prompt_lang: z.string().default("zh"),
  text_lang: z.string().default("zh"),
  /** Raw output has no header, so the rate cannot be detected. */
  sample_rate: z.number().int().nonnegative().default(32_000),
  /** Extra `/tts` body fields (`top_k`, `speed_factor`, ...), merged last. */
  params: JsonMapSchema,
  timeout_secs: timeoutSecs(),
});
export type GptSovitsConfig = z.output<typeof GptSovitsConfigSchema>;

/**
 * Maps names like `Chinese` / `ja` to the codes GPT-SoVITS understands; `null` for anything
 * unknown (the configured default is used).
 */
export function sovitsLang(language: string): string | null {
  switch (language.trim().toLowerCase()) {
    case "zh":
    case "chinese":
    case "mandarin":
      return "zh";
    case "ja":
    case "japanese":
      return "ja";
    case "en":
    case "english":
      return "en";
    case "ko":
    case "korean":
      return "ko";
    case "yue":
    case "cantonese":
      return "yue";
    case "auto":
      return "auto";
    default:
      return null;
  }
}

/**
 * Best-effort GPT-SoVITS (api_v2) client: `POST {url}/tts` with `media_type = "raw"` and
 * `streaming_mode = true`, which yields headerless s16le mono PCM at the model's rate. The
 * request's `emotion`, `instruct` and `voice` are ignored (one reference voice per provider);
 * `language` is mapped to a GPT-SoVITS code when it is a known name.
 */
export class GptSovitsTts implements TtsProvider {
  readonly name: string;
  readonly #url: string;
  readonly #config: GptSovitsConfig;

  constructor(name: string, config: GptSovitsConfig) {
    this.name = name;
    this.#url = joinUrl(config.url, "tts");
    this.#config = config;
  }

  synthesize(request: TtsRequest, signal?: AbortSignal): Promise<AudioStream> {
    const c = this.#config;
    const textLang =
      (request.language === null ? null : sovitsLang(request.language)) ?? c.text_lang;
    const body: Record<string, JsonValue> = {
      text: request.text,
      text_lang: textLang,
      ref_audio_path: c.ref_audio_path,
      prompt_text: c.prompt_text,
      prompt_lang: c.prompt_lang,
      media_type: "raw",
      streaming_mode: true,
    };
    Object.assign(body, c.params);
    return streamPcm(this.#url, {}, body, c.timeout_secs, () => c.sample_rate, signal);
  }
}

/** `TtsFactory` for `gpt-sovits`. */
export class GptSovitsFactory implements TtsFactory {
  readonly kinds = ["gpt-sovits"] as const;

  build(name: string, config: ProviderConfig): TtsProvider {
    return new GptSovitsTts(name, parseSettings(GptSovitsConfigSchema, config));
  }
}
