// @miyoria/activity: the ActivityManager (docs/design/v2-architecture.md §3.2), the one owner of
// "what she is doing now".
//
// * `ActivityService` implements `ActivityManager` (`@miyoria/types`): three state machines
//   (presence, broadcast, activity) derived from the bus plus the tasks in flight; idempotent
//   requests serialized per resource; a task id per transition; `activity.*` events; a
//   `Notice` (`agent.notice`) back to the conversation that asked.
// * It is also the actuator registry's `ActivityRouter`: capabilities with an `activity`
//   mapping (`voice.join`, `stream.start`, `game.start`, `stage.scene`, ...) are handed to it
//   after the gate, whoever calls them.
// * Module `activity` (`[modules.activity]`) runs it.

export {
  type ActivityConfig,
  ActivityConfigSchema,
  defaultActivityConfig,
} from "./config.js";
export {
  BROWSE_CAPABILITIES,
  FACT_TOPICS,
  Facts,
  GAME_SESSION_TOPIC,
  GATE_DECISION_TOPIC,
  GOLIVE_TOPIC,
  type GoLiveState,
  type SessionEnd,
  type SessionFact,
  STAGE_STATUS_TOPIC,
  type StageFact,
  TASK_EVENT_TOPICS,
} from "./facts.js";
export { ActivityService, type ActivityServiceOptions, resourcesOf } from "./manager.js";
export { ActivityModule } from "./module.js";
export {
  type ActivityPort,
  failureCode,
  GatePort,
  type PrimaryStep,
  type StepCall,
  StepError,
} from "./port.js";
export { GAME_ACT_CAPABILITY, SteerDesk, type SteerDeskOptions } from "./steer.js";
export {
  answerText,
  CODE_TEXT,
  doneText,
  endedText,
  failedText,
  shortTask,
  what,
} from "./texts.js";
