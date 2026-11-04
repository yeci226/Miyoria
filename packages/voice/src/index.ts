// @miyoria/voice: the voice pipeline.
//
// * Module `voice.link` (`VoiceLinkModule`) serves the Voice Link WebSocket
//   (`docs/protocols/voice-link.md`) the self voice node connects to, and provides `VoiceLink`
//   (`VoiceLinkKey`): join / leave, participants, playback, Go Live and captured audio.
// * Module `voice` (`VoiceModule`) listens (consent filter → `Segmenter` with an energy `Vad` →
//   ASR → Traditional Chinese → `voice_utterance`) and speaks (provides `VoiceSink`: TTS →
//   playback, with barge-in). It registers `join`, `leave` and `voice consent <on|off>`.
//
// Latency measurements are published as `custom` events on `voice.latency` with `stage` =
// `asr` (`asr_ms`, `transcribe_ms`) or `tts` (`first_audio_ms`); the agent adds `llm`
// (`first_token_ms`).

export { BargeIn } from "./barge.js";
export { joinAnnouncement, PATHS, registerCommands, unregisterCommands } from "./commands.js";
export {
  type BargeInMode,
  BargeInModeSchema,
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
export { Playback, type Stoppable } from "./link/playback.js";
export { VoiceModule } from "./module.js";
export {
  CLOSE,
  type CoreMessage,
  coreMessageJson,
  decodeAudio,
  decodeSnapshot,
  decodeWatchAudio,
  encodeAudio,
  type NodeMessage,
  NodeMessageSchema,
  TAG_CAPTURE,
  TAG_LEVELS,
  TAG_PLAYBACK,
  TAG_SNAPSHOT,
  TAG_WATCH_AUDIO,
  VERSION,
  type WireGoLiveState,
  type WireParticipant,
  type WirePlaybackState,
  type WireWatchState,
  WireWatchStateSchema,
} from "./protocol.js";
export { DEFAULT_SEGMENTER, Segmenter, type SegmenterConfig, type Utterance } from "./segment.js";
export {
  cleanTranscript,
  echoesHint,
  isHallucination,
  isPunctuationOnly,
  stripTags,
  toTraditional,
} from "./text.js";
export { LATENCY_TOPIC } from "./topics.js";
export { BoundedQueue, Semaphore, Watch } from "./util.js";
export {
  DEFAULT_ENERGY_VAD,
  EnergyVad,
  type EnergyVadConfig,
  energyDb,
  type Vad,
  zeroCrossingRate,
} from "./vad.js";
