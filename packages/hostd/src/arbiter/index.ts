// GPU arbitration (docs/design/v5-gpu.md): the song worker's decisions, moved into hostd and
// checked against the table recorded from the Python (workers/sing/gpu_decisions.json).
export { Arbiter, type ArbiterEvent, type ArbiterOptions, type Timers } from "./arbiter.js";
export {
  type Action,
  type ByCard,
  type Card,
  type ClientFacts,
  type DeviceReading,
  HISTORY_KEPT,
  type HistoryEntry,
  JobState,
  LOW_FREE_READS,
  type Machine,
  STEP_WINDOW,
} from "./job.js";
export {
  CPU_STAGES,
  LIMITS_DEFAULT,
  LIMITS_ENV,
  type Limits,
  limitsFrom,
  POLICIES,
  type Policy,
  type PolicySource,
  policyFrom,
  type Settings,
} from "./limits.js";
export { median, pyFixed, pyFloat, pyInt, pyRepr, pyRound } from "./num.js";
export {
  type Decision,
  type DecisionMode,
  decide,
  type Facts,
  gb,
  headroom,
  silenceEstimate,
  urgentOf,
  yieldAllowance,
  yieldHold,
} from "./rules.js";
export {
  Audience,
  type AudienceContext,
  CardProfile,
  type CardProfileData,
  type CardRecord,
  type Clock,
  type PeerClient,
  type ProfileStore,
  RELOAD_PRIOR_S,
  SPEECH_READ_EVERY_S,
  SPEECH_READ_TIMEOUT_S,
  SpeechReader,
  type SpeechState,
  type Tenant,
  truthy,
} from "./state.js";
export { holdersFrom, type RunningService, tenantsFrom } from "./tenants.js";
