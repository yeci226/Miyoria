// The wallet karaoke rooms are paid through (`KaraokeWalletKey`, docs/design/karaoke.md
// 「做了什麼第四步」), built like the market's (`market-wallet.ts`): each movement is one ledger row
// of its own reason (`KARAOKE_REASONS`), keyed so a retry is the same row, and it all runs in turn
// with every other spend of this process (`serial`).
//
// * Opening a room is one `karaoke_room` row, `karaoke_room:<room>`. A charge that was given back
//   is refused, never answered as paid.
// * Its refund is one `karaoke_room_refund` row keyed on the charge (`refund:<charge id>`), once.
//   It reaches someone she blocked since: what was taken is theirs.
// * A prize is one `karaoke_prize` row and singing a round through one `karaoke_finish` row, each
//   `<reason>:<room>:<round>:<person>`, once; at most `perDay` rows of that reason per person since
//   the cap's start (counted in the same turn as the write, so two at once cannot both pass).
//
// A stranger or someone she blocked can neither pay nor be paid.

import {
  type AccountRef,
  KARAOKE_REASONS,
  type KaraokeCharge,
  type KaraokePaid,
  type KaraokePayoutKind,
  type KaraokeWallet,
  type Timestamp,
} from "@miyoria/types";
import { type EconomyService, type Member, STRANGER } from "./economy.js";
import { EconomyError } from "./types.js";

const R = KARAOKE_REASONS;
/** A charge of this key was given back: a retry is a new try, not this one. */
const GIVEN_BACK = "這筆已經退回了,請再試一次";
/** Rows read to count a day's payouts: far more than any limit. */
const MAX_CAP_ROWS = 2_000;

/** The reason of each kind of payout. */
const PAYOUT: Readonly<Record<KaraokePayoutKind, string>> = {
  prize: R.prize,
  finish: R.finish,
};

export class EconomyKaraokeWallet implements KaraokeWallet {
  constructor(private readonly e: EconomyService) {}

  get currency(): string {
    return this.e.config.currency;
  }

  /** Someone she knows and has not blocked, else `null`. */
  async #member(account: AccountRef): Promise<Member | null> {
    try {
      return await this.e.member(account);
    } catch {
      return null;
    }
  }

  async #givenBack(who: Member, receipt: string): Promise<boolean> {
    return (await this.e.byKey(who, `refund:${receipt}`)) !== null;
  }

  async balance(account: AccountRef): Promise<number | null> {
    const who = await this.#member(account);
    return who === null ? null : this.e.ledger().balance(this.e.profile, who.wallet);
  }

  async charge(
    account: AccountRef,
    amount: number,
    key: string,
    ref: string | null,
  ): Promise<KaraokeCharge> {
    if (!Number.isSafeInteger(amount) || amount <= 0 || key === "") {
      return { ok: false, reason: "refused", message: "沒有這種花法" };
    }
    const who = await this.#member(account);
    if (who === null) return { ok: false, reason: "refused", message: STRANGER };
    try {
      return await this.e.serial(async (): Promise<KaraokeCharge> => {
        const idem = `${R.room}:${key}`;
        const first = await this.e.byKey(who, idem);
        if (first !== null) {
          if (await this.#givenBack(who, first.id)) {
            return { ok: false, reason: "refused", message: GIVEN_BACK };
          }
          const balance = await this.e.ledger().balance(this.e.profile, who.wallet);
          return { ok: true, receipt: first.id, balance };
        }
        const spent = await this.e.spend(who, amount, R.room, ref, idem);
        return { ok: true, receipt: spent.entry.id, balance: spent.balance };
      });
    } catch (error) {
      if (!(error instanceof EconomyError)) throw error;
      if (error.status === 402) {
        const balance = await this.e.ledger().balance(this.e.profile, who.wallet);
        return { ok: false, reason: "insufficient", balance };
      }
      return { ok: false, reason: "refused", message: error.message };
    }
  }

  async charged(account: AccountRef, key: string): Promise<boolean> {
    let who: Member;
    try {
      who = await this.e.holder(account);
    } catch {
      return false;
    }
    const first = await this.e.byKey(who, `${R.room}:${key}`);
    return first !== null && first.delta < 0 && !(await this.#givenBack(who, first.id));
  }

  async refund(account: AccountRef, key: string): Promise<number> {
    const who = await this.e.holder(account);
    return this.e.serial(async () => {
      const charge = await this.e.byKey(who, `${R.room}:${key}`);
      if (charge === null || charge.delta >= 0) return 0;
      const post = await this.e
        .ledger()
        .post(this.e.entryFor(who, -charge.delta, R.roomRefund, charge.id, `refund:${charge.id}`));
      if (post.status === "posted") return -charge.delta;
      if (post.status !== "duplicate") {
        this.e.log.warn(
          { person: who.wallet, entry: charge.id, status: post.status },
          "karaoke: a refund was not posted",
        );
      }
      return 0;
    });
  }

  async pay(
    account: AccountRef,
    kind: KaraokePayoutKind,
    amount: number,
    key: string,
    ref: string | null,
    cap: { since: Timestamp; perDay: number },
  ): Promise<KaraokePaid> {
    const reason = PAYOUT[kind];
    if (reason === undefined || !Number.isSafeInteger(amount) || amount <= 0 || key === "") {
      return { status: "refused", paid: 0 };
    }
    const who = await this.#member(account);
    if (who === null) return { status: "refused", paid: 0 };
    const idem = `${reason}:${key}`;
    return this.e.serial(async (): Promise<KaraokePaid> => {
      if ((await this.e.byKey(who, idem)) !== null) return { status: "duplicate", paid: 0 };
      const rows = await this.e.ledger().entries(this.e.profile, who.wallet, {
        reasons: [reason],
        since: cap.since,
        limit: MAX_CAP_ROWS,
      });
      if (rows.filter((r) => r.delta > 0).length >= cap.perDay) {
        return { status: "capped", paid: 0 };
      }
      const post = await this.e.ledger().post(this.e.entryFor(who, amount, reason, ref, idem));
      if (post.status === "posted") return { status: "paid", paid: amount };
      if (post.status === "duplicate") return { status: "duplicate", paid: 0 };
      this.e.log.warn(
        { person: who.wallet, reason, status: post.status },
        "karaoke: a payout was not posted",
      );
      return { status: "refused", paid: 0 };
    });
  }
}
