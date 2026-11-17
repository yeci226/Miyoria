// @miyoria/brain/selfhost: the text and voice conversations on the phase-3 turn runner
// (`@miyoria/brain/self`), wired to today's services. Core installs `selfHost()` on the agent
// module.

export {
  GateBook,
  type GateConfig,
  type GateFacts,
  type GateName,
  type GateSnapshot,
  type GateVerdict,
  keyOf,
  OPPORTUNITY_KINDS,
  type Opportunity,
  type OpportunityKind,
} from "./gates.js";
export { SelfHost, type SelfHostOptions, selfHost } from "./host.js";
export { ADMITTED_NOTES, NOTICE_TOOL } from "./impulse-texts.js";
export { ImpulseDesk, type ImpulseDeskHost } from "./impulses.js";
export {
  INITIATIVE_STATE_KEY,
  Initiative,
  type InitiativeOptions,
  ScheduleRemindersKey,
  startInitiative,
} from "./initiative.js";
export {
  gateConfig,
  type InitiativeConfig,
  InitiativeConfigSchema,
  type InitiativeSettings,
  initiativeFromConfig,
  initiativeSettings,
} from "./initiative-config.js";
export { initiativeSchema } from "./initiative-migrations.js";
export {
  type InboxRow,
  InitiativeStore,
  initiativeTables,
  type ScheduleRow,
} from "./initiative-store.js";
export {
  DELEGATE_OWNER,
  JobsHost,
  type JobsHostDeps,
  type JobsHostOptions,
  type RunReflectDeps,
  runReflect,
  settingsJobStore,
  taskEventOf,
} from "./jobs.js";
export {
  type AdmittedAnswer,
  type AdmittedInput,
  Lane,
  type LaneHost,
  type LaneInput,
  type LaneRun,
  selfStarted,
} from "./lane.js";
export { MouthOutlet, type Settled, Settlements, submitTyping, TYPING_TTL_MS } from "./outlet.js";
export { type PlaceBook, resolvePlace } from "./places.js";
export {
  HostPrompt,
  type HostPromptOptions,
  RECAP_TITLE,
  type SlowReads,
  type Speaker,
  speakersOf,
  type WarmSlot,
} from "./prompt.js";
export {
  type ParseAt,
  parseWhen,
  type ReminderBackend,
  ScheduleBook,
  scheduleKey,
} from "./schedule.js";
export { SCHEDULE, SCHEDULE_CANCEL, SCHEDULE_LIST, scheduleTools } from "./schedule-tools.js";
export { silentWaits, VoiceHost, type VoiceHostDeps, type VoiceLineFacts } from "./voice.js";
export { type VoiceInput, VoiceLane, type VoiceLaneHost, type VoiceRun } from "./voice-lane.js";
export { PlaceOutlet, VoiceOutlet, type VoiceOutletHost } from "./voice-outlet.js";
export { VoicePrompt, type VoiceRoom, voiceReads, WarmValues } from "./voice-prompt.js";
