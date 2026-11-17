// @miyoria/heart/self: her inner state (docs/design/autonomy.md §4, §23).
//
// Module `SelfModule` (`self`) keeps her feelings with one writer (docs/design/v2-architecture.md
// §3.6): three layers at three speeds. Drives (六欲: social, play, attention, rest, curiosity,
// esteem, hunger, longing) and boredom drift on their own and drop when something satisfies
// them. Emotions (七情 and a few more: discrete, coexisting, each fading toward its baseline at
// the pace the profile's temperament sets) have only two inputs, rule events (`events.ts`)
// and appraisals (an emotion, a strength, who it is about); the dynamics (`dynamics.ts`:
// habituation, mutual inhibition, a stir budget) turn them into numbers. How she feels about each
// person is the heart's (`heart_person`, module `heart`), read here for 在意 and longing.
// Mood is not stored: it is derived from the three layers and the hour. What she shows of what
// she feels is a pure function of her display rules and who is there (`display.ts`).
//
// Provides `AffectStateKey` (the one service for all of that, with the canonical prompt text
// of her mood) beside `SelfStateKey` (policy, agenda and the older reads) and `MoodSignalsKey`.
// What each emotion goes on to do is the table `EMOTION_OUTPUTS` of `@miyoria/types`.
//
// Persisted in `heart_self` (the store's `heart` plugin), written only when it changed: drives,
// emotions, policy and agenda. The old `self:state` settings record is read once, when
// `heart_self` is still empty, and never written again.

export {
  type AffectDeps,
  AffectService,
  type AppliedEffect,
  MAX_APPRAISALS,
  MAX_PROMISES,
} from "./affect.js";
export { type BiasInputs, computeBiases, MAX_BIAS, MIN_WANT } from "./biases.js";
export {
  type EmotionsConfig,
  type SelfConfig,
  SelfConfigSchema,
  selfConfig,
} from "./config.js";
export { type Audience, shownEmotion } from "./display.js";
export {
  BUDGET_WINDOW_MS,
  HABITUATION_WINDOW_MS,
  Habituation,
  habituationFactor,
  INHIBITION_SHARE,
  INHIBITS,
  StirBudget,
} from "./dynamics.js";
export {
  BASE_BASELINES,
  BASE_HALF_LIFE_MINS,
  BASE_TOWARD_HALF_LIFE_MINS,
  type DisplayRules,
  EmotionEngine,
  type Excitation,
  type Excited,
  fade,
  stir,
  type Temper,
  type Temperament,
  type TemperamentInput,
  temperament,
} from "./emotions.js";
export { type Circumstances, IDLE, SavedSchema, SelfEngine, SelfError } from "./engine.js";
export {
  type Effect,
  eventEffects,
  NO_CONTEXT,
  type RuleContext,
  socialEffects,
  strengthOf,
} from "./events.js";
export {
  eventDelta,
  parseAffectEvent,
  SelfModule,
  type SelfModuleOptions,
  STATE_KEY,
} from "./module.js";
export { EmotionRules, type RuleDeps } from "./rules.js";
export { SelfService, type SelfServiceDeps } from "./state.js";
