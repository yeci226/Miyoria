// The shapes of economy 2.0 (docs/design/v4-plan.md §10) that the panel, the Discord commands and the
// other parts of her share. `Economy2` is what `Economy2Key` provides; the basic `Economy` of
// types.ts is unchanged so nothing that implements or fakes it breaks.

import type { AccountRef } from "@miyoria/types";
import { serviceKey } from "@miyoria/types";

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
  /** Achievements this quest unlocked (paid); absent when none. */
  unlocked?: AchievementUnlocked[];
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

// ---- her room --------------------------------------------------------------------------------

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
  /** Her room: every item with how far the audience got. */
  room(): Promise<RoomView[]>;
  /** Puts coins into an item of her room (`EconomyError` 400/402/403/409/429). */
  fundRoom(account: AccountRef, item: string, amount: number, key: string): Promise<RoomFundResult>;
  /** Coins issued against recovered per day, for the panel (admin only: it is about the whole economy). */
  health(): Promise<HealthView>;
}

export const Economy2Key = serviceKey<Economy2>("Economy2");
