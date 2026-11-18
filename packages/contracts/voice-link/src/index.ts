// @miyoria/contracts/voice-link: the link between Core and the voice node (apps/voice-node), a
// WebSocket with JSON text frames and binary audio frames (docs/protocols/voice-link.md).
//
// One schema per direction, a union on `type`: `VoiceLinkNodeMessageSchema` (node → Core) and
// `VoiceLinkCoreMessageSchema` (Core → node). Within version 1 a change is additive only: a new
// field is optional or has a default, and a receiver checks `type` against the union's tags
// before parsing, so a type it does not know stays ignorable.

export {
  type VoiceLinkCoreMessage,
  type VoiceLinkCoreMessageIn,
  VoiceLinkCoreMessageSchema,
  type VoiceLinkGoLiveEncoder,
  VoiceLinkGoLiveEncoderSchema,
  VoiceLinkGoLiveStartSchema,
  VoiceLinkGoLiveStopSchema,
  VoiceLinkJoinSchema,
  VoiceLinkLeaveSchema,
  VoiceLinkPlayDuckSchema,
  VoiceLinkPlayEndSchema,
  VoiceLinkPlayPauseSchema,
  VoiceLinkPlayResumeSchema,
  VoiceLinkPlayStartSchema,
  VoiceLinkPlayStopSchema,
  VoiceLinkWatchSnapshotSchema,
  VoiceLinkWatchStartSchema,
  VoiceLinkWatchStopSchema,
  VoiceLinkWelcomeSchema,
} from "./core-messages.js";
export {
  VoiceLinkGoLiveSchema,
  type VoiceLinkGoLiveState,
  VoiceLinkGoLiveStateSchema,
  VoiceLinkHelloSchema,
  VoiceLinkJoinedSchema,
  VoiceLinkLeftSchema,
  VoiceLinkNodeErrorSchema,
  type VoiceLinkNodeMessage,
  type VoiceLinkNodeMessageIn,
  VoiceLinkNodeMessageSchema,
  type VoiceLinkParticipant,
  VoiceLinkParticipantSchema,
  VoiceLinkPingSchema,
  VoiceLinkPlaybackSchema,
  VoiceLinkPongSchema,
  type VoiceLinkSelfAccount,
  VoiceLinkSelfAccountSchema,
  VoiceLinkSpeakingSchema,
  VoiceLinkStreamCloseSchema,
  VoiceLinkStreamOpenSchema,
  VoiceLinkVoiceStateSchema,
  VoiceLinkWatchSchema,
  VoiceLinkWatchSnapshotFailedSchema,
  type VoiceLinkWatchState,
  VoiceLinkWatchStateSchema,
} from "./node-messages.js";
export {
  readFrameHeader,
  VOICE_LINK_CAPABILITIES,
  VOICE_LINK_CLOSE,
  VOICE_LINK_FRAME,
  VOICE_LINK_FRAME_HEADER_BYTES,
  VOICE_LINK_LIMITS,
  VOICE_LINK_U32_MAX,
  VOICE_LINK_VERSION,
  writeFrameHeader,
} from "./protocol.js";
