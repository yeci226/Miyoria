// The log itself: nothing a writer does can fail or wait on the store, and the reads and `cause`
// walks work from memory and from the store alike.

import { type EventLogStore, SqliteStore } from "@miyoria/store";
import { type LogEvent, type Projection, toTimestamp } from "@miyoria/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventLogService, matchesFilter } from "../src/log.js";

const P = "miyoria";
const T0 = Date.UTC(2026, 10, 7, 12);
const clock = { now: () => T0 };

const stores: SqliteStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

async function sqlite(): Promise<EventLogStore> {
  const store = await SqliteStore.open(":memory:");
  stores.push(store);
  return store.events;
}

/** A store that fails on demand. */
function flaky(inner: EventLogStore): EventLogStore & { down: boolean } {
  const store = Object.create(inner) as EventLogStore & { down: boolean };
  store.down = false;
  store.append = (profile, events) =>
    store.down ? Promise.reject(new Error("disk full")) : inner.append(profile, events);
  store.query = (profile, filter) =>
    store.down ? Promise.reject(new Error("disk full")) : inner.query(profile, filter);
  store.get = (profile, id) => inner.get(profile, id);
  store.effectsOf = (profile, causes, limit) => inner.effectsOf(profile, causes, limit);
  return store;
}

const thought = (cause: string | null = null) =>
  ({ kind: "thought", source: "mind", cause, body: { text: "嗯" } }) as const;

describe("writing", () => {
  it("fills in what a writer leaves out and keeps the body as plain JSON", () => {
    const log = new EventLogService({ profile: P, store: null, clock });
    const event = log.append({ kind: "thought", source: "mind", body: { a: 1 } });
    expect(event).toMatchObject({
      at: toTimestamp(T0),
      cause: null,
      context: null,
      person: null,
      body: { a: 1 },
    });
    expect(event.id).toHaveLength(26);
  });

  it("does not throw on a body that is not JSON", () => {
    const log = new EventLogService({ profile: P, store: null, clock });
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    const event = log.append({ kind: "thought", source: "mind", body: loop as never });
    expect(event.body).toHaveProperty("unserializable");
  });

  it("does not let a time the store cannot write reach it", async () => {
    const log = new EventLogService({ profile: P, store: await sqlite(), clock });
    const event = log.append({ ...thought(), at: "not a time" });
    expect(event.at).toBe(toTimestamp(T0));
    await log.flush();
    expect(log.failing).toBe(false);
  });

  it("does not touch the store until it is flushed", async () => {
    const store = await sqlite();
    const append = vi.spyOn(store, "append");
    const log = new EventLogService({ profile: P, store, clock });
    log.append(thought());
    log.append(thought());
    expect(append).not.toHaveBeenCalled();
    await log.flush();
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0]?.[1]).toHaveLength(2);
    expect(log.buffered).toBe(0);
  });

  it("keeps events while the store is down and writes them once it is back", async () => {
    const store = flaky(await sqlite());
    const log = new EventLogService({ profile: P, store, clock });
    store.down = true;
    const event = log.append(thought());
    await expect(log.flush()).resolves.toBeUndefined();
    expect(log.failing).toBe(true);
    expect(log.buffered).toBe(1);
    log.append(thought());
    store.down = false;
    await log.flush();
    expect(log.failing).toBe(false);
    expect(log.buffered).toBe(0);
    expect((await log.query()).map((e) => e.id)).toContain(event.id);
  });

  it("drops the oldest events past `maxBuffer` instead of growing", async () => {
    const store = flaky(await sqlite());
    const log = new EventLogService({ profile: P, store, clock, maxBuffer: 3 });
    store.down = true;
    const events = [1, 2, 3, 4, 5].map(() => log.append(thought()));
    expect(log.buffered).toBe(3);
    store.down = false;
    await log.flush();
    const stored = (await log.query({ order: "asc" })).map((e) => e.id);
    expect(stored).toEqual(events.slice(2).map((e) => e.id));
  });

  it("keeps a bounded hot window", () => {
    const log = new EventLogService({ profile: P, store: null, clock, hotEvents: 2 });
    const events = [1, 2, 3].map(() => log.append(thought()));
    expect(log.recent().map((e) => e.id)).toEqual(events.slice(1).map((e) => e.id));
    expect(log.recent(1).map((e) => e.id)).toEqual([events[2]?.id]);
  });
});

