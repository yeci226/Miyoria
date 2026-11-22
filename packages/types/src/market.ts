// How the weekly market is paid for (docs/design/v5-play.md §4.5, §11.4): a port the economy
// provides (`MarketWalletKey`) and the market plugin (`@miyoria/play/market`) moves coins through,
// so neither package depends on the other, and a port the market provides to the singer
// (`SongPriorityKey`) for the song priority ticket. Coins are only earned, never bought; nothing
// here buys bond, and nothing here pays her: she cannot bid, buy a ticket or win.
//
// Every movement is one ledger row with its own reason (`MARKET_REASONS`), keyed so a retry is the
// same row. A charge that was given back is never answered as paid again.

import type { PersonId } from "./ids.js";
import type { AccountRef } from "./platform.js";
import { serviceKey } from "./service-key.js";
import type { Timestamp } from "./time.js";

/** The ledger reasons of the market (statements and the health table read them). */
export const MARKET_REASONS = {
  /** A song request moved ahead of the ones without a ticket. */
  songPriority: "song_priority",
  songPriorityRefund: "song_priority_refund",
  /** Lottery tickets (one row per purchase). */
  lotteryTicket: "lottery_ticket",
  lotteryRefund: "lottery_refund",
  /** The week's prize, paid to the winner out of the tickets sold. */
  lotteryPrize: "lottery_prize",
  /** A bid's coins, held until it is outbid or the lot is settled. */
  auctionHold: "auction_hold",
  auctionRelease: "auction_release",
  /** What a won lot cost: burned. */
  auctionWon: "auction_won",
} as const;

/** What a charge of the market is for. */
export type MarketChargeReason =
  | typeof MARKET_REASONS.songPriority
  | typeof MARKET_REASONS.lotteryTicket;

/** Someone whose wallet can be used: she knows them and has not blocked them. */
export interface MarketPerson {
  person: PersonId;
  /** The display name of the account (untrusted). */
  name: string;
}

/**
 * A charge or a hold: `receipt` is its ledger row. A refusal is too few coins (with the balance
 * when the wallet knows it), a limit (`capped`), or someone whose wallet cannot be used or a
 * charge given back already, with a sentence for them.
 */
export type MarketCharge =
  | { ok: true; receipt: string; balance: number }
  | { ok: false; reason: "insufficient"; balance: number | null }
  | { ok: false; reason: "capped"; message: string }
  | { ok: false; reason: "refused"; message: string };

/** At most `limit` charges of the reason (not given back) since `since`. */
export interface MarketCap {
  since: Timestamp;
  limit: number;
}

export interface MarketWallet {
  /** What the coins are called (`魚幣`). */
  readonly currency: string;
  /** The person behind `account` when their wallet can be used, else `null`. */
  member(account: AccountRef): Promise<MarketPerson | null>;
  /** Their balance; `null` when their wallet cannot be used. */
  balance(account: AccountRef): Promise<number | null>;
  /**
   * Takes `amount` for `reason`; the same `key` is the same charge, and one given back is
   * refused. With `cap`, refused (`capped`) when that many charges already stand.
   */
  charge(
    account: AccountRef,
    amount: number,
    reason: MarketChargeReason,
    key: string,
    ref: string | null,
    cap?: MarketCap,
  ): Promise<MarketCharge>;
  /** Whether a charge of `reason` under `key` stands (taken and not given back). */
  charged(account: AccountRef, reason: MarketChargeReason, key: string): Promise<boolean>;
  /**
   * Gives back the charge of `reason` under `key`, once: the coins given back (0 when nothing was
   * charged or it was given back already). Reaches someone blocked since: what was taken is theirs.
   */
  refund(account: AccountRef, reason: MarketChargeReason, key: string): Promise<number>;
  /** Holds `amount` of a bid under `key` (refused like a charge). */
  hold(account: AccountRef, amount: number, key: string, ref: string | null): Promise<MarketCharge>;
  /** Gives back the hold under `key`, once: the coins given back. */
  release(account: AccountRef, key: string): Promise<number>;
  /**
   * Burns `amount` for a won lot under `key`, once. The coins are held when this is called, so it
   * is written whatever the balance says; the holds are released after it. Whether it is written.
   */
  burn(account: AccountRef, amount: number, key: string, ref: string | null): Promise<boolean>;
  /** Pays a lottery prize under `key`, once. Whether it is written. */
  pay(account: AccountRef, amount: number, key: string, ref: string | null): Promise<boolean>;
}

export const MarketWalletKey = serviceKey<MarketWallet>("MarketWallet");

/** What the song priority ticket costs now. */
export interface SongPriorityTerms {
  price: number;
  per_day: number;
  currency: string;
}

/**
 * The song priority ticket (點歌優先券), as the singer sees it: a request that uses one stands
 * ahead of the requests without one. The market provides it; without it there is no ticket.
 */
export interface SongPriority {
  /** The price and the day's limit; `null` when the ticket is not on sale. */
  terms(): SongPriorityTerms | null;
  /**
   * Takes one ticket from `account` under `key`; a sentence for them when it cannot. `space`: the
   * Space (identity's id) whose queue the song is in, recorded with the ticket; the price and the
   * day's limit are the same everywhere.
   */
  charge(
    account: AccountRef,
    key: string,
    ref: string,
    space?: string | null,
  ): Promise<{ ok: true; balance: number } | { ok: false; message: string }>;
  /**
   * Gives the ticket of `key` back, once: the coins given back (0: nothing to give back). Throws
   * when the wallet cannot be reached now; the caller keeps the key and tries again.
   */
  refund(account: AccountRef, key: string): Promise<number>;
  /**
   * The song of `key` started being sung: its ticket is used and is never given back. Throws when
   * that cannot be kept now; the caller keeps the key and tries again.
   */
  consume(key: string): void;
}

export const SongPriorityKey = serviceKey<SongPriority>("SongPriority");

/**
 * The singer's side of the ticket: whether its set list still holds the song a ticket was charged
 * for (listed, and not ended without being sung). The market's pass gives back a ticket that is
 * neither used nor held after a grace period, whatever stopped half way (a charge just before Core
 * stopped, before the set list was saved; a refund that failed before the song was listed; a song
 * that left the set list's history with its refund still due).
 */
export interface SongTickets {
  /** `null`: it cannot tell now (the set list is not read back yet). */
  holds(key: string): boolean | null;
}

export const SongTicketsKey = serviceKey<SongTickets>("SongTickets");
