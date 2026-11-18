// The wallet the weekly market is paid through (`MarketWalletKey`, docs/design/v5-play.md §4.5,
// §11.4): each movement is one ledger row of its own reason (`MARKET_REASONS`), keyed so a retry
// is the same row, and it all runs in turn with every other spend of this process.
//
// * A charge (the song priority ticket, lottery tickets) is `<reason>:<key>`; with a cap, the
//   charges of that reason since the cap's start that were not given back are counted first. A
//   refund is one `<reason>_refund` row keyed on the charge (`refund:<id>`), once. A charge that was
//   given back is refused, never answered as paid.
// * A bid's hold is `auction_hold:<key>`; it goes back as one `auction_release` row keyed on it
//   (`release:<id>`). Every hold is released in the end, the winner's too: a won lot is one
//   `auction_won` row that burns its price, written before the winner's holds are released, so
//   the coins are never free in between. A hold with no release is still held; that is what a
//   retire of the auction gives back.
// * A prize is one `lottery_prize` row, paid out of what the tickets took.
//
// A stranger or someone she blocked cannot pay; what was taken from someone blocked since still
// goes back to them.

import {
  type AccountRef,
  MARKET_REASONS,
  type MarketCap,
  type MarketCharge,
  type MarketChargeReason,
  type MarketPerson,
  type MarketWallet,
} from "@miyoria/types";
import { type EconomyService, type Member, STRANGER } from "./economy.js";
import type { CoinEntry } from "./records.js";
import { EconomyError } from "./types.js";

/** A charge of this key was given back: a retry is a new try, not this one. */
const GIVEN_BACK = "這筆已經退回了,請再試一次";
/** Rows read to count a cap: far more than any limit. */
const MAX_CAP_ROWS = 2_000;

/** The refund reason of each charge reason. */
const REFUND_OF: Readonly<Record<MarketChargeReason, string>> = {
  [MARKET_REASONS.songPriority]: MARKET_REASONS.songPriorityRefund,
  [MARKET_REASONS.lotteryTicket]: MARKET_REASONS.lotteryRefund,
};

export class EconomyMarketWallet implements MarketWallet {
  constructor(private readonly e: EconomyService) {}

  get currency(): string {
    return this.e.config.currency;
  }

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

  async member(account: AccountRef): Promise<MarketPerson | null> {
    const who = await this.#member(account);
    return who === null ? null : { person: who.wallet, name: who.name };
  }

  async balance(account: AccountRef): Promise<number | null> {
    const who = await this.#member(account);
    return who === null ? null : this.e.ledger().balance(this.e.profile, who.wallet);
  }

  async charge(
    account: AccountRef,
    amount: number,
    reason: MarketChargeReason,
    key: string,
    ref: string | null,
    cap?: MarketCap,
  ): Promise<MarketCharge> {
    const who = await this.#member(account);
    if (who === null) return { ok: false, reason: "refused", message: STRANGER };
    const refund = REFUND_OF[reason];
    if (refund === undefined) return { ok: false, reason: "refused", message: "沒有這種花法" };
    try {
      return await this.e.serial(async (): Promise<MarketCharge> => {
        const idem = `${reason}:${key}`;
        const first = await this.e.byKey(who, idem);
        if (first !== null) {
          if (await this.#givenBack(who, first.id)) {
            return { ok: false, reason: "refused", message: GIVEN_BACK };
          }
          const balance = await this.e.ledger().balance(this.e.profile, who.wallet);
          return { ok: true, receipt: first.id, balance };
        }
        if (cap !== undefined && (await this.#standing(who, reason, refund, cap)) >= cap.limit) {
          return { ok: false, reason: "capped", message: `最多 ${cap.limit} 張,已經到上限了` };
        }
        const spent = await this.e.spend(who, amount, reason, ref, idem);
        return { ok: true, receipt: spent.entry.id, balance: spent.balance };
      });
    } catch (error) {
      return this.#refusal(who, error);
    }
  }

  /** Charges of `reason` since the cap's start that were not given back. */
  async #standing(who: Member, reason: string, refund: string, cap: MarketCap): Promise<number> {
    const rows = await this.e.ledger().entries(this.e.profile, who.wallet, {
      reasons: [reason, refund],
      since: cap.since,
      limit: MAX_CAP_ROWS,
    });
    const back = new Set(rows.filter((r) => r.reason === refund).map((r) => r.ref));
    return rows.filter((r) => r.reason === reason && r.delta < 0 && !back.has(r.id)).length;
  }

