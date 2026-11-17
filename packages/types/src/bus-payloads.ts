// Payloads of bus topics whose owning package does not depend on the contracts directly: the gate
// decision (`gate.decision`) and the LLM budget (`llm.budget`). Both are the types inferred from
// the schemas in @miyoria/contracts/events.

import type {
  ActionOutcomeData,
  DirectorTraceData,
  GameSkillData,
  GateDecisionData,
  GoalEndData,
  LlmBudgetData,
  MoodNudgeData,
} from "@miyoria/contracts/events";

/** Payload of `gate.decision` (contract: `GateDecisionSchema` in @miyoria/contracts/events). */
export type GateDecisionPayload = GateDecisionData;

/** Payload of `llm.budget` (contract: `LlmBudgetSchema` in @miyoria/contracts/events). */
export type LlmBudgetPayload = LlmBudgetData;

/** Payload of `actions.outcome` (contract: `ActionOutcomeSchema` in @miyoria/contracts/events). */
export type ActionOutcomePayload = ActionOutcomeData;

/** Payload of `game.director.goal` (contract: `GoalEndSchema` in @miyoria/contracts/events). */
export type GoalEndPayload = GoalEndData;

/** Payload of `game.director.skill` (contract: `GameSkillSchema` in @miyoria/contracts/events). */
export type GameSkillPayload = GameSkillData;

/** Payload of `game.director.decision` (contract: `DirectorTraceSchema` in @miyoria/contracts/events). */
export type DirectorTracePayload = DirectorTraceData;

/** Payload of `mood.nudge` (contract: `MoodNudgeSchema` in @miyoria/contracts/events). */
export type MoodNudgePayload = MoodNudgeData;
