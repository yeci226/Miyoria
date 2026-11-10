// @miyoria/stage: her body on the streaming PC.
//
// * Module `stage.link` (`StageLinkModule`, Core side) serves the Stage Link WebSocket
//   (`docs/protocols/stage-link.md`), forwards emotions, subtitles and speaking state to the
//   Stage node and provides `StageLinkKey` (scene, stream, hotkey, gaze, status). It registers
//   `stream start | stop | scene <name> | status` and follows the voice node's Go Live with OBS
//   (`voice.golive` → OBS "Start / Stop Streaming").
//
//   ```toml
//   [modules."stage.link"]
//   bind = "127.0.0.1:7882"
//   token = "${STAGE_LINK_TOKEN}"
//   ```
//
// * `runStage` (Stage side, `miyoria stage`) connects to Core and drives VTube Studio (`vts`:
//   accent expressions, emotion poses, gestures, blinking, lip sync with vowels and procedural
//   motion by parameter injection), OBS (`obs`) and the overlay (`overlay`). The voice node
//   streams playback levels to its lip-sync endpoint (`lipsync`).

export {
  type AvatarAction,
  AvatarProfile,
  AvatarProfileError,
  DEFAULT_GIFT_EXPRESSIONS,
  type EmotionPose,
  type Gesture,
  type IdleGestures,
  type LipSyncMode,
  parseAvatarAction,
} from "./avatar.js";
export {
  AvatarLoop,
  type AvatarLoopConfig,
  SILENCE_PARAM,
  VOWEL_PARAMS,
} from "./avatar-loop.js";
export { type BlinkConfig, BlinkConfigSchema, BlinkScheduler } from "./blink.js";
export { EmotionController, type VtsCommand } from "./emotion.js";
export { type GestureConfig, GestureConfigSchema, GestureController } from "./gesture.js";
export {
  countedLabel,
  GIFT_MERGE_MS,
  GIFT_SHOW_MS,
  type Gift,
  GiftMerger,
  giftLine,
} from "./gifts.js";
export {
  type SceneCapabilityTarget,
  sceneTarget,
  stageCapabilities,
} from "./link/actions.js";
export {
  type ActivityOptions,
  ActivityTracker,
  prepareLabel,
  SINGING_LABEL,
  SYNTH_LABEL,
  THINKING_LABEL,
} from "./link/activity.js";
export {
  describeStatus,
  PATHS as STREAM_COMMAND_PATHS,
  registerStreamCommands,
  unregisterStreamCommands,
} from "./link/commands.js";
export { checkHello, type HelloOutcome, tokenMatches } from "./link/conn.js";
export {
  type GoLiveState,
  type RoleSwitcher,
  SceneDirector,
  type SceneDirectorDeps,
  type SceneSwitcher,
} from "./link/director.js";
export {
  EMOTION_TOPIC,
  Forwarder,
  type ForwarderOptions,
  GIFT_TOPIC,
  SCREEN_TOPIC,
  SUBTITLE_TOPIC,
} from "./link/forward.js";
export { type GoLiveFollow, goliveFollow, VOICE_GOLIVE_TOPIC } from "./link/golive.js";
export {
  DEFAULT_BIND,
  ERROR_TOPIC,
  STATUS_TOPIC,
  StageLink,
  type StageLinkConfig,
  StageLinkConfigSchema,
  StageLinkError,
  StageLinkKey,
} from "./link/link.js";
export { GAME_SESSION_TOPIC, StageLinkModule } from "./link/module.js";
export {
  away,
  factsOf,
  NO_FACTS,
  pickScene,
  type SceneFacts,
  type SceneMemory,
  sceneWants,
  type Want,
} from "./link/scene-rule.js";
export {
  BUILTIN_ROLES,
  type BuiltinRole,
  type ClassifiedBy,
  classifyByKeywords,
  classifyMessages,
  matchScene,
  parseClassification,
  ROLE_LABELS,
  ROLE_NAME,
  type RoleSource,
  type RoleView,
  SCENE_ROLES_KEY,
  SceneRoleError,
  SceneRoles,
  type SceneRolesDeps,
  SceneRolesKey,
  type SceneRolesView,
  type ScenesConfig,
  ScenesConfigSchema,
  SceneTransitionSchema,
} from "./link/scenes.js";
export {
  DEFAULT_VOWEL_TEMPLATES,
  defaultLipSyncConfig,
  dominantVowel,
  Envelope,
  type LevelSample,
  Levels,
  type LipSyncConfig,
  LipSyncConfigSchema,
  type Mouth,
  MouthShaper,
  type ServeResult,
  serveLevels,
  VOWELS,
  type Vowel,
  VowelClassifier,
  type VowelWeights,
} from "./lipsync.js";
export {
  type GazeConfig,
  GazeConfigSchema,
  type GazePose,
  GazePoseSchema,
  gazePose,
  IdleMotion,
  MOTION_PARAMS,
  type MotionConfig,
  MotionConfigSchema,
  type MotionFrame,
  type MotionInput,
} from "./motion.js";
export { BindError, type BoundAddress, formatAddress, parseBind } from "./net.js";
export {
  defaultObsState,
  type MediaAction,
  type Obs,
  type ObsConfig,
  ObsConfigSchema,
  type ObsConnector,
  ObsController,
  ObsError,
  type ObsState,
  ObsWebSocketConnector,
  type SceneItem,
} from "./obs.js";
export {
  applyObsSetup,
  describeStep,
  GAME_MODEL,
  MASK_FILE,
  MASK_FILTER,
  type ObsAdmin,
  type ObsSetupOptions,
  type ObsSnapshot,
  ObsWebSocketAdmin,
  planObsSetup,
  roundedMaskPng,
  SING,
  SOURCES,
  type Step as ObsSetupStep,
  VTS_WINDOW,
} from "./obs-setup.js";
export { OverlayHub, serveOverlay } from "./overlay.js";
export {
  BODY_PARAMS,
  clampParam,
  DEFAULT_REST,
  type EmotionConfig,
  EmotionConfigSchema,
  OFFSET_PARAMS,
  PoseBlender,
  type PoseFrame,
  paramRange,
} from "./pose.js";
export {
  ACTIVITY_DETAIL_MAX,
  ACTIVITY_LABEL_MAX,
  type Activity,
  type ActivityKind,
  CLOSE,
  type CoreMessage,
  defaultStageStatus,
  encodeMessage,
  type GazeTarget,
  GIFT_EXPRESSION_MAX_S,
  GIFT_EXPRESSIONS,
  type GiftExpression,
  type LevelFrame,
  parseCoreMessage,
  parseGazeTarget,
  parseLevelFrame,
  parseStageMessage,
  type SceneTransition,
  type SongVideoAction,
  SongVideoActionSchema,
  type SpeakingState,
  type StageMessage,
  type StageStatus,
  type StreamAction,
  sameStatus,
  sceneTransitionOf,
  TRANSITION_MAX_MS,
  VERSION,
} from "./protocol.js";
export { Drift, Random, SmoothNoise } from "./random.js";
export {
  overlayUrl,
  parseStageConfig,
  type RunStageOptions,
  runStage,
  runStageWith,
  type StageConfig,
  StageConfigSchema,
  type StageConfigSection,
  StageError,
} from "./runtime.js";
export { SongVideo, type SongVideoDeps, type SongVideoPlay, songVideoFile } from "./song-video.js";
export {
  API_NAME,
  API_VERSION,
  ApiError,
  ERROR_USER_DENIED,
  type Expression,
  type Hotkey,
  type ModelInfo,
  type PluginInfo,
  pluginInfo,
  tokenPath,
  VtsClient,
  type VtsConfig,
  VtsConfigSchema,
  VtsError,
} from "./vts.js";
