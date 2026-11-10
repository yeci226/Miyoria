// @miyoria/actions: everything she can do, behind one gate.
//
// * A `Capability` wraps one action (join voice, go live, switch scene, play, DM, ...) with a
//   risk tier, a zod argument schema and an executor. The module owning the wrapped service
//   registers it in the app's `ActuatorRegistry` (`ActuatorRegistryKey`).
// * `ActuatorRegistry.invoke` runs the gate (pause → prohibitions → consent → permission →
//   budget → risk: rate limits, self-review, owner approval), records the decision (audit log +
//   `gate.decision`) and executes. Callers say who they act for with a `Principal`
//   (`@miyoria/types`): her tools (`user` / `self`), slash commands (`command`, with override),
//   the panel (`panel`) and the game director (`director`).
// * Capabilities with a `tool` are offered to the model as tools in reactive turns. High-risk
//   tools whose result matters (`tool.followup`) wait briefly and otherwise report back in a
//   follow-up turn (`Followups`).
// * Module `actions` applies `[modules.actions]` and serves `/admin autonomy ...` and
//   `/me privacy`.

export {
  builtinCapabilities,
  dmCapability,
  handleLookup,
  messageDm,
  type NameLookup,
  priorityFor,
  recipient,
  speak,
  testHigh,
} from "./builtin.js";
export {
  ActionDeniedError,
  ActionDroppedError,
  type ActionOutcome,
  type ActionRequest,
  type ActionResult,
  type ApprovalDetail,
  type Capability,
  CapabilityError,
  type CapabilityTool as CapabilityToolInfo,
  type ConsentKind,
  type DeniedContext,
  defineCapability,
  deniedText,
  type ExecContext,
  type GateDecision,
  type GateStage,
  type Risk,
} from "./capability.js";
export {
  NODE_APPROVE,
  NODE_PRIVACY,
  NODE_TOGGLE,
  NODE_VIEW,
  PATHS as COMMAND_PATHS,
} from "./commands.js";
export {
  type ActionsConfig,
  ActionsConfigSchema,
  capabilityMatches,
  defaultActionsConfig,
  type Limit,
  type TierLimit,
} from "./config.js";
export { type EmergencyDeps, EmergencyStop } from "./emergency.js";
export {
  FOLLOWUP_MAX_AGE_MS,
  FOLLOWUP_REASON,
  FOLLOWUP_RETRY_MS,
  Followups,
  followupHint,
  MAX_FOLLOWUP_CHARS,
} from "./followup.js";
export { GatedToolsKey, isGatedToolName } from "./gated.js";
export { ActionsModule, actuatorsFor } from "./module.js";
export {
  ACTION_OUTCOME_TOPIC,
  type ActionOutcomeRecord,
  ledgerSource,
  NOTICE_TTL_MS,
  outcomeNotice,
} from "./outcome.js";
export {
  DEFAULT_PRIVACY,
  PRIVACY_PROFILE,
  Privacy,
  type PrivacyChoices,
  privacyKey,
} from "./privacy.js";
export { effectiveLimits, type Limits, RateLimiter, tightened } from "./rate.js";
export {
  type ActivityMode,
  type ActivityRouter,
  ActuatorRegistry,
  ActuatorRegistryKey,
  type ActuatorRegistryOptions,
  type DirectRun,
  GATE_DECISION_TOPIC,
  type InvokeOptions,
  PAUSED_KEY,
  type RoutedCall,
  SELF_REVIEWER,
  type StatusProvider,
} from "./registry.js";
export {
  type Answer,
  APPROVE_ROUTE,
  type ApprovalInfo,
  approvalCard,
  DENY_ROUTE,
  Escalations,
  type PendingApproval,
  parseReview,
  ReviewError,
  type ReviewInput,
  type ReviewReply,
  type ReviewVerdict,
  reviewMessages,
} from "./review.js";
export { CapabilityTool, REQUEST_RULE, RESULT_PENDING, REVIEW_PENDING } from "./tools.js";
