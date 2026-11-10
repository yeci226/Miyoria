// Coins for taking part (docs/design/v4-plan.md §10, "玩了就賺"): the one place party games, the
// live web page and anything else that is "doing something together" pay people.
//
// * A caller names who, what (`game_join`, `headpat`, ...) and a key for this one occurrence. What
//   an activity pays is `play_rewards[activity]`; an activity that is not there (or is `0`) pays
//   nothing, so a new game never pays by accident.
// * Two daily limits, both counted off the ledger: one activity pays one person at most
//   `play_per_activity_per_day` times, and all play together at most `play_cap` coins. The last
//   award that does not fit is paid in part, so the cap is exact.
// * Strangers and blocked people earn nothing (`EconomyService.member`), like every faucet.

import type { AccountRef, Participation, PlayAward } from "@miyoria/types";
import type { EconomyService } from "./economy.js";

/** Activities that count as "a game" for the daily quest. */
const GAME_PREFIX = "game_";
const MAX_ROWS = 2_000;

export class PlayDesk implements Participation {
  constructor(private readonly e: EconomyService) {}

  async award(account: AccountRef, activity: string, key: string): Promise<PlayAward> {
    const c = this.e.config;
    const amount = Object.hasOwn(c.play_rewards, activity) ? (c.play_rewards[activity] ?? 0) : 0;
    if (amount <= 0 || key.trim() === "") return { status: "off", paid: 0 };
    const who = await this.e.member(account);
    if (!who) return { status: "stranger", paid: 0 };
    const idem = `play:${activity}:${key}`;
    const done = await this.e.serial(async (): Promise<PlayAward> => {
      if ((await this.e.byKey(who, idem)) !== null) return { status: "duplicate", paid: 0 };
      const rows = await this.e.ledger().entries(this.e.profile, who.wallet, {
        reasons: ["play"],
        since: this.e.todayStart(),
        limit: MAX_ROWS,
      });
      if (rows.filter((r) => r.ref === activity).length >= c.play_per_activity_per_day) {
        return { status: "capped", paid: 0 };
      }
      const paid = await this.e.faucet(
        who,
        "play",
        amount,
        idem,
        activity,
        { reasons: ["play"], limit: c.play_cap },
        true,
      );
      return paid.status === "paid"
        ? { status: "paid", paid: paid.paid }
        : { status: paid.status, paid: 0 };
    });
    // Taking part counts for the daily quest even when today's coins for play are all paid.
    if ((done.status === "paid" || done.status === "capped") && activity.startsWith(GAME_PREFIX)) {
      await this.e.v2.questDone(who, "play_game");
    }
    return done;
  }
}
