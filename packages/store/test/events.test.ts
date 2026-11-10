// The EventLog's rows on SQLite: append-only, queries, and compaction that only ever removes
// leaves, so whatever survives keeps its whole `cause` chain.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type LogEvent, newId, toTimestamp } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { type EventLogStore, resolveCategories, SqliteStore } from "../src/index.js";

const P = "miyoria";
const T0 = Date.UTC(2026, 10, 1, 12);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const VOICE = { platform: "discord", scope: "g", channel: "v", kind: "voice" } as const;
const TEXT = { platform: "discord", scope: "g", channel: "c", kind: "channel" } as const;

const stores: SqliteStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

async function open(): Promise<{ store: SqliteStore; events: EventLogStore }> {
  const store = await SqliteStore.open(":memory:");
  stores.push(store);
  return { store, events: store.events };
}

function ambient(at: number, cause: string | null = null): LogEvent {
  return {
    id: newId(),
    at: toTimestamp(at),
    kind: "observation",
    source: "voice.asr",
    cause,
    context: VOICE,
    person: "Owen",
    body: {
      observation: { attention_key: "voice:utterance:1", salience: "ambient" },
    },
  };
}

function line(kind: LogEvent["kind"], at: number, cause: string | null): LogEvent {
  return {
    id: newId(),
    at: toTimestamp(at),
    kind,
    source: "agent",
    cause,
    context: null,
    person: null,
    body: { attention_key: "game:craft:stone_pickaxe" },
  };
}

describe("append and read", () => {
  it("round-trips an event and leaves an existing id alone", async () => {
    const { events } = await open();
    const e = ambient(T0);
    await events.append(P, [e]);
    await events.append(P, [{ ...e, source: "other" }]);
    expect(await events.get(P, e.id)).toEqual(e);
    expect(await events.get("someone-else", e.id)).toBeNull();
  });

  it("refuses to change a row, even behind the interface's back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "miyoria-events-"));
    const path = join(dir, "events.db");
    try {
      const store = await SqliteStore.open(path);
      await store.events.append(P, [ambient(T0)]);
      await store.close();
      const db = new DatabaseSync(path);
      expect(() => db.exec("UPDATE log_events SET source = 'x'")).toThrow(/append-only/);
      expect(db.prepare("SELECT source FROM log_events").get()).toEqual({ source: "voice.asr" });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes a batch all or nothing", async () => {
    const { events } = await open();
    const bad = { ...ambient(T0), at: "not a time" };
    await expect(events.append(P, [ambient(T0), bad])).rejects.toThrow();
    expect(await events.query(P, {})).toEqual([]);
  });

  it("filters and pages", async () => {
    const { events } = await open();
    const a = ambient(T0);
    const b = { ...line("decision", T0 + 1000, a.id), context: TEXT, person: "Amy" };
    const c = line("delivered", T0 + 2000, b.id);
    await events.append(P, [a, b, c]);
    const ids = (list: LogEvent[]) => list.map((e) => e.id);
    expect(ids(await events.query(P, {}))).toEqual([c.id, b.id, a.id]);
    expect(ids(await events.query(P, { order: "asc", limit: 2 }))).toEqual([a.id, b.id]);
    expect(ids(await events.query(P, { kinds: ["decision", "delivered"] }))).toEqual([c.id, b.id]);
    expect(ids(await events.query(P, { sources: ["voice.asr"] }))).toEqual([a.id]);
    expect(ids(await events.query(P, { context: TEXT }))).toEqual([b.id]);
    expect(ids(await events.query(P, { person: "Owen" }))).toEqual([a.id]);
    expect(ids(await events.query(P, { attention_key: "voice:utterance:1" }))).toEqual([a.id]);
    expect(ids(await events.query(P, { since: toTimestamp(T0 + 1000) }))).toEqual([c.id, b.id]);
    expect(ids(await events.query(P, { until: toTimestamp(T0 + 1000) }))).toEqual([a.id]);
    expect(ids(await events.query(P, { before: c.id }))).toEqual([b.id, a.id]);
    expect(ids(await events.query(P, { after: a.id, order: "asc" }))).toEqual([b.id, c.id]);
  });

  it("filters by the turn a body names", async () => {
    const { events } = await open();
    const a = { ...line("utterance", T0, null), body: { turn: "t1", said: "hi" } };
    const b = { ...line("result", T0 + 1000, a.id), body: { turn_outcome: { turn: "t1" } } };
    const c = { ...line("utterance", T0 + 2000, null), body: { turn: "t2" } };
    const d = line("delivered", T0 + 3000, a.id);
    await events.append(P, [a, b, c, d]);
    const ids = (list: LogEvent[]) => list.map((e) => e.id);
    expect(ids(await events.query(P, { turn: "t1", order: "asc" }))).toEqual([a.id, b.id]);
    expect(ids(await events.query(P, { turn: "t2" }))).toEqual([c.id]);
    expect(await events.query(P, { turn: "nope" })).toEqual([]);
  });

  it("finds what an event caused", async () => {
    const { events } = await open();
    const a = ambient(T0);
    const b = line("decision", T0 + 1, a.id);
    const c = line("decision", T0 + 2, a.id);
    await events.append(P, [a, b, c, line("decision", T0 + 3, b.id)]);
    const found = await events.effectsOf(P, [a.id], 10);
    expect(found.map((e) => e.id)).toEqual([b.id, c.id]);
  });
});

