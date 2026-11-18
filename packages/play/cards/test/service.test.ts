// The daily card through the store's tables: the price (the first card too), the daily cap by her
// local day, too few coins, a refund when a card cannot be written, the pity counter, the dex with
// series titles, wishlists and their events, and forgetting and merging a person.

import { identitySchema, migrate } from "@miyoria/store";
import { openTestDb, type TestDb } from "@miyoria/store/testing";
import type { PersonId } from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CardOccasion,
  type CardPayer,
  CardService,
  type CardServiceOptions,
  CardStore,
  type CardWallet,
  cardsConfig,
  cardsSchema,
  dayStart,
  drawRules,
  type IssueInput,
  type Part,
  SEED_PARTS,
  SETTLE_GRACE_MS,
  seededRandom,
} from "../src/index.js";

/** 2026-11-17 10:00 in her time zone (UTC+8). */
const T0 = Date.UTC(2026, 10, 17, 2, 0, 0);
const DAY = 86_400_000;
const FACE = {
  name: "小明",
  avatar_url: null,
  call_name: null,
  line: "今天也來了呢",
  stamp: null,
  fields: [],
  number: 1,
};
const FACE_NO_LINE = { ...FACE, line: null };
const FRIEND = {
  tier: "朋友",
  tier_label: "朋友 I",
  closeness: "不錯",
  trust: "有點信任",
  familiarity: "見過幾次",
  public_feeling: null,
};

class FakeWallet implements CardWallet {
  readonly balances = new Map<PersonId, number>();
  readonly charges: { person: PersonId; amount: number; reason: string; key: string }[] = [];
  readonly refunds: { person: PersonId; key: string }[] = [];

  async balance({ person }: CardPayer) {
    return this.balances.get(person) ?? 0;
  }

  /** What a foil costs; `null`: not on sale. */
  foilCost: number | null = 50;
  /** Foils a day. */
  foilsPerDay = 5;

  /**
   * Keyed like the economy's: the same key (and reason) is the same charge, and one given back is
   * refused.
   */
  async spend({ person }: CardPayer, amount: number, reason: string, key: string) {
    const balance = this.balances.get(person) ?? 0;
    if (this.charges.some((c) => c.key === key && c.reason === reason)) {
      if (this.refunds.some((r) => r.key === key)) {
        return { ok: false as const, reason: "refused" as const, message: "given back" };
      }
      return { ok: true as const, receipt: `r-${reason}-${key}`, balance };
    }
    if (balance < amount) return { ok: false as const, reason: "insufficient" as const, balance };
    this.balances.set(person, balance - amount);
    this.charges.push({ person, amount, reason, key });
    return { ok: true as const, receipt: `r-${reason}-${key}`, balance: balance - amount };
  }

  foilPrice() {
    return this.foilCost;
  }

  async foil(payer: CardPayer, key: string) {
    const kept = this.charges.filter((c) => c.reason === "card_foil" && c.person === payer.person);
    const live = kept.filter((c) => !this.refunds.some((r) => r.key === c.key));
    if (!kept.some((c) => c.key === key) && live.length >= this.foilsPerDay) {
      return { ok: false as const, reason: "capped" as const, message: "今天最多 5 次" };
    }
    return this.spend(payer, this.foilCost ?? 0, "card_foil", key);
  }

  /** Keyed by the card like the economy's: its card and foil, once; nothing for no charge. */
  async refund({ person }: CardPayer, key: string) {
    if (this.refunds.some((r) => r.key === key)) return 0;
    const charges = this.charges.filter((c) => c.key === key && c.person === person);
    if (charges.length === 0) return 0;
    const back = charges.reduce((sum, c) => sum + c.amount, 0);
    this.balances.set(person, (this.balances.get(person) ?? 0) + back);
    this.refunds.push({ person, key });
    return back;
  }
}

/** The person paying through a Discord account of theirs. */
const payer = (person: PersonId): CardPayer => ({
  person,
  account: { platform: "discord", id: `acc-${person}` },
});
const face = async () => FACE;

let t: TestDb;
let store: CardStore;
let wallet: FakeWallet;
let now: number;
let serials: number;

beforeEach(() => {
  now = T0;
  serials = 0;
  t = openTestDb({ identity: true, plugins: [cardsSchema], clock: { now: () => now } });
  store = new CardStore(t.db, t.events);
  wallet = new FakeWallet();
});

afterEach(() => t.close());

function service(overrides: Partial<CardServiceOptions> = {}): CardService {
  return new CardService(store, {
    config: cardsConfig(),
    clock: { now: () => now },
    wallet: () => wallet,
    relationship: () => FRIEND,
    random: seededRandom(1),
    newSerial: () => `MYR-TEST-0000-${String(++serials).padStart(4, "0")}`,
    ...overrides,
  });
}

/** One card straight through the store: `random` always 0 gives an N card, the first parts. */
function issue(person: PersonId, overrides: Partial<IssueInput> = {}) {
  return store.issue({
    person,
    kind: "daily",
    serial: `MYR-DRAW-0000-${String(++serials).padStart(4, "0")}`,
    price: 30,
    face: FACE,
    relationship: FRIEND,
    rules: drawRules(cardsConfig()),
    random: () => 0,
    now,
    ...overrides,
  });
}

function events(type: string) {
  return t.events.query({ types: [type], order: "asc", limit: 1000 }).map((e) => e.envelope);
}

describe("the catalogue", () => {
  it("is seeded with every part of SEED_PARTS, as they are", () => {
    const byId = (a: Part, b: Part) => (a.id < b.id ? -1 : 1);
    expect([...store.catalogue()].sort(byId)).toEqual([...SEED_PARTS].sort(byId));
  });
});

