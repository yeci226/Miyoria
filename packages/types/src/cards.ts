// How her cards are paid for (docs/design/v5-play.md §2): a port the economy provides
// (`CardWalletKey`) and the cards plugin (`@miyoria/play/cards`) charges through, so neither
// package depends on the other. A charge is keyed by the card's serial, so a retry is the same
// charge, and a card that could not be written gives its coins back, found by the same key. Coins
// are only earned, never bought, and cards are never sold or given away: there is no way back from
// a card to coins.

import type { PersonId } from "./ids.js";
import type { AccountRef } from "./platform.js";
import { serviceKey } from "./service-key.js";

/** Who pays: the person the card is for, through the account that asked. */
export interface CardPayer {
  person: PersonId;
  account: AccountRef;
}

/**
 * A charge: `receipt` is its ledger row. A refusal is too few coins (with the balance when the
 * wallet knows it), the day's limit of a paid extra (`capped`), or someone whose wallet cannot be
 * used (a stranger, someone she blocked) or a charge that was given back already, with a sentence
 * for them.
 */
export type CardCharge =
  | { ok: true; receipt: string; balance: number | null }
  | { ok: false; reason: "insufficient"; balance: number | null }
  | { ok: false; reason: "capped"; message: string }
  | { ok: false; reason: "refused"; message: string };

export interface CardWallet {
  /** Their balance now; `null` when their wallet cannot be used. */
  balance(payer: CardPayer): Promise<number | null>;
  /**
   * Takes `amount` fish coins for `reason`; the same `key` is the same charge. A charge of that key
   * that was given back is refused, never answered as paid.
   */
  spend(payer: CardPayer, amount: number, reason: string, key: string): Promise<CardCharge>;
  /** What a foil finish costs now; `null`: not on sale. */
  foilPrice(): number | null;
  /**
   * Takes the foil finish of the card `key` (its serial), at its price and within the day's limit
   * of foils; the same key is the same charge, and one given back is refused, as `spend`.
   */
  foil(payer: CardPayer, key: string): Promise<CardCharge>;
  /**
   * Gives back what was charged for the card `key` (its serial: the card and its foil) when it was
   * not written: once, so a second call, or one for a key nothing was charged under, gives
   * nothing. The coins given back. Keyed by the card, not a receipt, so a try that stopped before
   * it saw its receipts can still be settled.
   */
  refund(payer: CardPayer, key: string, reason: string): Promise<number>;
}

export const CardWalletKey = serviceKey<CardWallet>("CardWallet");

/** The ledger reasons a card's charge and its refund are written with. */
export const CARD_REASONS = {
  daily: "card_daily",
  refund: "card_refund",
} as const;
