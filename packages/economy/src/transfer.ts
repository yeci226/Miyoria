// Coins from one person to another (docs/design/economy.md §13). Not a gift to her: no gift
// event, no affinity, no share of hers.
//
// * Both sides are members (she knows them, neither is blocked). Whatever stops the receiver
//   (a stranger, a block, a role without `me.wallet`, the day's limit) answers the same words, so
//   the answer never says who is blocked.
// * The ledger has no transaction over two rows, so a transfer is two rows posted in turn: the
//   sender's `transfer_out` first (covered, under the key), then the receiver's `transfer_in` under
//   a key derived from the out row's id. Retrying with the same key finds the out row and posts
//   whatever of the in row is missing, so a crash between them is finished by the retry, never
//   paid twice. An in row the receiver's limit refuses gives the out row back.
// * The two rows point at each other through `ref` (`<other row id>:<other's name>`); the in row's
//   id is the out row's plus `~in`, which is how a retry finds it.
// * The sender pays a fee on top of the amount (`transfer_fee` of it, rounded up, at least 1 coin):
//   a third row, the sender's `transfer_fee`, with no row on the other side, so the coins are burned.
//   It is posted after the in row lands (a refused transfer costs nothing) and under a key derived
//   from the out row, so a retry finishes it too. The day limits count the amount, not the fee.
// * Spends take turns inside this process (`serial`), so the sender's day limit holds.

import { type AccountRef, accountRefString, newId, safeName, toTimestamp } from "@miyoria/types";
import type { EconomyService, Member } from "./economy.js";
import { STRANGER } from "./economy.js";
import type { CoinEntry, CoinLedgerStore } from "./records.js";
import { EconomyError, type TransferResult } from "./types.js";

/** Whatever keeps the other side from receiving, said the same way every time. */
export const NO_RECEIVER = "對方現在收不到";
export const NO_TRANSFERS = "現在沒有開放轉帳";
export const OWN_ACCOUNT = "不能轉給自己";
const MAX_NAME_CHARS = 24;
const MAX_DAY_ROWS = 2_000;

/** The fee on sending `amount` at `rate` of it: rounded up, at least 1, none when the rate is 0. */
export function transferFee(amount: number, rate: number): number {
  if (rate <= 0) return 0;
  // Rounded to 6 places first so 140 * 0.05 is 7, not 7.000000000000001 and then 8.
  return Math.max(1, Math.ceil(Number((amount * rate).toFixed(6))));
}

/** The id of the receiver's row of the transfer whose sender's row is `outId`. */
export const inIdOf = (outId: string): string => `${outId}~in`;

/** The other party's name in a transfer row's `ref` (`<row id>:<name>`), or `null`. */
export function otherName(ref: string | null): string | null {
  if (ref === null) return null;
  const at = ref.indexOf(":");
  const name = at < 0 ? "" : ref.slice(at + 1);
  return name === "" ? null : name;
}

function row(
  e: EconomyService,
  who: Member,
  id: string,
  delta: number,
  reason: string,
  ref: string,
  key: string,
): CoinEntry {
  return {
    id,
    person: who.wallet,
    delta,
    reason,
    ref,
    idem_key: key,
    ts: toTimestamp(e.now()),
  };
}

/** Today's rows of `reason` that were not given back, summed (positive). */
async function dayTotal(
  ledger: CoinLedgerStore,
  e: EconomyService,
  who: Member,
  reason: "transfer_out" | "transfer_in",
): Promise<number> {
  const rows = await ledger.entries(e.profile, who.wallet, {
    reasons: [reason, "refund"],
    since: e.todayStart(),
    limit: MAX_DAY_ROWS,
  });
  const refunded = new Set(rows.filter((r) => r.reason === "refund").map((r) => r.ref));
  return rows
    .filter((r) => r.reason === reason && !refunded.has(r.id))
    .reduce((n, r) => n + Math.abs(r.delta), 0);
}

/** `from` sends `amount` to `to` under `key` (the one entry point; `Economy.transfer`). */
export async function sendCoins(
  e: EconomyService,
  from: AccountRef,
  to: AccountRef,
  amount: number,
  key: string,
): Promise<TransferResult> {
  const c = e.config;
  if (c.transfer_max === 0 || c.transfer_out_per_day === 0 || c.transfer_in_per_day === 0) {
    throw new EconomyError(400, NO_TRANSFERS);
  }
  if (!Number.isInteger(amount) || amount < 1 || amount > c.transfer_max) {
    throw new EconomyError(400, `一次轉 1 到 ${c.transfer_max} ${c.currency}`);
  }
  const sender = await e.member(from);
  if (!sender) throw new EconomyError(403, STRANGER);
  const receiver = await e.member(to);
  if (!receiver) throw new EconomyError(403, NO_RECEIVER);
  if (receiver.person.id === sender.person.id) throw new EconomyError(400, OWN_ACCOUNT);
  const senderName = safeName(sender.name, MAX_NAME_CHARS);
  const receiverName = safeName(receiver.name, MAX_NAME_CHARS);
  const ledger = e.ledger();
  const fee = transferFee(amount, c.transfer_fee);

  const sent = await e.serial(async (): Promise<number> => {
    const outKey = `transfer:${key}`;
    let out = await ledger.byKey(e.profile, sender.wallet, outKey);
    if (out === null) {
      if ((await dayTotal(ledger, e, sender, "transfer_out")) + amount > c.transfer_out_per_day) {
        throw new EconomyError(429, `今天最多轉出 ${c.transfer_out_per_day} ${c.currency}`);
      }
      if ((await dayTotal(ledger, e, receiver, "transfer_in")) + amount > c.transfer_in_per_day) {
        throw new EconomyError(403, NO_RECEIVER);
      }
      if ((await ledger.balance(e.profile, sender.wallet)) < amount + fee) {
        throw new EconomyError(402, `${c.currency}不夠(要 ${amount + fee},含手續費 ${fee})`);
      }
      const id = newId();
      const post = await ledger.post(
        row(e, sender, id, -amount, "transfer_out", `${inIdOf(id)}:${receiverName}`, outKey),
        { covered: true },
      );
      if (post.status === "short") throw new EconomyError(402, `${c.currency}不夠`);
      if (post.status === "capped") throw new EconomyError(429, "今天到上限了");
      out = post.entry;
      e.record(sender, "economy.transfer", {
        amount,
        fee,
        to: accountRefString(receiver.account),
      });
    }
    // A retry owes whatever the first try did not finish, of the amount it started with.
    const owed = -out.delta;
    const since = e.todayStart();
    const landed = await ledger.post(
      row(
        e,
        receiver,
        inIdOf(out.id),
        owed,
        "transfer_in",
        `${out.id}:${senderName}`,
        `transfer_in:${out.id}`,
      ),
      {
        caps: [
          {
            wallet: receiver.wallet,
            reasons: ["transfer_in"],
            since,
            limit: c.transfer_in_per_day,
          },
        ],
      },
    );
    if (landed.status === "capped") {
      await e.refundOnce(sender, out);
      throw new EconomyError(403, NO_RECEIVER);
    }
    // The fee burns with the amount's rows in place; a retry finds the row by its key.
    const burn = transferFee(owed, c.transfer_fee);
    if (burn > 0) {
      await ledger.post(
        row(e, sender, `${out.id}~fee`, -burn, "transfer_fee", out.id, `transfer_fee:${out.id}`),
      );
    }
    return owed;
  });

  return {
    sent,
    fee,
    balance: await ledger.balance(e.profile, sender.wallet),
    to: receiverName,
  };
}
