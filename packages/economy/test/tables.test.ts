// The economy plugin's tables (`tables.ts`): the coin ledger's guarantees, the wallets' choices,
// and the economy's tables as data categories. A wallet is a person (with whoever they
// absorbed) or her purse. One database is one character: the profile a caller names is not part
// of any key.

import {
  EconomyPosted,
  type PluginContext,
  resolveCategories,
  SqliteStore,
  StoreError,
  type StorePlugin,
} from "@miyoria/store";
import { type AccountRef, newId, type PersonId, type Timestamp, toTimestamp } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Bounty,
  type CoinEntry,
  type EconomyDoc,
  type FortuneRecord,
  PURSE,
} from "../src/records.js";
import { type EconomyTables, economyTables } from "../src/tables.js";

const SECOND = 1000;
const HOUR = 3600 * SECOND;
const DAY = 24 * HOUR;

const stores: SqliteStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

/** The store's connection and identity, for what only SQL can show. */
const probe: StorePlugin<PluginContext> = {
  schema: { plugin: "probe", migrations: [] },
  open: (ctx) => ctx,
};

interface Rig {
  store: SqliteStore;
  economy: EconomyTables;
  ctx: PluginContext;
  /** A person seen on `account` (made on first sight). */
  person(account: AccountRef, name?: string): PersonId;
}

async function rig(): Promise<Rig> {
  const store = await SqliteStore.open(":memory:", { plugins: [economyTables] });
  stores.push(store);
  return {
    store,
    economy: store.plugin(economyTables),
    ctx: store.plugin(probe),
    person: (account, name = account.id) => store.persons.see(account, name).id,
  };
}

const discord = (id: string): AccountRef => ({ platform: "discord", id });
const at = (ms: number): Timestamp => toTimestamp(ms);

function coin(
  person: PersonId,
  delta: number,
  reason: string,
  key: string | null,
  ms: number,
): CoinEntry {
  return { id: newId(), person, delta, reason, ref: null, idem_key: key, ts: at(ms) };
}