describe("a daily card", () => {
  it("costs the price, the first card of the day too", async () => {
    wallet.balances.set("p1", 100);
    const result = await service().issueDaily(payer("p1"), face);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(wallet.charges).toEqual([
      { person: "p1", amount: 30, reason: "card_daily", key: result.issued.card.serial },
    ]);
    expect(wallet.balances.get("p1")).toBe(70);
    const card = store.card(result.issued.card.serial);
    expect(card).toMatchObject({
      person: "p1",
      kind: "daily",
      price: 30,
      face: FACE,
      relationship: FRIEND,
    });
    expect(card?.parts).toHaveLength(5);
  });

  it("stops at five a day, without charging the sixth, and starts again the next local day", async () => {
    wallet.balances.set("p1", 1000);
    const cards = service();
    for (let i = 0; i < 5; i++) expect((await cards.issueDaily(payer("p1"), face)).ok).toBe(true);
    expect(await cards.issueDaily(payer("p1"), face)).toEqual({
      ok: false,
      reason: "daily_cap",
      cap: 5,
    });
    expect(wallet.charges).toHaveLength(5);
    expect(cards.dailyLeft("p1")).toBe(0);
    // Someone else is not affected.
    wallet.balances.set("p2", 30);
    expect((await cards.issueDaily(payer("p2"), face)).ok).toBe(true);
    // Her day starts at midnight UTC+8 (16:00 UTC).
    now = dayStart(T0, 480) + DAY;
    expect(cards.dailyLeft("p1")).toBe(5);
    expect((await cards.issueDaily(payer("p1"), face)).ok).toBe(true);
  });

  it("holds the cap when several are asked for at once", async () => {
    wallet.balances.set("p1", 1000);
    const cards = service();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => cards.issueDaily(payer("p1"), face)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(wallet.charges).toHaveLength(5);
  });

  it("is refused without enough coins, and nothing is written", async () => {
    wallet.balances.set("p1", 29);
    expect(await service().issueDaily(payer("p1"), face)).toEqual({
      ok: false,
      reason: "insufficient",
      price: 30,
      balance: 29,
    });
    expect(store.cards("p1")).toEqual([]);
    expect(store.pitySince("p1")).toBe(0);
    expect(events("cards.drawn")).toEqual([]);
  });

  it("is refused without a wallet, unless it is free", async () => {
    expect(await service({ wallet: () => null }).issueDaily(payer("p1"), face)).toEqual({
      ok: false,
      reason: "no_wallet",
    });
    const free = service({ wallet: () => null, config: cardsConfig({ price: 0 }) });
    expect((await free.issueDaily(payer("p1"), face)).ok).toBe(true);
  });

  it("gives the coins back when the card cannot be written", async () => {
    wallet.balances.set("p1", 30);
    t.db.run("UPDATE cards_parts SET enabled = 0");
    await expect(service().issueDaily(payer("p1"), face)).rejects.toThrow(/nothing to draw/);
    expect(wallet.refunds).toHaveLength(1);
    expect(wallet.balances.get("p1")).toBe(30);
    expect(store.cards("p1")).toEqual([]);
  });

  it("keeps the serial of a keyed card whose refund failed, for the settling", async () => {
    wallet.balances.set("p1", 30);
    t.db.run("UPDATE cards_parts SET enabled = 0");
    wallet.refund = async () => {
      throw new Error("ledger busy");
    };
    await expect(service().issueDaily(payer("p1"), face, { key: "kf" })).rejects.toThrow(
      /nothing to draw/,
    );
    expect(wallet.balances.get("p1")).toBe(0);
    expect(store.pending()).toMatchObject([{ person: "p1", key: "daily:kf" }]);
  });

  it("writes cards.drawn in her DM scope with the card's parts", async () => {
    wallet.balances.set("p1", 30);
    const result = await service().issueDaily(payer("p1"), face);
    if (!result.ok) throw new Error("refused");
    const [event] = events("cards.drawn");
    expect(event).toMatchObject({ person_id: "p1", scope: "dm", tier: "long", source: "cards" });
    expect(event?.data).toMatchObject({
      serial: result.issued.card.serial,
      rarity: result.issued.card.rarity,
      parts: result.issued.card.parts.map((p) => p.id),
      pity_hit: false,
      pity_since: result.issued.pity.since,
      wished: [],
      price: 30,
    });
  });
});

describe("a daily card asked for under a key", () => {
  it("is the one card of its key, after a restart too, charged once", async () => {
    wallet.balances.set("p1", 100);
    const first = await service().issueDaily(payer("p1"), face, { key: "k1" });
    if (!first.ok) throw new Error("refused");
    expect(first.issued.card.issue_key).toBe("daily:k1");
    const again = await service().issueDaily(payer("p1"), face, { key: "k1" });
    expect(again.ok && again.issued).toMatchObject({ again: true, card: first.issued.card });
    expect(wallet.charges).toHaveLength(1);
    expect(service().dailyByKey("p1", "k1")?.serial).toBe(first.issued.card.serial);
    // The same key of someone else is theirs.
    wallet.balances.set("p2", 30);
    expect((await service().issueDaily(payer("p2"), face, { key: "k1" })).ok).toBe(true);
  });

  it("is the card a try charged before Core stopped, and that charge", async () => {
    wallet.balances.set("p1", 100);
    const kept = store.reserve("p1", "daily:k2", "MYR-KEPT-0000-0001", now);
    await wallet.spend(payer("p1"), 30, "card_daily", kept);
    const retry = await service().issueDaily(payer("p1"), face, { key: "k2" });
    expect(retry.ok && retry.issued.card.serial).toBe("MYR-KEPT-0000-0001");
    expect(wallet.charges).toHaveLength(1);
    expect(wallet.balances.get("p1")).toBe(70);
    // Written: nothing is kept for the key any more.
    expect(store.reserve("p1", "daily:k2", "MYR-NEXT-0000-0001", now)).toBe("MYR-NEXT-0000-0001");
  });

  it("is a new charge again once a failed try gave the coins back", async () => {
    wallet.balances.set("p1", 30);
    const cards = service();
    await expect(
      cards.issueDaily(
        payer("p1"),
        async () => {
          throw new Error("she could not write");
        },
        { key: "k3" },
      ),
    ).rejects.toThrow("she could not write");
    expect(wallet.balances.get("p1")).toBe(30);
    const retry = await cards.issueDaily(payer("p1"), face, { key: "k3" });
    expect(retry.ok).toBe(true);
    expect(wallet.charges).toHaveLength(2);
    expect(wallet.balances.get("p1")).toBe(0);
  });
});

