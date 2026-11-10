// @miyoria/agent: the cognition core (module `agent`).
//
// Turns `platform.*` and `voice.*` events into replies: each conversation context keeps a
// `Session`, a coordinator debounces messages into turns, attention decides whether to respond,
// and the reply is generated through the `chat` LLM purpose (with an optional tool loop),
// parsed by the expression parser and submitted to the scheduler. In voice channels the reply
// is cut into sentences that are spoken while the model is still generating.
//
// Other modules shape her turns through optional services: prompt contributors
// (`PromptContributorsKey`) add per-turn context, `SocialSignalsKey` and `MoodSignalsKey` steer
// attention and tone, and `agent.initiative` events let her start conversations. `llm.budget`
// events make her save tokens (see `BudgetState`).

export { type Tool, type ToolContext, ToolRegistry, ToolRegistryKey } from "@miyoria/tools";
export {
  ACTIVENESS_CAPABILITY,
  activenessCapability,
  chatCapabilities,
  LEVEL_TALKATIVENESS,
} from "./actions.js";
export {
  ACTIVENESS_SHIFT,
  type Assessment,
  type AttentionInput,
  ambientProbability,
  ambientScale,
  answersHer,
  assess,
  decide,
  directReason,
  effectiveTalk,
  flooredTalk,
  type Gate,
  isQuestion,
  mentionsTopic,
  type RandomSource,
  SeededRandom,
  SILENT_TALKATIVENESS,
  type TalkLevel,
  talkFactor,
  USUAL_TALKATIVENESS,
  type VoiceAttention,
  vocativeName,
} from "./attention.js";
export { activenessLabel, personaSummary } from "./commands.js";
export {
  type Budgeted,
  type BudgetOptions,
  budgetBlocks,
  budgetSelf,
  contributedData,
  fairShares,
  fitBody,
  ordered,
  PROMPT_TOPIC,
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
  type AttentionConfig,
  AttentionConfigSchema,
  activenessFor,
  CHANNEL_MODES,
  type ChannelMode,
  ChannelModeSchema,
  DEPRECATED_AGENT_KEYS,
  defaultAgentConfig,
  deprecatedAgentKeys,
  type FilesConfig,
  FilesConfigSchema,
  type HistoryConfig,
  HistoryConfigSchema,
  MainLineConfigSchema,
  maxDebounceMs,
  modeFor,
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
} from "./config.js";
export { Gathered, gather } from "./contributors.js";
export {
  DEFAULT_PAUSE_MS,
  Expression,
  ExpressionParser,
  MAX_PAUSE_MS,
  type Segment,
} from "./expression.js";
export { type FileCandidate, fileParts, selectFiles } from "./files.js";
export {
  type CallKind,
  callKind,
  type FocusSelection,
  focusVerb,
  selectFocus,
  TurnFocusBoard,
  type TurnFocusInit,
  type VoiceCallFacts,
} from "./focus.js";
export {
  ACTIVENESS_PREFIX,
  AgentHandle,
  AgentHandleKey,
  MODE_PREFIX,
  voiceScope,
} from "./handle.js";
export { awaitBackfill, backfillLimit, replyParents, startBackfill } from "./history.js";
export { AgentIntents } from "./intents.js";
export {
  CEILINGS,
  type Ceiling,
  cappedTalk,
  ceilingFor,
  levelHint,
  modeDescription,
  modeLabel,
  UNCAPPED_INITIATIVES,
} from "./levels.js";
export { ACTING_ALONE, MainLine, MainTurn } from "./mainline/main.js";
export { COMMIT_SPEC, STEER_SPEC, slimTool } from "./mainline/output.js";
export {
  contextData,
  estimateTokens,
  fitHistory,
  mainMessages,
  mainRules,
  pinnedSection,
  promptTokens,
  proposalData,
  tailSection,
} from "./mainline/prompt.js";
export { linkMentions, type MentionTarget } from "./mentions.js";
export { AgentModule } from "./module.js";
export { PersonaHandle, PersonaHandleKey } from "./persona.js";
export {
  ADDRESSED,
  AMBIENT,
  afterFold,
  BOT_TAG,
  buildMessages,
  checkMessages,
  cleanReply,
  DATA_PREAMBLE,
  DEFAULT_TRANSCRIPT,
  dataMessage,
  EXAMPLES_TITLE,
  FOCUS_HEAD,
  FORMAT_RULES,
  FRESHNESS_RULE,
  focusMessage,
  GUARD_RULES,
  gapLine,
  INITIATIVE,
  INITIATIVE_HINT,
  INITIATIVE_SILENCE,
  INITIATIVE_TITLE,
  INTENT,
  INTENT_TITLE,
  INTERRUPTED,
  type IntentData,
  intentBody,
  MAX_PARENT_CHARS,
  NOTICE,
  PRESENT_TITLE,
  RULES,
  replyTag,
  rulesPrompt,
  SELF_HEAD,
  SELF_QUOTE_NAME,
  SITUATION,
  type Situation,
  SPOKEN_TAG,
  selfSection,
  situationPrompt,
  speaksReminder,
  speaksRule,
  splitMessage,
  TRANSCRIPT_RULES,
  type TranscriptOptions,
  transcriptLine,
  VOICE_ADDRESSED,
  VOICE_AMBIENT,
  VOICE_INITIATIVE,
  VOICE_INTENT,
  VOICE_PRESENT_TITLE,
  VOICE_RULES,
  VOICE_SITUATION,
} from "./prompt.js";
export { BARGE_IN_TOPIC, SUBTITLE_TOPIC } from "./runtime.js";
export {
  activityBlock,
  goalsBlock,
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
  type HistoryEntry,
  historyEntry,
  messageText,
  Session,
  type SessionParticipant,
} from "./session.js";
export {
  BUDGET_TOPIC,
  type BudgetState,
  EXHAUSTED_LINE,
  herStatusHint,
  parseBudgetState,
  shownHint,
  unansweredHint,
} from "./signals.js";
export {
  type FencedPiece,
  FenceSplitter,
  isSpeakable,
  LinkSplitter,
  LONG_CLAUSE_CHARS,
  SentenceSplitter,
} from "./speech.js";
export { ReactTool, ToolArgumentError } from "./tools.js";
export {
  CheckError,
  focusVerbs,
  markCurrent,
  parseCheck,
  TurnError,
  type TurnPlan,
  truncate,
} from "./turn.js";
export {
  allowedUrl,
  type FetchLike,
  type ImageCandidate,
  ImageLoader,
  imageParts,
  type LoadedImage,
  selectImages,
} from "./vision.js";
