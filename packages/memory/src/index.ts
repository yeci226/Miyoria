// @miyoria/memory: long-term memory (module `memory`).
//
// * Consolidation: when a context goes quiet (or many lines piled up), new log lines are
//   summarized by the `summarizer` purpose into an episode, facts, her own notes and followups,
//   written from her perspective, deduplicated against existing records and stored.
// * Retrieval: hybrid score of vector similarity, full text, recency, importance and "about
//   someone present", restricted to the scopes visible in the current context (`scope.ts`).
//   Embeddings are optional.
// * Privacy: what is learned in a DM stays in that DM.
// * Prompt contributor `memory`, tools `remember` / `recall`, commands
//   `/me memory show | forget | export`, `/admin memory wipe`, a `FollowupSource` and daily
//   forgetting.
//
// V3 (docs/design/v3-architecture.md §11) adds discipline, not a new system:
// * Three layers: `PinnedMemory` (persona, rules, open commitments, one line per person present:
//   always in the prompt, capped, never retrieved), the EventLog as evidence, and derived memory
//   behind `MemoryRetrieval`.
// * Every memory says whether she lived it or was told it (`origin`); a person fact is stored
//   only when a line somebody said backs it (`evidence.ts`); what is happening right now is
//   refused, the state machine answers that. Confidence fades on read.
// * `forget` follows the evidence: what is about a person, told by them or derived from their
//   events goes; the log itself has its own wipe.

export {
  FORGET_KEEPS,
  FORGET_REMOVES,
  type MemoryCommandDeps,
  MemoryCommands,
  NODE_WIPE,
  type OwnMemories,
  ownMemories,
  PATHS,
  WIPE_SCOPE_LABEL,
  type WipeScope,
  wipeModules,
  wipePlan,
} from "./commands.js";
export {
  type DedupeConfig,
  DedupeConfigSchema,
  type EmbeddingConfig,
  EmbeddingConfigSchema,
  type EvidenceConfig,
  EvidenceConfigSchema,
  embeddingConfig,
  type ForgettingConfig,
  ForgettingConfigSchema,
  type GuildScope,
  GuildScopeSchema,
  type MemoryConfig,
  MemoryConfigSchema,
  memoryConfig,
  type PinnedConfig,
  PinnedConfigSchema,
  type RepeatConfig,
  RepeatConfigSchema,
  type Weights,
  WeightsSchema,
} from "./config.js";
export {
  CONTRIBUTOR_KEY,
  formatLines,
  lineOf,
  MemoryContributor,
  PROMPT_KINDS,
  type Readable,
  readable,
  SECTION_TITLE,
} from "./contributor.js";
export { Curator } from "./curate.js";
export {
  buildEmbedder,
  cosine,
  type Embedder,
  EmbeddingError,
  NoEmbedder,
  OpenAiCompatibleEmbedder,
} from "./embed.js";
export {
  type ConsolidationReport,
  type ForgetReport,
  MAINTENANCE_KEY,
  type MaintenanceReport,
  MemoryEngine,
  MemoryEngineKey,
  type MemoryEngineOptions,
  MemoryError,
  matchesKeyword,
  memoryFilter,
  type NewMemory,
  type Recalled,
  type Refusal,
  type Searched,
  type Stored,
  storedId,
  strongerOrigin,
  toFollowup,
  WATERMARK_PREFIX,
  type Watermark,
  weakerOrigin,
} from "./engine.js";
export {
  type EventReader,
  type EvidenceLine,
  isEventRef,
  LINE_REF_PREFIX,
  linkLines,
  mergeRefs,
  nameWords,
  supporting,
} from "./evidence.js";
export {
  expired,
  expiryOf,
  isPresentState,
  isStateLifetime,
  MAX_VALID_HOURS,
  wordingTtlHours,
} from "./expiry.js";
export {
  type ExEpisode,
  type ExFact,
  type ExFollowup,
  type ExNote,
  type Extraction,
  ExtractionError,
  parseExtraction,
  type SubjectName,
  systemPrompt,
  transcript,
} from "./extract.js";
export {
  type Activity,
  ActivityTracker,
  MemoryModule,
  MemoryModuleError,
  type MemoryModuleOptions,
} from "./module.js";
export { PersonNotes } from "./person-note.js";
export { PINNED_TITLE, PinnedReader } from "./pinned.js";
export { RepeatDamper } from "./repeat.js";
export { MemoryRetriever } from "./retrieval.js";
export {
  hasScope,
  isPrivate,
  presentPeople,
  requestScopes,
  scopeEquals,
  scopeForNew,
  scopeLabel,
  visibleScopes,
  visibleToSelf,
} from "./scope.js";
export {
  effectiveConfidence,
  fadedConfidence,
  finalScore,
  recency,
  recencyTau,
  relativeDate,
  type Signals,
  signalScore,
  signals,
  tokenOverlap,
} from "./score.js";
export { normalizeForCompare, textSimilarity, tokenize, tokenString } from "./tokenize.js";
export { MemoryToolError, RECALL, REMEMBER, RecallTool, RememberTool } from "./tools.js";
