// Coins between people: transfers (both sides members, the same words for every reason the
// receiver cannot take them, day limits on both sides, one key one transfer, a crash between the
// two rows finished by a retry) and the sponsor board (opt-in only, the window, refunds, linked
// accounts as one person, no balances).

import { getLogger, ServiceRegistry } from "@miyoria/runtime/kernel";
import { PeopleStoreKey, SqliteStore } from "@miyoria/store";
import {
  type AccountRef,
  AffectStateKey,
  AuthorizerKey,
  type PersonId,
  SocialSignalsKey,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { EconomyConfigSchema } from "../src/config.js";
import { EconomyService } from "../src/economy.js";
import { CoinLedgerStoreKey } from "../src/records.js";
import {
  inIdOf,
  NO_RECEIVER,
  NO_TRANSFERS,
  OWN_ACCOUNT,
  otherName,
  transferFee,
} from "../src/transfer.js";
import { EconomyError } from "../src/types.js";
import { ledgerOf, walletOf } from "./ledger.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 8, 4, 0, 0);
const discord = (id: string): AccountRef => ({ platform: "discord", id });
const ALICE = discord("1");
const ALICE_TWO = discord("1b");
const BOB = discord("2");
const CAROL = discord("3"); // blocked
const DAVE = discord("4"); // never met
const ERIN = discord("5"); // a role without me.wallet
const FRANK = discord("6");

let stores: SqliteStore[] = [];
afterEach(async () => {
  for (const s of stores) await s.close();
  stores = [];
});

async function rig(config: Record<string, number> = {}) {
  const store = await SqliteStore.open(":memory:");
  stores.push(store);
  const services = new ServiceRegistry();
  services.provide("t", CoinLedgerStoreKey, ledgerOf(store));
  services.provide("t", PeopleStoreKey, store.people);
  const people = new Map<string, PersonId>();
  for (const [a, name] of [
    [ALICE, "Alice"],
    [BOB, "Bob:*x*"],
    [CAROL, "Carol"],
    [ERIN, "Erin"],
    [FRANK, "Frank"],
  ] as const) {
    people.set(a.id, await store.people.upsertAccount(a, name));
  }
  await store.people.upsertAccount(ALICE_TWO, "Alice two");
  await store.identity.linkAccount(ALICE_TWO, people.get(ALICE.id) as PersonId);
  services.provide("t", SocialSignalsKey, {
    attitude: (a: AccountRef) => ({ blocked: a.id === CAROL.id }) as never,
  });
  services.provide("t", AuthorizerKey, {
    allows: (a: AccountRef, node: string) => a.id !== ERIN.id && node === "me.wallet",
  } as never);
  services.provide("t", AffectStateKey, { card: () => null, cards: () => [] } as never);
  const clock = { at: T0 };
  const economy = new EconomyService({
    // Achievement coins are tested in achievements.test.ts; off here so these sums stay exact.
    config: EconomyConfigSchema.parse({ achievement_cap: 0, ...config }),
    services,
    profile: "p",
    clock: { now: () => clock.at },
    publish: () => undefined,
    log: getLogger("test"),
  });
  return { economy, store, clock };
}
type Rig = Awaited<ReturnType<typeof rig>>;

async function post(
  r: Rig,
  account: AccountRef,
  delta: number,
  reason: string,
  extra: { ref?: string | null; at?: number; id?: string } = {},
) {
  const id = extra.id ?? `seed-${account.id}-${reason}-${r.clock.at}-${delta}-${Math.random()}`;
  await ledgerOf(r.store).post({
    id,
    person: walletOf(r.store, account),
    delta,
    reason,
    ref: extra.ref ?? null,
    idem_key: null,
    ts: new Date(extra.at ?? r.clock.at).toISOString(),
  });
  return id;
}

async function refused(p: Promise<unknown>, status: number, message?: string) {
  const error = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(EconomyError);
  expect((error as EconomyError).status).toBe(status);
  if (message !== undefined) expect((error as EconomyError).message).toBe(message);
}

const balance = async (r: Rig, a: AccountRef) => (await r.economy.wallet(a)).balance;

describe("transfers", () => {
  it("move coins in two rows that name each other, and read as a ledger line", async () => {
    const r = await rig();
    await post(r, ALICE, 80, "checkin");
    const out = await r.economy.transfer(ALICE, BOB, 30, "k1");
    // 5% of 30 is 1.5: the fee rounds up to 2, on top of the amount.
    expect(out).toEqual({ sent: 30, fee: 2, balance: 48, to: "Bob∶*x*" });
    expect(await balance(r, ALICE)).toBe(48);
    expect(await balance(r, BOB)).toBe(30);
    const [fee, mine] = (await r.economy.wallet(ALICE)).recent;
    const theirs = (await r.economy.wallet(BOB)).recent[0];
    expect(fee).toMatchObject({ delta: -2, label: "轉帳手續費" });
    expect(mine).toMatchObject({ delta: -30, label: "轉給 Bob∶*x*" });
    expect(theirs).toMatchObject({ delta: 30, label: "Alice 轉給你" });
    const rowOut = (
      await ledgerOf(r.store).entries("p", walletOf(r.store, ALICE), {
        reasons: ["transfer_out"],
        limit: 9,
      })
    )[0];
    const rowIn = (
      await ledgerOf(r.store).entries("p", walletOf(r.store, BOB), {
        reasons: ["transfer_in"],
        limit: 9,
      })
    )[0];
    expect(rowIn?.id).toBe(inIdOf(rowOut?.id ?? ""));
    expect(rowOut?.ref?.startsWith(rowIn?.id ?? "?")).toBe(true);
    expect(rowIn?.ref?.startsWith(rowOut?.id ?? "?")).toBe(true);
    expect(otherName(rowIn?.ref ?? null)).toBe("Alice");
  });

  it("is not a gift to her: no hunger, no social event, no board spend", async () => {
    const r = await rig();
    await post(r, ALICE, 80, "checkin");
    await r.economy.transfer(ALICE, BOB, 10, "k1");
    const spent = await ledgerOf(r.store).spent("p", ["feed"], "2000-01-01T00:00:00Z", 10);
    expect(spent).toEqual([]);
  });

  it("answers one key once", async () => {
    const r = await rig();
    await post(r, ALICE, 80, "checkin");
    const first = await r.economy.transfer(ALICE, BOB, 20, "same");
    const again = await r.economy.transfer(ALICE, BOB, 20, "same");
    expect(again).toEqual(first);
    expect(await balance(r, BOB)).toBe(20);
    expect(await balance(r, ALICE)).toBe(59);
  });

  it("refuses bad amounts and an unfunded sender", async () => {
    const r = await rig();
    await post(r, ALICE, 40, "checkin");
    await refused(r.economy.transfer(ALICE, BOB, 0, "a"), 400);
    await refused(r.economy.transfer(ALICE, BOB, 1.5, "b"), 400);
    await refused(r.economy.transfer(ALICE, BOB, 51, "c"), 400, "一次轉 1 到 50 魚幣");
    await refused(r.economy.transfer(ALICE, BOB, 41, "d"), 402);
    // The fee counts: 40 and its fee of 2 are more than 40.
    await refused(r.economy.transfer(ALICE, BOB, 40, "e"), 402, "魚幣不夠(要 42,含手續費 2)");
    expect(await balance(r, ALICE)).toBe(40);
    expect(await balance(r, BOB)).toBe(0);
  });

  it("rounds the fee up to at least one coin, and charges none at a rate of 0", () => {
    expect([1, 10, 20, 21, 60, 100, 140].map((n) => transferFee(n, 0.05))).toEqual([
      1, 1, 1, 2, 3, 5, 7,
    ]);
    expect(transferFee(30, 0.1)).toBe(3);
    expect(transferFee(30, 0)).toBe(0);
  });

  it("burns the fee: it leaves the sender, reaches nobody and is not spent on her", async () => {
    const r = await rig();
    await post(r, ALICE, 80, "checkin");
    await r.economy.transfer(ALICE, BOB, 40, "k");
    expect((await balance(r, ALICE)) + (await balance(r, BOB))).toBe(80 - 2);
    const rows = await ledgerOf(r.store).entries("p", walletOf(r.store, ALICE), {
      reasons: ["transfer_fee"],
      limit: 9,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ delta: -2, reason: "transfer_fee" });
    expect(await r.economy.board()).toEqual([]);
    // The day limit counts the amount, not the fee.
    const limited = await rig({ transfer_out_per_day: 50 });
    await post(limited, ALICE, 200, "checkin");
    await limited.economy.transfer(ALICE, BOB, 50, "a");
    await refused(limited.economy.transfer(ALICE, BOB, 1, "b"), 429);
  });

  it("charges no fee when the rate is 0, and none for a transfer that was refused", async () => {
    const free = await rig({ transfer_fee: 0 });
    await post(free, ALICE, 80, "checkin");
    expect(await free.economy.transfer(ALICE, BOB, 30, "k")).toEqual({
      sent: 30,
      fee: 0,
      balance: 50,
      to: "Bob∶*x*",
    });
    const r = await rig({ transfer_in_per_day: 20 });
    await post(r, ALICE, 80, "checkin");
    await refused(r.economy.transfer(ALICE, BOB, 30, "k"), 403, NO_RECEIVER);
    expect(await balance(r, ALICE)).toBe(80);
  });

  it("tells the wallet what the fee is", async () => {
    const r = await rig({ transfer_fee: 0.1 });
    await post(r, ALICE, 10, "checkin");
    expect((await r.economy.wallet(ALICE)).transfer_fee).toBe(0.1);
    expect((await r.economy.wallet(DAVE)).transfer_fee).toBe(0.1);
  });

  it("refuses a stranger sender and answers every receiver that cannot take it alike", async () => {
    const r = await rig();
    await post(r, ALICE, 80, "checkin");
    await refused(r.economy.transfer(DAVE, BOB, 5, "s"), 403);
    for (const who of [DAVE, CAROL, ERIN, discord("999")]) {
      await refused(r.economy.transfer(ALICE, who, 5, `to-${who.id}`), 403, NO_RECEIVER);
    }
    expect(await balance(r, ALICE)).toBe(80);
  });

  it("refuses the same person, however the account is named", async () => {
    const r = await rig();
    await post(r, ALICE, 80, "checkin");
    await refused(r.economy.transfer(ALICE, ALICE_TWO, 5, "a"), 400, OWN_ACCOUNT);
    await refused(r.economy.transfer(ALICE, ALICE, 5, "b"), 400, OWN_ACCOUNT);
    expect(await balance(r, ALICE)).toBe(80);
  });

  it("stops a sender at the day's limit, and the next day starts over", async () => {
    const r = await rig({ transfer_out_per_day: 60, transfer_in_per_day: 500 });
    await post(r, ALICE, 500, "checkin");
    await r.economy.transfer(ALICE, BOB, 40, "a");
    await refused(r.economy.transfer(ALICE, BOB, 21, "b"), 429, "今天最多轉出 60 魚幣");
    await r.economy.transfer(ALICE, FRANK, 20, "c");
    await refused(r.economy.transfer(ALICE, BOB, 1, "d"), 429);
    r.clock.at += DAY;
    await r.economy.transfer(ALICE, BOB, 50, "e");
  });

  it("stops a receiver at the day's limit in the words of any other reason", async () => {
    const r = await rig({ transfer_in_per_day: 60, transfer_out_per_day: 500 });
    await post(r, ALICE, 500, "checkin");
    await post(r, FRANK, 500, "checkin");
    await r.economy.transfer(ALICE, BOB, 40, "a");
    await refused(r.economy.transfer(FRANK, BOB, 21, "b"), 403, NO_RECEIVER);
    // Nothing left Frank's wallet.
    expect(await balance(r, FRANK)).toBe(500);
    await r.economy.transfer(FRANK, BOB, 20, "c");
    expect(await balance(r, BOB)).toBe(60);
  });

  it("finishes a transfer whose second row never landed, on the same key, once", async () => {
    const r = await rig();
    await post(r, ALICE, 80, "checkin");
    // The first try died after the sender's row.
    await ledgerOf(r.store).post({
      id: "OUT1",
      person: walletOf(r.store, ALICE),
      delta: -25,
      reason: "transfer_out",
      ref: "OUT1~in:Bob",
      idem_key: "transfer:crash",
      ts: new Date(T0).toISOString(),
    });
    expect(await balance(r, BOB)).toBe(0);
    const done = await r.economy.transfer(ALICE, BOB, 25, "crash");
    expect(done.sent).toBe(25);
    expect(await balance(r, BOB)).toBe(25);
    await r.economy.transfer(ALICE, BOB, 25, "crash");
    expect(await balance(r, BOB)).toBe(25);
    // The retry took the fee the first try had not reached, once.
    expect(await balance(r, ALICE)).toBe(80 - 25 - 2);
  });

  it("gives the sender's row back when the receiver's limit refuses the second", async () => {
    const r = await rig({ transfer_in_per_day: 30 });
    await post(r, ALICE, 80, "checkin");
    await post(r, BOB, 0 + 1, "checkin");
    await ledgerOf(r.store).post({
      id: "OUT2",
      person: walletOf(r.store, ALICE),
      delta: -40,
      reason: "transfer_out",
      ref: "OUT2~in:Bob",
      idem_key: "transfer:late",
      ts: new Date(T0).toISOString(),
    });
    await refused(r.economy.transfer(ALICE, BOB, 40, "late"), 403, NO_RECEIVER);
    expect(await balance(r, ALICE)).toBe(80 - 40 + 40);
    expect(await balance(r, BOB)).toBe(1);
  });

  it("is closed by a zero limit", async () => {
    const r = await rig({ transfer_max: 0 });
    await post(r, ALICE, 80, "checkin");
    await refused(r.economy.transfer(ALICE, BOB, 5, "a"), 400, NO_TRANSFERS);
  });
});

describe("the sponsor board", () => {
  it("lists everyone who spent, by what they spent on her, without balances, unless they left", async () => {
    const r = await rig();
    await post(r, ALICE, -40, "feed", { ref: "rice:4" });
    await post(r, BOB, -90, "feed", { ref: "big_bowl:1" });
    await post(r, FRANK, -15, "screen_message");
    const lines = await r.economy.board();
    expect(lines).toEqual([
      { rank: 1, name: "Bob∶*x*", spent: 90 },
      { rank: 2, name: "Alice", spent: 40 },
      { rank: 3, name: "Frank", spent: 15 },
    ]);
    expect(Object.keys(lines[0] ?? {}).sort()).toEqual(["name", "rank", "spent"]);
    expect((await r.economy.wallet(ALICE)).on_board).toBe(true);
    expect(await r.economy.setOnBoard(BOB, false)).toBe(true);
    expect((await r.economy.wallet(BOB)).on_board).toBe(false);
    expect((await r.economy.board()).map((l) => l.name)).toEqual(["Alice", "Frank"]);
    await r.economy.setOnBoard(BOB, true);
    expect((await r.economy.board()).map((l) => l.name)).toEqual(["Bob∶*x*", "Alice", "Frank"]);
  });

  it("counts everything spent on her, within the window, and not transfers or refunds", async () => {
    const r = await rig();
    await post(r, ALICE, -10, "feed", { ref: "rice:1" });
    await post(r, ALICE, -30, "screen_message");
    await post(r, ALICE, -15, "dedication");
    await post(r, ALICE, -25, "song_ticket");
    await post(r, ALICE, -100, "frame");
    await post(r, ALICE, -50, "card_foil");
    await post(r, ALICE, -5, "fortune");
    await post(r, ALICE, -7, "goal_pledge");
    // Coins to other people, and income.
    await post(r, ALICE, -30, "transfer_out");
    await post(r, ALICE, -30, "bounty_escrow");
    await post(r, ALICE, -30, "purse_gift");
    await post(r, ALICE, 500, "checkin");
    // Too old (31 days).
    await post(r, ALICE, -70, "feed", { at: T0 - 31 * DAY, ref: "rice:7" });
    // Refunded.
    const gone = await post(r, ALICE, -40, "dedication");
    await post(r, ALICE, 40, "refund", { ref: gone });
    expect(await r.economy.board()).toEqual([{ rank: 1, name: "Alice", spent: 242 }]);
  });

  it("lists a fortune-only spender and leaves out a transfer-only one", async () => {
    const r = await rig();
    await post(r, ALICE, -5, "fortune");
    await post(r, BOB, -50, "transfer_out");
    expect(await r.economy.board()).toEqual([{ rank: 1, name: "Alice", spent: 5 }]);
  });

  it("counts what a removed feature held only while it was not given back", async () => {
    const r = await rig();
    // Escrow rows of before deals went: a kept deal counts, one the migration returned does not.
    await post(r, BOB, -40, "deal_escrow", { id: "ESC2" });
    await post(r, BOB, -10, "deal_escrow", { id: "ESC1" });
    await post(r, BOB, 10, "refund_removed", { ref: "ESC1" });
    expect(await r.economy.board()).toEqual([{ rank: 1, name: "Bob∶*x*", spent: 40 }]);
  });

  it("is one person across linked accounts, off when any account left, and off for all", async () => {
    const r = await rig();
    await post(r, ALICE, -30, "feed", { ref: "rice:3" });
    await post(r, ALICE_TWO, -20, "frame");
    expect(await r.economy.board()).toEqual([{ rank: 1, name: "Alice", spent: 50 }]);
    await r.economy.setOnBoard(ALICE_TWO, false);
    expect(await r.economy.board()).toEqual([]);
    expect((await r.economy.wallet(ALICE)).on_board).toBe(false);
    await r.economy.setOnBoard(ALICE, true);
    expect(await r.economy.board()).toEqual([{ rank: 1, name: "Alice", spent: 50 }]);
    expect((await r.economy.wallet(ALICE_TWO)).on_board).toBe(true);
  });

  it("drops the blocked, refuses strangers, shares a rank for a tie and cuts at the limit", async () => {
    const r = await rig();
    await post(r, BOB, -20, "feed", { ref: "rice:2" });
    await post(r, FRANK, -20, "feed", { ref: "rice:2" });
    await post(r, ALICE, -10, "feed", { ref: "rice:1" });
    expect((await r.economy.board()).map((l) => [l.rank, l.name])).toEqual([
      [1, "Bob∶*x*"],
      [1, "Frank"],
      [3, "Alice"],
    ]);
    expect(await r.economy.board(2)).toHaveLength(2);
    expect(await r.economy.setOnBoard(DAVE, true)).toBe(false);
    expect(await r.economy.setOnBoard(CAROL, true)).toBe(false);
  });

  it("leaves a chosen frame alone", async () => {
    const r = await rig();
    await ledgerOf(r.store).selectFrame(
      "p",
      walletOf(r.store, ALICE),
      "sakura",
      new Date(T0).toISOString(),
    );
    await r.economy.setOnBoard(ALICE, false);
    await r.economy.setOnBoard(ALICE_TWO, false);
    expect(await ledgerOf(r.store).selectedFrame("p", walletOf(r.store, ALICE))).toBe("sakura");
  });
});
