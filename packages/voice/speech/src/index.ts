// @miyoria/voice/speech: ASR / TTS provider interfaces, fallback chains (`SpeechService`), the
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
export {
  type Endpoint,
  type EndpointQuery,
  type EndpointSource,
  type EndpointsOption,
  firstEndpoint,
} from "./endpoints.js";
export { SpeechHttpError, speechEntryName } from "./http.js";
export {
  defaultAsrFactories,
  defaultTtsFactories,
  ProviderConfigSchema,
  type SpeechConfig,
  SpeechConfigSchema,
  SpeechModule,
  type SpeechModuleOptions,
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
  NO_ENV,
  NO_HINT,
  type ProviderConfig,
  type ProviderEnv,
  SpeechError,
  type SpeechPriority,
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
