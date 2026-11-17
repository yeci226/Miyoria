// What `SettingsStore` returns, method by method, pinned as literal values: every case opens a
// fresh in-memory database. The cases under "profiles" pin what separated one profile's keys from
// another's; everything else holds for the global profile and a named one alike.

import type { JsonValue, ProfileId } from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GLOBAL_SETTINGS_PROFILE,
  openStore,
  type SettingsStore,
  type Store,
} from "../src/index.js";

const NAMED: ProfileId = "deepseek-chan";

let store: Store;
let settings: SettingsStore;
beforeEach(async () => {
  store = await openStore("memory://");
  settings = store.settings;
});
afterEach(async () => {
  await store.close();
});

const keysOf = async (profile: ProfileId, prefix: string) => [
  ...(await settings.list(profile, prefix)).keys(),
];

describe.each([
  ["the global profile", GLOBAL_SETTINGS_PROFILE],
  ["a named profile", NAMED],
])("settings of %s", (_name, profile) => {
  it("get: a key never set is null", async () => {
    expect(await settings.get(profile, "nothing:here")).toBeNull();
    expect(await settings.get(profile, "")).toBeNull();
  });

  it("set then get: every JSON shape comes back equal", async () => {
    const values: [string, JsonValue][] = [
      ["s:text", "quiet"],
      ["s:empty", ""],
      ["s:unicode", "她說:你好 🌙"],
      ["n:zero", 0],
      ["n:int", 42],
      ["n:negative", -7],
      ["n:float", 0.1],
      ["n:max", 9007199254740991],
      ["n:big", 1e21],
      ["b:true", true],
      ["b:false", false],
      ["o:empty", {}],
      ["o:nested", { mode: "chatty", n: 2, deep: { list: [1, "x", { y: null }] } }],
      ["o:null-inside", { a: null }],
      ["a:empty", []],
      ["a:null", [null]],
      ["a:mixed", [1, "two", false, null, { three: 3 }]],
    ];
    for (const [key, value] of values) await settings.set(profile, key, value);
    for (const [key, value] of values) expect(await settings.get(profile, key), key).toEqual(value);
    // Object keys keep their order.
    await settings.set(profile, "o:order", { b: 1, a: 2, c: 3 });
    expect(Object.keys((await settings.get(profile, "o:order")) as object)).toEqual([
      "b",
      "a",
      "c",
    ]);
  });

  it("set: a second write replaces the first", async () => {
    await settings.set(profile, "mode:general", "quiet");
    await settings.set(profile, "mode:general", { mode: "chatty", n: 2 });
    expect(await settings.get(profile, "mode:general")).toEqual({ mode: "chatty", n: 2 });
    await settings.set(profile, "mode:general", 3);
    expect(await settings.get(profile, "mode:general")).toBe(3);
  });

  it("set null deletes the key, also a missing one; a JSON null inside a value stays", async () => {
    await settings.set(profile, "k:a", { a: null });
    await settings.set(profile, "k:b", [null]);
    await settings.set(profile, "k:a", null);
    await settings.set(profile, "k:missing", null);
    expect(await settings.get(profile, "k:a")).toBeNull();
    expect(await settings.get(profile, "k:missing")).toBeNull();
    expect(await settings.get(profile, "k:b")).toEqual([null]);
    expect(await keysOf(profile, "k:")).toEqual(["k:b"]);
  });

  it("odd keys: quotes, spaces, the empty key", async () => {
    for (const key of ["a'b", 'q"uote', "with space", "", "%", "_"]) {
      await settings.set(profile, key, key.length);
    }
    expect(await settings.get(profile, "a'b")).toBe(3);
    expect(await settings.get(profile, 'q"uote')).toBe(6);
    expect(await settings.get(profile, "with space")).toBe(10);
    expect(await settings.get(profile, "")).toBe(0);
    expect(await keysOf(profile, "")).toEqual(["", "%", "_", "a'b", 'q"uote', "with space"]);
  });

  it("a returned value is a copy", async () => {
    await settings.set(profile, "copy", { list: [1] });
    const got = (await settings.get(profile, "copy")) as { list: number[] };
    got.list.push(2);
    expect(await settings.get(profile, "copy")).toEqual({ list: [1] });
    const listed = (await settings.list(profile, "copy")).get("copy") as { list: number[] };
    listed.list.push(3);
    expect(await settings.get(profile, "copy")).toEqual({ list: [1] });
  });

  it("a large value round-trips whole", async () => {
    const text = "雪".repeat(300_000);
    const big: Record<string, number> = {};
    for (let i = 0; i < 5000; i++) big[`k${i}`] = i;
    await settings.set(profile, "big:text", text);
    await settings.set(profile, "big:object", big);
    expect(await settings.get(profile, "big:text")).toBe(text);
    expect(await settings.get(profile, "big:object")).toEqual(big);
    const listed = await settings.list(profile, "big:");
    expect([...listed.keys()]).toEqual(["big:object", "big:text"]);
    expect((listed.get("big:text") as string).length).toBe(300_000);
  });

  it("list: keys starting with the prefix in byte order; `%` and `_` literal; case matters", async () => {
    const keys = ["中", "a:2", "B", "a_b", "a:10", "é", "a", "a:1", "mo%de", "A:1"];
    for (const [i, key] of keys.entries()) await settings.set(profile, key, i);
    expect(await keysOf(profile, "")).toEqual([
      "A:1",
      "B",
      "a",
      "a:1",
      "a:10",
      "a:2",
      "a_b",
      "mo%de",
      "é",
      "中",
    ]);
    expect(await keysOf(profile, "a")).toEqual(["a", "a:1", "a:10", "a:2", "a_b"]);
    expect(await keysOf(profile, "a:")).toEqual(["a:1", "a:10", "a:2"]);
    expect(await keysOf(profile, "a:1")).toEqual(["a:1", "a:10"]);
    expect(await keysOf(profile, "a_")).toEqual(["a_b"]);
    expect(await keysOf(profile, "a%")).toEqual([]);
    expect(await keysOf(profile, "mo%")).toEqual(["mo%de"]);
    expect(await keysOf(profile, "A")).toEqual(["A:1"]);
    expect(await keysOf(profile, "中")).toEqual(["中"]);
    expect(await keysOf(profile, "nothing")).toEqual([]);
    const listed = await settings.list(profile, "a:");
    expect([...listed.entries()]).toEqual([
      ["a:1", 7],
      ["a:10", 4],
      ["a:2", 1],
    ]);
  });

  it("deletePrefix: deletes the keys starting with the prefix and says how many", async () => {
    for (const key of ["a%:1", "a%:2", "ab:3", "a_:4", "b:5"]) await settings.set(profile, key, 1);
    expect(await settings.deletePrefix(profile, "a%:")).toBe(2);
    expect(await keysOf(profile, "")).toEqual(["a_:4", "ab:3", "b:5"]);
    expect(await settings.deletePrefix(profile, "a%:")).toBe(0);
    expect(await settings.deletePrefix(profile, "nothing")).toBe(0);
    expect(await settings.deletePrefix(profile, "")).toBe(3);
    expect(await keysOf(profile, "")).toEqual([]);
  });
});