describe("the coin ledger", () => {
  it("is a wallet's sum, a key once per wallet, the caps and the balance in one transaction", async () => {
    const { economy, person, store } = await rig();
    const ledger = economy.ledger;
    const id = person(discord("1"));
    const absorbed = person(discord("1b"));
    const other = person(discord("2"));

    const first = await ledger.post(coin(id, 10, "checkin", "checkin:1", 1_000));
    expect(first).toMatchObject({ status: "posted", balance: 10 });
    // Someone else's key is theirs.
    expect((await ledger.post(coin(other, 5, "checkin", "checkin:1", 2_000))).status).toBe(
      "posted",
    );
    // The person she later learns is the same one: their rows are the wallet's, and their key
    // was the wallet's click.
    await ledger.post(coin(absorbed, 2, "talked", "t:1", 2_500));
    store.persons.merge(id, absorbed);
    const again = await ledger.post(coin(absorbed, 10, "checkin", "checkin:1", 2_600));
    expect(again.status).toBe("duplicate");
    expect(again.status === "duplicate" && again.entry.id).toBe(
      first.status === "posted" && first.entry.id,
    );
    expect(again).toMatchObject({ balance: 12 });
    expect(await ledger.balance("p", absorbed)).toBe(12);

    // Caps: the voice cap is 4, the second earning gets what fits, the third nothing.
    const cap = { wallet: id, reasons: ["voice"], since: at(0), limit: 4 };
    const capped = { caps: [cap], partial: true };
    expect(await ledger.post(coin(id, 3, "voice", "v:1", 3_000), capped)).toMatchObject({
      status: "posted",
      balance: 15,
    });
    const part = await ledger.post(coin(id, 3, "voice", "v:2", 4_000), capped);
    expect(part).toMatchObject({ status: "posted", balance: 16 });
    expect(part.status === "posted" && part.entry.delta).toBe(1);
    expect(await ledger.post(coin(id, 3, "voice", "v:3", 5_000), capped)).toMatchObject({
      status: "capped",
      balance: 16,
    });
    // A cap over everyone (`wallet: null`), not partial.
    const total = { wallet: null, reasons: ["checkin"], since: at(0), limit: 16 };
    expect((await ledger.post(coin(id, 2, "checkin", null, 5_000), { caps: [total] })).status).toBe(
      "capped",
    );

    // Spending needs the coins.
    expect(await ledger.post(coin(id, -20, "feed", "f:1", 6_000), { covered: true })).toMatchObject(
      { status: "short", balance: 16 },
    );
    expect(await ledger.post(coin(id, -16, "feed", "f:2", 7_000), { covered: true })).toMatchObject(
      { status: "posted", balance: 0 },
    );
    await expect(ledger.post(coin(id, 1.5, "feed", null, 7_000))).rejects.toThrow(/whole/);

    expect(await ledger.balance("p", id)).toBe(0);
    expect(await ledger.balance("p", other)).toBe(5);
    expect(await ledger.balance("p", "nobody")).toBe(0);
    // One database is one character: another profile names the same wallet.
    expect(await ledger.balance("other", other)).toBe(5);

    const all = await ledger.entries("p", id, { limit: 10 });
    expect(all.map((e) => e.idem_key)).toEqual(["f:2", "v:2", "v:1", "t:1", "checkin:1"]);
    expect(all[0]).toMatchObject({ delta: -16, reason: "feed", person: id });
    expect(Date.parse(all[0]?.ts ?? "")).toBe(7_000);
    expect((await ledger.entries("p", id, { reasons: ["voice"], limit: 10 })).length).toBe(2);
    expect((await ledger.entries("p", id, { since: at(3_500), limit: 10 })).length).toBe(2);
    expect(await ledger.entries("p", id, { limit: 1 })).toHaveLength(1);
    expect(await ledger.entries("p", id, { reasons: [], limit: 9 })).toEqual([]);
    expect((await ledger.byKey("p", id, "v:2"))?.delta).toBe(1);
    expect(await ledger.byKey("p", other, "v:2")).toBeNull();
  });

  it("never takes a balance below zero, whatever runs at once", async () => {
    const { economy, person } = await rig();
    const id = person(discord("1"));
    await economy.ledger.post(coin(id, 30, "checkin", null, 1_000));
    const spends = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        economy.ledger.post(coin(id, -10, "feed", `f:${i}`, 2_000 + i), { covered: true }),
      ),
    );
    expect(spends.filter((s) => s.status === "posted")).toHaveLength(3);
    expect(await economy.ledger.balance("p", id)).toBe(0);
  });

  it("keeps a wallet nobody knows to itself, and her purse apart", async () => {
    const { economy, person } = await rig();
    const id = person(discord("1"));
    // As an account nobody saw had rows before: its own, never anyone's, never a spender.
    await economy.ledger.post(coin("nobody", 5, "checkin", null, 1_000));
    await economy.ledger.post(coin("nobody", -2, "feed", null, 1_000));
    expect(await economy.ledger.balance("p", "nobody")).toBe(3);
    expect(await economy.ledger.spent("p", ["feed"], at(0), 10)).toEqual([]);
    await economy.ledger.post(coin(PURSE, 7, "her_share", "share:x", 1_000));
    await economy.ledger.post(coin(PURSE, -3, "purse_treat", "treat:x", 2_000));
    expect(await economy.ledger.balance("p", PURSE)).toBe(4);
    expect(await economy.ledger.balance("p", id)).toBe(0);
    // Her keys are hers.
    expect((await economy.ledger.post(coin(PURSE, 7, "her_share", "share:x", 3_000))).status).toBe(
      "duplicate",
    );
    expect((await economy.ledger.post(coin(id, 7, "her_share", "share:x", 3_000))).status).toBe(
      "posted",
    );
    // What she spends is never on the sponsor board.
    expect(await economy.ledger.spent("p", ["purse_treat"], at(0), 10)).toEqual([]);
  });

  it("keeps the order rows were written in, also within one instant", async () => {
    const { economy, person } = await rig();
    const id = person(discord("1"));
    for (const key of ["a", "b", "c"]) await economy.ledger.post(coin(id, 1, "talked", key, 5_000));
    const rows = await economy.ledger.entries("p", id, { limit: 9 });
    expect(rows.map((r) => r.idem_key)).toEqual(["c", "b", "a"]);
    // The first row of a key is the earliest written (the key is unique, so there is one).
    expect((await economy.ledger.byKey("p", id, "a"))?.idem_key).toBe("a");
  });

  it("writes a posting and its checks together, inside a caller's transaction too", async () => {
    const { economy, person, ctx } = await rig();
    const id = person(discord("1"));
    await economy.ledger.post(coin(id, 10, "checkin", null, 1_000));
    // The caller's transaction fails after the posting: the posting goes with it.
    expect(() =>
      ctx.db.tx(() => {
        void economy.ledger.post(coin(id, -10, "feed", "f:1", 2_000), { covered: true });
        throw new Error("the caller failed");
      }),
    ).toThrow(/the caller failed/);
    expect(await economy.ledger.balance("p", id)).toBe(10);
    expect(await economy.ledger.byKey("p", id, "f:1")).toBeNull();
  });

  it("holds its keys, ids and whole numbers in the table itself", async () => {
    const { economy, person, ctx } = await rig();
    const id = person(discord("1"));
    const row = coin(id, 10, "checkin", "checkin:1", 1_000);
    await economy.ledger.post(row);
    const insert = (fields: Partial<Record<string, unknown>>) =>
      ctx.db.run(
        "INSERT INTO economy_ledger (id, person_id, delta, reason, ref, idem_key, ts) " +
          "VALUES ($id, $person, $delta, 'checkin', NULL, $key, 1)",
        { id: newId(), person: id, delta: 1, key: null, ...fields } as never,
      );
    // A key twice in one wallet, past the code's check.
    expect(() => insert({ key: "checkin:1" })).toThrow(/UNIQUE/);
    // A row id twice (a transfer's in row is its out row's id plus `~in`: written once).
    expect(() => insert({ id: row.id })).toThrow(/UNIQUE/);
    await expect(economy.ledger.post({ ...row, idem_key: null })).rejects.toThrow(StoreError);
    // A fraction of a coin (STRICT).
    expect(() => insert({ delta: 1.5 })).toThrow(/INTEGER/);
    // No key is no key: rows without one are never the same click.
    insert({});
    insert({});
    expect(await economy.ledger.balance("p", id)).toBe(12);
  });

  it("adds up a local day per reason, issued and recovered, all wallets", async () => {
    const { economy, person } = await rig();
    const x = person(discord("1"));
    const y = person(discord("2"));
    const base = Date.UTC(2026, 10, 3); // a UTC midnight
    const post = (who: PersonId, delta: number, reason: string, ms: number) =>
      economy.ledger.post(coin(who, delta, reason, null, ms));
    await post(x, 10, "checkin", base + HOUR);
    await post(y, 5, "checkin", base + 2 * HOUR);
    await post(x, 3, "talked", base + 22 * HOUR);
    await post(x, -4, "feed", base + 23 * HOUR);
    await post(y, -6, "feed", base + DAY + HOUR);
    await post(y, 8, "checkin", base + 2 * DAY);
    await post(y, 7, "checkin", base - DAY); // before `since`
    const since = at(base);
    const d0 = Math.floor(base / DAY);

    // UTC: rows of one reason are added across wallets.
    expect(await economy.ledger.dailyTotals("p", since, 0)).toEqual([
      { day: d0, reason: "checkin", positive: 15, negative: 0 },
      { day: d0, reason: "feed", positive: 0, negative: 4 },
      { day: d0, reason: "talked", positive: 3, negative: 0 },
      { day: d0 + 1, reason: "feed", positive: 0, negative: 6 },
      { day: d0 + 2, reason: "checkin", positive: 8, negative: 0 },
    ]);

    // Two hours east: the 22:00 and 23:00 rows fall on the next local day.
    const east = await economy.ledger.dailyTotals("p", since, 120);
    expect(east.filter((r) => r.day === d0)).toEqual([
      { day: d0, reason: "checkin", positive: 15, negative: 0 },
    ]);
    expect(
      east.filter((r) => r.day === d0 + 1).map((r) => [r.reason, r.positive, r.negative]),
    ).toEqual([
      ["feed", 0, 10],
      ["talked", 3, 0],
    ]);
  });

  it("adds what a person spent across whoever they absorbed, by their first account", async () => {
    const { economy, person, store } = await rig();
    const id = person(discord("1"), "Alice");
    const absorbed = person(discord("1b"), "Alice two");
    const bob = person(discord("2"), "Bob");
    await economy.ledger.post(coin(id, -30, "feed", null, 1_000));
    await economy.ledger.post(coin(absorbed, -20, "expression", null, 2_000));
    await economy.ledger.post(coin(bob, -10, "feed", null, 3_000));
    store.persons.merge(id, absorbed);
    expect(await economy.ledger.spent("p", ["feed", "expression"], at(0), 10)).toEqual([
      { person: id, account: discord("1"), spent: 50 },
      { person: bob, account: discord("2"), spent: 10 },
    ]);
  });
});

