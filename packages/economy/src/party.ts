// Coins for the people who played a voice party game (docs/design/v4-plan.md §9.1 and §10): the
// `PartyRewards` service `@miyoria/party` looks up when a scored game ends.
//
// * The game says how many coins each person earned; this only decides whether they are paid.
//   Every coin is a `play` row of the ledger, under the same daily cap as the rest of play
//   (`play_cap`, the last award that does not fit is paid in part) and the same rules about who
//   earns (strangers and blocked people do not, `EconomyService.member`).
// * The request id is the idempotency key: the ledger refuses the same key twice for a wallet, so
//   a game announced again after a restart pays nobody twice. The key is not shared with
//   `Participation`, so a person's "joined" coins and the game's own pay stay separate.
// * One person failing (a ledger error) does not stop the others; the first error is thrown after
//   everyone was tried, and `@miyoria/party` logs it and does not retry.

import type { AccountRef, PartyRewardRequest, PartyRewards } from "@miyoria/types";
import type { EconomyService } from "./economy.js";

/** What a game's coins read as in a wallet ("finished a game"). */
const PARTY_REF = "game_finish";

export class PartyRewardDesk implements PartyRewards {
  constructor(private readonly e: EconomyService) {}

  async award(request: PartyRewardRequest): Promise<void> {
    if (request.id.trim() === "") return;
    const idem = `play:party:${request.id}`;
    const seen: AccountRef[] = [];
    let failure: unknown = null;
    for (const award of request.awards) {
      const coins = Math.floor(award.coins);
      // A person listed twice is paid once: the second row would only hit the same key.
      if (
        !(coins > 0) ||
        seen.some((a) => a.platform === award.account.platform && a.id === award.account.id)
      ) {
        continue;
      }
      seen.push(award.account);
      try {
        await this.#pay(award.account, coins, idem);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== null) throw failure;
  }

  async #pay(account: AccountRef, coins: number, idem: string): Promise<void> {
    const who = await this.e.member(account);
    if (!who) return;
    const paid = await this.e.serial(() =>
      this.e.faucet(
        who,
        "play",
        coins,
        idem,
        PARTY_REF,
        { reasons: ["play"], limit: this.e.config.play_cap },
        true,
      ),
    );
    // Playing counts for the daily quest even when today's coins for play are all paid.
    if (paid.status === "paid" || paid.status === "capped") {
      await this.e.v2.questDone(who, "play_game");
    }
  }
}
