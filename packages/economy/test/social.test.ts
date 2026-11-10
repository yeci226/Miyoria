// Coins between people: transfers (both sides members, the same words for every reason the
// receiver cannot take them, day limits on both sides, one key one transfer, a crash between the
// two rows finished by a retry) and the sponsor board (opt-in only, the window, refunds, linked
// accounts as one person, no balances).

import { getLogger, ServiceRegistry } from "@miyoria/kernel";
import { CoinLedgerStoreKey, PeopleStoreKey, SqliteStore } from "@miyoria/store";
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
import { inIdOf, NO_RECEIVER, NO_TRANSFERS, OWN_ACCOUNT, otherName } from "../src/transfer.js";
import { EconomyError } from "../src/types.js";

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
  services.provide("t", CoinLedgerStoreKey, store.coins);
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
    config: EconomyConfigSchema.parse(config),
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
  await r.store.coins.post(
    {
      id,
      profile: "p",
      account,
      delta,
      reason,
      ref: extra.ref ?? null,
      idem_key: null,
      ts: new Date(extra.at ?? r.clock.at).toISOString(),
    },
    { wallet: [] },
  );
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
    expect(out).toEqual({ sent: 30, balance: 50, to: "Bob∶*x*" });
    expect(await balance(r, ALICE)).toBe(50);
    expect(await balance(r, BOB)).toBe(30);
    const mine = (await r.economy.wallet(ALICE)).recent[0];
    const theirs = (await r.economy.wallet(BOB)).recent[0];
    expect(mine).toMatchObject({ delta: -30, label: "轉給 Bob∶*x*" });
    expect(theirs).toMatchObject({ delta: 30, label: "Alice 轉給你" });
    const rowOut = (
      await r.store.coins.entries("p", [ALICE], { reasons: ["transfer_out"], limit: 9 })
    )[0];
    const rowIn = (
      await r.store.coins.entries("p", [BOB], { reasons: ["transfer_in"], limit: 9 })
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
    const spent = await r.store.coins.spent(
      "p",
      ["feed", "letter", "expression"],
      "2000-01-01T00:00:00Z",
      10,
    );
    expect(spent).toEqual([]);
  });

  it("answers one key once", async () => {
    const r = await rig();
    await post(r, ALICE, 80, "checkin");
    const first = await r.economy.transfer(ALICE, BOB, 20, "same");
    const again = await r.economy.transfer(ALICE, BOB, 20, "same");
    expect(again).toEqual(first);
    expect(await balance(r, BOB)).toBe(20);
    expect(await balance(r, ALICE)).toBe(60);
  });

  it("refuses bad amounts and an unfunded sender", async () => {
    const r = await rig();
    await post(r, ALICE, 40, "checkin");
    await refused(r.economy.transfer(ALICE, BOB, 0, "a"), 400);
    await refused(r.economy.transfer(ALICE, BOB, 1.5, "b"), 400);
    await refused(r.economy.transfer(ALICE, BOB, 51, "c"), 400, "一次轉 1 到 50 魚幣");
    await refused(r.economy.transfer(ALICE, BOB, 41, "d"), 402);
    expect(await balance(r, ALICE)).toBe(40);
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
    await r.store.coins.post(
      {
        id: "OUT1",
        profile: "p",
        account: ALICE,
        delta: -25,
        reason: "transfer_out",
        ref: "OUT1~in:Bob",
        idem_key: "transfer:crash",
        ts: new Date(T0).toISOString(),
      },
      { wallet: [ALICE] },
    );
    expect(await balance(r, BOB)).toBe(0);
    const done = await r.economy.transfer(ALICE, BOB, 25, "crash");
    expect(done.sent).toBe(25);
    expect(await balance(r, BOB)).toBe(25);
    await r.economy.transfer(ALICE, BOB, 25, "crash");
    expect(await balance(r, BOB)).toBe(25);
    expect(await balance(r, ALICE)).toBe(55);
  });

  it("gives the sender's row back when the receiver's limit refuses the second", async () => {
    const r = await rig({ transfer_in_per_day: 30 });
    await post(r, ALICE, 80, "checkin");
    await post(r, BOB, 0 + 1, "checkin");
    await r.store.coins.post(
      {
        id: "OUT2",
        profile: "p",
        account: ALICE,
        delta: -40,
        reason: "transfer_out",
        ref: "OUT2~in:Bob",
        idem_key: "transfer:late",
        ts: new Date(T0).toISOString(),
      },
      { wallet: [ALICE] },
    );
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
    await post(r, FRANK, -15, "letter");
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
    await post(r, ALICE, -15, "letter");
    await post(r, ALICE, -20, "expression", { ref: "heart" });
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
    expect(await r.economy.board()).toEqual([{ rank: 1, name: "Alice", spent: 277 }]);
  });

  it("lists a fortune-only spender and leaves out a transfer-only one", async () => {
    const r = await rig();
    await post(r, ALICE, -5, "fortune");
    await post(r, BOB, -50, "transfer_out");
    expect(await r.economy.board()).toEqual([{ rank: 1, name: "Alice", spent: 5 }]);
  });

  it("counts a deal's escrow only once it was released to her", async () => {
    const r = await rig();
    const held = await post(r, BOB, -10, "deal_escrow", { id: "ESC1" });
    const paid = await post(r, BOB, -40, "deal_escrow", { id: "ESC2" });
    const sent = (id: string, escrow: string, status: string) =>
      r.store.deals
        .create({
          id,
          profile: "p",
          account: BOB,
          item: "rice",
          count: 1,
          value: 10,
          task: "t",
          prepaid: true,
          escrow,
          status: "open",
          created_at: new Date(T0).toISOString(),
          done_at: null,
          due_at: null,
          closed_at: null,
        } as never)
        .then(async () => {
          if (status !== "open") await r.store.deals.transition(id, ["open"], { status } as never);
        });
    await sent("D1", held, "open");
    await sent("D2", paid, "settled");
    expect(await r.economy.board()).toEqual([{ rank: 1, name: "Bob∶*x*", spent: 40 }]);
  });

  it("is one person across linked accounts, off when any account left, and off for all", async () => {
    const r = await rig();
    await post(r, ALICE, -30, "feed", { ref: "rice:3" });
    await post(r, ALICE_TWO, -20, "letter");
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
    await r.store.coins.selectFrame("p", ALICE, "sakura", new Date(T0).toISOString());
    await r.economy.setOnBoard(ALICE, false);
    await r.economy.setOnBoard(ALICE_TWO, false);
    expect(await r.store.coins.selectedFrame("p", [ALICE, ALICE_TWO])).toBe("sakura");
  });
});
