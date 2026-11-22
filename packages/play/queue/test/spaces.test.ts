// The request queue per Space (phase 6): each server has its own items, pause, vote and fairness;
// an item id still names one item everywhere; a snapshot of before Spaces loads as it was, its
// pause and vote the original server's and each item in the server of its context.

import { MemorySettingsStore } from "@miyoria/store";
import {
  type AccountRef,
  type Clock,
  type ContextKey,
  type JsonValue,
  type Publish,
  type PublishedEvent,
  publishedInto,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  QueueConfigSchema,
  type QueueSpaces,
  RequestQueue,
  STATE_KEY,
  STATE_PROFILE,
  type SubmitRequest,
} from "../src/index.js";

const acct = (id: string): AccountRef => ({ platform: "discord", id });
const where = (guild: string | null, channel = "c"): ContextKey => ({
  platform: "discord",
  scope: guild,
  channel,
  kind: guild === null ? "dm" : "channel",
});

class TestClock implements Clock {
  #ms = 0;
  now(): number {
    return 1_700_000_000_000 + this.#ms++;
  }
  advance(secs: number): void {
    this.#ms += secs * 1000;
  }
}

/** Guild gA is Space A (the primary), gB is B. */
const SPACES: QueueSpaces = {
  spaceOf: (c) => (c.scope === "gA" ? "A" : c.scope === "gB" ? "B" : null),
  primary: () => "A",
};

function req(who: string, text: string, guild: string | null): SubmitRequest {
  return {
    requester: acct(who),
    requesterName: `user${who}`,
    kind: "chat",
    text,
    context: where(guild),
  };
}

const texts = (q: { list(): { text: string }[] }) => q.list().map((i) => i.text);

describe("a queue per Space", () => {
  it("keeps each server's items, pause and vote apart", () => {
    const clock = new TestClock();
    const q = new RequestQueue(QueueConfigSchema.parse({ max_pending_per_user: 1 }), {
      clock,
      spaces: SPACES,
    });
    q.submit(req("1", "a1", "gA"));
    // The per-person limit is per server: the same person may wait in both.
    q.submit(req("1", "b1", "gB"));
    q.submit(req("2", "dm", null));
    expect(texts(q.of("A"))).toEqual(["a1", "dm"]);
    expect(texts(q)).toEqual(["a1", "dm"]);
    expect(texts(q.of("B"))).toEqual(["b1"]);
    expect(q.get(2)?.space).toBe("B");
    expect(q.get(3)?.space).toBeNull();

    q.pause("B");
    expect(q.isPaused("B")).toBe(true);
    expect(q.isPaused()).toBe(false);
    expect(q.next("B")).toBeNull();
    expect(q.next()?.text).toBe("a1");
    expect(q.current("B")).toBeNull();

    q.startVote(["x", "y"], 60_000, "B");
    expect(q.voteStatus()).toBeNull();
    q.castVote(acct("1"), "y", "B");
    expect(() => q.castVote(acct("1"), "y")).toThrow();
    const result = q.endVote("B");
    expect(result.winner).toBe(1);
    // The winner goes into B's queue.
    expect(texts(q.of("B"))).toEqual(["y", "b1"]);
    expect(texts(q.of("A"))).toEqual(["a1", "dm"]);
    // An id names one item, whichever queue it is in.
    q.skip(2);
    expect(texts(q.of("B"))).toEqual(["y"]);
    expect(q.clear("A")).toBe(1);
    expect(texts(q.of("B"))).toEqual(["y"]);
  });

  it("publishes the changed queue alone", () => {
    const events: PublishedEvent[] = [];
    const q = new RequestQueue(QueueConfigSchema.parse({}), {
      clock: new TestClock(),
      spaces: SPACES,
      publisher: publishedInto(events),
    });
    q.submit(req("1", "a1", "gA"));
    q.submit(req("2", "b1", "gB"));
    const last = events.at(-1)?.data as { items: { text: string }[] };
    expect(last.items.map((i) => i.text)).toEqual(["b1"]);
  });

  it("says on each queue.changed which Space it is (none without places)", () => {
    const seen: Array<{ type: string; space: string | null }> = [];
    const publisher: Publish = (definition, _data, ...meta) => {
      const m = meta[0] as { space_id?: string } | undefined;
      seen.push({ type: definition.type, space: m?.space_id ?? null });
    };
    const q = new RequestQueue(QueueConfigSchema.parse({}), {
      clock: new TestClock(),
      spaces: SPACES,
      publisher,
    });
    q.submit(req("1", "a1", "gA"));
    q.submit(req("2", "b1", "gB"));
    const changed = seen.filter((e) => e.type === "queue.changed").map((e) => e.space);
    expect(changed).toEqual(["A", "B"]);

    const plain: Array<string | null> = [];
    const one = new RequestQueue(QueueConfigSchema.parse({}), {
      clock: new TestClock(),
      publisher: (definition, _data, ...meta) => {
        if (definition.type === "queue.changed") {
          plain.push((meta[0] as { space_id?: string } | undefined)?.space_id ?? null);
        }
      },
    });
    one.submit(req("1", "x", null));
    expect(plain).toEqual([null]);
  });
});

