// What `AuditLog` returns (`recent`), pinned on fresh databases so the implementation behind it
// can change: who did what, newest first, for everyone or one actor. One database belongs to one
// character (v5-data decision D6).

import { type Timestamp, toTimestamp } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { type AuditEntry, RESET_CATEGORIES, SqliteStore, type Store } from "../src/index.js";

const P = "deepseek-chan";
const T0 = Date.UTC(2026, 10, 1, 12);
const SECOND = 1000;

const stores: Store[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

async function open(): Promise<Store> {
  const store = await SqliteStore.open(":memory:");
  stores.push(store);
  return store;
}

const at = (secs: number): Timestamp => toTimestamp(T0 + secs * SECOND);

function entry(id: string, actor: string, action: string, secs: number): AuditEntry {
  return {
    id,
    at: at(secs),
    actor,
    action,
    target: "discord:123",
    detail: { reason: "測試", n: [1, 2], nested: { ok: null } },
    ok: secs % 2 === 0,
  };
}

const OWEN = "discord:100";
const AMY = "discord:200";

describe("the audit log", () => {
  it("reads the newest first, for everyone or one actor, up to a limit", async () => {
    const audit = (await open()).audit;
    const actions = async (limit: number, actor: string | null) =>
      (await audit.recent(limit, actor)).map((e) => e.action);
    expect(await actions(10, null)).toEqual([]);
    // Appended out of order.
    for (const e of [
      entry("a3", OWEN, "module.disable", 3),
      entry("a1", OWEN, "role.assign", 1),
      entry("a4", OWEN, "memory.forget", 4),
      entry("a2", AMY, "economy.adjust", 2),
      entry("a5", "api", "persona.set", 5),
    ]) {
      await audit.append(e);
    }
    expect(await actions(10, null)).toEqual([
      "persona.set",
      "memory.forget",
      "module.disable",
      "economy.adjust",
      "role.assign",
    ]);
    expect(await actions(2, null)).toEqual(["persona.set", "memory.forget"]);
    expect(await actions(10, OWEN)).toEqual(["memory.forget", "module.disable", "role.assign"]);
    expect(await actions(1, OWEN)).toEqual(["memory.forget"]);
    expect(await actions(10, AMY)).toEqual(["economy.adjust"]);
    expect(await actions(10, "api")).toEqual(["persona.set"]);
    expect(await actions(10, "discord:404")).toEqual([]);
    expect(await actions(0, null)).toEqual([]);
    expect(await actions(0, OWEN)).toEqual([]);
    expect(await actions(Number.POSITIVE_INFINITY, null)).toHaveLength(5);
  });

  it("orders entries of the same time by id, the larger first", async () => {
    const audit = (await open()).audit;
    for (const id of ["01B", "01A", "01C"]) await audit.append(entry(id, OWEN, `x.${id}`, 1));
    expect((await audit.recent(10, null)).map((e) => e.id)).toEqual(["01C", "01B", "01A"]);
    expect((await audit.recent(2, OWEN)).map((e) => e.id)).toEqual(["01C", "01B"]);
  });

  it("gives back each entry as it was appended", async () => {
    const audit = (await open()).audit;
    const done = entry("a1", OWEN, "role.assign", 2);
    const refused = { ...entry("a2", OWEN, "directive.add", 3), ok: false, detail: null };
    // A command's action is its path, words and all.
    const command: AuditEntry = {
      id: "a3",
      at: at(4),
      actor: AMY,
      action: "admin memory wipe",
      target: '{"platform":"discord","scope":"g1","channel":"c1","kind":"channel"}',
      detail: { args: {}, outcome: "denied" },
      ok: false,
    };
    for (const e of [done, refused, command]) await audit.append(e);
    expect(await audit.recent(10, null)).toEqual([command, refused, done]);
    expect(await audit.recent(10, AMY)).toEqual([command]);
  });

  it("keeps microseconds and normalizes to UTC", async () => {
    const audit = (await open()).audit;
    await audit.append({ ...entry("p1", OWEN, "a", 0), at: "2026-03-10T12:00:00.123456789Z" });
    await audit.append({ ...entry("p2", OWEN, "b", 0), at: "2026-03-10T20:00:01.5+08:00" });
    expect((await audit.recent(10, OWEN)).map((e) => e.at)).toEqual([
      "2026-03-10T12:00:01.500Z",
      "2026-03-10T12:00:00.123456Z",
    ]);
  });

  it("refuses an id it already has", async () => {
    const audit = (await open()).audit;
    const e = entry("once", OWEN, "role.assign", 1);
    await audit.append(e);
    await expect(audit.append(e)).rejects.toThrow(/already exists/);
    expect(await audit.recent(10, null)).toEqual([e]);
  });

  it("is counted and exported under `audit`, and never wiped", async () => {
    const store = await open();
    const e = entry("a1", OWEN, "role.assign", 2);
    await store.audit.append(e);
    const inventory = await store.profileData.inventory(P);
    const audit = inventory.categories.find((c) => c.id === "audit");
    expect(audit?.count).toBe(1);
    // Configuration changes are kept beside the audit entries (none here).
    expect(audit?.parts.map((p) => [p.id, p.count])).toEqual([
      ["audit_log", 1],
      ["config_changes", 0],
    ]);
    expect(audit?.updated_at).toBe(at(2));
    const backup = await store.profileData.export(P, ["audit"]);
    expect(backup.parts.audit_log).toEqual([
      {
        id: "a1",
        at: at(2),
        actor: OWEN,
        action: "role.assign",
        target: "discord:123",
        detail: { reason: "測試", n: [1, 2], nested: { ok: null } },
        ok: true,
      },
    ]);
    await expect(store.profileData.wipe(P, ["audit"])).rejects.toThrow(/kept/);
    // A factory reset leaves it too.
    await store.profileData.wipe(P, RESET_CATEGORIES);
    expect(await store.audit.recent(10, null)).toEqual([e]);
  });
});
