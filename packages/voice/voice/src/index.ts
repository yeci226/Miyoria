// @miyoria/voice/voice: the voice pipeline.
//
// * Module `voice.link` (`VoiceLinkModule`) serves the Voice Link WebSocket
//   (`docs/protocols/voice-link.md`) the self voice node connects to, and provides `VoiceLink`
//   (`VoiceLinkKey`): join / leave, participants, playback, Go Live and captured audio.
// * Module `voice` (`VoiceModule`) listens (consent filter → `Segmenter` with an energy `Vad` →
//   ASR → Traditional Chinese → `voice.utterance`) and speaks (provides `VoiceSink`: TTS →
//   playback, with barge-in). It registers `join`, `leave` and `voice consent <on|off>`.
//
// Latency measurements are published as `voice.latency` with `stage` =
// `asr` (`asr_ms`, `transcribe_ms`), `tts` (`first_audio_ms`), `filler` (a short sound of hers
// filled a silence) or `e2e` (`speech_end → first_audio_played`, split into `endpoint`, `asr`,
// `prepare`, `llm_first`, `tts_queue`, `tts_first` and `playback`, with the agent's `parts`); the
// agent adds `llm` (`first_token_ms`) and `speculation`. The module provides `VoiceTurns`
// (`VoiceTurnsKey`), through which the agent marks its turns and asks for a filler.

export {
  type BargeDecision,
  type BargeFacts,
  BargeIn,
  type BargeOptions,
  type BargeTarget,
  type BargeThresholds,
  type BargeVerdict,
  type BargeWho,
  DEFAULT_BARGE_OPTIONS,
  decideBargeIn,
  type PlaybackInfo,
  type SpeakerRole,
} from "./barge.js";
export {
  CONSENT_ROUTES,
  joinAnnouncement,
  PATHS,
  registerCommands,
  unregisterCommands,
} from "./commands.js";
export {
  type BargeInMode,
  BargeInModeSchema,
  fillerLines,
  segmenterConfig,
  type VoiceConfig,
  VoiceConfigSchema,
  VoiceProfile,
  VoiceProfileError,
} from "./config.js";
export {
  CONSENT_PROFILE,
  Consent,
  type ConsentPolicy,
  consentKey,
  defaultAllowed,
} from "./consent.js";
export {
  E2E_SEGMENTS,
  E2eLatency,
  type E2eMeasure,
  type E2eParts,
  type E2eReason,
  type E2eRecord,
  type E2eSegment,
  e2eJson,
} from "./e2e.js";
export { containment, looksLikeHintEcho, matchCore, SelfEchoGuard } from "./echo.js";
export {
  Filler,
  FillerBank,
  type FillerBankOptions,
  type FillerClip,
  type FillerDeps,
  trim,
} from "./filler.js";
export { Hearing, type HearingDeps, type StreamHearing, StreamHearingKey } from "./hearing.js";
export {
  type GoLiveState,
  type GoLiveStatus,
  VoiceLinkError,
  type WatchStatus,
} from "./link/conn.js";
export {
  type AudioEvent,
  DEFAULT_BIND,
  GOLIVE_TOPIC,
  type GoLiveRequest,
  type StreamInfo,
  VoiceLink,
  type VoiceLinkConfig,
  VoiceLinkConfigSchema,
  VoiceLinkKey,
  type VoiceLinkOptions,
  voiceContext,
  WATCH_TOPIC,
} from "./link/link.js";
export { VOICE_LINK_PATH, VoiceLinkModule } from "./link/module.js";
export {
  CAP_DUCK,
  CAP_PAUSE,
  Playback,
  type PlaybackControl,
  type Stoppable,
} from "./link/playback.js";
export { VoiceModule } from "./module.js";
export {
  BufferedAudio,
  LinePrefetch,
  type PrefetchOptions,
  type PreparedLine,
  type Producer,
  type Production,
} from "./prefetch.js";
export {
  CLOSE,
  type CoreMessage,
  coreMessageJson,
  decodeAudio,
  encodeAudio,
  type NodeMessage,
  NodeMessageSchema,
  TAG_CAPTURE,
  TAG_LEVELS,
  TAG_PLAYBACK,
  VERSION,
  type WireParticipant,
} from "./protocol.js";
export { DEFAULT_SEGMENTER, Segmenter, type SegmenterConfig, type Utterance } from "./segment.js";
export { SileroVad, sileroVad } from "./silero.js";
export {
  applyAliases,
  cleanTranscript,
  compileAliases,
  echoesHint,
  isHallucination,
  isPunctuationOnly,
  stripEmoji,
  stripTags,
  toTraditional,
} from "./text.js";
export { HttpTurnJudge, type TurnAnswer, TurnGate, type TurnJudge } from "./turn.js";
export { BoundedQueue, Semaphore, Watch } from "./util.js";
export {
  createVad,
  DEFAULT_ENERGY_VAD,
  EnergyVad,
  type EnergyVadConfig,
  energyDb,
  registerVadEngine,
  type Vad,
  type VadFactory,
  type VadSettings,
  type VadWorker,
  zeroCrossingRate,
} from "./vad.js";