describe("the wallets", () => {
  it("keep the frame chosen last and who left the board, for the person as a whole", async () => {
    const { economy, person, store } = await rig();
    const ledger = economy.ledger;
    const id = person(discord("1"));
    const absorbed = person(discord("1b"));
    const other = person(discord("2"));

    expect(await ledger.selectedFrame("p", id)).toBeNull();
    await ledger.selectFrame("p", id, "sakura", at(1_000));
    await ledger.selectFrame("p", absorbed, "gold", at(2_000));
    store.persons.merge(id, absorbed);
    // The latest choice of anyone in the wallet.
    expect(await ledger.selectedFrame("p", id)).toBe("gold");
    await ledger.selectFrame("p", id, null, at(3_000));
    expect(await ledger.selectedFrame("p", id)).toBeNull();
    await ledger.selectFrame("p", id, "sakura", at(4_000));

    // The board is on unless they left; leaving keeps the frame.
    expect(await ledger.onBoard("p", id)).toBe(true);
    expect(await ledger.offBoard("p", 10)).toEqual([]);
    await ledger.setOnBoard("p", id, false);
    expect(await ledger.onBoard("p", id)).toBe(false);
    expect(await ledger.onBoard("p", absorbed)).toBe(false);
    expect(await ledger.onBoard("p", other)).toBe(true);
    expect(await ledger.offBoard("p", 10)).toEqual([id]);
    expect(await ledger.selectedFrame("p", id)).toBe("sakura");
    await ledger.setOnBoard("p", id, true);
    expect(await ledger.onBoard("p", id)).toBe(true);
    expect(await ledger.offBoard("p", 10)).toEqual([]);
    await expect(ledger.selectFrame("p", "nobody", "gold", at(5_000))).rejects.toThrow(StoreError);
  });
});