describe("a daily card with a foil finish", () => {
  it("costs the card and the foil, both under the card's serial", async () => {
    wallet.balances.set("p1", 100);
    const result = await service().issueDaily(payer("p1"), face, { foil: true, key: "f1" });
    if (!result.ok) throw new Error("refused");
    expect(result.issued.card.foil).toBe(true);
    expect(result.charged).toBe(80);
    const serial = result.issued.card.serial;
    expect(wallet.charges.map((c) => [c.reason, c.amount, c.key])).toEqual([
      ["card_daily", 30, serial],
      ["card_foil", 50, serial],
    ]);
    expect(wallet.balances.get("p1")).toBe(20);
    // Asked again: the card as it was, nothing charged.
    const again = await service().issueDaily(payer("p1"), face, { key: "f1" });
    expect(again.ok && again).toMatchObject({ charged: 0, issued: { again: true } });
    expect(again.ok && again.issued.card.foil).toBe(true);
    expect(wallet.balances.get("p1")).toBe(20);
  });

  it("is refused before any charge without coins for both, or with no foil on sale", async () => {
    wallet.balances.set("p1", 79);
    expect(await service().issueDaily(payer("p1"), face, { foil: true })).toEqual({
      ok: false,
      reason: "insufficient",
      price: 80,
      balance: 79,
    });
    wallet.foilCost = null;
    expect(await service().issueDaily(payer("p1"), face, { foil: true })).toEqual({
      ok: false,
      reason: "no_foil",
    });
    // Even when the card itself is free.
    const free = service({ config: cardsConfig({ price: 0 }) });
    expect(await free.issueDaily(payer("p1"), face, { foil: true })).toEqual({
      ok: false,
      reason: "no_foil",
    });
    expect(wallet.charges).toEqual([]);
    expect(store.pending()).toEqual([]);
  });

  it("gives the card's coins back when the foil is refused", async () => {
    wallet.balances.set("p1", 1000);
    wallet.foilsPerDay = 0;
    expect(await service().issueDaily(payer("p1"), face, { foil: true, key: "f2" })).toEqual({
      ok: false,
      reason: "capped",
      message: "今天最多 5 次",
    });
    expect(wallet.balances.get("p1")).toBe(1000);
    expect(store.cards("p1")).toEqual([]);
    expect(store.pending()).toEqual([]);
  });

  it("is never free on a retry: the card and the foil are paid again after a give-back", async () => {
    wallet.balances.set("p1", 160);
    const cards = service();
    const failing = async () => {
      throw new Error("she could not write");
    };
    await expect(cards.issueDaily(payer("p1"), failing, { foil: true, key: "f3" })).rejects.toThrow(
      "she could not write",
    );
    expect(wallet.balances.get("p1")).toBe(160);
    const retry = await cards.issueDaily(payer("p1"), face, { foil: true, key: "f3" });
    expect(retry.ok && retry.issued.card.foil).toBe(true);
    expect(wallet.balances.get("p1")).toBe(80);
  });

  it("keeps the foil a stopped try ordered: its retry is the same order", async () => {
    wallet.balances.set("p1", 100);
    const kept = store.reserve("p1", "daily:f4", "MYR-KEPT-0000-00F4", now, true);
    await wallet.spend(payer("p1"), 30, "card_daily", kept);
    await wallet.foil(payer("p1"), kept);
    expect(wallet.balances.get("p1")).toBe(20);
    // The balance is below a card now, and the retry asks for no foil: the paid order stands.
    const retry = await service().issueDaily(payer("p1"), face, { key: "f4" });
    expect(retry.ok && retry.issued.card).toMatchObject({ serial: kept, foil: true });
    expect(wallet.balances.get("p1")).toBe(20);
    expect(wallet.charges).toHaveLength(2);
  });

  it("is refused, not answered as paid, for a charge that was given back", async () => {
    wallet.balances.set("p1", 100);
    // A serial still kept although its charges went back (the row's delete failed).
    const kept = store.reserve("p1", "daily:f5", "MYR-KEPT-0000-00F5", now, true);
    await wallet.spend(payer("p1"), 30, "card_daily", kept);
    await wallet.refund(payer("p1"), kept);
    const retry = await service().issueDaily(payer("p1"), face, { key: "f5" });
    expect(retry).toEqual({ ok: false, reason: "refused", message: "given back" });
    expect(store.cards("p1")).toEqual([]);
    // The kept serial went: the next try is a new order.
    expect(store.pending()).toEqual([]);
    const next = await service().issueDaily(payer("p1"), face, { foil: true, key: "f5" });
    expect(next.ok && next.issued.card.foil).toBe(true);
    expect(wallet.balances.get("p1")).toBe(20);
  });
});

