// The shapes of economy 2.0 (docs/design/v4-plan.md §10) that the panel, the Discord commands and the
// other parts of her share. `Economy2` is what `Economy2Key` provides; the basic `Economy` of
// types.ts is unchanged so nothing that implements or fakes it breaks.

import type { AccountRef, ContextKey } from "@miyoria/types";
import { serviceKey } from "@miyoria/types";

// ---- quests ----------------------------------------------------------------------------------

/**
 * The three of a day (docs/design/v5-architecture.md §9.4): one with her (`new_topic`), one with
 * other people (`together`), one she thought of for them from what she remembers (`her_pick`).
 */
export type QuestId = "new_topic" | "together" | "her_pick";

export interface QuestView {
  id: QuestId;
  /** What to do; for `her_pick` her own words once she wrote them for today. */
  label: string;
  /** How it gets done (who ticks it). */
  hint: string;
  done: boolean;
  /**
   * `her_pick` only: `her` when she wrote it from her memories of them, `fallback` when she could
   * not (no memories, no model) and it is one of the plain ones, `null` before today's is chosen.
   */
  by: "her" | "fallback" | null;
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
 * `unpicked`: `her_pick` before today's was chosen (nobody has seen it, so nobody did it).
 */
export interface QuestResult {
  status: "paid" | "done" | "repeat" | "capped" | "stranger" | "unpicked";
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

/**
 * What a prediction that settles by itself is bound to: a turtle soup going on (guessed or not),
 * or the game goal she is working on (done or not).
 */
export type PredictionSourceKind = "soup" | "goal";

/**
 * Who settled a prediction and how, kept on it. `auto`: what it was bound to came out (or could
 * not be told: then every stake went back). `her`: her own call. `admin`: the owner, by hand
 * (`who`). `expired`: nobody could tell in time.
 */
export interface PredictionSettledBy {
  by: "auto" | "her" | "admin" | "expired";
  /** One line for people (`海龜湯被猜中了`, `管理員公布的結果`). */
  note: string;
  at: string;
  /** The operator, for the owner's own record; `null` otherwise. */
  who: string | null;
}

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
  /**
   * The server it belongs to (identity's `spaces.id`, and its name while she is still there);
   * `null` for one of no server, open to everyone she knows.
   */
  space: { id: string; name: string | null } | null;
  question: string;
  options: PredictionOption[];
  /** Everything staked. */
  total: number;
  closes_at: string;
  /** `closed`: betting ended and the result is not called yet. */
  status: "open" | "closed" | "resolved" | "cancelled";
  winner: string | null;
  /** How it will be (or was) settled: by her, or by itself on what it is bound to. */
  settles: { kind: "her" | PredictionSourceKind; label: string };
  /** Who settled it; `null` while it is open. */
  settled_by: PredictionSettledBy | null;
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
  /** The cut of the pool that was burned (0 when everything went back). */
  rake: number;
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
  /**
   * Today's quests for `account`. `pick: true` (they or she look at their own quests) has her
   * think of today's `her_pick` when it is not chosen yet; an admin's look leaves it unchosen.
   */
  quests(account: AccountRef, opts?: { pick?: boolean }): Promise<QuestsView>;
  /**
   * Marks a quest done for `account` (the caller judged it: a game with others ended, a song was
   * heard with others, she heard something new, they did what she thought of). `topic` is
   * required for `new_topic`.
   */
  completeQuest(account: AccountRef, quest: QuestId, topic?: string): Promise<QuestResult>;
  /** The achievements and titles of `account`. */
  achievements(account: AccountRef): Promise<AchievementsView>;
  /**
   * The predictions open now and the ones settled lately; `account` adds their own stake.
   * `spaces`: only those servers' (and the ones of no server); every one without (the owner).
   */
  predictions(account: AccountRef | null, spaces?: readonly string[]): Promise<PredictionView[]>;
  /**
   * A prediction people can stake on for `minutes` (`EconomyError`: 400 a bad one, 409 nothing to
   * bind `settle_by` to, 429 too many). With `settle_by` it settles by itself on the soup or game
   * goal going on (`context`: where she is), and its options are fixed by that.
   */
  openPrediction(req: {
    question: string;
    options: readonly string[];
    minutes: number;
    settle_by?: PredictionSourceKind | null;
    context?: ContextKey | null;
  }): Promise<PredictionView>;
  /**
   * Stakes `amount` on an option (its number from 1, or its words) of the prediction `ref`
   * (`EconomyError`: 400 a bad amount or option, 402 short, 403 a stranger, 409 closed or already
   * staked, 429 the day's limit; 403 too for someone who is not a member of the prediction's
   * server, with the reason). The same key twice answers the first stake.
   */
  placeBet(
    account: AccountRef,
    ref: string,
    option: string | number,
    amount: number,
    key: string,
  ): Promise<BetResult>;
  /**
   * Her call of the result: the ones who were right share the pool; nobody right gives all back.
   * 409 for one that settles by itself.
   */
  resolvePrediction(ref: string, option: string | number): Promise<ResolveResult>;
  /** She calls a prediction off: every stake is given back. */
  cancelPrediction(ref: string): Promise<ResolveResult>;
  /** The owner settles any open prediction by hand; `who` is the operator, kept on it. */
  resolvePredictionByAdmin(
    ref: string,
    option: string | number,
    who: string,
  ): Promise<ResolveResult>;
  /** The owner calls any open prediction off by hand: every stake is given back. */
  cancelPredictionByAdmin(ref: string, who: string): Promise<ResolveResult>;
  /** Her room: every item with how far the audience got. */
  room(): Promise<RoomView[]>;
  /** Puts coins into an item of her room (`EconomyError` 400/402/403/409/429). */
  fundRoom(account: AccountRef, item: string, amount: number, key: string): Promise<RoomFundResult>;
  /** Coins issued against recovered per day, for the panel (admin only: it is about the whole economy). */
  health(): Promise<HealthView>;
}

export const Economy2Key = serviceKey<Economy2>("Economy2");

/**
 * Who writes today's `her_pick` quest for someone (the api module, which has her memories of them
 * as the member page shows them, her voice and the model). Optional: without it, or when it
 * answers `null`, the quest is one of the plain ones (quests.ts).
 */
export interface QuestPicker {
  /**
   * One small thing for `account` to do today, in her words and from what she remembers of them;
   * `null` when she cannot now (no memories they may see, no model, too slow, nothing usable).
   * Never throws for that.
   */
  pick(account: AccountRef, signal: AbortSignal): Promise<string | null>;
}

export const QuestPickerKey = serviceKey<QuestPicker>("QuestPicker");