describe("as data", () => {
  it("are counted, exported and wiped with the relationships, and go with their person", async () => {
    const { economy, person, store } = await rig();
    const id = person(discord("1"));
    await economy.ledger.post(coin(id, 10, "checkin", null, 1_000));
    await economy.ledger.post(coin(PURSE, 3, "her_share", null, 1_000));
    await economy.ledger.setOnBoard("p", id, false);
    const parts = async () =>
      (await store.profileData.inventory("p")).categories
        .find((c) => c.id === "relationships")
        ?.parts.filter((p) => ["coin_ledger", "coin_wallets"].includes(p.id))
        .map((p) => [p.id, p.count]);
    expect(await parts()).toEqual([
      ["coin_ledger", 2],
      ["coin_wallets", 1],
    ]);
    const backup = await store.profileData.export("p", ["relationships"]);
    expect(backup.parts.coin_ledger?.map((r) => [r.person_id, r.delta])).toEqual([
      [id, 10],
      [PURSE, 3],
    ]);
    expect(await store.profileData.wipe("p", ["relationships"])).toMatchObject({
      coin_ledger: 2,
      coin_wallets: 1,
    });
    expect(await parts()).toEqual([
      ["coin_ledger", 0],
      ["coin_wallets", 0],
    ]);
    // People go after what names them.
    expect(resolveCategories(["people"])).toContain("relationships");
  });
});

