// The wallet the deep-sea exchange is paid through (`ExchangeWalletKey`, docs/design/exchange.md
// §3): each posting is one or more ledger rows of one wallet, written in one transaction by
// `CoinLedgerStore.postAll` (all of them or none), each under its own key, so a retry after a
// restart finds the first row and writes nothing. It all runs in turn with every other spend of
// this process.
//
// A buy is `exchange_in` (the margin) with `exchange_fee` (burned); a sale or what a liquidation
// left is `exchange_out` with `exchange_fee` (the fee, the tax and the carry, burned); a buy that
// did not fill gives back `exchange_out` and `exchange_fee_back`. Only the health table reads the
// reasons: the fee is recovered, the fee given back is not. The coins in the vault are the
// exchange's to account for (its own tables), not the ledger's.
//
// Someone she does not know cannot trade; someone she blocked can sell what they hold (`holder`)
// but not buy (`member`).

import {
  type AccountRef,
  type ExchangeEntry,
  type ExchangePerson,
  type ExchangePost,
  type ExchangeWallet,
  newId,
  type PersonId,
  type Timestamp,
  toTimestamp,
} from "@miyoria/types";
import type { EconomyService } from "./economy.js";
import type { CoinEntry } from "./records.js";

/** Rows read to sum the transfers of a day: far more than any limit. */
const MAX_TRANSFER_ROWS = 2_000;

export class EconomyExchangeWallet implements ExchangeWallet {
  constructor(private readonly e: EconomyService) {}

  get currency(): string {
    return this.e.config.currency;
  }

  /** The economy's one fixed rate; the exchange reads it here and defines none of its own. */
  get twdPerCoin(): number {
    return this.e.config.twd_per_coin;
  }

  async member(account: AccountRef): Promise<ExchangePerson | null> {
    try {
      const who = await this.e.member(account);
      return who === null ? null : { person: who.wallet, name: who.name };
    } catch {
      return null;
    }
  }

  async holder(account: AccountRef): Promise<ExchangePerson | null> {
    try {
      const who = await this.e.holder(account);
      return { person: who.wallet, name: who.name };
    } catch {
      return null;
    }
  }

  balance(person: PersonId): Promise<number> {
    return this.e.ledger().balance(this.e.profile, person);
  }

  async transferredIn(person: PersonId, since: Timestamp): Promise<number> {
    const rows = await this.e.ledger().entries(this.e.profile, person, {
      reasons: ["transfer_in"],
      since,
      limit: MAX_TRANSFER_ROWS,
    });
    return rows.reduce((t, r) => t + Math.max(0, r.delta), 0);
  }

  async post(
    person: PersonId,
    entries: readonly ExchangeEntry[],
    ref: string,
    covered: boolean,
  ): Promise<ExchangePost> {
    const ledger = this.e.ledger();
    if (!ledger.postAll) return { ok: false, reason: "refused", message: "錢包現在不能記這種帳" };
    if (entries.length === 0)
      return { ok: true, balance: await this.balance(person), duplicate: true };
    const ts = toTimestamp(this.e.now());
    const rows: CoinEntry[] = entries.map((x) => ({
      id: newId(),
      person,
      delta: x.delta,
      reason: x.reason,
      ref,
      idem_key: x.key,
      ts,
    }));
    return this.e.serial(async (): Promise<ExchangePost> => {
      const post = await (ledger.postAll as NonNullable<typeof ledger.postAll>)(rows, { covered });
      if (post.status === "short") return { ok: false, reason: "short", balance: post.balance };
      if (post.status === "capped") return { ok: false, reason: "refused", message: "到上限了" };
      return { ok: true, balance: post.balance, duplicate: post.status === "duplicate" };
    });
  }

  async posted(person: PersonId, key: string): Promise<boolean> {
    return (await this.e.ledger().byKey(this.e.profile, person, key)) !== null;
  }

  /** Every coin in the ledger: all rows summed, every wallet and her purse (one `GROUP BY`). */
  async circulation(): Promise<number> {
    const rows = await this.e.ledger().dailyTotals(this.e.profile, toTimestamp(0), 0);
    return rows.reduce((t, r) => t + r.positive - r.negative, 0);
  }
}
