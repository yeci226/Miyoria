// The shapes shared with the panel, the stage overlay and the Discord commands. Changing one
// changes the contract (docs/design/economy.md).

import { type AccountRef, serviceKey } from "@miyoria/types";

export type FeedItem = "rice" | "big_bowl" | "dessert";
export type GiftExpression = "heart" | "blush" | "squint";
/** What `economy.gift` names. */
export type GiftItem = FeedItem | "letter" | "expression";

export const FEED_ITEMS: readonly FeedItem[] = ["rice", "big_bowl", "dessert"];
export const GIFT_EXPRESSIONS: readonly GiftExpression[] = ["heart", "blush", "squint"];

export type EarnReason = "checkin" | "talked" | "voice" | "song" | "her_gift";

export interface EarnLine {
  reason: EarnReason;
  label: string;
  amount: number;
  earned_today: number;
  cap: number;
}

/**
 * Paid things another part of her sells (docs/design/economy.md §13): the card routes, the singer,
 * the overlay, the fortune. The economy only charges, caps per day and refunds; what is bought is
 * the caller's. Prices and daily limits are `[modules.economy]` keys of the same name.
 */
export type PaidItem =
  | "card_reroll"
  | "card_pose"
  | "card_foil"
  | "song_ticket"
  | "dedication"
  | "screen_message"
  | "fortune";

export const PAID_ITEMS: readonly PaidItem[] = [
  "card_reroll",
  "card_pose",
  "card_foil",
  "song_ticket",
  "dedication",
  "screen_message",
  "fortune",
];

/** Most coins one hand adjustment may add or take (docs/design/economy.md §14). */
export const MAX_ADJUST = 100_000;
/** Longest note on a hand adjustment, in characters. */
export const MAX_ADJUST_NOTE_CHARS = 100;

/** What `Economy.adjust` did; `duplicate` when the key was already used (nothing new posted). */
export interface AdjustResult {
  entry_id: string;
  balance: number;
  duplicate: boolean;
}

/** One charge of a `PaidItem`; `duplicate` when the key was already used (nothing new charged). */
export interface Purchase {
  /** The ledger row; pass it to `Economy.refund`. */
  entry_id: string;
  charged: number;
  balance: number;
  duplicate: boolean;
}

export interface ShopItem {
  /** `rice`, `letter`, `expression:heart`, `frame:sakura`, `card_reroll`, ... */
  id: string;
  kind: "feed" | "letter" | "expression" | "frame" | "card" | "song" | "stream" | "fortune";
  label: string;
  price: number;
  available: boolean;
  why: string | null;
}

export interface LedgerLine {
  ts: string;
  delta: number;
  label: string;
}

export type Hunger = "full" | "ok" | "hungry" | "starving";

/** One deal as the wallet shows it (docs/design/economy.md §12). */
export interface DealView {
  /** What she said she would do. */
  task: string;
  /** `一碗白飯`, `3 碗白飯`. */
  reward_label: string;
  status: "open" | "owed" | "settled" | "broken" | "refunded";
  /** When the next deadline falls (`open`: do it by; `owed`: pay by); `null` once it ended. */
  due_at: string | null;
}

export interface WalletView {
  currency: string;
  balance: number;
  can_earn: boolean;
  today_earned: number;
  checked_in_today: boolean;
  /** Consecutive check-in days, today included when done. */
  streak: number;
  earn: EarnLine[];
  shop: ShopItem[];
  frames: { owned: string[]; selected: string | null };
  /** Words, never the number; `null` for strangers. */
  hungry: Hunger | null;
  /** Newest first, at most 20. */
  recent: LedgerLine[];
  /** Her deals with this person, newest first, at most 10; cancelled ones are not shown. */
  deals: DealView[];
  /** Whether they are on the sponsor board (on unless they left; `false` for strangers). */
  on_board: boolean;
}

export interface CheckinResult {
  gained: number;
  streak: number;
  balance: number;
}

/** Refused when she is full: `accepted` false, `charged` 0. */
export interface FeedResult {
  accepted: boolean;
  eaten: number;
  charged: number;
  balance: number;
  message: string;
}

export interface SpendResult {
  accepted: boolean;
  charged: number;
  balance: number;
  message: string;
}

export interface FramesResult {
  owned: string[];
  selected: string | null;
  balance: number;
}

/** A wallet for `GET /api/member/export`: every line, oldest last. */
export interface WalletExport {
  balance: number;
  ledger: LedgerLine[];
}

/** Bus topic of every accepted gift (the overlay merges them). */
export const GIFT_TOPIC = "economy.gift";

/** Payload of `economy.gift`. */
export interface GiftEvent {
  /** The giver's display name (untrusted). */
  name: string;
  item: GiftItem;
  count: number;
  /** `一碗白飯`. */
  label: string;
}

/**
 * Coins for one person's account. Strangers and blocked people get a stranger's answers: a read
 * shows an empty wallet, a spend is an `EconomyError` 403. Spends take a key: the same key twice
 * answers what the first did.
 */