describe("a paid card charged and never written", () => {
  const account = async (person: PersonId) => payer(person).account;
  /** A first try that kept `serial` under `key`, was charged, and stopped. */
  async function stopped(person: PersonId, key: string, serial: string) {
    store.reserve(person, `daily:${key}`, serial, now);
    await wallet.spend(payer(person), 30, "card_daily", serial);
  }

  it("gets its coins back once nobody retried it, once, and a later retry is a new charge", async () => {
    wallet.balances.set("p1", 100);
    await stopped("p1", "k1", "MYR-KEPT-0000-0001");
    expect(wallet.balances.get("p1")).toBe(70);
    const cards = service({ account });
    // A try still going is not raced: nothing younger than the grace period is touched.
    now += SETTLE_GRACE_MS - 1;
    expect(await cards.settlePending()).toEqual({ cleared: 0, refunded: 0, waiting: 1 });
    expect(wallet.balances.get("p1")).toBe(70);
    now += 1;
    expect(await cards.settlePending()).toEqual({ cleared: 0, refunded: 1, waiting: 0 });
    expect(wallet.balances.get("p1")).toBe(100);
    expect(wallet.refunds).toEqual([{ person: "p1", key: "MYR-KEPT-0000-0001" }]);
    expect(store.pending()).toEqual([]);
    // Again: nothing left to settle, nothing given twice.
    expect(await cards.settlePending()).toEqual({ cleared: 0, refunded: 0, waiting: 0 });
    expect(wallet.balances.get("p1")).toBe(100);
    // The same key later is a new try: a new serial, a new charge, one card.
    const retry = await cards.issueDaily(payer("p1"), face, { key: "k1" });
    expect(retry.ok && retry.issued.card.serial).not.toBe("MYR-KEPT-0000-0001");
    expect(wallet.balances.get("p1")).toBe(70);
    expect(store.cards("p1")).toHaveLength(1);
  });

  it("clears the row of a card written after all, and refunds nothing", async () => {
    wallet.balances.set("p1", 100);
    const cards = service({ account });
    const issued = await cards.issueDaily(payer("p1"), face, { key: "k2" });
    if (!issued.ok) throw new Error("refused");
    // A row left behind next to its card (it is normally deleted with the card's write).
    store.reserve("p1", "daily:k2", issued.issued.card.serial, now);
    now += SETTLE_GRACE_MS;
    expect(await cards.settlePending()).toEqual({ cleared: 1, refunded: 0, waiting: 0 });
    expect(wallet.refunds).toEqual([]);
    expect(wallet.balances.get("p1")).toBe(70);
    expect(store.pending()).toEqual([]);
  });

  it("waits for the wallet and an account, and settles once they are there", async () => {
    wallet.balances.set("p1", 100);
    await stopped("p1", "k3", "MYR-KEPT-0000-0003");
    now += SETTLE_GRACE_MS;
    let open: FakeWallet | null = null;
    const noAccount = service({ account: async () => null });
    expect(await noAccount.settlePending()).toEqual({ cleared: 0, refunded: 0, waiting: 1 });
    const cards = service({ account, wallet: () => open });
    expect(await cards.settlePending()).toEqual({ cleared: 0, refunded: 0, waiting: 1 });
    expect(store.pending()).toHaveLength(1);
    open = wallet;
    expect(await cards.settlePending()).toEqual({ cleared: 0, refunded: 1, waiting: 0 });
    expect(wallet.balances.get("p1")).toBe(100);
  });

  it("keeps the row when the refund fails, for the next pass", async () => {
    wallet.balances.set("p1", 100);
    await stopped("p1", "k4", "MYR-KEPT-0000-0004");
    now += SETTLE_GRACE_MS;
    const refund = wallet.refund.bind(wallet);
    wallet.refund = async () => {
      throw new Error("ledger busy");
    };
    const cards = service({ account });
    expect(await cards.settlePending()).toEqual({ cleared: 0, refunded: 0, waiting: 1 });
    wallet.refund = refund;
    expect(await cards.settlePending()).toEqual({ cleared: 0, refunded: 1, waiting: 0 });
    expect(wallet.balances.get("p1")).toBe(100);
  });

  it("also settles a try that kept its serial and stopped before the charge", async () => {
    wallet.balances.set("p1", 100);
    store.reserve("p1", "daily:k5", "MYR-KEPT-0000-0005", now);
    now += SETTLE_GRACE_MS;
    expect(await service({ account }).settlePending()).toEqual({
      cleared: 0,
      refunded: 1,
      waiting: 0,
    });
    expect(wallet.balances.get("p1")).toBe(100);
    expect(store.pending()).toEqual([]);
  });
});

