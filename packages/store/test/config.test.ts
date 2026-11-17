// The `config` plugin (docs/design/v5-data.md §6): its tables' constraints, plugin state, and the
// settings keys kept as plugin state rows.

import { openTestDb, type TestDb } from "@miyoria/store/testing";
import { afterEach, describe, expect, it } from "vitest";
import { migrated } from "../scripts/schema-sql.js";
import {
  configSchema,
  openStore,
  PLUGIN_STATE_MAX_BYTES,
  PluginState,
  SETTINGS_PLUGIN,
  SettingsState,
} from "../src/index.js";

const open: TestDb[] = [];
afterEach(() => {
  for (const t of open.splice(0)) t.close();
});

function testDb(): TestDb {
  const t = openTestDb({ config: true, clock: { now: () => Date.UTC(2026, 10, 15) } });
  open.push(t);
  return t;
}

describe("config schema", () => {
  it("holds its constraints: types, the scope check, the keys", () => {
    const { raw, db } = migrated(configSchema);
    try {
      const place = (scope: string, key: string) =>
        raw
          .prepare(
            "INSERT INTO place_settings VALUES (?, 's1', 'agent', ?, '\"quiet\"', 1, 'test')",
          )
          .run(scope, key);
      place("space", "mode");
      place("room", "mode");
      expect(() => place("guild", "mode")).toThrow(/CHECK/);
      expect(() => place("space", "mode")).toThrow(/UNIQUE|PRIMARY KEY/);
      raw
        .prepare(
          "INSERT INTO plugin_state (plugin, key, value, updated_at) VALUES ('q', 'k', '1', 1)",
        )
        .run();
      expect(() =>
        raw
          .prepare(
            "INSERT INTO plugin_state (plugin, key, value, updated_at) VALUES ('q', 'k', '2', 1)",
          )
          .run(),
      ).toThrow(/UNIQUE|PRIMARY KEY/);
      expect(raw.prepare("SELECT v FROM plugin_state").get()).toEqual({ v: 1 });
      // STRICT: an integer column takes no text.
      expect(() =>
        raw
          .prepare(
            "INSERT INTO config_revisions (version, doc, created_at, created_by) VALUES (1, '{}', 'now', 'x')",
          )
          .run(),
      ).toThrow(/cannot store TEXT value in INTEGER column/);
      expect(() =>
        raw
          .prepare(
            "INSERT INTO config_revisions (version, doc, created_at, created_by) VALUES (1, '{}', 1, NULL)",
          )
          .run(),
      ).toThrow(/NOT NULL/);
    } finally {
      db.close();
    }
  });
});

describe("plugin state", () => {
  it("stores one value per plugin and key, with the version of its shape", () => {
    const t = testDb();
    const state = new PluginState(t.db);
    expect(state.get("queue", "state")).toBeNull();
    state.set("queue", "state", { items: [1, 2] });
    state.set("sing", "state", "other plugin");
    expect(state.get("queue", "state")).toEqual({
      value: { items: [1, 2] },
      v: 1,
      updated_at: "2026-11-15T00:00:00.000Z",
    });
    state.set("queue", "state", { list: [] }, 2);
    expect(state.get("queue", "state")?.v).toBe(2);
    expect(state.get("queue", "state")?.value).toEqual({ list: [] });
    expect(state.get("sing", "state")?.value).toBe("other plugin");
    expect(state.delete("queue", "state")).toBe(true);
    expect(state.delete("queue", "state")).toBe(false);
    expect(state.get("queue", "state")).toBeNull();
    expect(() => state.set("queue", "state", 1, 0)).toThrow(/version 0/);
  });

  it("refuses a value larger than the limit: a value that grows needs a table", () => {
    const t = testDb();
    const state = new PluginState(t.db);
    // JSON text in UTF-8: the quotes count, and 雪 is three bytes.
    state.set("p", "fits", "x".repeat(PLUGIN_STATE_MAX_BYTES - 2));
    expect(() => state.set("p", "big", "x".repeat(PLUGIN_STATE_MAX_BYTES - 1))).toThrow(
      /65537 bytes; the limit is 65536/,
    );
    expect(() => state.set("p", "big", "雪".repeat(22_000))).toThrow(/66002 bytes/);
    expect(state.get("p", "big")).toBeNull();
  });
});

describe("settings as plugin state", () => {
  it("keeps every settings key as a row of plugin `settings`, under its own name", async () => {
    const t = testDb();
    const settings = new SettingsState(t.db);
    await settings.set("deepseek-chan", "mind:thought:1", { text: "嗯" });
    await settings.set("_global", "queue:state", { items: [] });
    expect(t.db.all("SELECT plugin, key, value, v FROM plugin_state ORDER BY key")).toEqual([
      { plugin: SETTINGS_PLUGIN, key: "mind:thought:1", value: '{"text":"嗯"}', v: 1 },
      { plugin: SETTINGS_PLUGIN, key: "queue:state", value: '{"items":[]}', v: 1 },
    ]);
    // A plugin's own state under the same key is another row.
    new PluginState(t.db).set("queue", "queue:state", 1);
    expect(await settings.list("_global", "queue:")).toEqual(
      new Map([["queue:state", { items: [] }]]),
    );
    expect(await settings.deletePrefix("x", "")).toBe(2);
    expect(new PluginState(t.db).get("queue", "queue:state")?.value).toBe(1);
  });

  it("the store's settings are the same rows, whatever profile is named", async () => {
    const store = await openStore("memory://");
    try {
      await store.settings.set("deepseek-chan", "mode:general", "quiet");
      expect(await store.settings.get("_global", "mode:general")).toBe("quiet");
      expect(await store.settings.get("someone-else", "mode:general")).toBe("quiet");
    } finally {
      await store.close();
    }
  });
});
