// The port through which the singer takes money for the two paid extras of a request (a ticket
// for one song over the limit, a dedication). The economy module provides it; sing never imports
// the economy. Without it the extras are simply not on sale.

import { type AccountRef, serviceKey } from "@miyoria/types";

export type SongPaidItem = "song_ticket" | "dedication";

/** What a charge came to: the ledger row to refund, or why it was refused (for the person). */
export type SongCharge = { entryId: string } | { refused: string };

export interface SongPayments {
  /**
   * Charges `item` to `requester`; `key` makes a repeat harmless. `ref` names what it is for
   * (the song); `text` is the dedication's words, which the payer screens before charging.
   */
  charge(
    requester: AccountRef,
    item: SongPaidItem,
    key: string,
    ref: string,
    text?: string,
  ): Promise<SongCharge>;
  /** Gives the charge back, once. */
  refund(requester: AccountRef, entryId: string): Promise<boolean>;
}

export const SongPaymentsKey = serviceKey<SongPayments>("SongPayments");

/** Longest dedication, in characters. */
export const MAX_DEDICATION_CHARS = 40;

/** Why a dedication is not allowed (too long, names someone), or `null`. */
export function dedicationProblem(text: string): string | null {
  if ([...text].length > MAX_DEDICATION_CHARS) {
    return `獻詞最多 ${MAX_DEDICATION_CHARS} 個字`;
  }
  // The overlay shows the payer's own name; no pinging or naming others via mentions.
  if (/[@＠]|<[@#:]|<a:/.test(text)) return "獻詞不能點名別人(不能用 @ 或提及)";
  if (/https?:\/\//i.test(text)) return "獻詞不能放連結";
  return null;
}
