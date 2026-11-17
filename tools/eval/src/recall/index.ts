// Recall evaluation of her long-term memory: a labelled set (memories, and lines with the
// memories that should come back), a harness that asks the engine the way a turn does, and
// recall@k / MRR / scope-leak numbers to compare a rebuilt memory against today's.

export {
  DEFAULT_KS,
  leaksOf,
  type QueryResult,
  type RecallMetrics,
  type Returned,
  scoreRecall,
  visibleAt,
} from "./metrics.js";
export { noteScopeOf, runNotesRecall, viewerAt } from "./notes.js";
export {
  formatRecallReport,
  formatSweep,
  type MemorySuiteOptions,
  memorySuite,
} from "./report.js";
export {
  CachedEmbedder,
  RECALL_TARGETS,
  type RecallConfigOverrides,
  type RecallOptions,
  type RecallResult,
  type RecallTarget,
  runRecall,
  type SweepRow,
  type SweepVariant,
  sweepRecall,
} from "./run.js";
export {
  loadRecallSet,
  type RecallMemory,
  RecallMemorySchema,
  type RecallPlace,
  type RecallQuery,
  RecallQuerySchema,
  type RecallScope,
  RecallScopeSchema,
  type RecallSet,
  RecallSetError,
  RecallSetSchema,
} from "./set.js";
