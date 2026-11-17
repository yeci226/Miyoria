// A plugin outside the store attached to it (`plugin.ts`): its tables migrate at open or on first
// use, its code is built once, and a settings key family it keeps is routed to it.

import type { JsonValue } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { appliedMigrations, type Db, SqliteStore, type StorePlugin } from "../src/index.js";

class Shop {
  readonly values = new Map<string, JsonValue>();
  constructor(readonly db: Db) {}
  count(): number {
    return Number(this.db.get("SELECT COUNT(*) AS n FROM shop_items")?.n);
  }
}

const shop: StorePlugin<Shop> = {
  schema: {
    plugin: "shop",
    migrations: [
      { version: 1, name: "init", sql: "CREATE TABLE shop_items (id TEXT PRIMARY KEY) STRICT;" },
    ],
  },
  open: ({ db }) => new Shop(db),
  settings: (opened) => [
    {
      prefix: "shop:",
      get: (key) => opened.values.get(key) ?? null,
      set: (key, value) => {
        if (value === null) opened.values.delete(key);
        else opened.values.set(key, value);
      },
      entries: () => new Map(opened.values),
    },
  ],
};

const stores: SqliteStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

async function open(plugins: StorePlugin<unknown>[] = []): Promise<SqliteStore> {
  const store = await SqliteStore.open(":memory:", { plugins });
  stores.push(store);
  return store;
}

describe("store plugins", () => {
  it("migrate at open, and are built once", async () => {
    const store = await open([shop as StorePlugin<unknown>]);
    const one = store.plugin(shop);
    expect(one.count()).toBe(0);
    expect(store.plugin(shop)).toBe(one);
  });

  it("migrate on first use when the store was opened without them", async () => {
    const store = await open();
    const db = store.plugin(shop).db;
    expect(appliedMigrations(db).filter((m) => m.plugin === "shop")).toHaveLength(1);
    // Another object with the same schema id is refused.
    expect(() => store.plugin({ ...shop })).toThrow(/another plugin/);
  });

  it("keep their settings key family, the rest stays in plugin_state", async () => {
    const store = await open();
    const owned = store.plugin(shop);
    await store.settings.set("_global", "shop:a", 1);
    await store.settings.set("p", "other:b", 2);
    expect(owned.values.get("shop:a")).toBe(1);
    expect(await store.settings.get("p", "shop:a")).toBe(1);
    expect([...(await store.settings.list("p", "")).keys()]).toEqual(["other:b", "shop:a"]);
    expect(await store.settings.deletePrefix("p", "sh")).toBe(1);
    expect(owned.values.size).toBe(0);
    expect(await store.settings.get("p", "other:b")).toBe(2);
  });
});
