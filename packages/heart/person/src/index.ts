// @miyoria/heart/person: her numbers and words for each person, and the rules that move them
// (docs/design/v5-heart.md §2.2, §2.3; phase 4 step 1, "資料和規則").
//
// - `model.ts`: a person as a `heart_person` row (nine numbers, her words about them, the tier
//   anchors, when she last saw them, `legacy`).
// - `rules.ts`: pure functions. The size of a `feel` proposal, the repeat damping, the daily caps
//   (H3), the anchors a tier needs (H4), the daily decay (H9) and the one definition of 在意.
// - `log.ts`: a change is one `heart.changed` event and evidence one `heart.evidence`; a
//   person's history and the day's ledger are read from them.
// - `legacy.ts`: the migration from `relationships`, `relationship_deltas`, the
//   `self:feeling:<person>` cards and the `hearts` of `self:state`.
// - `config.ts`: every number of the rules, with its default.
// - `schema.ts`, `migrations.ts`, `store.ts`: the `heart` store plugin (`heart_person`,
//   `heart_self`) and the code that writes a row and its event in one transaction.
// - `place.ts`, `public.ts`: where a bond is (tier, next tier, the ring); what a member may see of
//   it (words, the ring, the tier; no raw value).
// - `ring-image.ts`: the key through which the api's renderer gives `/me profile` the ring's PNG.
// - `module.ts`: module `heart`, the owner of the tables: its config section, the migration on
//   start, the daily pass and `HeartKey` (`@miyoria/types`), through which her `feel` is applied.
// - `directory.ts`, `commands.ts`, `call-name-tool.ts`: who people are (accounts, names, `/me link`),
//   `SocialSignalsKey` from the rows, `/me profile | call | link`, `/admin person ...` and the tool
//   `set_call_name` (the old `social` module's, phase 4 step 5).
// - `old-cards.ts`: the old `self:feeling:*` cards, read once by the migration.
// - `effects.ts`, `together.ts`: the economy's effects (cause `evidence`) and the evidence of time
//   together in voice and songs heard.

export { callNameCapability } from "./call-name-tool.js";
export {
  CLEAR_WORDS,
  checkCallName,
  FEELINGS,
  labelOf,
  NODE_OWNER_TAG,
  PATHS,
  type RingImages,
  registerCommands,
  type ScreenCallName,
  UNFIT_CALL_NAME,
  unregisterCommands,
} from "./commands.js";
export {
  type HeartPersonConfig,
  HeartPersonConfigSchema,
  heartPersonConfig,
} from "./config.js";
export {
  attitudeOf,
  type DirectoryStores,
  type LinkOutcome,
  PeopleDirectory,
  PeopleDirectoryKey,
} from "./directory.js";
export { GAIN_QUOTES, HeartEffects } from "./effects.js";
export {
  type LegacyHearts,
  type LegacyInput,
  type LegacyResult,
  migrateLegacy,
  parseLegacyHearts,
} from "./legacy.js";
export {
  changeWrite,
  evidenceWrite,
  HEART_SOURCE,
  type HeartEvidenceEntry,
  type HeartHistoryEntry,
  HeartLog,
} from "./log.js";
export { heartSchema } from "./migrations.js";
export {
  type AnchorSource,
  BLOCKED_TAG,
  clampField,
  type Direction,
  FIELD_RANGE,
  goodDirection,
  HEART_FIELDS,
  type HeartCause,
  type HeartField,
  type HeartPerson,
  hasAnchor,
  hasTag,
  isProposalField,
  newPerson,
  OWNER_TAG,
  PROPOSAL_FIELDS,
  type ProposalField,
  type TierAnchor,
} from "./model.js";
export {
  DECAY_BATCH,
  type HeartConfig,
  HeartConfigSchema,
  HeartModule,
  type HeartModuleOptions,
  HeartService,
  lineOf,
  MIGRATED_KEY,
  type MigrationDeps,
  migrateOnStart,
  runDecay,
  SELF_ACCOUNTS_KEY,
  togetherOf,
} from "./module.js";
export {
  type BondLedger,
  type BondSnapshot,
  type CardExtras,
  type CardLegacy,
  type CardRecord,
  FEELING_PREFIX,
  feelingKey,
  readOldCards,
} from "./old-cards.js";
export { type BondPlace, type BondRingPlace, bondPlace } from "./place.js";
export { type PublicBond, type PublicRing, publicBond } from "./public.js";
export {
  type BondRingImageSpec,
  type BondRingImages,
  BondRingImagesKey,
} from "./ring-image.js";
export {
  ANCHORED_TIERS,
  type AppliedChange,
  applyBond,
  applyChange,
  applyDecay,
  type BondResult,
  bondGainCap,
  bookChange,
  CAPPED_CAUSES,
  CARE_BY_TIER,
  CARES_THRESHOLD,
  capLeft,
  cares,
  caresBase,
  type DayLedger,
  type DecayPass,
  dailyCap,
  dayStart,
  decayDay,
  emptyLedger,
  type FieldLedger,
  familiarityGain,
  type HeartChange,
  type HeartChangeRequest,
  heldTier,
  isNegative,
  type LocalDay,
  ledgerFrom,
  lineDepth,
  localDay,
  proposalStep,
  repeatFactor,
  settle,
  startingEase,
  startingRapport,
  warmthBaseline,
} from "./rules.js";
export { type HeartPersonRow, type HeartSelfRow, heartPerson, heartSelf } from "./schema.js";
export {
  type HeartApplied,
  type HeartApplyOptions,
  type HeartListEntry,
  type HeartListOptions,
  type HeartPersonPage,
  HeartSelfStore,
  HeartStore,
  type HeartTables,
  heartTables,
  type TierEntered,
  type TierListener,
} from "./store.js";
export { MIN_TOGETHER_MS, type SongHeard, type StayEnded, Together } from "./together.js";
export { recordOf, viewOf } from "./view.js";