describe("settings: a person's choices under the global profile", () => {
  it("privacy and voice consent round-trip, false included", async () => {
    await settings.set(GLOBAL_SETTINGS_PROFILE, "privacy:discord:1", { presence: false });
    await settings.set(GLOBAL_SETTINGS_PROFILE, "voice_consent:discord:1", false);
    expect(await settings.get(GLOBAL_SETTINGS_PROFILE, "privacy:discord:1")).toEqual({
      presence: false,
    });
    expect(await settings.get(GLOBAL_SETTINGS_PROFILE, "voice_consent:discord:1")).toBe(false);
    expect([...(await settings.list(GLOBAL_SETTINGS_PROFILE, "")).entries()]).toEqual([
      ["privacy:discord:1", { presence: false }],
      ["voice_consent:discord:1", false],
    ]);
    expect(await settings.deletePrefix(GLOBAL_SETTINGS_PROFILE, "voice_consent:")).toBe(1);
    expect(await settings.get(GLOBAL_SETTINGS_PROFILE, "voice_consent:discord:1")).toBeNull();
  });
});

// What only existed to keep one profile's settings apart from another's. One database belongs to
// one character (decision D6, v5-data §8 step 8), so the profile a caller names is not part of the
// key any more: each case below pinned the separation, and now pins that it is gone.
describe("settings: profiles", () => {
  it("a key set under one profile is seen under every other", async () => {
    await settings.set(NAMED, "queue:state", { items: [1] });
    expect(await settings.get(GLOBAL_SETTINGS_PROFILE, "queue:state")).toEqual({ items: [1] });
    expect(await settings.get("someone-else", "queue:state")).toEqual({ items: [1] });
    expect(await keysOf(GLOBAL_SETTINGS_PROFILE, "")).toEqual(["queue:state"]);
  });

  it("the same key holds one value: the last write wins", async () => {
    await settings.set(NAMED, "mode:general", "named");
    await settings.set(GLOBAL_SETTINGS_PROFILE, "mode:general", "global");
    expect(await settings.get(NAMED, "mode:general")).toBe("global");
    expect(await settings.get(GLOBAL_SETTINGS_PROFILE, "mode:general")).toBe("global");
    await settings.set(NAMED, "mode:general", null);
    expect(await settings.get(GLOBAL_SETTINGS_PROFILE, "mode:general")).toBeNull();
  });

  it("deletePrefix deletes the keys whatever profile wrote them", async () => {
    await settings.set(NAMED, "x:1", 1);
    await settings.set(GLOBAL_SETTINGS_PROFILE, "x:2", 2);
    expect(await settings.deletePrefix(NAMED, "x:")).toBe(2);
    expect(await keysOf(GLOBAL_SETTINGS_PROFILE, "x:")).toEqual([]);
  });

  it("a person's choice is the person's under any profile", async () => {
    await settings.set(NAMED, "privacy:discord:1", 1);
    expect(await settings.get(NAMED, "privacy:discord:1")).toBe(1);
    expect(await settings.get(GLOBAL_SETTINGS_PROFILE, "privacy:discord:1")).toBe(1);
  });
});
