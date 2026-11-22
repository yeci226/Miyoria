// @miyoria/brain/self: the turn runner of phase 3 (docs/design/v5-brain.md). One run: what woke
// her, a profile, and ports for everything outside (transcript, tools, model, prompt blocks,
// guard, outlet). Not wired into the running system yet.

export {
  DayPool,
  type DayState,
  DEFAULT_DELEGATE_LIMITS,
  type DelegateEvent,
  type DelegateLimits,
  Delegator,
  type DelegatorPorts,
  ENDED_STATES,
  isEnded,
  type JobRow,
  type JobState,
  type JobStore,
  type JobUsage,
  MAX_GOAL_CHARS,
  MemoryJobStore,
  noUsage,
  PoolLedger,
  type StartOutcome,
  type StartSpec,
} from "./delegate.js";
export * as delegateTexts from "./delegate-texts.js";
export {
  askerOf,
  DELEGATE,
  DELEGATE_CANCEL,
  DELEGATE_LIST,
  DELEGATE_READ,
  DELEGATE_TOOLS,
  type DelegateToolDeps,
  delegateTools,
} from "./delegate-tools.js";
export {
  type FeelDropReason,
  type FeelLine,
  type FeelSelf,
  isFeelLine,
  limitProposals,
  MAX_FEEL_LINES,
  MAX_FEEL_PEOPLE,
  type ParsedFeel,
  parseFeel,
} from "./feel.js";
export { composeGuards, permissiveGuard } from "./guard.js";
export {
  HOUR_TOKENS,
  HOUR_USD,
  type LimitName,
  PREFIX_PROFILE,
  PROFILE_NAMES,
  PROFILES,
  type ProfileName,
  type RunLimits,
  type RunProfile,
  SILENT_WAIT_MS,
  VOICE_TOOLS,
  withLimits,
} from "./profiles.js";
export {
  gatherBlocks,
  type PromptBlocks,
  type RunMessages,
  runMessages,
  serialiseMessages,
  serialiseTools,
  toolSpecs,
  wakeLine,
} from "./prompt.js";
export * as rules from "./rules.js";
export {
  capMinutes,
  DEFAULT_COMPACTION,
  type RunnerOptions,
  SelfRunner,
  STATE_VERSION,
} from "./run.js";
export { SAY, type SayDeps, type Spoken, sayTool } from "./say.js";
export {
  ALL_CHECKS,
  asideLine,
  type OutputChecks,
  type ScreenedLine,
  StepText,
  type TextUnit,
} from "./screens.js";
export { floorKind, type ServiceGuardOptions, sayKind, serviceGuard } from "./service-guard.js";
export { type Capped, type HourCap, type HourSpend, SpendLedger, stepCost } from "./spend.js";
export {
  CALLABLE_KINDS,
  fixedTools,
  helperGuard,
  helperPrompt,
  isolatedTranscript,
  isSubagentKind,
  jobBudget,
  jobTools,
  KINDS,
  type KindSpec,
  noMouth,
  profileOf,
  SUBAGENT_KINDS,
  type SubagentKind,
  TOKENS_PER_USD,
} from "./subagents.js";
export { modelSummarise, summaryText } from "./summarise.js";
export {
  addressedReason,
  DEFAULT_TRIAGE,
  GLANCES_PER_HOUR,
  HOUR_MS,
  noteGlance,
  type TriageConfig,
  type TriageDecision,
  type TriageEvent,
  type TriageState,
  triage,
} from "./triage.js";
export {
  type AddressedReason,
  ALLOW,
  type CallRecord,
  type Delivery,
  type Guard,
  type GuardCall,
  type GuardContext,
  type GuardVerdict,
  type ModelStream,
  type OutgoingLine,
  type Outlet,
  type PromptInput,
  type PromptSource,
  type RunEvent,
  type RunInput,
  type RunModel,
  type RunOutcome,
  type RunPorts,
  type RunResult,
  type RunSession,
  type RunTools,
  type RunUsage,
  refuse,
  type ScreenKind,
  someoneWaits,
  type Wake,
  type WakeAuthor,
  type WakeKind,
  wakeAuthor,
} from "./types.js";
