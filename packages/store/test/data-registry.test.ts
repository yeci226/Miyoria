// The data categories as the installed schemas declare them (`data.ts`, `categories.ts`): a
// plugin's parts are there only on a store it is attached to; the event log's keep-tier events go
// only with the category they record.

import { newId, toTimestamp } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { authTables } from "../../auth/src/tables.js";
import { directiveTables } from "../../brain/directive/src/tables.js";
import { economyTables } from "../../economy/src/tables.js";
import { memoryTables } from "../../memory/memory/src/tables.js";
import {
  CATEGORY_SPECS,
  DATA_CATEGORIES,
  DataRegistry,
  RESET_CATEGORIES,
  SqliteStore,
  STORE_DATA,
  type StorePlugin,
  storeRegistry,
  tablePart,
} from "../src/index.js";

const PLUGINS: StorePlugin<unknown>[] = [authTables, directiveTables, economyTables, memoryTables];

const stores: SqliteStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

async function open(plugins: StorePlugin<unknown>[] = []): Promise<SqliteStore> {
  const store = await SqliteStore.open(":memory:", { plugins });
  stores.push(store);
  return store;
}

const partsOf = (inv: { categories: { id: string; parts: { id: string }[] }[] }, id: string) =>
  inv.categories.find((c) => c.id === id)?.parts.map((p) => p.id);

describe("the data registry", () => {
  it("gives every category its parts, as the store and its plugins declare them", async () => {
    const store = await open(PLUGINS);
    const registry = store.profileData.registry;
    expect(registry.categories.map((c) => c.id)).toEqual(CATEGORY_SPECS.map((c) => c.id));
    // The parts of a store with every plugin, category by category, in their order.
    expect(
      Object.fromEntries(registry.categories.map((c) => [c.id, c.parts.map((p) => p.id)])),
    ).toEqual({
      memories: ["memory_records", "memory_maintenance"],
      relationships: [
        "relationships",
        "relationship_deltas",
        "member_cards",
        "coin_ledger",
        "coin_wallets",
        "fortunes",
        "bounties",
        "economy_docs",
      ],
      call_names: ["call_names"],
      inner: [
        "self_state",
        "self_feelings",
        "self_cards_migration",
        "mind_thoughts",
        "mind_digests",
        "mind_goals",
      ],
      knowledge: ["knowledge_docs"],
      learning: ["lessons", "reflections", "feedback"],
      conversation: ["conversation_states"],
      mood: ["mood"],
      messages: ["message_log", "memory_watermarks"],
      decisions: ["decision_log", "turn_outcomes"],
      directives: ["directives"],
      event_log: ["events", "event_rollups"],
      initiative: ["initiative"],
      artifacts: ["artifact_shares", "artifacts", "artifact_blobs"],
      people: [
        "link_codes",
        "space_members",
        "sessions",
        "rooms",
        "spaces",
        "accounts",
        "people",
        "handles",
      ],
      channels: ["channel_modes", "channel_activeness"],
      voice_consent: ["voice_consent", "voice_consent_keys"],
      privacy: ["privacy", "privacy_keys"],
      queue: ["queue"],
      roles: ["roles", "role_assignments", "role_mappings", "node_overrides"],
      persona: ["persona_overrides"],
      proposed_tools: ["proposed_tools"],
      extensions: ["extension_storage"],
      module_state: ["module_state"],
      other_settings: ["other_settings"],
      audit: ["audit_log", "config_changes"],
      llm_usage: ["llm_calls"],
      panel_sessions: ["panel_sessions", "panel_session_keys"],
    });
    // Without plugins, the store's own parts only: what `DATA_CATEGORIES` lists.
    expect(storeRegistry().categories).toEqual(DATA_CATEGORIES);
  });

  it("shows none of a plugin's parts on a store opened without it", async () => {
    const store = await open();
    const inv = await store.profileData.inventory("p");
    // Every category is listed (the panel names them all); a plugin's have nothing in them.
    expect(inv.categories.map((c) => c.id)).toEqual(CATEGORY_SPECS.map((c) => c.id));
    expect(inv.categories.find((c) => c.id === "directives")).toMatchObject({
      count: 0,
      parts: [],
      breakdown: null,
    });
    expect(partsOf(inv, "roles")).toEqual([]);
    expect(partsOf(inv, "memories")).toEqual(["memory_maintenance"]);
    expect(inv.categories.find((c) => c.id === "memories")?.breakdown).toBeNull();
    expect(partsOf(inv, "relationships")).toEqual([
      "relationships",
      "relationship_deltas",
      "member_cards",
    ]);
    expect(partsOf(inv, "panel_sessions")).toEqual(["panel_session_keys"]);
    // Nothing to export, nothing to delete, and no built-in roles written into a missing table.
    const backup = await store.profileData.export("p", ["directives", "roles", "memories"]);
    expect(Object.keys(backup.parts)).toEqual(["memory_maintenance"]);
    const seedRoles = [{ name: "owner", rank: 100, grants: ["*"], denies: [], builtin: true }];
    expect(await store.profileData.wipe("p", ["directives", "roles"], { seedRoles })).toEqual({});

    // Attached later, the plugin's parts count from then on.
    await store.plugin(directiveTables).insert("p", {
      id: "d1",
      issuer: { platform: "discord", id: "1" },
      authority: "owner",
      scope: { capability: "game.*", activity: "osu" },
      effect: "deny",
      text: "不要玩 osu",
      expires: "until_revoked",
      source_event: "msg:m1",
      created_at: toTimestamp(Date.UTC(2026, 0, 1)),
    });
    const after = await store.profileData.inventory("p");
    expect(after.categories.find((c) => c.id === "directives")).toMatchObject({
      count: 1,
      parts: [{ id: "directives", count: 1 }],
    });
    expect(await store.profileData.wipe("p", ["directives"])).toEqual({ directives: 1 });
  });

  it("refuses a part declared twice and a category it does not know", () => {
    const twice = tablePart("memory_records", "x", "node", null, "id", { id: "text" });
    expect(() => storeRegistry([{ category: "memories", parts: [twice, twice] }])).toThrow(
      /declared twice/,
    );
    expect(
      () => new DataRegistry([...STORE_DATA, { category: "nope" as never, parts: [] }]),
    ).toThrow(/unknown data category/);
  });
});

