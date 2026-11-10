// @miyoria/game: the game director (module `game`).
//
// A game adapter extension registers the task executor of `game.<id>` (v2 §3.8) and publishes
// `game.<id>.*` events. While a session runs (`game start`) the director observes the game
// through the executor every `decide_secs` (sooner on trigger events), asks the LLM purpose
// `game` (JSON mode) for `{goal, goal_status, action, commentary, mood_nudge}` and starts the
// action as a task with an id and a budget (`game.act`, through the gate); the task's
// `game.<id>.task.done|failed` event (with a failure code) ends it, and every goal that ends is
// published on `game.director.goal` with its code. A goal has a success condition (her
// inventory) and survives a failed attempt; a `done` that changed nothing is no progress; the
// same method (action and item) failing the same way twice is held, so she changes method; her
// record of attempts, the holds and the skills she learned are in every decision; night and
// death start survival goals by themselves (docs/design/v4-plan.md §11.2). It consumes
// `queue.item_activated` items of kind `game_goal` as locked goals; requests live commentary
// with `agent.initiative` (reason `game`); nudges the mood on deaths and achievements; and
// contributes a `game` prompt section. The one timeout policy is in `timeouts.ts`.

export { GAME_ACT, safeActCall } from "./actions.js";
export {
  type ChatLine,
  chatLine,
  type Delivery,
  deliveryFor,
  GameChat,
  type GameChatConfig,
  GameChatConfigSchema,
  GameChatModule,
  gameChatContext,
  LINK_TOPIC,
  playerId,
  REPLY_ROUTES,
  type ReplyRoute,
} from "./chat.js";
export { GAME_CHAT_MAX, sanitizeGameChat } from "./chat-text.js";
export { formatStatus, registerCommands } from "./commands.js";
export {
  defaultGameConfig,
  type GameConfig,
  GameConfigSchema,
  type GamePermissions,
  GamePermissionsSchema,
} from "./config.js";
export {
  ActionCall,
  type Decision,
  type GoalFacts,
  type GoalSource,
  goalLocked,
  goalNote,
  judge,
  type MoodNudge,
  type PromptParts,
  parseDecision,
  prompts,
  type ReportedStatus,
  type Verdict,
  verdictDebug,
  type Want,
  wantMet,
} from "./decision.js";
export {
  type ChatHandled,
  DECISION_TOPIC,
  Director,
  GameChatKey,
  GameError,
  type GameStatus,
  GOAL_TOPIC,
  type GoalEnd,
  type GoalEndCode,
  type GoalView,
  INITIATIVE_REASON,
  type Persona,
  type Placement,
  type Preflight,
  SESSION_TOPIC,
  View,
} from "./director.js";
export {
  activeGuard,
  afterSuccess,
  type FailureGuard,
  guardAfter,
  guardNote,
  withheld,
} from "./guard.js";
export { LIVE_TOPICS, LiveState } from "./live.js";
export {
  FINAL_CODES,
  INTERRUPTION_CODES,
  MethodGuard,
  type MethodHold,
  methodKey,
} from "./methods.js";
export {
  GameControl,
  GameControlKey,
  GameHandle,
  GameHandleKey,
  GameModule,
  PROMPT_KEY,
} from "./module.js";
export { type Attempt, AttemptRecord, type AttemptResult } from "./record.js";
export { SKILL_TOPIC, type Skill, SkillBook } from "./skills.js";
export {
  budgetFor,
  codeOf,
  GameTaskError,
  gameExecutor,
  goalCatalog,
  observationText,
  observeWithin,
  offersGoal,
  runTask,
  type TaskEnd,
} from "./tasks.js";
export {
  type GameTimeoutConfig,
  OUTER_DEFAULTS,
  type TimeoutValues,
  timeoutValues,
  timeoutViolations,
} from "./timeouts.js";
