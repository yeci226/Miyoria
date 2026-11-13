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
// * One card in the game's voice channel says what moved (notices.ts): each player's coins, who
//   finished the daily quest by playing, and what that unlocked. Nothing moved, no card.

import type { AccountRef, PartyRewardRequest, PartyRewards } from "@miyoria/types";
import type { EconomyService } from "./economy.js";
import {
  amounts,
  type Earned,
  eventCard,
  postCard,
  type QuestDone,
  questParts,
  unlockLines,
} from "./notices.js";
import type { AchievementUnlocked, QuestResult } from "./v2-types.js";

/** What a game's coins read as in a wallet ("finished a game"). */
const PARTY_REF = "game_finish";

export class PartyRewardDesk implements PartyRewards {
  constructor(private readonly e: EconomyService) {}

  async award(request: PartyRewardRequest): Promise<void> {
    if (request.id.trim() === "") return;
    const idem = `play:party:${request.id}`;
    const seen: AccountRef[] = [];
    const paid: Earned[] = [];
    const quests: QuestDone[] = [];
    const unlocks: string[] = [];
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
        const out = await this.#pay(award.account, coins, idem);
        if (out === null) continue;
        if (out.paid > 0) paid.push({ account: award.account, paid: out.paid });
        if (out.quest?.status === "paid")
          quests.push({ account: award.account, result: out.quest });
        unlocks.push(...unlockLines(out.unlocked, award.account));
      } catch (error) {
        failure ??= error;
      }
    }
    const q = questParts(quests);
    const lines: string[] = [];
    if (paid.length > 0) lines.push(`這場拿到:${amounts(paid)}`);
    if (q.paid.length > 0) lines.push(`每日任務:${amounts(q.paid)}`);
    const title = request.title.trim() || request.game;
    postCard(
      this.e,
      request.context,
      eventCard(`🎮 玩完「${title}」`, lines, [...q.bonuses, ...q.unlocks, ...unlocks]),
    );
    if (failure !== null) throw failure;
  }

  /** One player's coins; `null` for someone who earns nothing. */
  async #pay(
    account: AccountRef,
    coins: number,
    idem: string,
  ): Promise<{
    paid: number;
    quest: QuestResult | null;
    unlocked: AchievementUnlocked[];
  } | null> {
    const who = await this.e.member(account);
    if (!who) return null;
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
    const quest =
      paid.status === "paid" || paid.status === "capped"
        ? await this.e.v2.questDone(who, "play_game")
        : null;
    // A paid quest checked the achievements already; the game's own coins may reach one too.
    const unlocked =
      quest?.status !== "paid" && paid.status === "paid" ? await this.e.v2.afterEarn(who) : [];
    return { paid: paid.paid, quest, unlocked };
  }
}
