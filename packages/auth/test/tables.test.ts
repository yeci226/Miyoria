// The panel sessions on the auth plugin's tables: `@miyoria/api` writes them as
// `panel_session:<hash>` settings, and the store keeps them in `auth_sessions`. The roles,
// assignments, mappings and overrides are pinned in the store's behaviour suite.

import { RESET_CATEGORIES, SqliteStore } from "@miyoria/store";
import { afterEach, describe, expect, it } from "vitest";
import { authTables, SESSION_PREFIX } from "../src/index.js";

const stores: SqliteStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

const SESSION = {
  account: { platform: "discord", id: "1" },
  name: "Owen",
  avatar_url: null,
  tier: "member",
  created_at: "2026-11-15T00:00:00.000Z",
  expires_at: "2026-11-16T00:00:00.000Z",
};

describe("panel sessions", () => {
  it("are rows of auth_sessions, read and listed as the settings the API wrote", async () => {
    const store = await SqliteStore.open(":memory:", { plugins: [authTables] });
    stores.push(store);
    const key = `${SESSION_PREFIX}abc`;
    await store.settings.set("_global", key, SESSION);
    expect(store.plugin(authTables).sessions.get("abc")).toEqual(SESSION);
    expect(await store.settings.get("_global", key)).toEqual(SESSION);
    expect([...(await store.settings.list("_global", SESSION_PREFIX))]).toEqual([[key, SESSION]]);
    // Nothing of the family is in `plugin_state` (the settings part counts its rows there).
    const inventory = await store.profileData.inventory("p");
    const sessions = inventory.categories.find((c) => c.id === "panel_sessions");
    expect(sessions?.parts.map((p) => [p.id, p.count])).toEqual([
      ["panel_sessions", 1],
      ["panel_session_keys", 0],
    ]);

    await expect(store.settings.set("_global", `${SESSION_PREFIX}x`, 1)).rejects.toThrow(
      /not a panel session/,
    );
    await store.settings.set("_global", key, null);
    expect(store.plugin(authTables).sessions.get("abc")).toBeNull();
  });

  it("are kept by a factory reset, which deletes the accounts", async () => {
    const store = await SqliteStore.open(":memory:", { plugins: [authTables] });
    stores.push(store);
    await store.people.upsertAccount(SESSION.account, "Owen");
    await store.settings.set("_global", `${SESSION_PREFIX}abc`, SESSION);
    await store.profileData.wipe("p", RESET_CATEGORIES);
    expect(await store.people.all()).toEqual([]);
    expect(store.plugin(authTables).sessions.get("abc")).toEqual(SESSION);
  });
});
