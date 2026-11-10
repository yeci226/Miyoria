// @miyoria/replay: record what she perceives (the opt-in `replay` module) and replay it through
// the real pipeline with a scripted LLM and fake platforms, measuring the v2 §4 targets.

export { type ReplaySink, ScriptedLlm, type SubmittedAction } from "./fakes.js";
export {
  DEFAULT_RECORD_TOPICS,
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
  type ReplayConfig,
  ReplayConfigSchema,
  ReplayRecorderModule,
  type ReplayRecorderOptions,
} from "./recorder.js";
export {
  type Address,
  buildReport,
  formatReport,
  type Rate,
  type ReplayReport,
  type TurnLine,
} from "./report.js";
export { type ReplayClock, type ReplayRun, type ReplayRunOptions, replay } from "./runner.js";