describe("a milestone card", () => {
  const friends = { min: 15, label: "朋友" } as const;
  const occasion = (faces: number[]) => async () => {
    faces.push(1);
    return { face: FACE, relationship: FRIEND };
  };

  it("is free, once per tier, outside the day's cap and the pity", async () => {
    wallet.balances.set("p1", 1000);
    const cards = service();
    for (let i = 0; i < 5; i++) await cards.issueDaily(payer("p1"), face);
    const pity = store.pitySince("p1");
    const asked: number[] = [];
    const first = await cards.issueMilestone("p1", friends, occasion(asked));
    if (!first.ok) throw new Error("refused");
    expect(first.issued.again).toBe(false);
    expect(first.issued.card).toMatchObject({
      kind: "milestone",
      price: 0,
      issue_key: "milestone:15",
      pity_hit: false,
    });
    expect(wallet.charges).toHaveLength(5);
    expect(store.pitySince("p1")).toBe(pity);
    expect(cards.dailyLeft("p1")).toBe(0);
    // Asked again (down and up again, or a restart): the same card, her words not asked for.
    const again = await service().issueMilestone("p1", friends, occasion(asked));
    expect(again.ok && again.issued).toMatchObject({ again: true, card: first.issued.card });
    expect(asked).toHaveLength(1);
    expect(store.cards("p1").filter((c) => c.kind === "milestone")).toHaveLength(1);
    // Another tier is another card.
    expect(
      (await cards.issueMilestone("p1", { min: 45, label: "好朋友" }, occasion(asked))).ok,
    ).toBe(true);
    expect(events("cards.drawn").at(-1)?.data).toMatchObject({ kind: "milestone", price: 0 });
  });

  it("is never given twice for a tier, not after they asked her to forget them", async () => {
    const cards = service();
    const asked: number[] = [];
    expect((await cards.issueMilestone("p1", friends, occasion(asked))).ok).toBe(true);
    expect(store.milestoneGiven("p1", 15)).toBe(true);
    expect(store.forgetPerson(["p1"])).toMatchObject({ cards_card: 1 });
    expect(store.cards("p1")).toEqual([]);
    // The heart forgot the floor, the bond climbed back: no second card, her words not asked for.
    expect(await cards.issueMilestone("p1", friends, occasion(asked))).toEqual({
      ok: false,
      reason: "not_eligible",
    });
    expect(asked).toHaveLength(1);
    // A tier never reached still gives its card.
    expect(
      (await cards.issueMilestone("p1", { min: 45, label: "好朋友" }, occasion(asked))).ok,
    ).toBe(true);
  });

  it("merged, is the kept person's: no tier either had gives another", async () => {
    const cards = service();
    expect((await cards.issueMilestone("a", friends, occasion([]))).ok).toBe(true);
    store.merge("k", "a");
    expect(store.milestoneGiven("k", 15)).toBe(true);
    expect(store.milestoneGiven("a", 15)).toBe(false);
    store.forgetPerson(["k"]);
    expect(await cards.issueMilestone("k", friends, occasion([]))).toEqual({
      ok: false,
      reason: "not_eligible",
    });
  });

  it("is marked for every milestone card already there when the mark comes (migration 8)", () => {
    const before = { ...cardsSchema, migrations: cardsSchema.migrations.slice(0, 7) };
    const old = openTestDb({ identity: true, plugins: [before], clock: { now: () => now } });
    try {
      const card = (serial: string, person: string, kind: string, key: string | null, at: number) =>
        old.db.run(
          "INSERT INTO cards_card (serial, person_id, kind, rarity, parts, created_at, issue_key) VALUES ($serial, $person, $kind, 'N', '{}', $at, $key)",
          { serial, person, kind, key, at },
        );
      card("MYR-OLD-0000-0001", "p1", "milestone", "milestone:15", 10);
      card("MYR-OLD-0000-0002", "p1", "milestone", "milestone:45", 20);
      // A merge's leftover: a milestone card that is no longer the one of its key.
      card("MYR-OLD-0000-0003", "p2", "milestone", null, 30);
      card("MYR-OLD-0000-0004", "p2", "daily", "daily:x", 40);
      migrate(old.db, [identitySchema, cardsSchema]);
      expect(
        old.db.all("SELECT person_id, tier_min, given_at FROM cards_milestone ORDER BY tier_min"),
      ).toEqual([
        { person_id: "p1", tier_min: 15, given_at: 10 },
        { person_id: "p1", tier_min: 45, given_at: 20 },
      ]);
    } finally {
      old.close();
    }
  });

  it("is only for a tier above 認識 on the ladder, and not without a face", async () => {
    const cards = service();
    const asked: number[] = [];
    for (const tier of [
      { min: 0, label: "認識" },
      { min: 16, label: "朋友" },
      { min: 15, label: "好朋友" },
    ] as const) {
      expect(await cards.issueMilestone("p1", tier, occasion(asked))).toEqual({
        ok: false,
        reason: "not_eligible",
      });
    }
    expect(await cards.issueMilestone("p1", friends, async () => null)).toEqual({
      ok: false,
      reason: "no_face",
    });
    expect(asked).toEqual([]);
    expect(store.cards("p1")).toEqual([]);
  });
});

