// The economy's side of the singer's payment port (`SongPaymentsKey` in @miyoria/sing): a song
// ticket and a dedication are `Economy.purchase` items; a dedication's words pass the same screen
// a letter passes before anything is charged.

import type { SongCharge, SongPayments } from "@miyoria/sing";
import type { AccountRef } from "@miyoria/types";
import type { EconomyService } from "./economy.js";
import { EconomyError } from "./types.js";

export function songPayments(economy: EconomyService): SongPayments {
  return {
    async charge(requester, item, key, ref, text): Promise<SongCharge> {
      try {
        if (item === "dedication") {
          const who = await economy.member(requester);
          if (!who) return { refused: "她還不認識你,沒辦法收費" };
          if (!text || !economy.passes(who, text)) return { refused: "這句獻詞沒辦法通過" };
        }
        const bought = await economy.purchase(requester, item, key, ref);
        return { entryId: bought.entry_id };
      } catch (error) {
        if (error instanceof EconomyError) return { refused: error.message };
        throw error;
      }
    },
    refund(requester: AccountRef, entryId: string): Promise<boolean> {
      return economy.refund(requester, entryId);
    },
  };
}