describe("bounties", () => {
  it("keep their statuses moving once and only from where they were", async () => {
    const { economy } = await rig();
    const { bounties } = economy;
    const closed = at(3_000);

    const bounty = (ms: number, task: string): Bounty => ({
      id: newId(),
      task,
      reward: 30,
      hold: newId(),
      status: "open",
      created_at: at(ms),
      expires_at: at(ms + 5_000),
      closed_at: null,
      winner: null,
      space: null,
    });
    const one = bounty(1_000, "guess");
    const two = bounty(2_000, "draw");
    for (const x of [one, two]) await bounties.create(x);
    expect(await bounties.get(one.id)).toEqual(one);
    expect((await bounties.list("p", { limit: 9 })).map((x) => x.task)).toEqual(["draw", "guess"]);
    const winner = discord("w");
    expect(
      await bounties.transition(one.id, ["open"], { status: "awarded", closed_at: closed, winner }),
    ).toBe(true);
    expect(await bounties.transition(one.id, ["open"], { status: "cancelled" })).toBe(false);
    expect(await bounties.get(one.id)).toMatchObject({ status: "awarded", winner });
    expect((await bounties.list("p", { statuses: ["open"], limit: 9 })).map((x) => x.task)).toEqual(
      ["draw"],
    );
    expect(await bounties.transition(two.id, ["open"], { status: "expired" })).toBe(true);
    expect(await bounties.get(two.id)).toMatchObject({ status: "expired", winner: null });
  });
});

describe("fortune slips", () => {
  it("are one per person per local day, theirs across their accounts", async () => {
    const { economy, person } = await rig();
    const { fortunes } = economy;
    const owen = person(discord("1"));
    const wallet = [discord("1"), discord("1b")];
    const slip = (account: AccountRef, day: number, ms: number): FortuneRecord => ({
      id: newId(),
      account,
      person: owen,
      day,
      issued_at: at(ms),
      entry: newId(),
      slip: { rank: "大吉", poem: ["一", "二"] },
    });
    const today = slip(discord("1"), 10, 1_000);
    expect(await fortunes.put(today, wallet)).toBe(true);
    // The same day from their other account is taken; another day is not.
    expect(await fortunes.put(slip(discord("1b"), 10, 2_000), wallet)).toBe(false);
    const tomorrow = slip(discord("1b"), 11, 3_000);
    expect(await fortunes.put(tomorrow, wallet)).toBe(true);
    expect(await fortunes.forDay("p", wallet, 10)).toEqual(today);
    expect(await fortunes.forDay("p", [discord("1")], 11)).toBeNull();
    expect(await fortunes.forDay("p", [], 10)).toBeNull();
    expect((await fortunes.listFor("p", wallet, 9)).map((f) => f.id)).toEqual([
      tomorrow.id,
      today.id,
    ]);
    expect(await fortunes.listFor("p", wallet, 1)).toHaveLength(1);
    expect(await fortunes.deleteFor("p", wallet)).toBe(2);
    expect(await fortunes.listFor("p", wallet, 9)).toEqual([]);
  });
});

describe("economy documents", () => {
  it("are created once, updated by compare and set, and listed by kind, owner and status", async () => {
    const { economy } = await rig();
    const docs = economy.docs;
    const mine = discord("mine");
    const theirs = discord("theirs");
    const doc = (kind: string, id: string, owner: AccountRef | null, ms: number): EconomyDoc => ({
      id,
      kind,
      owner,
      status: "open",
      version: 1,
      data: { title: id, nested: { n: [1, 2] } },
      created_at: at(ms),
      updated_at: at(ms),
    });
    const a = doc("item", "a", mine, 1_000);
    const b = doc("item", "b", theirs, 2_000);
    const c = doc("item", "c", null, 3_000);
    const p = doc("prediction", "a", null, 1_000);
    for (const d of [a, b, c, p]) expect(await docs.create(d)).toBe(true);

    // The same id twice changes nothing; the same id of another kind is another document.
    expect(await docs.create({ ...a, status: "gone", data: {} })).toBe(false);
    expect(await docs.get("p", "item", "a")).toEqual(a);
    expect(await docs.get("p", "prediction", "a")).toEqual(p);
    expect(await docs.get("p", "item", "zzz")).toBeNull();
    // One database is one character: another profile reads the same document.
    expect(await docs.get("other", "item", "a")).toEqual(a);

    // Compare and set on the version.
    const next = { status: "held", data: { title: "a", held: true }, at: at(5_000) };
    expect(await docs.update("p", "item", "a", 2, next)).toBe(false);
    expect(await docs.update("p", "item", "a", 1, next)).toBe(true);
    expect(await docs.update("p", "item", "a", 1, next)).toBe(false);
    expect(await docs.get("p", "item", "a")).toEqual({
      ...a,
      status: "held",
      data: { title: "a", held: true },
      version: 2,
      updated_at: at(5_000),
    });
    expect(await docs.update("p", "item", "nope", 1, next)).toBe(false);

    // The owner changes only when given, `null` included.
    expect(await docs.update("p", "item", "c", 1, { ...next, owner: theirs })).toBe(true);
    expect((await docs.get("p", "item", "c"))?.owner).toEqual(theirs);
    expect(await docs.update("p", "item", "c", 2, { ...next, owner: null })).toBe(true);
    expect((await docs.get("p", "item", "c"))?.owner).toBeNull();
    expect(await docs.update("p", "item", "b", 1, next)).toBe(true);
    expect((await docs.get("p", "item", "b"))?.owner).toEqual(theirs);

    // Newest first by creation, narrowed by owner and status, limited.
    const ids = async (kind: string, filter: Parameters<typeof docs.list>[2]) =>
      (await docs.list("p", kind, filter)).map((d) => d.id);
    expect(await ids("item", { limit: 9 })).toEqual(["c", "b", "a"]);
    expect(await ids("item", { limit: 2 })).toEqual(["c", "b"]);
    expect(await ids("item", { limit: 0 })).toEqual([]);
    expect(await ids("item", { owners: [mine], limit: 9 })).toEqual(["a"]);
    expect(await ids("item", { owners: [mine, theirs], limit: 9 })).toEqual(["b", "a"]);
    expect(await ids("item", { owners: [], limit: 9 })).toEqual([]);
    expect(await ids("item", { statuses: ["held"], limit: 9 })).toEqual(["c", "b", "a"]);
    expect(await ids("item", { statuses: ["open"], limit: 9 })).toEqual([]);
    expect(await ids("item", { statuses: [], limit: 9 })).toEqual([]);
    expect(await ids("prediction", { limit: 9 })).toEqual(["a"]);
  });
});