describe("a keepsake card", () => {
  const LEGACY = { first_seen: "2025-03-01T00:00:00.000Z", old_tier: "摯友", cards: 4 };
  const migrated = (p: PersonId) => store.importedLegacy(p) !== null;
  const words = async () => ({ face: FACE, relationship: FRIEND });

  it("is for someone the import brought, once, free and outside the pity", async () => {
    t.db.run(
      "INSERT INTO persons (id, name, handle, created_at, legacy) VALUES ('p9', '小九', '小九', 1, $legacy)",
      { legacy: JSON.stringify(LEGACY) },
    );
    expect(store.importedLegacy("p9")).toEqual(LEGACY);
    expect(store.importedLegacy("p1")).toBeNull();
    const cards = service({ migrated });
    expect(await cards.keepsake("p1", words)).toEqual({ ok: false, reason: "not_eligible" });
    // Nobody is from before without being told who.
    expect(await service().keepsake("p9", words)).toEqual({ ok: false, reason: "not_eligible" });
    const first = await cards.keepsake("p9", words);
    if (!first.ok) throw new Error("refused");
    expect(first.issued.card).toMatchObject({ kind: "keepsake", price: 0, issue_key: "keepsake" });
    expect(store.pitySince("p9")).toBe(0);
    expect(wallet.charges).toEqual([]);
    const again = await cards.keepsake("p9", async () => {
      throw new Error("not asked again");
    });
    expect(again.ok && again.issued.again).toBe(true);
    expect(store.cards("p9")).toHaveLength(1);
  });

  it("is never given twice, not after they asked her to forget them", async () => {
    const cards = service({ migrated: () => true });
    const first = await cards.keepsake("p9", words);
    expect(first.ok).toBe(true);
    expect(store.keepsakeGiven("p9")).toBe(true);
    // Their cards go; the mark that they had their keepsake stays.
    expect(store.forgetPerson(["p9"])).toMatchObject({ cards_card: 1 });
    expect(store.cards("p9")).toEqual([]);
    expect(await cards.keepsake("p9", words)).toEqual({ ok: false, reason: "not_eligible" });
    expect(store.cards("p9")).toEqual([]);
  });

  it("merged, is the kept person's: neither gets another", async () => {
    const cards = service({ migrated: () => true });
    expect((await cards.keepsake("a", words)).ok).toBe(true);
    store.merge("k", "a");
    expect(store.keepsakeGiven("k")).toBe(true);
    expect(store.keepsakeGiven("a")).toBe(false);
    store.forgetPerson(["k"]);
    expect(await cards.keepsake("k", words)).toEqual({ ok: false, reason: "not_eligible" });
  });

  it("gets her line later, once, through the writer, and is let be after a few tries", async () => {
    const cards = service({ migrated: () => true });
    const fields = [{ label: "第一次見面", text: "2025-03-01" }];
    for (const p of ["p1", "p2", "p3"]) {
      const given = await cards.keepsake(p, async () => ({
        face: { ...FACE, line: null, fields },
        relationship: FRIEND,
      }));
      expect(given.ok).toBe(true);
    }
    const asked: { person: string; occasion: unknown }[] = [];
    const rewritten: string[] = [];
    const lines: Record<string, string | null> = { p1: "好久不見,還記得那年冬天嗎", p2: null };
    const faces = {
      async face(person: PersonId, occasion: CardOccasion) {
        asked.push({ person, occasion });
        // p3: someone she will not say anything about now.
        if (person === "p3") return null;
        return { face: { ...FACE, line: lines[person] ?? null }, relationship: FRIEND };
      },
      rewritten: (serial: string) => rewritten.push(serial),
    };
    const p1 = store.cards("p1")[0];
    store.setArtifact(p1?.serial ?? "", "art-1");
    expect(await cards.writeKeepsakeLines(faces, 10)).toEqual({ written: 1, tried: 3 });
    expect(asked[0]).toEqual({ person: "p1", occasion: { kind: "keepsake", facts: fields } });
    // Her line, and only it: the facts and the rest stay as issued; its picture of record goes.
    const written = store.card(p1?.serial ?? "");
    expect(written?.face).toMatchObject({
      line: "好久不見,還記得那年冬天嗎",
      fields,
      name: "小明",
    });
    expect(written?.artifact_id).toBeNull();
    expect(rewritten).toEqual([p1?.serial]);
    // Again: p1 is done; the others are tried until the third try, then let be.
    expect(await cards.writeKeepsakeLines(faces, 10)).toEqual({ written: 0, tried: 2 });
    expect(await cards.writeKeepsakeLines(faces, 10)).toEqual({ written: 0, tried: 2 });
    expect(await cards.writeKeepsakeLines(faces, 10)).toEqual({ written: 0, tried: 0 });
    expect(asked.filter((a) => a.person === "p1")).toHaveLength(1);
    expect(store.keepsakesWithoutLine(10)).toEqual([]);
    // A line is never written over.
    expect(store.setKeepsakeLine(p1?.serial ?? "", "另一句")).toBe(false);
    expect(store.card(p1?.serial ?? "")?.face.line).toBe("好久不見,還記得那年冬天嗎");
  });

  it("takes a few lines a pass, oldest first", async () => {
    const cards = service({ migrated: () => true });
    for (const p of ["p1", "p2", "p3"]) {
      now += 1000;
      await cards.keepsake(p, async () => ({ face: FACE_NO_LINE, relationship: FRIEND }));
    }
    const asked: string[] = [];
    const faces = {
      async face(person: PersonId) {
        asked.push(person);
        return { face: { ...FACE, line: `給 ${person}` }, relationship: FRIEND };
      },
    };
    expect(await cards.writeKeepsakeLines(faces, 2)).toEqual({ written: 2, tried: 2 });
    expect(asked).toEqual(["p1", "p2"]);
    expect(await cards.writeKeepsakeLines(faces, 2)).toEqual({ written: 1, tried: 1 });
    expect(asked).toEqual(["p1", "p2", "p3"]);
  });

  it("is marked for every keepsake card already there when the mark comes (migration 5)", () => {
    const before = { ...cardsSchema, migrations: cardsSchema.migrations.slice(0, 4) };
    const old = openTestDb({ identity: true, plugins: [before], clock: { now: () => now } });
    try {
      const card = (serial: string, person: string, kind: string, key: string | null, at: number) =>
        old.db.run(
          "INSERT INTO cards_card (serial, person_id, kind, rarity, parts, created_at, issue_key) VALUES ($serial, $person, $kind, 'N', '{}', $at, $key)",
          { serial, person, kind, key, at },
        );
      card("MYR-OLD-0000-0001", "p1", "keepsake", "keepsake", 10);
      card("MYR-OLD-0000-0002", "p2", "daily", null, 20);
      card("MYR-OLD-0000-0003", "p3", "keepsake", null, 30);
      card("MYR-OLD-0000-0004", "p3", "keepsake", "keepsake", 40);
      migrate(old.db, [identitySchema, cardsSchema]);
      const migrated = new CardStore(old.db, old.events);
      expect(migrated.keepsakeGiven("p1")).toBe(true);
      expect(migrated.keepsakeGiven("p2")).toBe(false);
      expect(migrated.keepsakeGiven("p3")).toBe(true);
      expect(
        old.db.all("SELECT person_id, given_at FROM cards_keepsake ORDER BY person_id"),
      ).toEqual([
        { person_id: "p1", given_at: 10 },
        { person_id: "p3", given_at: 30 },
      ]);
    } finally {
      old.close();
    }
  });
});

describe("the pity", () => {
  it("counts up to 20 and gives SR or better on the 21st, then starts again", () => {
    for (let i = 1; i <= 20; i++) {
      const issued = issue("p1");
      expect(issued.card.rarity).toBe("N");
      expect(issued.pity).toEqual({ since: i, pity: 20, until: 20 - i });
    }
    const hit = issue("p1");
    expect(["SR", "SSR"]).toContain(hit.card.rarity);
    expect(hit.card.pity_hit).toBe(true);
    expect(hit.pity.since).toBe(0);
    expect(store.pitySince("p1")).toBe(0);
    const drawn = events("cards.drawn");
    expect(drawn.at(-1)?.data).toMatchObject({ pity_hit: true, pity_since: 0 });
    expect(drawn.filter((e) => (e.data as { pity_hit: boolean }).pity_hit)).toHaveLength(1);
  });
});

