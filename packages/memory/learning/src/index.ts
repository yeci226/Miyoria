// @miyoria/memory/learning: reflection and learning (docs/design/autonomy.md §19, phase G).
//
// * Module `conversation`: continuous conversation compaction. Every context's conversation is
//   folded into her own notes (free-form JSON + a recap) every few lines or after a pause, in
//   the background (`ConversationStatesKey`, prompt contributor `conversation`).
// * Module `knowledge`: her self-organized documents (`KnowledgeKey`): a fixed envelope
//   (subject, kind, title, per-field sources with confidence and privacy origin, versions, caps)
//   around schema-free content changed with JSON-patch-like operations; overwrite protection by
//   source; prompt contributor `knowledge` and tool `knowledge_note`.
// * Module `reflect`: feedback signals, lessons (`LessonsKey`, contributor `lessons`) and her
//   daily and light reflections (`ReflectionKey`).

export { type BudgetState, CallCap, type CapLimits } from "./caps.js";
export {
  type ConversationConfig,
  ConversationConfigSchema,
  type KnowledgeConfig,
  KnowledgeConfigSchema,
  knowledgeConfig,
  peopleInPrompt,
  type ReflectConfig,
  ReflectConfigSchema,
  reflectConfig,
  TidyConfigSchema,
  type TidyNightConfig,
} from "./config.js";
export {
  ConversationEngine,
  FEEDBACK_TOPIC,
  type FoldDeps,
  type FoldSkip,
  foldSchema,
  parseState,
  STATE_PREFIX,
  stateKey,
} from "./conversation.js";
export {
  applyDrafts,
  DRAFT_FORMAT,
  type Draft,
  DraftSchema,
  draftChange,
  OpSchema,
  type RefTable,
  resolveSubject,
} from "./drafts.js";
export {
  emojiTone,
  FEEDBACK_PREFIX,
  FeedbackTracker,
  phraseTone,
  type Who,
} from "./feedback.js";
export {
  type Applied,
  applyPatch,
  checkContent,
  cleanJson,
  DEFAULT_LIMITS,
  fitContent,
  formatPointer,
  getAt,
  isUnder,
  type JsonLimits,
  jsonChars,
  type OutlineOptions,
  outline,
  PatchError,
  parseOps,
  parsePointer,
} from "./json-doc.js";
export {
  DOC_PREFIX,
  docKey,
  effectiveSource,
  KnowledgeError,
  KnowledgeStore,
  limitsOf,
  originOf,
  originVisible,
  shortId,
  similarTitles,
  sourceTag,
} from "./knowledge.js";
export { isTalkLesson, LESSON_PREFIX, LessonStore } from "./lessons.js";
export {
  CachedSelfDocument,
  CONVERSATION_CONTRIBUTOR,
  ConversationModule,
  KNOWLEDGE_CONTRIBUTOR,
  KnowledgeModule,
  LESSONS_CONTRIBUTOR,
  type LearningModuleOptions,
  ReflectModule,
  reflectOnPeople,
  reflectUnder,
  subjectsFor,
} from "./modules.js";
export {
  MAX_CORRECTIONS,
  MAX_QUOTE,
  PersonReflectionError,
  type PersonReflectionReply,
  PersonReflectionSchema,
  personData,
  personRules,
  reflectionOf,
  type ShownMemory,
  TEXT_LIMITS,
} from "./person-reflect.js";
export { RECAP_STALE_MINS, recapAgeNote } from "./recap-age.js";
export {
  MAX_PUBLIC_FEELING,
  parseContextString,
  REFLECT_STATE_KEY,
  type ReflectDeps,
  type ReflectionReply,
  ReflectionSchema,
  Reflector,
  RUN_PREFIX,
} from "./reflect.js";
export { dropStale, noteUnits, similarity, touchUnits } from "./threads.js";
export { NightlyTidy, type NightlyTidyDeps, TIDY_GOAL, TIDY_STATE_KEY } from "./tidy.js";
export { KNOWLEDGE_TOOL, KnowledgeTool, type ToolDeps } from "./tool.js";
