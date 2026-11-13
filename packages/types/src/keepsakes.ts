// The cards and fortune slips she gives people (docs/design/v4-plan.md §9.3), as a port.
//
// The logic (what she writes, the day limit, the price, the refund when she cannot write) lives in
// the api module because the member page was first; this lets a command in Discord do the same
// thing without knowing any of it. A refusal is a `KeepsakeResult` with a sentence meant to be
// shown as it is, never an exception, so the same words reach the web page and the command. The
// views are the parts of `IssuedCard` / `IssuedFortune` a chat reply can use.

import type { AccountRef } from "./platform.js";
import { serviceKey } from "./service-key.js";

/** Who is asking: the account and the name and picture it has now. */
export interface KeepsakeWho {
  account: AccountRef;
  name: string;
  avatar_url: string | null;
}

export type KeepsakeResult<T> =
  | {
      ok: true;
      value: T;
      /** Coins this call took (0 when the thing already existed). */
      charged: number;
      /** What is left, when it is known. */
      balance: number | null;
    }
  | {
      ok: false;
      /** HTTP-like: 403 not someone she knows, 409 retry with a new key, 429 too often, 503 not now. */
      status: number;
      /** A sentence for the person. */
      message: string;
    };

/** A field she added to a slip or a card. */
export interface KeepsakeField {
  label: string;
  text: string;
}

export interface KeepsakeFortune {
  id: string;
  /** The local day it is for, `YYYY-MM-DD`. */
  date: string;
  rank: string;
  title: string;
  poem: string[];
  fields: KeepsakeField[];
  line: string | null;
}

export interface KeepsakeCard {
  /** `MYR-XXXX-XXXX-XXXX`. */
  serial: string;
  /** The nth card this person was given. */
  number: number;
  issued_at: string;
  relationship: string | null;
  line: string | null;
  stamp: string | null;
  fields: KeepsakeField[];
  foil: boolean;
}

/** Today's cards of someone. */
export interface KeepsakeCards {
  /** Their newest card that is not voided. */
  latest: KeepsakeCard | null;
  /** Cards issued today (the local day). */
  today: number;
  per_day: number;
  /** What a foil finish and a reroll cost now; `null` when it is not on offer. */
  prices: { foil: number | null; reroll: number | null };
  /** Rerolls of today's newest card still allowed today. */
  rerolls_left: number;
}

/** What a new card is issued with (a chosen picture stays on the member page). */
export interface KeepsakeCardOrder {
  /** A foil finish, paid (`card_foil`). */
  foil?: boolean;
}

export interface Keepsakes {
  /** Today's slip, if one was drawn, and what drawing one costs (0 without a wallet). */
  fortuneToday(account: AccountRef): Promise<{ fortune: KeepsakeFortune | null; price: number }>;
  /**
   * Draws today's slip: pays, she writes it, it is kept. Asking again the same day answers the
   * same slip and charges nothing. `key` names this one attempt (an interaction id).
   */
  drawFortune(who: KeepsakeWho, key: string): Promise<KeepsakeResult<KeepsakeFortune>>;
  cardsToday(account: AccountRef): Promise<KeepsakeCards>;
  /** A card of what she thinks of them now (no chosen picture; foil when ordered and paid). */
  issueCard(
    who: KeepsakeWho,
    key: string,
    order?: KeepsakeCardOrder,
  ): Promise<KeepsakeResult<KeepsakeCard>>;
  /**
   * Replaces today's newest card with one she writes afresh, paid (`card_reroll`): the old one is
   * voided and the new one keeps its number. Refused when there is no card today to replace.
   */
  rerollCard(who: KeepsakeWho, key: string): Promise<KeepsakeResult<KeepsakeCard>>;
}

export const KeepsakesKey = serviceKey<Keepsakes>("Keepsakes");
