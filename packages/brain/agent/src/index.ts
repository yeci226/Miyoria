// @miyoria/brain/agent: the conversations' module (`agent`).
//
// Hands `platform.*` and `voice.*` events to the runner Core installs (`@miyoria/brain/selfhost`),
// after the checks every line goes through, and keeps what the runner and the other modules share:
// the persona, the channels' levels and her talkativeness there, who is in each voice channel she
// is in, the mouth her lines leave through (`MainLine`, `MouthKey`) and the game director's work
// lane. The pieces of the old turn the runner reuses are here too: who a line is for, the expression
// parser and sentence splitters, the screens of her output, images and files of a line, her state
// blocks and the persona's lorebook.

export { type Tool, type ToolContext, ToolRegistry, ToolRegistryKey } from "@miyoria/llm/tools";
export { ACTIVENESS_CAPABILITY, activenessCapability, LEVEL_TALKATIVENESS } from "./actions.js";
export {
  type Aside,
  aboutHerInThirdPerson,
  asideOf,
  directReason,
  isQuestion,
  openingCall,
  reactionOnly,
  saidToOthers,
  vocativeName,
} from "./address.js";
export { activenessLabel } from "./commands.js";
export {
  type Budgeted,
  type BudgetOptions,
  budgetBlocks,
  budgetSelf,
  contributedData,
  fairShares,
  fitBody,
  ordered,
  renderSections,
  SavedPrompts,
  SavedPromptsKey,
  type SelfBlock,
  SUPERSEDED,
  savedMessages,
  savedPrompt,
  squeeze,
} from "./compiler.js";
export {
  ACTIVENESS_LEVELS,
  type Activeness,
  ActivenessSchema,
  type AgentConfig,
  AgentConfigSchema,
  AMBIENT_MODES,
  activenessFor,
  CHANNEL_MODES,
  type ChannelMode,
  ChannelModeSchema,
  type CorrectionsConfig,
  CorrectionsConfigSchema,
  type DelegateConfig,
  DelegateConfigSchema,
  defaultAgentConfig,
  type FilesConfig,
  FilesConfigSchema,
  type HistoryConfig,
  HistoryConfigSchema,
  LEVEL_KEYS,
  type LevelKey,
  MainLineConfigSchema,
  maxDebounceMs,
  modeFor,
  NEW_SPACE_ACTIVENESS,
  NEW_SPACE_MODE,
  ParseError,
  type PromptConfig,
  PromptConfigSchema,
  parseActiveness,
  parseChannelMode,
  typingRefreshMs,
  type VisionConfig,
  VisionConfigSchema,
  type VoiceConfig,
  VoiceConfigSchema,
  voiceMaxDebounceMs,
  type WorkConfig,
  WorkConfigSchema,
} from "./config.js";
export {
  Gathered,
  gather,
  mergeGathered,
  readWarm,
  Warm,
  WarmContext,
  type WarmRead,
} from "./contributors.js";
export {
  DEFAULT_PAUSE_MS,
  Expression,
  ExpressionParser,
  MAX_PAUSE_MS,
  type ParserChecks,
  type Segment,
} from "./expression.js";
export { type FileCandidate, fileParts, selectFiles } from "./files.js";
export {
  type CallFor,
  type CallKind,
  callFor,
  callKind,
  callsHer,
  FOR_ARG,
  FOR_PROPERTY,
  oneCaller,
  TurnFocusBoard,
  type TurnFocusInit,
  type VoiceCallFacts,
} from "./focus.js";
export {
  ACTIVENESS_PREFIX,
  AgentHandle,
  AgentHandleKey,
  LEVELS_PLUGIN,
  type LevelPlaces,
  type LevelScope,
  type LevelSettings,
  MODE_PREFIX,
  PLACES_MIGRATION_KEY,
  parseContextDisplay,
  type SetLevelOptions,
  UnknownPlaceError,
  voiceScope,
} from "./handle.js";
export { backfillLimit } from "./history.js";
export { isSelfTalk, looksLikeReasoning, ReplyScreen } from "./leak.js";
export {
  CEILINGS,
  type Ceiling,
  cappedTalk,
  ceilingFor,
  languageHint,
  levelHint,
  modeDescription,
  modeLabel,
  paceMs,
} from "./levels.js";
export {
  MOOD_STYLE,
  moodStyleLines,
  pickKaomoji,
  RECENT_OWN_LINES,
  SCAN_LINES,
  styleNote,
  triggeredEntries,
} from "./lorebook.js";
export { FALLBACK_LINES, MainLine } from "./mainline/main.js";
export {
  contextData,
  contextState,
  exampleDialogues,
  examplesBlock,
  partyLine,
  pinnedSection,
  rotatedExamples,
  stableHash,
} from "./mainline/prompt.js";
export {
  agentTurns,
  CorrectionTally,
  speculations,
  speculationWaste,
} from "./metrics.js";
export { AgentModule } from "./module.js";
export { PersonaHandle, PersonaHandleKey } from "./persona.js";
export {
  cleanReply,
  FEELING_TITLE,
  LIFE_TITLE,
  MOOD_MIN,
  PRESENT_TITLE,
  whenAndWhere,
} from "./prompt.js";
export {
  Agent,
  type TextLineMarks,
  type TextReplyOutcome,
  type TextRunner,
  type TextRunnerFactory,
  type VoiceRunner,
} from "./runtime.js";
export { toTraditional } from "./script.js";
export {
  activityBlock,
  feelingCauseBody,
  goalsBlock,
  HEART_NOW_TITLE,
  heartNowBody,
  ledgerBlock,
  moodBlock,
  noticesBlock,
  type PeopleSources,
  type PresentPerson,
  peopleBody,
  policyBlock,
  type SelfSources,
  selfBlocks,
} from "./self-block.js";
export {
  type BudgetState,
  EXHAUSTED_LINE,
  HOUR_CAP_LINE,
  herStatusHint,
  parseBudgetState,
  shownHint,
  unansweredHint,
} from "./signals.js";
export { DEFAULT_TOOL_LIMITS, slimTool, type ToolLimits } from "./slim.js";
export {
  type FencedPiece,
  FenceSplitter,
  isSpeakable,
  LinkSplitter,
  LONG_CLAUSE_CHARS,
  SentenceSplitter,
} from "./speech.js";
export { ReactTool, ToolArgumentError } from "./tools.js";
export { TimeoutError, timeout, truncate } from "./util.js";
export {
  allowedUrl,
  type FetchLike,
  type ImageCandidate,
  ImageLoader,
  imageParts,
  type LoadedImage,
} from "./vision.js";
export { type LaneDeps, RESTART_REASON, WorkLaneService } from "./worklane/lane.js";
