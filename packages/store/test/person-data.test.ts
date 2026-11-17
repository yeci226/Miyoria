// Forgetting and merging a person through every schema's hooks (`person-data.ts`): in dependency
// order, in one transaction, recorded as one event.

import {
  type AccountRef,
  type ContextKey,
  newId,
  type PersonId,
  toTimestamp,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { authTables } from "../../auth/src/tables.js";
import { directiveTables } from "../../brain/directive/src/tables.js";
import { economyTables } from "../../economy/src/tables.js";
import { memoryTables } from "../../memory/memory/src/tables.js";
import {
  type Db,
  declined,
  hookCounts,
  PERSON_FORGET_TYPE,
  PERSON_MERGE_TYPE,
  SqliteStore,
  type StorePlugin,
} from "../src/index.js";

/** A plugin keeping rows by person, with both hooks; `fail` makes the next hook throw. */
class Shop {
  fail = false;
  readonly seen: string[] = [];
  constructor(readonly db: Db) {}
  add(person: PersonId): void {
    this.db.run("INSERT INTO shop_items (id, person_id) VALUES ($id, $person)", {
      id: newId(),
      person,
    });
  }
  of(person: PersonId): number {
    return Number(
      this.db.get("SELECT COUNT(*) AS n FROM shop_items WHERE person_id = $person", { person })?.n,
    );
  }
}

const shop: StorePlugin<Shop> = {
  schema: {
    plugin: "shop",
    migrations: [
      {
        version: 1,
        name: "init",
        sql: "CREATE TABLE shop_items (id TEXT PRIMARY KEY, person_id TEXT NOT NULL) STRICT;",
      },
    ],
  },
  open: ({ db }) => new Shop(db),
  forgetPerson: (opened, r) => {
    opened.seen.push(`forget ${r.ids.join(",")} ${r.accounts.map((a) => a.id).join(",")}`);
    const n = opened.db.run(
      "DELETE FROM shop_items WHERE person_id IN (SELECT value FROM json_each($ids))",
      { ids: JSON.stringify(r.ids) },
    );
    if (opened.fail) throw new Error("the shop broke");
    return { counts: { items: n } };
  },
  mergePerson: (opened, r) => {
    // Runs before identity merges the people: `absorb` is still a person of its own.
    opened.seen.push(`merge ${r.absorb} into ${r.keep}`);
    const n = opened.db.run("UPDATE shop_items SET person_id = $keep WHERE person_id = $absorb", {
      keep: r.keep,
      absorb: r.absorb,
    });
    if (opened.fail) throw new Error("the shop broke");
    return { counts: { items: n } };
  },
};

/** A plugin that keeps its rows on purpose. */
const vault: StorePlugin<null> = {
  schema: { plugin: "vault", migrations: [] },
  open: () => null,
  forgetPerson: () => declined("money is kept"),
};

const stores: SqliteStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

const OWEN: AccountRef = { platform: "discord", id: "1" };
const OWEN_ALT: AccountRef = { platform: "discord", id: "2" };
const AMY: AccountRef = { platform: "discord", id: "3" };
const ctx: ContextKey = { platform: "discord", scope: "g", channel: "c", kind: "channel" };

async function rig() {
  const store = await SqliteStore.open(":memory:", {
    plugins: [shop as StorePlugin<unknown>, vault as StorePlugin<unknown>],
  });
  stores.push(store);
  const say = async (author: AccountRef, text: string) =>
    store.messages.append({
      id: newId(),
      profile: "p",
      context: ctx,
      author,
      author_name: author.id,
      text,
      is_self: false,
      ts: toTimestamp(Date.UTC(2026, 0, 1)),
      turn: null,
    });
  const owen = await store.people.upsertAccount(OWEN, "Owen");
  const alt = await store.people.upsertAccount(OWEN_ALT, "Owen2");
  const amy = await store.people.upsertAccount(AMY, "Amy");
  return { store, items: store.plugin(shop), say, owen, alt, amy };
}

const texts = async (store: SqliteStore) =>
  (await store.messages.recent("p", ctx, 10)).map((m) => m.text);

describe("forgetting a person", () => {
  it("runs every schema's hook, dependents first, and records the request", async () => {
    const { store, items, say, owen, alt, amy } = await rig();
    await say(OWEN, "我是 Owen");
    await say(OWEN_ALT, "我是另一個 Owen");
    await say(AMY, "我是 Amy");
    items.add(owen);
    items.add(alt);
    items.add(amy);
    // The second account turned out to be Owen's: merged, its rows keep the absorbed id.
    store.personData.merge(owen, alt, { source: "test" });
    items.seen.length = 0;

    const result = store.personData.forget(owen, { reason: "forget me", source: "memory" });
    expect(result.hooks.map((h) => h.plugin)).toEqual([
      "vault",
      "shop",
      "legacy",
      "identity",
      "core",
    ]);
    expect(store.personData.participants()).toEqual(result.hooks.map((h) => h.plugin));
    // Their own item and the one the merge moved to them.
    expect(hookCounts(result, "shop")).toEqual({ items: 2 });
    // Both of their lines, under either id; nobody else's.
    expect(hookCounts(result, "core")).toEqual({ lines: 2 });
    expect(result.hooks.find((h) => h.plugin === "vault")).toEqual({
      plugin: "vault",
      counts: {},
      declined: "money is kept",
    });
    expect(result.hooks.find((h) => h.plugin === "identity")?.declined).toMatch(/unlink/);
    expect(items.seen).toEqual([`forget ${owen},${alt} 1,2`]);
    expect(items.of(owen)).toBe(0);
    expect(items.of(amy)).toBe(1);
    expect(await texts(store)).toEqual(["我是 Amy"]);
    // The person stays; one audit entry says what was done, never what they said.
    expect((await store.people.personByAccount(OWEN))?.id).toBe(owen);
    const recorded = store.events.get(result.event)?.envelope;
    expect(recorded).toMatchObject({
      type: PERSON_FORGET_TYPE,
      person_id: owen,
      scope: "owner",
      tier: "keep",
      source: "memory",
      data: {
        actor: "memory",
        action: "person.forget",
        target: owen,
        ok: true,
        detail: {
          ids: [owen, alt],
          reason: "forget me",
          hooks: { shop: { items: 2 }, core: { lines: 2 }, vault: { declined: "money is kept" } },
        },
      },
    });
    expect((await store.audit.recent(1, null))[0]).toMatchObject({
      actor: "memory",
      action: "person.forget",
      target: owen,
    });
  });

  it("leaves nothing half done when a hook throws", async () => {
    const { store, items, say, owen } = await rig();
    await say(OWEN, "我是 Owen");
    items.add(owen);
    items.fail = true;
    const before = store.events.query().length;
    expect(() => store.personData.forget(owen, { reason: "forget me", source: "memory" })).toThrow(
      /the shop broke/,
    );
    // The shop's delete is rolled back, the lines were never redacted, nothing is recorded.
    expect(items.of(owen)).toBe(1);
    expect(await texts(store)).toEqual(["我是 Owen"]);
    expect(store.events.query()).toHaveLength(before);
  });

  it("refuses a person it does not know, or one merged into another", async () => {
    const { store, owen, alt } = await rig();
    expect(() =>
      store.personData.forget("nobody" as PersonId, { reason: "x", source: "t" }),
    ).toThrow(/unknown person/);
    store.personData.merge(owen, alt, { source: "test" });
    expect(() => store.personData.forget(alt, { reason: "x", source: "t" })).toThrow(
      /unknown person/,
    );
  });
});

describe("merging two people", () => {
  it("runs the plugins' hooks before identity merges, and records the merge", async () => {
    const { store, items, owen, alt } = await rig();
    items.add(alt);
    const result = store.personData.merge(owen, alt, { source: "social" });
    expect(result.hooks.map((h) => h.plugin)).toEqual(["shop", "legacy", "identity", "core"]);
    expect(items.seen).toEqual([`merge ${alt} into ${owen}`]);
    expect(hookCounts(result, "shop")).toEqual({ items: 1 });
    expect(hookCounts(result, "identity")).toEqual({ persons: 1, accounts: 1 });
    expect(items.of(owen)).toBe(1);
    expect((await store.people.personByAccount(OWEN_ALT))?.id).toBe(owen);
    expect(store.events.get(result.event)?.envelope).toMatchObject({
      type: PERSON_MERGE_TYPE,
      person_id: owen,
      data: {
        action: "person.merge",
        target: owen,
        detail: { absorb: alt, hooks: { shop: { items: 1 } } },
      },
    });
  });

  it("leaves both people as they were when a hook throws", async () => {
    const { store, items, owen, alt } = await rig();
    items.add(alt);
    items.fail = true;
    expect(() => store.personData.merge(owen, alt, { source: "social" })).toThrow(/the shop broke/);
    expect(items.of(alt)).toBe(1);
    expect((await store.people.personByAccount(OWEN_ALT))?.id).toBe(alt);
  });
});

describe("the installed plugins' hooks", () => {
  async function installed() {
    const store = await SqliteStore.open(":memory:", {
      plugins: [authTables, directiveTables, economyTables, memoryTables],
    });
    stores.push(store);
    const owen = await store.people.upsertAccount(OWEN, "Owen");
    const at = toTimestamp(Date.UTC(2026, 0, 1));
    await store.plugin(economyTables).ledger.post({
      id: newId(),
      person: owen,
      delta: 10,
      reason: "checkin",
      ref: null,
      idem_key: "checkin:1",
      ts: at,
    });
    await store.plugin(authTables).store.upsertRole({
      name: "vip",
      rank: 50,
      grants: [],
      denies: [],
      builtin: false,
    });
    await store.plugin(authTables).store.assign({
      account: OWEN,
      role: "vip",
      scope: { type: "global" },
      granted_by: "test",
      at,
    });
    await store.plugin(directiveTables).insert("p", {
      id: "d1",
      issuer: OWEN,
      authority: "owner",
      scope: { capability: "game.*", activity: "osu" },
      effect: "deny",
      text: "不要玩 osu",
      expires: "until_revoked",
      source_event: "msg:m1",
      created_at: at,
    });
    await store.plugin(memoryTables).upsert({
      id: newId(),
      profile: "p",
      kind: "fact",
      scope: { type: "global" },
      subjects: [owen],
      content: "Owen 喜歡拉麵",
      tokens: "owen 喜歡 拉麵",
      embedding: null,
      importance: 0.5,
      confidence: 0.8,
      created_at: at,
      updated_at: at,
      last_accessed: null,
      access_count: 0,
      source_context: null,
      source: null,
      due: null,
      done: false,
      superseded_by: null,
    });
    return { store, owen };
  }

  it("forget: memory forgets, money, roles and rules stay and say so", async () => {
    const { store, owen } = await installed();
    const at = toTimestamp(Date.UTC(2026, 0, 1));
    await store.relationships.upsert({
      profile: "p",
      person: owen,
      affinity: 40,
      trust: 30,
      familiarity: 20,
      tags: [],
      notes: "他住在台南",
      call_name: null,
      interactions: 3,
      last_interaction: at,
      updated_at: at,
    });
    const result = store.personData.forget(owen, { reason: "forget me", source: "memory" });
    expect(result.hooks.map((h) => [h.plugin, h.declined === null])).toEqual([
      ["memory", true],
      ["legacy", true],
      ["economy", false],
      ["directive", false],
      ["auth", false],
      ["identity", false],
      ["core", true],
    ]);
    expect(hookCounts(result, "memory")).toEqual({ about: 1, derived: 0, unverified: 0 });
    // The old tables keep her numbers for them and lose her notes on what they said.
    expect(hookCounts(result, "legacy")).toEqual({ notes: 1, reasons: 0 });
    expect(await store.relationships.get("p", owen)).toMatchObject({ affinity: 40, notes: "" });
    expect(await store.plugin(economyTables).ledger.balance("p", owen)).toBe(10);
    expect(await store.plugin(authTables).store.assignmentsFor(OWEN)).toHaveLength(1);
    expect(await store.plugin(directiveTables).all("p", 9)).toHaveLength(1);
  });
});

describe("the installed plugins' merge hooks", () => {
  it("moves the memories, keeps the wallet's rule, and runs through IdentityStore", async () => {
    const store = await SqliteStore.open(":memory:", {
      plugins: [authTables, directiveTables, economyTables, memoryTables],
    });
    stores.push(store);
    const owen = await store.people.upsertAccount(OWEN, "Owen");
    const alt = await store.people.upsertAccount(OWEN_ALT, "Owen2");
    const at = toTimestamp(Date.UTC(2026, 0, 1));
    await store.plugin(economyTables).ledger.post({
      id: newId(),
      person: alt,
      delta: 3,
      reason: "talked",
      ref: null,
      idem_key: null,
      ts: at,
    });
    const memories = store.plugin(memoryTables);
    await memories.upsert({
      id: "m1",
      profile: "p",
      kind: "fact",
      scope: { type: "person", person: alt },
      subjects: [alt],
      content: "Owen2 喜歡拉麵",
      tokens: "owen2 喜歡 拉麵",
      embedding: null,
      importance: 0.5,
      confidence: 0.8,
      created_at: at,
      updated_at: at,
      last_accessed: null,
      access_count: 0,
      source_context: null,
      source: null,
      due: null,
      done: false,
      superseded_by: null,
    });
    // What `/me link` calls: the store's `IdentityStore`.
    // It returns what each hook did, so the caller can say how many memories moved.
    const result = await store.identity.mergePeople(owen, alt);
    expect(result === null ? null : hookCounts(result, "memory")).toEqual({ records: 1 });
    const merged = store.events.query({ types: [PERSON_MERGE_TYPE] });
    expect(merged.map((e) => (e.envelope.data as { detail: unknown }).detail)).toEqual([
      {
        absorb: alt,
        hooks: {
          memory: { records: 1 },
          legacy: { declined: expect.any(String) },
          economy: { declined: expect.stringMatching(/when it is read/) },
          directive: { declined: expect.any(String) },
          auth: { declined: expect.any(String) },
          identity: { persons: 1, accounts: 1 },
          core: { declined: expect.any(String) },
        },
      },
    ]);
    expect((await memories.get("m1"))?.subjects).toEqual([owen]);
    expect((await memories.get("m1"))?.scope).toEqual({ type: "person", person: owen });
    // The wallet finds the absorbed person's coins when it is read.
    expect(await store.plugin(economyTables).ledger.balance("p", owen)).toBe(3);
    expect((await store.people.personByAccount(OWEN_ALT))?.id).toBe(owen);
    // Merging a person into itself is checked and is no merge; an absorbed one is unknown.
    expect(await store.identity.mergePeople(owen, owen)).toBeNull();
    await expect(store.identity.mergePeople(owen, alt)).rejects.toThrow(/unknown person/);
    expect(store.events.query({ types: [PERSON_MERGE_TYPE] })).toHaveLength(1);
  });
});