describe("the dex", () => {
  it("collects parts, not blanks, and counts repeats", () => {
    const first = issue("p1");
    const second = issue("p1");
    const collected = first.card.parts.filter((p) => !p.blank).map((p) => p.id);
    expect(first.new_parts).toEqual(collected);
    expect(second.new_parts).toEqual([]);
    const dex = service().dex("p1");
    expect(dex.parts.map((p) => [p.part, p.count]).sort()).toEqual(
      collected.map((id) => [id, 2]).sort(),
    );
    expect(dex.parts.every((p) => p.first_card === first.card.serial)).toBe(true);
    expect(dex.parts.some((p) => p.part.endsWith(".none"))).toBe(false);
  });

  it("gives a series' title once, on the card that completes it", () => {
    // The 眼鏡系列 is the plain glasses and the monocle; they already have the monocle.
    t.db.run(
      "INSERT INTO cards_dex (person_id, part_id, first_at, count) VALUES ('p1', 'accessory.monocle', 1, 1)",
    );
    const issued = issue("p1");
    expect(issued.card.parts.map((p) => p.id)).toContain("accessory.glasses");
    expect(issued.titles).toMatchObject([{ series: "glasses", title: "眼鏡控", public: false }]);
    expect(issue("p1").titles).toEqual([]);
    const dex = service().dex("p1");
    expect(dex.titles).toHaveLength(1);
    expect(dex.series.find((s) => s.id === "glasses")).toMatchObject({
      owned: 2,
      total: 2,
      complete: true,
    });
    expect(events("cards.titled").map((e) => e.data)).toEqual([
      { person: "p1", series: "glasses", title: "眼鏡控", serial: issued.card.serial },
    ]);
  });

  it("keeps a title theirs alone until they make it public, and back", () => {
    t.db.run(
      "INSERT INTO cards_dex (person_id, part_id, first_at, count) VALUES ('p1', 'accessory.monocle', 1, 1)",
    );
    issue("p1");
    const cards = service();
    expect(cards.publicTitles("p1")).toEqual([]);
    expect(cards.setTitlePublic("p1", "glasses", true)).toMatchObject({
      series: "glasses",
      title: "眼鏡控",
      public: true,
    });
    expect(cards.publicTitles("p1").map((x) => x.title)).toEqual(["眼鏡控"]);
    expect(cards.setTitlePublic("p1", "glasses", false)?.public).toBe(false);
    expect(cards.publicTitles("p1")).toEqual([]);
    // Nobody's title but their own, and only one they have.
    expect(cards.setTitlePublic("p2", "glasses", true)).toBeNull();
    expect(cards.setTitlePublic("p1", "sky", true)).toBeNull();
  });
});

describe("the wishlist", () => {
  it("holds up to three parts, each once, each collectable", () => {
    const cards = service();
    expect(cards.setWishlist("p1", ["pose.sway", "pose.shy", "pose.front"])).toBeNull();
    expect(cards.wishlist("p1")).toEqual(["pose.sway", "pose.shy", "pose.front"]);
    expect(cards.setWishlist("p1", ["pose.sway", "pose.shy", "pose.front", "pose.look_up"])).toBe(
      "too_many",
    );
    expect(cards.setWishlist("p1", ["pose.sway", "pose.sway"])).toBe("duplicate");
    expect(cards.setWishlist("p1", ["pose.moonwalk"])).toBe("unknown_part");
    expect(cards.setWishlist("p1", ["hand.none"])).toBe("unknown_part");
    // A refused list leaves the old one.
    expect(cards.wishlist("p1")).toEqual(["pose.sway", "pose.shy", "pose.front"]);
    expect(cards.setWishlist("p1", ["background.aurora"])).toBeNull();
    expect(cards.wishlist("p1")).toEqual(["background.aurora"]);
    // A part only a drop gives can be wished for; one no card can give now cannot.
    expect(cards.setWishlist("p1", ["background.fireworks"])).toBeNull();
    t.db.run("UPDATE cards_parts SET enabled = 0 WHERE id = 'pose.sway'");
    expect(cards.setWishlist("p1", ["pose.sway"])).toBe("unknown_part");
    cards.clearWishlist("p1");
    expect(cards.wishlist("p1")).toEqual([]);
  });

  it("flags a draw with a wished part, and changes nothing about the draw", () => {
    const plain = issue("p2");
    const wished = plain.card.parts.find((p) => !p.blank)?.id as string;
    service().setWishlist("p1", ["background.aurora", wished]);
    const card = issue("p1").card;
    expect(card.parts).toEqual(plain.card.parts);
    expect(card.wished).toEqual([wished]);
    expect(events("cards.drawn").at(-1)?.data).toMatchObject({ wished: [wished] });
  });
});

