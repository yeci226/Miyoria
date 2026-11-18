// @miyoria/play/cards: her cards for each person (docs/design/v5-play.md §2, §6.3, §10; cards.md).
//
// - `catalogue.ts`: the slots, rarities, series and the catalogue `cards_parts` is seeded with.
// - `draw.ts`: the draw as pure functions with the random source passed in: the rarity by the
//   public weights, the pity, the parts allowed for that rarity, her expression by relationship.
// - `expressions.ts`: which expressions each tier of the relationship may show.
// - `odds.ts`: the public odds table, from the catalogue and the draw's own helpers.
// - `dex.ts`: series progress and titles, and what a wishlist may hold.
// - `config.ts`: `[modules.cards]` (price, daily cap, pity, rarity weights; the drops' part in
//   `drop-config.ts`).
// - `drops.ts`: when she drops a card in a lively channel that opted in, and the button's route.
// - `legacy.ts`: the old collectibles, kept as the closed series 舊收藏.
// - `schema.ts`, `migrations.ts`, `store.ts`: the `cards` store plugin (`cards_card`, `cards_parts`,
//   `cards_pity`, `cards_dex`, `cards_wishlist`, `cards_titles`) and the transaction that writes a
//   card with its pity, dex, titles and events (`events.ts`).
// - `notes.ts`: the line she hears of a card worth a word (a milestone, a rare one, the pity, a
//   wish, a title).
// - `faces.ts`: the port her words on a card nobody asked for come through (`CardFacesKey`, the
//   api's to provide): a milestone card.
// - `portrait.ts`: the seam for her rendered picture (`CardPortraitKey`), and the fixed portrait
//   nearest each expression until it exists.
// - `wallet.ts`: the port through which a card is paid (`CardWalletKey`, the economy's to provide).
// - `service.ts`, `module.ts`: module `cards` and `CardsKey`: issuing a daily card, the odds, a
//   person's pity, dex and wishlist.

export {
  drawPool,
  isRare,
  isRarity,
  isSlot,
  type Part,
  RARITIES,
  type Rarity,
  rarityRank,
  SEED_PARTS,
  SERIES,
  type Series,
  SLOT_NAMES,
  SLOTS,
  type Slot,
  seriesOf,
} from "./catalogue.js";
export { type CardsConfig, CardsConfigSchema, cardsConfig, drawRules } from "./config.js";
export {
  completedBy,
  isWishable,
  MAX_WISHES,
  type SeriesProgress,
  seriesParts,
  seriesProgress,
  type WishlistProblem,
  wishlistProblem,
} from "./dex.js";
export {
  CardsError,
  type DrawInput,
  type DrawnCard,
  type DrawnPart,
  type DrawRules,
  type DrawSnapshot,
  drawCard,
  drawnPart,
  headlineSlots,
  nextSince,
  type PityView,
  pityApplies,
  pityView,
  type Random,
  type RarityWeights,
  rarityChances,
  seededRandom,
  slotParts,
  wishedOn,
  withDropPart,
} from "./draw.js";
export { DROP_CONFIG } from "./drop-config.js";
export {
  type ChannelLine,
  DROP_ROUTE,
  DropWatch,
  type DropWatchOptions,
  dropCard,
  watchDrops,
} from "./drops.js";
export {
  CARDS_DRAWN,
  CARDS_SOURCE,
  CARDS_TITLED,
  type CardDrawnData,
  type CardTitledData,
  drawnWrite,
  titledWrite,
} from "./events.js";
export { EXPRESSIONS, type Expression, expressionsFor } from "./expressions.js";
export { type CardFaces, CardFacesKey, type CardOccasion, type OccasionFace } from "./faces.js";
export { LEGACY_ITEMS, LEGACY_SERIES, type LegacyItem } from "./legacy.js";
export { CARDS_CATALOGUE_SQL, cardsSchema } from "./migrations.js";
export {
  CardsKey,
  CardsModule,
  type CardsModuleOptions,
  KEEPSAKE_EVERY_MS,
  KEEPSAKE_FIRST_MS,
  KEEPSAKES_PER_PASS,
  SETTLE_EVERY_MS,
} from "./module.js";
export { cardNotes } from "./notes.js";
export {
  type OddsPart,
  type OddsRarity,
  type OddsSlot,
  type OddsTable,
  oddsTable,
  shownPercents,
} from "./odds.js";
export {
  type CardPortrait,
  CardPortraitKey,
  PORTRAIT_POSES,
  type PortraitInput,
  portraitPose,
} from "./portrait.js";
export {
  cacheBytes,
  PortraitCache,
  type PortraitCacheOptions,
  type SweepResult,
} from "./portrait-cache.js";
export { cardRelationship } from "./relationship.js";
export {
  type CardsCardRow,
  type CardsPartRow,
  cardsCard,
  cardsDex,
  cardsDrop,
  cardsKeepsake,
  cardsLegacy,
  cardsMilestone,
  cardsParts,
  cardsPity,
  cardsTally,
  cardsTitles,
  cardsWishlist,
} from "./schema.js";
export { newSerial } from "./serial.js";
export {
  CARD_TEXTS,
  CardService,
  type CardServiceOptions,
  type DailyOptions,
  type DailyOrder,
  type DailyQuote,
  type DailyRefusal,
  type DailyResult,
  type DexPart,
  type DexView,
  type DropRefusal,
  type DropResult,
  dayStart,
  type FreeResult,
  refusalText,
  SETTLE_GRACE_MS,
  type SettleResult,
} from "./service.js";
export {
  CARD_KINDS,
  CardCapError,
  type CardFace,
  type CardField,
  type CardKind,
  type CardRecord,
  type CardRelationship,
  CardStore,
  type CardsDaySummary,
  type CardTitle,
  cardsTables,
  type DexEntry,
  type DropRecord,
  FORGOTTEN_CLAIMER,
  type IssuedCard,
  type IssueInput,
  issueKey,
  KEEPSAKE_LINE_TRIES,
  milestoneTier,
  type PendingCard,
  TALLIED_KINDS,
  TALLY_KEPT_MS,
  type TalliedKind,
} from "./store.js";
export {
  CARD_REASONS,
  type CardCharge,
  type CardPayer,
  type CardWallet,
  CardWalletKey,
} from "./wallet.js";
