// @miyoria/speech: ASR / TTS provider interfaces, fallback chains (`SpeechService`), the
// built-in HTTP providers and the `speech` module. Audio is mono 16-bit PCM (`Int16Array`).

export {
  HttpWorkerAsr,
  type HttpWorkerAsrConfig,
  HttpWorkerAsrConfigSchema,
  HttpWorkerAsrFactory,
  OpenAiAsr,
  type OpenAiAsrConfig,
  OpenAiAsrConfigSchema,
  OpenAiAsrFactory,
} from "./asr.js";
export { SpeechHttpError } from "./http.js";
export {
  defaultAsrFactories,
  defaultTtsFactories,
  ProviderConfigSchema,
  type SpeechConfig,
  SpeechConfigSchema,
  SpeechModule,
} from "./module.js";
export { type Carry, decodeChunk, pcmStream, rateFromContentType } from "./pcm.js";
export {
  type GptSovitsConfig,
  GptSovitsConfigSchema,
  GptSovitsFactory,
  GptSovitsTts,
  HttpWorkerTts,
  type HttpWorkerTtsConfig,
  HttpWorkerTtsConfigSchema,
  HttpWorkerTtsFactory,
  OpenAiTts,
  type OpenAiTtsConfig,
  OpenAiTtsConfigSchema,
  OpenAiTtsFactory,
  sovitsLang,
  VllmOmniTts,
  type VllmOmniTtsConfig,
  VllmOmniTtsConfigSchema,
  VllmOmniTtsFactory,
} from "./tts.js";
export {
  type AsrFactory,
  type AsrHint,
  type AsrProvider,
  type AudioBuf,
  type AudioChunk,
  type AudioStream,
  durationMs,
  isOffloaded,
  NO_HINT,
  type ProviderConfig,
  SpeechError,
  SpeechService,
  SpeechServiceKey,
  type SpeechServiceOptions,
  type Transcript,
  type TtsFactory,
  type TtsPriority,
  type TtsProvider,
  type TtsRequest,
  ttsRequest,
} from "./types.js";
export { decodeWav, encodeWav, resample } from "./wav.js";
