// @miyoria/mind: her Deliberate calls (docs/design/v2-architecture.md §3.4, §3.7).
//
// Module `MindModule` (`mind`) runs two of the three small calls, each with its own short
// system (her 3–5 sentence character core, the task's rules, the JSON format):
//
// * Appraise, after an interaction segment ended: what it meant to her (at most 3 appraisals
//   and small feeling edits), into `AffectStateKey`.
// * Plan, on goal triggers (checked by cheap code), an activity ending, a cared-about person
//   coming online, her mood dropping, salient changes, suggestions and an adaptive heartbeat:
//   goal changes and 0–2 impulses for the Arbiter (`ArbiterKey`; until it runs, intents for the
//   agent). The first Plan of a day writes her day plan.
//
// Reflect lives in `@miyoria/learning`. Provides `MindKey` (the journal) and `GoalAgendaKey`.

export {
  type AppraiseInput,
  type AppraiseReply,
  type AppraiseResult,
  applyAppraisal,
  appraiseData,
  appraiseMessages,
  MAX_APPRAISALS,
  parseAppraiseReply,
  type Segment,
  type SegmentLine,
  Segments,
} from "./appraise.js";
export { type MindConfig, MindConfigSchema, mindConfig } from "./config.js";
export { type DesireInputs, rankDesires, renderDesire, type Whereabouts } from "./desire.js";
export {
  cleanTrigger,
  describeTrigger,
  GOAL_MIGRATION_KEY,
  GOAL_PREFIX,
  GoalBook,
  type GoalBookOptions,
  type GoalEdit,
  GoalError,
  goalKey,
  TriggerWatch,
} from "./goals.js";
export {
  type Condense,
  DIGEST_PREFIX,
  type DigestOptions,
  digestKey,
  intentCounts,
  Journal,
  ruleDigest,
  THOUGHT_PREFIX,
  thoughtKey,
} from "./journal.js";
export {
  fromLedger,
  type PlaceWait,
  type PlanLimits,
  renderEntries,
  renderLimits,
} from "./ledger.js";
export {
  applyTurnEvent,
  type MindDeps,
  MindLoop,
  outcomeOf,
  PLAN_STATE_KEY,
  resolveTrigger,
} from "./mind.js";
export { MIND_TOPICS, MindModule, type MindModuleOptions } from "./module.js";
export { type BudgetState, CallLog, heartbeatMs, localDay, type Pace, urgeOf } from "./pace.js";
export { type PresenceHabit, PresenceStats, renderHabit } from "./presence.js";
export {
  type CapabilityInfo,
  type PersonRef,
  PLAN_ASK,
  PLAN_FORMAT,
  type PlaceRef,
  type PlanInput,
  planData,
  planMessages,
  type WakeReason,
} from "./prompt.js";
export {
  type GoalDraft,
  type GoalEditDraft,
  type ImpulseDraft,
  isEmptyPlan,
  MAX_THOUGHT,
  MindReplyError,
  type PlanReply,
  parsePlanReply,
  parseTrigger,
  type TriggerDraft,
} from "./reply.js";
export {
  capabilityInfo,
  focusOf,
  type Gathered,
  gather,
  NOT_FOR_HER,
  personByRef,
  placeByRef,
  singing,
} from "./snapshot.js";
