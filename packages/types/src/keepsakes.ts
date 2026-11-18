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
  /** A daily card's rarity; `null` on an older member card. */
  rarity: string | null;
  /** The names of the parts drawn onto it; empty on an older card. */
  parts: string[];
  /** Her expression on it, in words; `null` on an older card. */
  expression: string | null;
  /** `daily`, `milestone`, `keepsake` or `drop`; absent on an older member card. */
  kind?: string;
}

/** Today's cards of someone. */
export interface KeepsakeCards {
  /** Their newest card that is not voided. */
  latest: KeepsakeCard | null;
  /** Daily cards issued today (the local day). */
  today: number;
  per_day: number;
  /** What a daily card and a foil finish on it cost now; `null` when it is not on offer. */
  prices: { card: number | null; foil: number | null };
  /** Cards in a row without SR or better, and how many until the next is guaranteed one. */
  pity: { since: number; pity: number; until: number } | null;
  /**
   * The keepsake card she gave them just now, the first time they looked (they were here before
   * the cards); absent otherwise. Shown before anything is issued.
   */
  keepsake?: KeepsakeCard;
}

/** A person's card book: their dex by series, titles, the old collectibles, the pity, wishes. */
export interface KeepsakeCardBook {
  series: { name: string; owned: number; total: number; title: string; complete: boolean }[];
  /** Parts collected, of every part a card can have. */
  parts: { owned: number; total: number };
  titles: string[];
  /** The closed series 舊收藏: the old collectibles, by name with how many. */
  legacy: { name: string; count: number }[];
  pity: { since: number; pity: number; until: number };
  /** The names of the wished parts. */
  wishlist: string[];
}

/** The public odds, as a chat reply prints them. */
export interface KeepsakeOdds {
  rarities: { rarity: string; shown: string }[];
  /** After this many cards without SR or better the next one is; `null`: no pity. */
  pity_after: number | null;
  price: number;
  per_day: number;
  /** Each slot's parts: name, rarity and chance. */
  slots: { name: string; parts: { name: string; rarity: string; shown: string }[] }[];
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
  /** Their dex, titles, old collectibles, pity and wishlist. */
  cardBook(account: AccountRef): Promise<KeepsakeResult<KeepsakeCardBook>>;
  /** The public odds of a daily card; `null` without the cards. */
  cardOdds(): Promise<KeepsakeOdds | null>;
  /**
   * Replaces their wishlist with the parts named (by name or id, at most three; none clears it).
   * Answers the names now on it.
   */
  setCardWishlist(who: KeepsakeWho, parts: readonly string[]): Promise<KeepsakeResult<string[]>>;
  /**
   * Picks up the card she dropped in a channel as `drop` (its button): theirs if they are the
   * first, within the day's limit; free. Asked again by whoever got it, the same card.
   */
  claimDrop?(who: KeepsakeWho, drop: string): Promise<KeepsakeResult<KeepsakeCard>>;
  /**
   * The picture of the card `serial`, the whole card as a PNG: the same one its link preview shows
   * (her rendered picture when there is one, the fixed portrait otherwise). `null` for a card it
   * cannot draw (unknown, voided, no renderer); never throws.
   */
  cardImage?(serial: string): Promise<KeepsakeCardImage | null>;
}

/** A card drawn as a picture. */
export interface KeepsakeCardImage {
  /** A file name for the attachment. */
  name: string;
  data: Uint8Array;
  contentType: string;
}

export const KeepsakesKey = serviceKey<Keepsakes>("Keepsakes");
