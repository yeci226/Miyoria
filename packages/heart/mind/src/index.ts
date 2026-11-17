// @miyoria/heart/mind: what is left of her mind loop (docs/design/v5-heart.md §2.6, §2.10).
//
// Module `MindModule` (`mind`) keeps her thought journal (`MindKey`: her `feel` applications and
// her reflections, a line each), her goals (`GoalAgendaKey`; a goal whose trigger fires becomes an
// item of her inbox on the new runner), her life log (`LifeLogKey`) and her old timers
// (`ReminderDeskKey`, `remind_me` on the new runner's schedules). Appraise is her own `feel`;
// Plan, the daily plan, `desire` and her own starts are the new runner's (phase 4 step 5).
//
// Reflect lives in `@miyoria/memory/learning`.

export {
  type MindConfig,
  MindConfigSchema,
  mindConfig,
} from "./config.js";
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
  activityOfCapability,
  FUTURE_CAPABILITIES,
  LIFE_ACTIVITIES,
  type LifeActivity,
  type LifeOption,
  type LifeSituation,
  type LifeTally,
  lifeActivity,
  lifeOptions,
  lifeTable,
  NO_TALLY,
  overShare,
  type PeopleNeed,
  shareOf,
  unfit,
} from "./life/activities.js";
export {
  LIFE_PREFIX,
  LifeBook,
  type LifeBookOptions,
  pointOf,
  renderLately,
  renderLines,
  renderToday,
} from "./life/log.js";
export {
  type Deliver,
  type DeliveryOutcome,
  localWhen,
  parseAt,
  REMIND_NODE,
  REMINDER_PREFIX,
  RETRY_MS,
  type ReminderBackend,
  ReminderBook,
  type ReminderBookOptions,
  ReminderError,
  type ReminderInput,
  type ReminderLimits,
  remindCapability,
  reminderKey,
} from "./life/reminders.js";
export { goalReminder, type MindDeps, MindLoop, type Whereabouts } from "./mind.js";
export { MIND_TOPICS, MindModule, type MindModuleOptions } from "./module.js";