describe("a snapshot of before Spaces", () => {
  it("loads as it was: the original server's pause and vote, each item in its context's server", async () => {
    const store = new MemorySettingsStore();
    const item = (id: number, guild: string | null, state = "pending") => ({
      id,
      requester: { platform: "discord", id: String(id) },
      requester_name: `u${id}`,
      kind: "song",
      text: `t${id}`,
      context: guild === null ? null : where(guild),
      created_at: `2026-11-20T00:00:0${id}Z`,
      priority: 0,
      slot: null,
      votes: 0,
      voters: [],
      state,
    });
    const old = {
      next_id: 5,
      items: [item(1, "gA", "active"), item(2, "gA"), item(3, null), item(4, "gB")],
      history: [item(0, "gA", "done")],
      paused: true,
      served: [[{ platform: "discord", id: "1" }, 1]],
      vote: {
        options: ["x", "y"],
        started_at: "2026-11-20T00:00:00Z",
        ends_at: "2099-01-01T00:00:00Z",
        ballots: [],
      },
      last_vote: null,
    };
    await store.set(STATE_PROFILE, STATE_KEY, old as unknown as JsonValue);
    const q = new RequestQueue(QueueConfigSchema.parse({}), {
      clock: new TestClock(),
      store,
      spaces: SPACES,
    });
    expect(await q.restore()).toBe(true);
    // The original server's queue holds what it held, paused, with its vote.
    expect(q.list().map((i) => i.id)).toEqual([1, 2, 3]);
    expect(q.isPaused()).toBe(true);
    expect(q.voteStatus()?.options).toEqual(["x", "y"]);
    expect(q.list().map((i) => i.space)).toEqual(["A", "A", "A"]);
    // The item asked for in the other server is there.
    expect(q.list("B").map((i) => i.id)).toEqual([4]);
    expect(q.isPaused("B")).toBe(false);
    expect(q.history().map((i) => i.space)).toEqual(["A"]);
    expect(q.submit(req("9", "new", "gA")).item.id).toBe(6);

    // Written back and read again: the same queues.
    await q.persist();
    const stored = (await store.get(STATE_PROFILE, STATE_KEY)) as Record<string, JsonValue>;
    expect(stored.paused).toBe(true);
    const again = new RequestQueue(QueueConfigSchema.parse({}), { store, spaces: SPACES });
    expect(await again.restore()).toBe(true);
    expect(again.list()).toEqual(q.list());
    expect(again.list("B")).toEqual(q.list("B"));
    expect(again.isPaused()).toBe(true);
  });

  it("loads without Spaces as the one queue it was", async () => {
    const store = new MemorySettingsStore();
    const q = new RequestQueue(QueueConfigSchema.parse({}), { clock: new TestClock(), store });
    q.submit(req("1", "a", "gA"));
    q.pause();
    await q.persist();
    // Spaces appear later (the first server seen): the queue of no Space is the primary's.
    const later = new RequestQueue(QueueConfigSchema.parse({}), { store, spaces: SPACES });
    expect(await later.restore()).toBe(true);
    expect(texts(later.of("A"))).toEqual(["a"]);
    expect(later.isPaused("A")).toBe(true);
  });
});