describe("compaction", () => {
  const policy = (now: number, retain: number | null = null) => ({
    fold_before: toTimestamp(now - 14 * DAY),
    expire_before: retain === null ? null : toTimestamp(now - retain * DAY),
    max_rows: 100,
  });

  it("folds old ambient observations into per-day counts", async () => {
    const { events } = await open();
    const now = T0 + 30 * DAY;
    const old = [ambient(T0), ambient(T0 + HOUR), ambient(T0 + DAY)];
    const fresh = ambient(now - DAY);
    await events.append(P, [...old, fresh]);
    const result = await events.compact(P, policy(now));
    expect(result).toEqual({ folded: 3, expired: 0, more: true });
    expect((await events.query(P, {})).map((e) => e.id)).toEqual([fresh.id]);
    expect(await events.compact(P, policy(now))).toEqual({ folded: 0, expired: 0, more: false });
    const rollups = await events.rollups(P, 10);
    expect(rollups.map((r) => r.count)).toEqual([1, 2]);
    expect(rollups[1]).toMatchObject({ kind: "observation", source: "voice.asr", count: 2 });
    expect(rollups[1]?.first_at).toBe(toTimestamp(T0));
    expect(rollups[1]?.last_at).toBe(toTimestamp(T0 + HOUR));
  });

  it("keeps what is not ambient, and what something still points at", async () => {
    const { events } = await open();
    const now = T0 + 30 * DAY;
    const heard = ambient(T0);
    const decided = line("decision", T0 + 1, heard.id);
    const noted = {
      ...ambient(T0),
      body: { observation: { attention_key: "game:death", salience: "urgent" } },
    };
    await events.append(P, [heard, decided, noted]);
    expect(await events.compact(P, policy(now))).toEqual({ folded: 0, expired: 0, more: false });
    expect(await events.query(P, {})).toHaveLength(3);
  });

  it("expires leaf first, and never breaks the chain of what survives", async () => {
    const { events } = await open();
    const now = T0 + 200 * DAY;
    // old ← old ← new: the new line keeps both its old ancestors.
    const root = line("observation", T0, null);
    const middle = line("decision", T0 + 1, root.id);
    const kept = line("utterance", now - DAY, middle.id);
    // old ← old: nothing new hangs on these, they go over two passes.
    const a = line("observation", T0, null);
    const b = line("delivered", T0 + 1, a.id);
    await events.append(P, [root, middle, kept, a, b]);
    expect(await events.compact(P, policy(now, 180))).toMatchObject({ expired: 1, more: true });
    expect(await events.get(P, b.id)).toBeNull();
    expect(await events.get(P, a.id)).not.toBeNull();
    expect(await events.compact(P, policy(now, 180))).toMatchObject({ expired: 1, more: true });
    expect(await events.compact(P, policy(now, 180))).toMatchObject({ expired: 0, more: false });
    const left = (await events.query(P, { order: "asc" })).map((e) => e.id);
    expect(left).toEqual([root.id, middle.id, kept.id]);
  });

  it("stops at `max_rows`", async () => {
    const { events } = await open();
    const now = T0 + 30 * DAY;
    await events.append(P, [ambient(T0), ambient(T0), ambient(T0)]);
    const result = await events.compact(P, { ...policy(now), max_rows: 2 });
    expect(result).toEqual({ folded: 2, expired: 0, more: true });
    expect(await events.query(P, {})).toHaveLength(1);
  });

  it("leaves other profiles alone", async () => {
    const { events } = await open();
    const now = T0 + 30 * DAY;
    await events.append("other", [ambient(T0)]);
    await events.compact(P, policy(now));
    expect(await events.query("other", {})).toHaveLength(1);
  });
});

describe("data categories", () => {
  it("counts, exports and deletes the log", async () => {
    const { store, events } = await open();
    await events.append(P, [ambient(T0)]);
    const inventory = await store.profileData.inventory(P);
    expect(inventory.categories.find((c) => c.id === "event_log")?.count).toBe(1);
    const backup = await store.profileData.export(P, ["event_log"]);
    expect(backup.parts.log_events?.[0]).toMatchObject({ kind: "observation", person: "Owen" });
    await store.profileData.wipe(P, ["event_log"]);
    expect(await events.query(P, {})).toEqual([]);
  });

  it("goes when the messages go: it repeats what people said", () => {
    expect(resolveCategories(["messages"])).toContain("event_log");
  });
});
