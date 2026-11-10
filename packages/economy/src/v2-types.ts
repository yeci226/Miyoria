// The shapes of economy 2.0 (docs/design/v4-plan.md §10) that the panel, the Discord commands and the
// other parts of her share. `Economy2` is what `Economy2Key` provides; the basic `Economy` of
// types.ts is unchanged so nothing that implements or fakes it breaks.

import type { AccountRef } from "@miyoria/types";
import { serviceKey } from "@miyoria/types";
import type { Rarity } from "./config.js";

// ---- quests ----------------------------------------------------------------------------------

export type QuestId = "new_topic" | "play_game" | "listen_song";

export interface QuestView {
  id: QuestId;
  label: string;
  done: boolean;
}

/** Today's three quests as one person sees them (empty for a stranger). */
export interface QuestsView {
  quests: QuestView[];
  /** What each pays, and what finishing all three adds. */
  reward: number;
  bonus: number;
  bonus_done: boolean;
  earned_today: number;
  cap: number;
}

/**
 * `paid`: done now. `done`: already done today. `repeat`: that topic was already told within the
 * last days. `capped`: today's quest coins are all paid. `stranger`: she does not know them.
 */
export interface QuestResult {
  status: "paid" | "done" | "repeat" | "capped" | "stranger";
  paid: number;
  /** What finishing all three added with this one. */
  bonus: number;
  all_done: boolean;
}

// ---- collection ------------------------------------------------------------------------------

export interface ItemRef {
  id: string;
  label: string;
  rarity: Rarity;
}

/** One rarity of the published odds of a draw. */
export interface OddsRow {
  rarity: Rarity;
  /** Its share of one draw, in percent (two decimals). */
  percent: number;
  items: { id: string; label: string }[];
}

export interface SeriesView {
  id: string;
  label: string;
  /** The title of whoever owns every item. */
  title: string;
  items: (ItemRef & { owned: number })[];
  owned_distinct: number;
  total: number;
  complete: boolean;
}

/** A person's album, with the odds and the pity counter (nothing here is a rank). */
export interface AlbumView {
  /** She knows the person (a stranger gets an empty album). */
  member: boolean;
  series: SeriesView[];
  odds: OddsRow[];
  price: number;
  draws_today: number;
  draws_per_day: number;
  /** After this many draws without an SR or better one is guaranteed; `0`: no pity. */
  pity: number;
  /** Draws since the last SR or better one. */
  since_best: number;
}

export interface DrawResult {
  /** The ledger row of the charge. */
  entry_id: string;
  item: ItemRef & { series: string };
  charged: number;
  balance: number;
  /** The key was used before: nothing new was charged. */
  duplicate: boolean;
  /** First copy of this collectible the person has. */
  new: boolean;
  /** The pity made this one an SR or better. */
  by_pity: boolean;
}

export interface GiveItemResult {
  item: string;
  label: string;
  /** The receiver's display name (untrusted). */
  to: string;
  duplicate: boolean;
}

// ---- achievements ----------------------------------------------------------------------------

export interface AchievementUnlocked {
  id: string;
  label: string;
  title: string;
  paid: number;
}

export interface AchievementView {
  id: string;
  label: string;
  title: string;
  reward: number;
  /** When it was paid, `null` while it is still ahead. */
  unlocked_at: string | null;
}

export interface AchievementsView {
  achievements: AchievementView[];
  /** The titles the person holds, from achievements. */
  titles: string[];
}

// ---- predictions -----------------------------------------------------------------------------

/** What one option of a prediction stands at. */
export interface PredictionOption {
  label: string;
  /** Coins staked on it, and by how many people. */
  staked: number;
  backers: number;
  /** What one coin on it would return if it won now; `null` while nobody backs it. */
  multiplier: number | null;
}