  async charged(account: AccountRef, reason: MarketChargeReason, key: string): Promise<boolean> {
    let who: Member;
    try {
      who = await this.e.holder(account);
    } catch {
      return false;
    }
    const first = await this.e.byKey(who, `${reason}:${key}`);
    return first !== null && first.delta < 0 && !(await this.#givenBack(who, first.id));
  }

  async refund(account: AccountRef, reason: MarketChargeReason, key: string): Promise<number> {
    const back = REFUND_OF[reason];
    if (back === undefined) return 0;
    const who = await this.e.holder(account);
    return this.e.serial(async () => {
      const charge = await this.e.byKey(who, `${reason}:${key}`);
      if (charge === null || charge.delta >= 0) return 0;
      return this.#giveBack(who, charge, back, `refund:${charge.id}`);
    });
  }

  async hold(
    account: AccountRef,
    amount: number,
    key: string,
    ref: string | null,
  ): Promise<MarketCharge> {
    const who = await this.#member(account);
    if (who === null) return { ok: false, reason: "refused", message: STRANGER };
    try {
      return await this.e.serial(async (): Promise<MarketCharge> => {
        const idem = `${MARKET_REASONS.auctionHold}:${key}`;
        const first = await this.e.byKey(who, idem);
        if (first !== null) {
          if ((await this.e.byKey(who, `release:${first.id}`)) !== null) {
            return { ok: false, reason: "refused", message: GIVEN_BACK };
          }
          const balance = await this.e.ledger().balance(this.e.profile, who.wallet);
          return { ok: true, receipt: first.id, balance };
        }
        const spent = await this.e.spend(who, amount, MARKET_REASONS.auctionHold, ref, idem);
        return { ok: true, receipt: spent.entry.id, balance: spent.balance };
      });
    } catch (error) {
      return this.#refusal(who, error);
    }
  }

  async release(account: AccountRef, key: string): Promise<number> {
    const who = await this.e.holder(account);
    return this.e.serial(async () => {
      const held = await this.e.byKey(who, `${MARKET_REASONS.auctionHold}:${key}`);
      if (held === null || held.delta >= 0) return 0;
      return this.#giveBack(who, held, MARKET_REASONS.auctionRelease, `release:${held.id}`);
    });
  }

  async burn(
    account: AccountRef,
    amount: number,
    key: string,
    ref: string | null,
  ): Promise<boolean> {
    return this.#write(account, -amount, MARKET_REASONS.auctionWon, key, ref);
  }

  async pay(
    account: AccountRef,
    amount: number,
    key: string,
    ref: string | null,
  ): Promise<boolean> {
    return this.#write(account, amount, MARKET_REASONS.lotteryPrize, key, ref);
  }

  /** One row of `delta` under `<reason>:<key>`, once, whatever the balance. */
  async #write(
    account: AccountRef,
    delta: number,
    reason: string,
    key: string,
    ref: string | null,
  ): Promise<boolean> {
    if (!Number.isSafeInteger(delta) || delta === 0) return false;
    const who = await this.e.holder(account);
    return this.e.serial(async () => {
      const post = await this.e
        .ledger()
        .post(this.e.entryFor(who, delta, reason, ref, `${reason}:${key}`));
      return post.status === "posted" || post.status === "duplicate";
    });
  }

  /** Gives back what `entry` took as one `reason` row under `idem`, once: the coins back. */
  async #giveBack(who: Member, entry: CoinEntry, reason: string, idem: string): Promise<number> {
    const post = await this.e
      .ledger()
      .post(this.e.entryFor(who, -entry.delta, reason, entry.id, idem));
    if (post.status === "posted") return -entry.delta;
    if (post.status !== "duplicate") {
      this.e.log.warn(
        { person: who.wallet, entry: entry.id, status: post.status },
        "market: a refund was not posted",
      );
    }
    return 0;
  }

  async #refusal(who: Member, error: unknown): Promise<MarketCharge> {
    if (!(error instanceof EconomyError)) throw error;
    if (error.status === 402) {
      const balance = await this.e.ledger().balance(this.e.profile, who.wallet);
      return { ok: false, reason: "insufficient", balance };
    }
    if (error.status === 429) return { ok: false, reason: "capped", message: error.message };
    return { ok: false, reason: "refused", message: error.message };
  }
}
