// Coins (docs/design/economy.md): the `economy` module and the shapes the panel, the overlay and
// the Discord commands share.

export { BOARD_REASONS, MAX_BOARD } from "./board.js";
export { BountyBoard } from "./bounties.js";
export { DEFAULT_FRAMES, type EconomyConfig, EconomyConfigSchema, type Frame } from "./config.js";
export { DealDesk, DealRefusal } from "./deals.js";
export {
  ALREADY_CHECKED_IN,
  EconomyService,
  feedLabel,
  HUNGER_OF,
  hungerWord,
  MAX_FEED_COUNT,
  MAX_LETTER_CHARS,
  PAID_NAME,
  STRANGER,
  WALLET_NODE,
} from "./economy.js";
export { GoalDesk } from "./goals.js";
export { EconomyModule } from "./module.js";
export { PURSE_PLATFORM, Purse } from "./purse.js";
export { MAX_SCREEN_CHARS, screenText } from "./screen.js";
export { NO_RECEIVER, NO_TRANSFERS, OWN_ACCOUNT } from "./transfer.js";
export {
  type AdjustResult,
  type BoardLine,
  type BountyView,
  type CheckinResult,
  type DealView,
  type EarnLine,
  type EarnReason,
  type Economy,
  EconomyError,
  EconomyKey,
  FEED_ITEMS,
  type FeedItem,
  type FeedResult,
  type FramesResult,
  GIFT_EXPRESSIONS,
  GIFT_TOPIC,
  type GiftEvent,
  type GiftExpression,
  type GiftItem,
  type GoalView,
  type Hunger,
  type LedgerLine,
  MAX_ADJUST,
  MAX_ADJUST_NOTE_CHARS,
  PAID_ITEMS,
  type PaidItem,
  type PledgeResult,
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