export interface PredictionView {
  /** The short code people and her tools name it by. */
  id: string;
  question: string;
  options: PredictionOption[];
  /** Everything staked. */
  total: number;
  closes_at: string;
  /** `closed`: betting ended and the result is not called yet. */
  status: "open" | "closed" | "resolved" | "cancelled";
  winner: string | null;
  /** This person's own stake, if they have one. */
  my_bet: {
    option: string;
    amount: number;
    outcome: "open" | "won" | "lost" | "refunded";
    payout: number;
  } | null;
}

export interface BetResult {
  prediction: string;
  question: string;
  option: string;
  amount: number;
  balance: number;
  /** The key was used before: nothing new was staked. */
  duplicate: boolean;
  /** The stake's own id. */
  stake_id: string;
}

export interface ResolveResult {
  id: string;
  /** The winning option; `null` when it was called off or nobody was right. */
  winner: string | null;
  winners: number;
  pool: number;
  /** What went back to people (their payouts, or every stake given back). */
  paid: number;
  /** Everyone got their stake back. */
  refunded: boolean;
}

// ---- commissions -----------------------------------------------------------------------------

export const COMMISSION_KINDS = ["poem", "name", "tool", "song", "voice"] as const;
export type CommissionKind = (typeof COMMISSION_KINDS)[number];
/** On the bus when someone commissions her: whatever does the work listens. */
export const COMMISSION_TOPIC = "economy.commission";
/** On the bus when she delivered or declined: whatever sends messages hands it to the person. */
export const COMMISSION_DONE_TOPIC = "economy.commission.done";

export interface CommissionView {
  id: string;
  kind: CommissionKind;
  label: string;
  brief: string;
  price: number;
  status: "open" | "delivered" | "declined" | "expired";
  created_at: string;
  due_at: string;
  result: string | null;
  note: string | null;
}

export interface CommissionResult {
  id: string;
  kind: CommissionKind;
  label: string;
  price: number;
  balance: number;
  /** The same key asked twice: nothing was charged again. */
  duplicate: boolean;
}

// ---- her room --------------------------------------------------------------------------------

/** On the bus when an item of her room is fully funded: whatever draws the room puts it in. */
export const ROOM_TOPIC = "economy.room.placed";

export interface RoomView {
  id: string;
  label: string;
  kind: "furniture" | "outfit" | "background";
  kind_label: string;
  price: number;
  funded: number;
  /** How many people gave; never who, and never ranked. */
  backers: number;
  placed: boolean;
}

export interface RoomFundResult {
  item: RoomView;
  /** What was taken (cut to what was missing). */
  charged: number;
  balance: number;
  duplicate: boolean;
}

// ---- her shop --------------------------------------------------------------------------------

export interface ShopView {
  /** `false` for someone she does not know (the shelf is still shown). */
  member: boolean;
  /** When the shelf is restocked. */
  renews_at: string;
  items: {
    id: string;
    label: string;
    kind: "title" | "collectible";
    price: number;
    /** A title: `true` once held; a collectible: how many copies. */
    owned: boolean | number;
  }[];
}

export interface ShopBuyResult {
  item: { id: string; label: string; kind: "title" | "collectible" };
  charged: number;
  balance: number;
  duplicate: boolean;
}

// ---- health ----------------------------------------------------------------------------------

export interface HealthDay {
  /** The local day number. */
  day: number;
  /** When it starts. */
  date: string;
  issued: number;
  recovered: number;
  /** `recovered / issued`; `null` on a day nothing was issued. */
  ratio: number | null;
}

export interface HealthView {
  /** `false` when no store provides the ledger totals (then nothing is shown, not made up). */
  available: boolean;
  days: HealthDay[];
  /** The last seven days together. */
  week: { issued: number; recovered: number; ratio: number | null };
  /** A sentence when the week recovered too little of what was issued, else `null`. */
  warn: string | null;
}