describe("a person", () => {
  it("forgotten loses every row of theirs, nobody else's", () => {
    issue("p1");
    issue("p2");
    service().setWishlist("p1", ["pose.sway"]);
    const counts = store.forgetPerson(["p1"]);
    expect(counts).toMatchObject({ cards_card: 1, cards_pity: 1, cards_wishlist: 1 });
    expect(store.cards("p1")).toEqual([]);
    expect(store.dex("p1")).toEqual([]);
    expect(store.cards("p2")).toHaveLength(1);
  });

  it("forgotten, still has had the day's cards: a forget resets no limit", async () => {
    wallet.balances.set("p1", 1000);
    const cards = service();
    for (let i = 0; i < 5; i++) expect((await cards.issueDaily(payer("p1"), face)).ok).toBe(true);
    expect(store.forgetPerson(["p1"])).toMatchObject({ cards_card: 5 });
    expect(store.cards("p1")).toEqual([]);
    expect(cards.dailyLeft("p1")).toBe(0);
    expect(await cards.issueDaily(payer("p1"), face)).toEqual({
      ok: false,
      reason: "daily_cap",
      cap: 5,
    });
    // The next local day is a new day, and what the limits counted two days back is gone.
    now = dayStart(T0, 480) + DAY;
    expect(cards.dailyLeft("p1")).toBe(5);
    expect((await cards.issueDaily(payer("p1"), face)).ok).toBe(true);
    now += 2 * DAY + 3_600_000;
    expect((await cards.issueDaily(payer("p1"), face)).ok).toBe(true);
    expect(t.db.all("SELECT kind, at FROM cards_tally WHERE person_id = 'p1'")).toHaveLength(1);
  });

  it("merged, keeps what the day's limits counted of both", async () => {
    wallet.balances.set("a", 1000);
    wallet.balances.set("k", 1000);
    const cards = service();
    for (let i = 0; i < 3; i++) await cards.issueDaily(payer("a"), face);
    for (let i = 0; i < 2; i++) await cards.issueDaily(payer("k"), face);
    store.merge("k", "a");
    expect(cards.dailyLeft("k")).toBe(0);
    expect(cards.dailyLeft("a")).toBe(5);
  });

  it("has today's cards counted when the count comes apart from them (migration 7)", () => {
    const before = { ...cardsSchema, migrations: cardsSchema.migrations.slice(0, 6) };
    const old = openTestDb({ identity: true, plugins: [before], clock: { now: () => now } });
    try {
      const card = (serial: string, person: string, kind: string, ago: number) =>
        old.db.run(
          "INSERT INTO cards_card (serial, person_id, kind, rarity, parts, created_at) VALUES ($serial, $person, $kind, 'N', '{}', $at)",
          { serial, person, kind, at: (Date.now() - ago) * 1000 },
        );
      card("MYR-OLD-0000-0001", "p1", "daily", 60_000);
      card("MYR-OLD-0000-0002", "p1", "drop", 60_000);
      card("MYR-OLD-0000-0003", "p1", "milestone", 60_000);
      card("MYR-OLD-0000-0004", "p2", "daily", 3 * DAY);
      migrate(old.db, [identitySchema, cardsSchema]);
      expect(old.db.all("SELECT person_id, kind FROM cards_tally ORDER BY kind")).toEqual([
        { person_id: "p1", kind: "daily" },
        { person_id: "p1", kind: "drop" },
      ]);
      const migrated = new CardStore(old.db, old.events);
      expect(migrated.countSince("p1", "daily", Date.now() - DAY)).toBe(1);
      expect(migrated.countSince("p2", "daily", Date.now() - 4 * DAY)).toBe(0);
    } finally {
      old.close();
    }
  });

  it("merged into another keeps the cards, adds up the dex and keeps the longer pity run", () => {
    for (let i = 0; i < 3; i++) issue("a");
    issue("k");
    store.merge("k", "a");
    expect(store.cards("k")).toHaveLength(4);
    expect(store.cards("a")).toEqual([]);
    expect(store.pitySince("k")).toBe(3);
    expect(store.dex("k").every((e) => e.count === 4)).toBe(true);
    expect(store.dex("a")).toEqual([]);
  });

  it("forgotten, still gets back what a card never written was charged", async () => {
    wallet.balances.set("p1", 100);
    store.reserve("p1", "daily:k1", "MYR-KEPT-0000-0001", now);
    await wallet.spend(payer("p1"), 30, "card_daily", "MYR-KEPT-0000-0001");
    store.forgetPerson(["p1"]);
    expect(store.pending()).toHaveLength(1);
    now += SETTLE_GRACE_MS;
    const account = async (p: PersonId) => payer(p).account;
    expect(await service({ account }).settlePending()).toMatchObject({ refunded: 1 });
    expect(wallet.balances.get("p1")).toBe(100);
    expect(store.pending()).toEqual([]);
  });

  it("merged, hands a try still pending to the kept person, and never pays for one twice", async () => {
    wallet.balances.set("a", 100);
    wallet.balances.set("k", 100);
    const account = async (p: PersonId) => payer(p).account;
    // Both stopped after paying for a try under the same key; the kept person's also got its card.
    store.reserve("a", "daily:k1", "MYR-KEPT-0000-000A", now);
    await wallet.spend(payer("a"), 30, "card_daily", "MYR-KEPT-0000-000A");
    store.reserve("a", "daily:k2", "MYR-KEPT-0000-00A2", now);
    await wallet.spend(payer("a"), 30, "card_daily", "MYR-KEPT-0000-00A2");
    store.reserve("a", "daily:k3", "MYR-KEPT-0000-00A3", now);
    await wallet.spend(payer("a"), 30, "card_daily", "MYR-KEPT-0000-00A3");
    const written = await service().issueDaily(payer("k"), face, { key: "k1" });
    if (!written.ok) throw new Error("refused");
    // The kept person's own try of k3 stopped before it was charged.
    store.reserve("k", "daily:k3", "MYR-KEPT-0000-00K3", now);
    store.merge("k", "a");
    // The economy's wallet of the kept person is theirs and the absorbed one's together.
    for (const c of wallet.charges) if (c.person === "a") c.person = "k";
    wallet.balances.set("k", (wallet.balances.get("k") ?? 0) + (wallet.balances.get("a") ?? 0));
    wallet.balances.delete("a");
    expect(wallet.balances.get("k")).toBe(80);
    expect(store.pending().map((p) => [p.person, p.key, p.serial])).toEqual([
      ["k", "daily:k1", "MYR-KEPT-0000-000A"],
      ["k", "daily:k2", "MYR-KEPT-0000-00A2"],
      ["k", "daily:k3", "MYR-KEPT-0000-00K3"],
      ["k", "daily:k3#MYR-KEPT-0000-00A3", "MYR-KEPT-0000-00A3"],
    ]);
    // The kept person retries the absorbed try of k2: the card it paid for, nothing more.
    const retry = await service().issueDaily(payer("k"), face, { key: "k2" });
    expect(retry.ok && retry.issued.card.serial).toBe("MYR-KEPT-0000-00A2");
    expect(wallet.balances.get("k")).toBe(80);
    // Of k1 the card is the kept person's own, and k3's kept serial is theirs: the absorbed tries
    // of both paid for no card and go back; the kept person's uncharged one just goes.
    now += SETTLE_GRACE_MS;
    expect(await service({ account }).settlePending()).toEqual({
      cleared: 0,
      refunded: 3,
      waiting: 0,
    });
    expect(wallet.balances.get("k")).toBe(140);
    expect(store.pending()).toEqual([]);
  });

  it("merged, keeps both cards of a key they both had, only one as that key's", () => {
    issue("a", { kind: "milestone", key: "milestone:15", pity: false });
    issue("k", { kind: "milestone", key: "milestone:15", pity: false });
    store.merge("k", "a");
    const cards = store.cards("k");
    expect(cards).toHaveLength(2);
    expect(cards.filter((c) => c.issue_key === "milestone:15")).toHaveLength(1);
  });
});
