// @miyoria/runtime/replay-log: the opt-in `replay` module that records what she perceives, and
// the log format it writes. The harness that plays a log back lives in tools/replay.

export {
  DEFAULT_RECORD_TOPICS,
  entryOf,
  entryTopic,
  formatEntry,
  isReplayInput,
  parseReplayLog,
  REPLAYED_MODULES,
  type ReplayEntry,
  type ReplayLog,
  ReplayLogError,
  type ReplayMeta,
  type ScriptedLlmConfig,
} from "./log.js";
export {
  logFileFor,
  ReplayConfigSchema,
  ReplayRecorderModule,
  type ReplayRecorderOptions,
} from "./recorder.js";