export interface Economy {
  wallet(account: AccountRef): Promise<WalletView>;
  checkin(account: AccountRef): Promise<CheckinResult>;
  feed(account: AccountRef, item: FeedItem, count: number, key: string): Promise<FeedResult>;
  letter(account: AccountRef, text: string, key: string): Promise<SpendResult>;
  expression(account: AccountRef, expression: GiftExpression, key: string): Promise<SpendResult>;
  /**
   * A message (1 to 60 characters) on the stream's screen while she is live: charged as
   * `screen_message`, once per person per cooldown. Refused without charging when the stage is
   * down or the text does not pass.
   */
  screenMessage(account: AccountRef, text: string, key: string): Promise<SpendResult>;
  frame(
    account: AccountRef,
    req: { buy?: string; select?: string | null },
    key: string,
  ): Promise<FramesResult>;
  /** Their whole ledger, for the export. */
  exportWallet(account: AccountRef): Promise<WalletExport>;
  /** The frame on their cards, `null` for none (and for strangers). */
  selectedFrame(account: AccountRef): Promise<string | null>;
  /**
   * Charges `item` at its price, within its daily limit (`EconomyError` 400 off sale, 402 short,
   * 403 a stranger, 429 the day's limit). `ref` says what was bought (a card serial, a song).
   * The same key twice answers what the first did.
   */
  purchase(
    account: AccountRef,
    item: PaidItem,
    key: string,
    ref?: string | null,
  ): Promise<Purchase>;
  /**
   * An admin adds (`amount` > 0) or takes (< 0) coins by hand (docs/design/economy.md §14): one
   * `admin_adjust` row, audited with the note and `by`, invisible to her and to the board.
   * `EconomyError`: 400 a bad amount or note, 402 it would go below 0, 403 someone she does not
   * know. A blocked person is fine. The same key twice answers what the first did.
   */
  adjust(
    account: AccountRef,
    amount: number,
    note: string,
    by: string,
    key: string,
  ): Promise<AdjustResult>;
  /**
   * An admin's look at someone's wallet (docs/design/economy.md §14): the balance and their
   * newest `limit` rows, blocked people included. Empty for someone she does not know.
   */
  statement(account: AccountRef, limit?: number): Promise<WalletExport>;
  /** Gives back what `entry_id` charged, once; `false` when it already was (or is not theirs). */
  refund(account: AccountRef, entryId: string): Promise<boolean>;
  /** What `item` costs now, and how many one person may buy a day (`0`: off sale). */
  price(item: PaidItem): { price: number; per_day: number };
  /**
   * Her crowdfunding goals (docs/design/economy.md §13): the open one and the ones that ended
   * lately. Anyone may read them; a stranger's `my_pledge` is 0.
   */
  goals(account: AccountRef): Promise<GoalView[]>;
  /**
   * Holds `amount` for the open goal `goal` (`EconomyError`: 400 a bad amount, 402 short, 403 a
   * stranger, 409 the goal is over, 429 the most one person may pledge). The same key twice
   * answers what the first did. Pledges are returned if the goal is not met.
   */
  pledge(account: AccountRef, goal: string, amount: number, key: string): Promise<PledgeResult>;
  /** The bounties she has open. */
  bounties(): Promise<BountyView[]>;
  /**
   * Coins from one person to another she knows (`EconomyError`: 400 a bad amount or yourself,
   * 402 short, 403 a stranger on either side, in the same words, 429 the sender's day). Not a gift
   * to her. The same key twice answers what the first did.
   */
  transfer(from: AccountRef, to: AccountRef, amount: number, key: string): Promise<TransferResult>;
  /** The sponsor board: everyone who left no wish to be off it, by what they spent on her lately, biggest first. */
  board(limit?: number): Promise<BoardLine[]>;
  /** Puts them on the board or takes them off; `false` when they are a stranger. */
  setOnBoard(account: AccountRef, on: boolean): Promise<boolean>;
}

/** What a transfer did. */
export interface TransferResult {
  /** What left the sender's wallet (and reached the other's). */
  sent: number;
  /** The sender's balance after. */
  balance: number;
  /** The receiver, as the sender's ledger names them. */
  to: string;
}

/** One place on the sponsor board; nothing that identifies the person beyond the name. */
export interface BoardLine {
  /** 1 for the top; the same spend shares a rank. */
  rank: number;
  /** A display name, made inert (`safeName`). */
  name: string;
  /** Coins spent on her over the board's window. */
  spent: number;
}

/** One of her goals as people see it. */
export interface GoalView {
  id: string;
  title: string;
  /** What she will do when it is reached. */
  promise: string;
  target: number;
  raised: number;
  /** What this person put in. */
  my_pledge: number;
  /** When it ends if it has not been reached. */
  deadline: string;
  status: "open" | "reached" | "expired" | "cancelled";
}

/** What a pledge did. */
export interface PledgeResult {
  /** What was held (less than asked when the goal needed less). */
  pledged: number;
  raised: number;
  target: number;
  /** This pledge met the target. */
  reached: boolean;
  balance: number;
  /** The key was used before: nothing new was held. */
  duplicate: boolean;
}

/** One bounty she has open. */
export interface BountyView {
  id: string;
  task: string;
  reward: number;
  posted_at: string;
  expires_at: string;
}

/** Bus topic of what goes on the stream overlay's screen line (a paid message, a dedication). */
export const SCREEN_TOPIC = "economy.screen";

/** Payload of `economy.screen`; texts were already screened. */
export interface ScreenEvent {
  kind: "message" | "dedication";
  /** Who paid (display name, untrusted). */
  name: string;
  /** The message, or the dedication's words. */
  text: string;
  /** A dedication: the song's title. */
  song: string | null;
}

export const EconomyKey = serviceKey<Economy>("Economy");

/**
 * A refused request, with the HTTP status the member routes answer: 400 bad input, 402 not
 * enough coins, 403 a stranger, 409 already done, 429 a limit, 503 a part of her is not running.
 * `message` is for the person.
 */
export class EconomyError extends Error {
  override readonly name = "EconomyError";

  constructor(
    readonly status: 400 | 402 | 403 | 409 | 429 | 503,
    message: string,
  ) {
    super(message);
  }
}
