// Coins (docs/design/economy.md): the `economy` module and the shapes the panel, the overlay and
// the Discord commands share.

export { BOARD_REASONS, MAX_BOARD } from "./board.js";
export { BountyBoard } from "./bounties.js";
export { EconomyCardWallet } from "./card-wallet.js";
export { DEFAULT_FRAMES, type EconomyConfig, EconomyConfigSchema, type Frame } from "./config.js";
export {
  DANMAKU_KIND,
  DANMAKU_REASON,
  DANMAKU_REFUND_REASON,
  DanmakuDesk,
  type DanmakuOutcome,
  danmakuText,
  NO_DANMAKU_TAG,
} from "./danmaku.js";
export {
  ALREADY_CHECKED_IN,
  EconomyService,
  feedLabel,
  HUNGER_OF,
  hungerWord,
  MAX_FEED_COUNT,
  marketWonLabel,
  PAID_NAME,
  STRANGER,
  uniqueFrameOf,
  WALLET_NODE,
} from "./economy.js";
export { TaskRefusal } from "./guard.js";
export { EconomyKaraokeWallet } from "./karaoke-wallet.js";
export { EconomyMarketWallet } from "./market-wallet.js";
export { economySchema } from "./migrations.js";
export { EconomyModule } from "./module.js";
export { PURSE_PLATFORM, Purse } from "./purse.js";
export {
  type Bounty,
  type BountyPatch,
  type BountyStatus,
  type BountyStore,
  BountyStoreKey,
  type CoinCap,
  type CoinEntry,
  type CoinLedgerStore,
  CoinLedgerStoreKey,
  type CoinPost,
  type CoinRule,
  type DocFilter,
  type DocUpdate,
  type EconomyDoc,
  type EconomyDocStore,
  EconomyDocsKey,
  type FortuneRecord,
  type FortuneStore,
  FortuneStoreKey,
  type LedgerDayTotal,
  LedgerStatsKey,
  type LedgerStatsStore,
  PURSE,
} from "./records.js";
export {
  BOUNTY_STATUSES,
  type BountyRow,
  type DocRow,
  economyBounties,
  economyDocs,
  economyFortunes,
  economyLedger,
  economyWallets,
  type FortuneRow,
  type LedgerRow,
  type WalletRow,
} from "./schema.js";
export { MAX_SCREEN_CHARS, screenText } from "./screen.js";
export {
  allowedDelta,
  BountyTables,
  DocTables,
  type EconomyTables,
  economyTables,
  FortuneTables,
  LedgerTables,
} from "./tables.js";
export { NO_RECEIVER, NO_TRANSFERS, OWN_ACCOUNT } from "./transfer.js";
export {
  type AdjustResult,
  type BoardLine,
  type BountyView,
  type CheckinResult,
  type DanmakuView,
  type EarnLine,
  type EarnReason,
  type Economy,
  EconomyError,
  EconomyKey,
  FEED_ITEMS,
  type FeedItem,
  type FeedResult,
  type FramesResult,
  GIFT_TOPIC,
  type GiftEvent,
  type GiftItem,
  type Hunger,
  type LedgerLine,
  MAX_ADJUST,
  MAX_ADJUST_NOTE_CHARS,
  PAID_ITEMS,
  type PaidItem,
  type Purchase,
  SCREEN_TOPIC,
  type ScreenEvent,
  type ShopItem,
  type SpendResult,
  type TransferResult,
  type WalletExport,
  type WalletView,
} from "./types.js";
export { type Economy2, Economy2Key } from "./v2-types.js";
