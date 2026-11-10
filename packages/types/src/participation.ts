// The port other parts of her (party games, the live web page) call to pay coins for taking part
// in something (docs/design/v4-plan.md §10, "玩了就賺"). The economy implements it; the caller only
// says who, what and a key. Amounts, per-activity and per-day limits, strangers and blocked people
// are the economy's business (`[modules.economy] play_*`), so a caller never needs to know them.

import type { AccountRef } from "./platform.js";
import { serviceKey } from "./service-key.js";

/** Activities the economy pays by default; any other name is paid only when it is configured. */
export const PLAY_ACTIVITIES = [
  /** Joined a party game. */
  "game_join",
  /** Played a party game to its end. */
  "game_finish",
  /** Won (or took part in the winning side of) a party game. */
  "game_win",
  /** Sang along or joined a chorus. */
  "sing_along",
  /** A head-pat on the web page. */
  "headpat",
  /** A free reaction on the web page (applause, emoji rain, a vote). */
  "web_reaction",
  /** Placed a bet on one of her predictions. */
  "prediction_join",
] as const;

export type PlayActivity = (typeof PLAY_ACTIVITIES)[number];

/**
 * `paid`: coins were added (`paid` > 0). `duplicate`: the key was used before. `capped`: today's
 * limit of this activity or of all play is reached. `stranger`: she does not know them, or has
 * blocked them. `off`: the activity is not paid.
 */
export type PlayStatus = "paid" | "duplicate" | "capped" | "stranger" | "off";

export interface PlayAward {
  status: PlayStatus;
  /** Coins added by this call; 0 unless `status` is `paid`. */
  paid: number;
}

export interface Participation {
  /**
   * Pays `account` for taking part in `activity`. `key` names this one occurrence (a game id and
   * the round, a click id): the same key twice pays once. Never throws for a refusal; a stranger
   * or a limit is a `PlayAward` with nothing paid.
   */
  award(account: AccountRef, activity: string, key: string): Promise<PlayAward>;
}

export const ParticipationKey = serviceKey<Participation>("Participation");