describe("economy.posted", () => {
  it("is one event per posted row, in its transaction, for the owner and kept", async () => {
    const { economy, person, store } = await rig();
    const id = person(discord("1"));
    const posted = (await store.events.query({ types: [EconomyPosted.type], order: "asc" })).map(
      (e) => e.envelope,
    );
    expect(posted).toEqual([]);
    const first = await economy.ledger.post({
      ...coin(id, 10, "checkin", "checkin:1", 1_000),
      ref: "r",
    });
    // A repeat of the key, a short spend and a full cap post nothing, and record nothing.
    await economy.ledger.post(coin(id, 10, "checkin", "checkin:1", 2_000));
    await economy.ledger.post(coin(id, -50, "feed", "f:1", 2_000), { covered: true });
    const cap = { wallet: id, reasons: ["checkin"], since: at(0), limit: 10 };
    await economy.ledger.post(coin(id, 5, "checkin", null, 2_000), { caps: [cap] });
    await economy.ledger.post(coin(PURSE, 3, "her_share", "share:x", 3_000));

    const events = (await store.events.query({ types: [EconomyPosted.type], order: "asc" })).map(
      (e) => e.envelope,
    );
    expect(events).toHaveLength(2);
    const entry = first.status === "posted" ? first.entry : null;
    expect(events[0]).toMatchObject({
      type: "economy.posted",
      scope: "owner",
      tier: "keep",
      source: "economy",
      person_id: id,
      key: `ledger:${entry?.id}`,
      data: {
        entry_id: entry?.id,
        person_id: id,
        delta: 10,
        reason: "checkin",
        ref: "r",
        idem_key: "checkin:1",
        balance: 10,
      },
    });
    expect(Date.parse(events[0]?.at ?? "")).toBe(1_000);
    // Her purse is no person: the wallet is in the payload, the envelope names nobody.
    expect(events[1]).toMatchObject({ person_id: null, data: { person_id: PURSE, balance: 3 } });
    for (const e of events) expect(EconomyPosted.data.safeParse(e.data).success).toBe(true);
  });

  it("goes with its row when the transaction does not commit", async () => {
    const { economy, person, ctx, store } = await rig();
    const id = person(discord("1"));
    expect(() =>
      ctx.db.tx(() => {
        void economy.ledger.post(coin(id, 10, "checkin", null, 1_000));
        throw new Error("the caller failed");
      }),
    ).toThrow(/the caller failed/);
    expect(await economy.ledger.balance("p", id)).toBe(0);
    expect(await store.events.query({ types: [EconomyPosted.type] })).toEqual([]);
  });
});