describe("reading", () => {
  it("sees what is still buffered", async () => {
    const log = new EventLogService({ profile: P, store: await sqlite(), clock });
    const event = log.append(thought());
    expect(await log.query({ kinds: ["thought"] })).toEqual([event]);
  });

  it("finds an event that fell out of the hot window in the store", async () => {
    const log = new EventLogService({ profile: P, store: await sqlite(), clock, hotEvents: 1 });
    const first = log.append(thought());
    log.append(thought());
    expect(await log.get(first.id)).toEqual(first);
  });

  it("answers from memory when the store cannot", async () => {
    const store = flaky(await sqlite());
    const log = new EventLogService({ profile: P, store, clock });
    const event = log.append(thought());
    store.down = true;
    expect(await log.query({ kinds: ["thought"] })).toEqual([event]);
  });

  it("filters like the store", () => {
    const event: LogEvent = {
      id: "01B",
      at: toTimestamp(T0),
      kind: "observation",
      source: "voice.asr",
      cause: null,
      context: { platform: "discord", scope: "g", channel: "v", kind: "voice" },
      person: "Owen",
      body: { observation: { attention_key: "k" } },
    };
    expect(matchesFilter(event, {})).toBe(true);
    expect(matchesFilter(event, { kinds: ["thought"] })).toBe(false);
    expect(matchesFilter(event, { sources: ["voice.asr"] })).toBe(true);
    expect(matchesFilter(event, { attention_key: "k" })).toBe(true);
    expect(matchesFilter(event, { attention_key: "x" })).toBe(false);
    expect(matchesFilter(event, { person: "Amy" })).toBe(false);
    expect(matchesFilter(event, { since: toTimestamp(T0 + 1) })).toBe(false);
    expect(matchesFilter(event, { until: toTimestamp(T0) })).toBe(false);
    expect(matchesFilter(event, { turn: "t1" })).toBe(false);
    expect(matchesFilter({ ...event, body: { turn: "t1" } }, { turn: "t1" })).toBe(true);
    expect(
      matchesFilter({ ...event, body: { turn_outcome: { turn: "t1" } } }, { turn: "t1" }),
    ).toBe(true);
    expect(matchesFilter({ ...event, body: { turn: "t2" } }, { turn: "t1" })).toBe(false);
    expect(matchesFilter(event, { before: "01A" })).toBe(false);
    expect(matchesFilter(event, { after: "01A" })).toBe(true);
    expect(
      matchesFilter(event, {
        context: { platform: "discord", scope: "g", channel: "c", kind: "channel" },
      }),
    ).toBe(false);
  });
});

describe("cause chains", () => {
  async function chained(hotEvents = 100) {
    const log = new EventLogService({ profile: P, store: await sqlite(), clock, hotEvents });
    const heard = log.append(thought());
    const decided = log.append(thought(heard.id));
    const said = log.append(thought(decided.id));
    const acked = log.append(thought(said.id));
    return { log, heard, decided, said, acked };
  }

  it("walks up to the root, oldest first", async () => {
    const { log, heard, decided, said, acked } = await chained();
    const chain = await log.chain(acked.id);
    expect(chain.complete).toBe(true);
    expect(chain.events.map((e) => e.id)).toEqual([heard.id, decided.id, said.id, acked.id]);
  });

  it("walks through the store when the chain left the hot window", async () => {
    const { log, heard, acked } = await chained(1);
    const chain = await log.chain(acked.id);
    expect(chain.complete).toBe(true);
    expect(chain.events[0]?.id).toBe(heard.id);
  });

  it("says when an ancestor is gone", async () => {
    const log = new EventLogService({ profile: P, store: await sqlite(), clock });
    const orphan = log.append(thought("01HZZZZZZZZZZZZZZZZZZZZZZZ"));
    const chain = await log.chain(orphan.id);
    expect(chain.complete).toBe(false);
    expect(chain.events.map((e) => e.id)).toEqual([orphan.id]);
  });

  it("is empty for an unknown event", async () => {
    const log = new EventLogService({ profile: P, store: await sqlite(), clock });
    expect(await log.chain("nope")).toEqual({ events: [], complete: false });
  });

  it("stops at a loop and at its depth", async () => {
    const log = new EventLogService({ profile: P, store: null, clock });
    log.append({ id: "a", ...thought("b") });
    log.append({ id: "b", ...thought("a") });
    expect((await log.chain("a")).complete).toBe(false);
    const { acked } = await chained();
    const short = await (await chained()).log.chain(acked.id, { maxDepth: 1 });
    expect(short.complete).toBe(false);
  });

  it("walks down what an event caused", async () => {
    const { log, heard, decided, said, acked } = await chained();
    const side = log.append(thought(decided.id));
    const effects = await log.effects(heard.id);
    expect(effects.map((e) => e.id)).toEqual([decided.id, said.id, acked.id, side.id]);
    expect(await log.effects(heard.id, { maxDepth: 1 })).toHaveLength(1);
    expect(await log.effects(heard.id, { limit: 2 })).toHaveLength(2);
    expect(await log.effects(acked.id)).toEqual([]);
  });

  it("walks down from memory without a store", async () => {
    const log = new EventLogService({ profile: P, store: null, clock });
    const a = log.append(thought());
    const b = log.append(thought(a.id));
    expect((await log.effects(a.id)).map((e) => e.id)).toEqual([b.id]);
  });
});

describe("projections", () => {
  class Seen implements Projection {
    readonly ids: string[] = [];
    apply(event: LogEvent): void {
      this.ids.push(event.id);
    }
  }

  it("feeds history from the store, then every new event", async () => {
    const log = new EventLogService({ profile: P, store: await sqlite(), clock, hotEvents: 1 });
    const a = log.append(thought());
    const b = log.append(thought());
    const seen = new Seen();
    const stop = await log.project(seen, { kinds: ["thought"] });
    expect(seen.ids).toEqual([a.id, b.id]);
    const c = log.append(thought());
    expect(seen.ids).toEqual([a.id, b.id, c.id]);
    stop();
    log.append(thought());
    expect(seen.ids).toHaveLength(3);
  });

  it("feeds only new events when no history is asked for", async () => {
    const log = new EventLogService({ profile: P, store: await sqlite(), clock });
    log.append(thought());
    const seen = new Seen();
    await log.project(seen);
    const b = log.append(thought());
    expect(seen.ids).toEqual([b.id]);
  });

  it("does not let a broken projection reach the writer", async () => {
    const log = new EventLogService({ profile: P, store: null, clock });
    const seen = new Seen();
    await log.project({
      apply() {
        throw new Error("boom");
      },
    });
    await log.project(seen);
    const event = log.append(thought());
    expect(seen.ids).toEqual([event.id]);
  });
});