describe("the event log's wipe", () => {
  const TYPES = [
    "facts.thought", // short: always goes with the log
    "privacy.redacted", // keep: goes with the chat lines it was about
    "economy.posted", // keep: goes with the ledger
    "identity.imported", // keep: goes with the people
    "artifact.created", // keep: goes with the artifacts
    "facts.directive", // keep: goes with the rules
  ];

  async function seeded() {
    const store = await open(PLUGINS);
    for (const type of TYPES) {
      store.events.appendNow({
        draft: { id: newId(), at: toTimestamp(Date.UTC(2026, 0, 1)), type, data: {} },
        source: "test",
      });
    }
    return store;
  }

  const left = (store: SqliteStore) => store.events.query().map((e) => e.envelope.type);

  it("keeps the keep-tier events of categories it does not delete", async () => {
    const store = await seeded();
    const inv = await store.profileData.inventory("p");
    expect(inv.categories.find((c) => c.id === "event_log")?.count).toBe(TYPES.length);
    // Deleting the chat history takes the log with it, not the record of a coin posting.
    const counts = await store.profileData.wipe("p", ["messages"]);
    expect(counts.events).toBe(2);
    expect(left(store).sort()).toEqual([
      "artifact.created",
      "economy.posted",
      "facts.directive",
      "identity.imported",
    ]);
    // Asked for explicitly, a category takes its own records with the log.
    await store.profileData.wipe("p", ["event_log", "directives"]);
    expect(left(store).sort()).toEqual(["artifact.created", "economy.posted", "identity.imported"]);
  });

  it("deletes every one in a factory reset", async () => {
    const store = await seeded();
    const counts = await store.profileData.wipe("p", RESET_CATEGORIES);
    expect(counts.events).toBe(TYPES.length);
    expect(left(store)).toEqual([]);
  });
});
