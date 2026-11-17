// @miyoria/replay: plays a recorded log (`@miyoria/runtime/replay-log`) through the real
// pipeline with a scripted LLM and fake platforms, measuring the v2 §4 targets.

export { type ReplaySink, ScriptedLlm, type SubmittedAction } from "./fakes.js";
export {
  type Address,
  buildReport,
  formatReport,
  type Rate,
  type ReplayReport,
  type TurnLine,
} from "./report.js";
export { type ReplayClock, type ReplayRun, type ReplayRunOptions, replay } from "./runner.js";
