// The owner's rules on SQLite: what `active` returns, how a rule ends, and that they are a data
// category like everything else she keeps.

import { type Directive, toTimestamp } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCategories, SqliteStore } from "../src/index.js";

const P = "miyoria";
const T0 = Date.UTC(2026, 10, 7, 12);
const MINUTE = 60_000;

const stores: SqliteStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

async function open(): Promise<SqliteStore> {
  const store = await SqliteStore.open(":memory:");
  stores.push(store);
  return store;
}

function rule(id: string, fields: Partial<Directive> = {}): Directive {
  return {
    id,
    issuer: { platform: "discord", id: "1" },
    authority: "owner",
    scope: { capability: "game.*", activity: "minecraft" },
    effect: "deny",
    text: "不要玩 Minecraft",
    expires: "until_revoked",
    source_event: "msg:m1",
    created_at: toTimestamp(T0),
    ...fields,
  };
}

describe("directives", () => {
  it("round-trip a rule and answer only what is in force", async () => {
    const { directives } = await open();
    const forever = rule("a");
    const soon = rule("b", { expires: toTimestamp(T0 + 5 * MINUTE) });
    await directives.insert(P, forever);
    await directives.insert(P, soon);
    await directives.insert("other", rule("c"));
    expect(await directives.active(P, toTimestamp(T0))).toMatchObject([forever, soon]);
    expect(await directives.active(P, toTimestamp(T0 + 5 * MINUTE))).toMatchObject([forever]);
    // `until_revoked` is not a far-away date.
    expect(await directives.active(P, toTimestamp(T0 + 1e13))).toMatchObject([forever]);
  });

  it("end a rule once, and keep it for the history", async () => {
    const { directives } = await open();
    await directives.insert(P, rule("a"));
    const at = toTimestamp(T0 + MINUTE);
    expect(await directives.revoke("other", "a", "discord:1", at)).toBe(false);
    expect(await directives.revoke(P, "a", "discord:1", at)).toBe(true);
    expect(await directives.revoke(P, "a", "discord:1", at)).toBe(false);
    expect(await directives.active(P, toTimestamp(T0))).toEqual([]);
    expect(await directives.all(P, 10)).toMatchObject([
      { id: "a", revoked_at: at, revoked_by: "discord:1" },
    ]);
  });

  it("prune what ended long ago and never a rule still in force", async () => {
    const { directives } = await open();
    await directives.insert(P, rule("kept"));
    await directives.insert(P, rule("expired", { expires: toTimestamp(T0) }));
    await directives.insert(P, rule("revoked"));
    await directives.revoke(P, "revoked", "discord:1", toTimestamp(T0));
    await directives.insert(P, rule("recent", { expires: toTimestamp(T0 + 3 * MINUTE) }));
    expect(await directives.prune(P, toTimestamp(T0 + MINUTE))).toBe(2);
    expect((await directives.all(P, 10)).map((r) => r.id).sort()).toEqual(["kept", "recent"]);
  });

  it("refuses an authority or an effect that does not exist", async () => {
    const { directives } = await open();
    await expect(
      directives.insert(P, rule("a", { authority: "god" as Directive["authority"] })),
    ).rejects.toThrow(/cannot store/);
    await expect(
      directives.insert(P, rule("b", { effect: "allow" as Directive["effect"] })),
    ).rejects.toThrow(/cannot store/);
  });

  it("are a data category: counted, exported, wiped", async () => {
    const store = await open();
    await store.directives.insert(P, rule("a"));
    const inventory = await store.profileData.inventory(P);
    expect(inventory.categories.find((c) => c.id === "directives")?.count).toBe(1);
    const backup = await store.profileData.export(P, ["directives"]);
    expect(JSON.stringify(backup)).toContain("不要玩 Minecraft");
    await store.profileData.wipe(P, ["directives"]);
    expect(await store.directives.all(P, 10)).toEqual([]);
    expect(resolveCategories(["directives"])).toEqual(["directives"]);
  });
});
