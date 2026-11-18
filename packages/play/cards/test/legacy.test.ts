// The old collectibles (抽收藏) are kept: every `economy_docs` row of kind `item` is copied once
// into `cards_legacy`, whoever's account it was on, and shown as the closed series 舊收藏, copies
// counted together. Nothing a person owned is lost, a second copy run takes nothing twice, and the
// economy's own rows are not touched.

import type { Identity } from "@miyoria/store";
import { openTestDb, type TestDb } from "@miyoria/store/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardStore, cardsSchema } from "../src/index.js";

const NOW = Date.UTC(2026, 10, 17, 2, 0, 0);

let t: TestDb;
let identity: Identity;
let store: CardStore;

/** The economy's documents table as far as the copy reads it. */
const DOCS = `CREATE TABLE economy_docs (
  kind text NOT NULL, id text NOT NULL, owner_account_id text, status text NOT NULL,
  version integer NOT NULL, data text NOT NULL, created_at integer NOT NULL,
  updated_at integer NOT NULL, PRIMARY KEY (kind, id)
)`;

function doc(kind: string, id: string, account: string, data: object, at: number) {
  t.db.run(
    "INSERT INTO economy_docs (kind, id, owner_account_id, status, version, data, created_at, updated_at) " +
      "VALUES ($kind, $id, $account, 'held', 1, $data, $at, $at)",
    { kind, id, account, data: JSON.stringify(data), at: at * 1000 },
  );
}

beforeEach(() => {
  t = openTestDb({ identity: true, plugins: [cardsSchema], clock: { now: () => NOW } });
  identity = t.identity as Identity;
  store = new CardStore(t.db, t.events);
});

afterEach(() => t.close());

describe("the old collectibles", () => {
  it("are copied once, all of them, and shown by person with copies counted", () => {
    t.db.exec(DOCS);
    const alice = identity.see({ platform: "discord", id: "a1" }, "Alice");
    const aliceTwo = { platform: "discord", id: "a2" };
    identity.see(aliceTwo, "Alice two");
    identity.link(aliceTwo, alice.id, "code");
    const bob = identity.see({ platform: "discord", id: "b1" }, "Bob");
    const acc = (id: string) => identity.account({ platform: "discord", id })?.id as string;
    doc("item", "i1", acc("a1"), { item: "glasses_black", rarity: "N", source: "draw" }, NOW - 3);
    doc("item", "i2", acc("a2"), { item: "glasses_black", rarity: "N", source: "card" }, NOW - 2);
    doc("item", "i3", acc("a1"), { item: "bg_aurora", rarity: "SSR", source: "draw" }, NOW - 1);
    doc("item", "i4", acc("a1"), { item: "shop_lamp", rarity: "R", source: "shop" }, NOW);
    doc("item", "i5", acc("b1"), { item: "hand_pot", rarity: "SR", source: "gift" }, NOW);
    // Not a collectible: left alone.
    doc("bet", "x1", acc("a1"), { amount: 5 }, NOW);

    expect(store.importLegacy()).toBe(5);
    expect(store.importLegacy()).toBe(0);
    expect(store.legacy(alice.id)).toEqual([
      expect.objectContaining({
        item: "glasses_black",
        name: "黑框眼鏡",
        series: "眼鏡系列",
        count: 2,
      }),
      expect.objectContaining({ item: "bg_aurora", name: "極光", rarity: "SSR", count: 1 }),
      // An id the old default catalogue did not have keeps its id as its name.
      expect.objectContaining({ item: "shop_lamp", name: "shop_lamp", series: null, count: 1 }),
    ]);
    expect(store.legacy(bob.id)).toEqual([
      expect.objectContaining({ item: "hand_pot", name: "大鋼盆", count: 1 }),
    ]);
    // The economy's rows are still there.
    expect(t.db.get("SELECT count(*) AS n FROM economy_docs")?.n).toBe(6);
  });

  it("are copied as they come in, and none twice", () => {
    t.db.exec(DOCS);
    const alice = identity.see({ platform: "discord", id: "a1" }, "Alice");
    const acc = identity.account({ platform: "discord", id: "a1" })?.id as string;
    doc("item", "i1", acc, { item: "bg_stars" }, NOW);
    expect(store.importLegacy()).toBe(1);
    doc("item", "i2", acc, { item: "bg_stars" }, NOW + 1);
    expect(store.importLegacy()).toBe(1);
    expect(store.legacy(alice.id)).toEqual([
      expect.objectContaining({ item: "bg_stars", name: "星點", rarity: "R", count: 2 }),
    ]);
  });

  it("stay when the person is forgotten, like what coins bought", () => {
    t.db.exec(DOCS);
    const alice = identity.see({ platform: "discord", id: "a1" }, "Alice");
    const acc = identity.account({ platform: "discord", id: "a1" })?.id as string;
    doc("item", "i1", acc, { item: "bg_stars" }, NOW);
    store.importLegacy();
    expect(store.forgetPerson([alice.id])).not.toHaveProperty("cards_legacy");
    expect(store.legacy(alice.id)).toHaveLength(1);
  });

  it("are nothing without the economy's table", () => {
    expect(store.importLegacy()).toBe(0);
  });
});