export interface Economy2 {
  /** The currency's name (`魚幣`). */
  readonly currency: string;
  /** Today's quests for `account`. */
  quests(account: AccountRef): Promise<QuestsView>;
  /**
   * Marks a quest done for `account` (the caller judged it: a game ended, a song was heard, she
   * heard something new). `topic` is required for `new_topic`.
   */
  completeQuest(account: AccountRef, quest: QuestId, topic?: string): Promise<QuestResult>;
  /** The album, the odds and the pity counter of `account` (an empty album for a stranger). */
  album(account: AccountRef): Promise<AlbumView>;
  /** The odds of one draw as published. */
  odds(): OddsRow[];
  /** The configured odds of a rarity alone, for things that are not a collectible (a card). */
  rarityOdds(): { rarity: Rarity; percent: number }[];
  /** A rarity by the configured weights, for the card service to roll a portrait card with. */
  rollRarity(): Rarity;
  /** Draws a collectible (`EconomyError`: 402 short, 403 a stranger, 429 the day's limit). */
  draw(account: AccountRef, key: string): Promise<DrawResult>;
  /** One spare copy of a collectible to another person she knows. */
  giveItem(from: AccountRef, to: AccountRef, item: string, key: string): Promise<GiveItemResult>;
  /**
   * A portrait card was issued with these traits: the ones that are collectibles fill the owner's
   * album. Returns how many were new to them.
   */
  recordCard(account: AccountRef, serial: string, traits: readonly string[]): Promise<number>;
  /** The achievements and titles of `account`. */
  achievements(account: AccountRef): Promise<AchievementsView>;
  /** The predictions open now and the ones settled lately; `account` adds their own stake. */
  predictions(account: AccountRef | null): Promise<PredictionView[]>;
  /** A prediction people can stake on for `minutes` (`EconomyError`: 400 a bad one, 429 too many). */
  openPrediction(req: {
    question: string;
    options: readonly string[];
    minutes: number;
  }): Promise<PredictionView>;
  /**
   * Stakes `amount` on an option (its number from 1, or its words) of the prediction `ref`
   * (`EconomyError`: 400 a bad amount or option, 402 short, 403 a stranger, 409 closed or already
   * staked, 429 the day's limit). The same key twice answers the first stake.
   */
  placeBet(
    account: AccountRef,
    ref: string,
    option: string | number,
    amount: number,
    key: string,
  ): Promise<BetResult>;
  /** Calls the result: the ones who were right share the pool; nobody right gives all back. */
  resolvePrediction(ref: string, option: string | number): Promise<ResolveResult>;
  /** Calls a prediction off: every stake is given back. */
  cancelPrediction(ref: string): Promise<ResolveResult>;
  /** The kinds of commission on offer with their prices. */
  commissionMenu(): { kind: CommissionKind; label: string; price: number }[];
  /** Commissions her for one thing, charging the price (`EconomyError` 400/402/403/429). */
  commission(
    account: AccountRef,
    kind: CommissionKind,
    brief: string,
    key: string,
  ): Promise<CommissionResult>;
  /** A person's own commissions, newest first. */
  commissions(account: AccountRef): Promise<CommissionView[]>;
  /** What is waiting for her, oldest first. */
  commissionsWaiting(): Promise<CommissionView[]>;
  /** Hands in the result; part of the price is hers. */
  deliverCommission(ref: string, text: string): Promise<CommissionView>;
  /** She will not do it: the price goes back. */
  declineCommission(ref: string, why: string): Promise<CommissionView>;
  /** Her room: every item with how far the audience got. */
  room(): Promise<RoomView[]>;
  /** Puts coins into an item of her room (`EconomyError` 400/402/403/409/429). */
  fundRoom(account: AccountRef, item: string, amount: number, key: string): Promise<RoomFundResult>;
  /** This week's shelf. */
  shop(account: AccountRef): Promise<ShopView>;
  /** Buys one thing off the shelf (`EconomyError` 402 short, 403 a stranger, 409 not on the shelf). */
  buyFromShop(account: AccountRef, item: string, key: string): Promise<ShopBuyResult>;
  /** Coins issued against recovered per day, for the panel (admin only: it is about the whole economy). */
  health(): Promise<HealthView>;
}

export const Economy2Key = serviceKey<Economy2>("Economy2");
