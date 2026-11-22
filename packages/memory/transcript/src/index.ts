// @miyoria/memory/transcript: L1 of her memory. One transcript per session, kept on disk in the
// model's own message form (other people's lines, her lines, her tool calls and their results, her
// reasoning), append-only, compacted when it grows (docs/design/v5-brain.md B3).

export {
  type CompactionBudget,
  type CompactOptions,
  compactIdle,
  compactIfNeeded,
  type IdleCompactOptions,
  pickCut,
  type Summarise,
} from "./compact.js";
export {
  BOT_TAG,
  entriesOfMessages,
  entryOfIncoming,
  FLAGGED_LINE,
  FLAGGED_TITLE,
  flaggedBody,
  INTERRUPTED,
  type IncomingMeta,
  nameSpeakers,
  REMOVED,
  type RenderOptions,
  SELF_QUOTE_NAME,
  SHOWN_AS,
  SPOKEN_TAG,
  type SpeakerNames,
  type StepMeta,
  SUMMARY_TITLE,
  speakerNamesOf,
  toMessages,
} from "./convert.js";
export { transcriptSchema } from "./migrations.js";
export { pairedEntries, splitsPair } from "./pairing.js";
export { type SweepScheduleOptions, TranscriptSweepSchedule } from "./schedule.js";
export {
  ENTRY_KINDS,
  type TranscriptEntryRow,
  type TranscriptSessionRow,
  type TranscriptSummaryRow,
  transcriptEntries,
  transcriptSessions,
  transcriptSummaries,
} from "./schema.js";
export {
  contextText,
  DEFAULT_COVERED_DAYS,
  DEFAULT_IDLE_DAYS,
  REPLY_PARENT_LABEL,
  type ReplyParent,
  TranscriptError,
  TranscriptStore,
  transcriptTables,
} from "./store.js";
export { entryTokens, estimateTokens } from "./tokens.js";
export type {
  Amendment,
  AppendOptions,
  CompactionMeta,
  EntryInput,
  EntryKind,
  ImageRef,
  SessionState,
  StoredToolCall,
  SweepResult,
  TranscriptEntry,
  TranscriptRetention,
  TranscriptSummary,
  TranscriptTail,
} from "./types.js";
