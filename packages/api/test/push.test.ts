// Server push (src/push/, v5-architecture §11.4): the hub on its own with a fake clock (values,
// changes, resume, stale ids, slow readers, limits, rechecks), then the streams through the whole
// app in process (the wire, the audiences, Space scoping, the heartbeat, a session that ends, the
// public listener), then once over loopback.

import type { PushEvent } from "@miyoria/contracts/api";
import { EconomyKey } from "@miyoria/economy";
import { ExchangeKey } from "@miyoria/play/exchange";
import { KaraokeRoomsKey } from "@miyoria/play/karaoke";
import { TopicFilter } from "@miyoria/runtime/kernel";
import { SingerKey } from "@miyoria/sing";
import { PeopleStoreKey } from "@miyoria/store";
import { type AccountRef, ActivityManagerKey, ModerationKey, PlacesKey } from "@miyoria/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Monitor } from "../src/monitor.js";
import { PublicConfigSchema, PublicSide } from "../src/public.js";
import {
  PUSH_LINGER_MS,
  PUSH_SLOW_MS,
  PushHub,
  type StreamRequest,
  type Subscription,
} from "../src/push/hub.js";
import { hubOf, parseTopics } from "../src/push/routes.js";
import { RECHECK_MS } from "../src/recheck.js";
import { createApp } from "../src/server.js";
import type { SessionRecord } from "../src/session.js";
import { ApiState } from "../src/state.js";
import type { Watch } from "../src/watch.js";

afterEach(() => {
  vi.useRealTimers();
});

/** Lets every pending promise and the stream plumbing run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

// ---- the hub ----------------------------------------------------------------------------------

const NO_TIMING = () => ({ triggers: [], everyMs: null });

function watch<T>(key: string, get: () => T): Watch<unknown> {
  return { key, build: () => get() };
}

function request(
  subscriptions: StreamRequest["subscriptions"],
  extra: Partial<StreamRequest> = {},
): StreamRequest {
  return {
    client: "203.0.113.1",
    account: null,
    subscriptions,
    lastEventId: undefined,
    recheck: async () => true,
    drop: () => {},
    ...extra,
  };
}

const STATUS: Subscription = { topic: "status", param: null };

/** The next event of `gen`, or `"none"` when nothing is waiting once everything has run. */
async function nextOrNone<T>(gen: AsyncGenerator<T>, pending?: Promise<IteratorResult<T>>) {
  const next = (pending ?? gen.next()).then((r) => r.value);
  await settle();
  return Promise.race([next, Promise.resolve("none" as const)]);
}

describe("the push hub", () => {
  it("sends each value, then ready, then only what changed", async () => {
    const hub = new PushHub({ now: () => 0, timers: false, run: "r1" });
    let value = { n: 1 };
    const ctl = new AbortController();
    const gen = hub.open(
      request([{ sub: STATUS, watch: watch("status", () => value) }], { signal: ctl.signal }),
      hub.reserve("c", null),
      NO_TIMING,
    );
    expect((await gen.next()).value).toEqual({
      event: { kind: "value", topic: "status", param: null, data: { n: 1 } },
      id: null,
    });
    const ready = (await gen.next()).value;
    expect(ready?.event).toEqual({ kind: "ready" });
    expect(ready?.id).toMatch(/^r1\.\d+\.[0-9a-z]+$/);

    const waiting = gen.next();
    value = { n: 2 };
    hub.touch("status");
    await hub.flush();
    const change = (await waiting).value;
    expect(change?.event).toEqual({ kind: "value", topic: "status", param: null, data: { n: 2 } });
    expect(change?.id).not.toBe(ready?.id);

    // Built again with the same answer: nothing goes out.
    hub.touch("status");
    await hub.flush();
    const idle = gen.next();
    expect(await nextOrNone(gen, idle)).toBe("none");
    // The client goes: the stream ends though it was waiting.
    ctl.abort();
    expect((await idle).done).toBe(true);
    expect(hub.size.streams).toBe(0);
  });

  it("shares a view between streams with the same key, and only theirs", async () => {
    const hub = new PushHub({ now: () => 0, timers: false });
    let built = 0;
    const values: Record<string, number> = { a: 1, b: 1 };
    const of = (key: string) =>
      watch(key, () => {
        built++;
        return { key, n: values[key] };
      });
    const one = hub.open(
      request([{ sub: STATUS, watch: of("a") }]),
      hub.reserve("1", null),
      NO_TIMING,
    );
    const two = hub.open(
      request([{ sub: STATUS, watch: of("a") }]),
      hub.reserve("2", null),
      NO_TIMING,
    );
    const other = hub.open(
      request([{ sub: STATUS, watch: of("b") }]),
      hub.reserve("3", null),
      NO_TIMING,
    );
    for (const gen of [one, two, other]) {
      await gen.next();
      await gen.next();
    }
    expect(built).toBe(2);
    values.a = 2;
    hub.touch("status");
    await hub.flush();
    expect(((await nextOrNone(one)) as { event: PushEvent }).event).toMatchObject({
      data: { n: 2 },
    });
    expect(((await nextOrNone(two)) as { event: PushEvent }).event).toMatchObject({
      data: { n: 2 },
    });
    expect(await nextOrNone(other)).toBe("none");
  });

  it("resumes after an id: only what changed since, nothing when nothing did", async () => {
    let t = 0;
    const hub = new PushHub({ now: () => t, timers: false, run: "r1" });
    const values = { status: 1, songs: 1 };
    const subs = () => [
      { sub: STATUS, watch: watch("status", () => ({ n: values.status })) },
      {
        sub: { topic: "songs" as const, param: null },
        watch: watch("songs:", () => ({ n: values.songs })),
      },
    ];
    const first = hub.open(request(subs()), hub.reserve("c", null), NO_TIMING);
    await first.next();
    await first.next();
    const ready = (await first.next()).value;
    const lastId = ready?.id ?? "";
    await first.return();

    // Nothing changed: the reconnect gets ready alone.
    const quiet = hub.open(
      request(subs(), { lastEventId: lastId }),
      hub.reserve("c", null),
      NO_TIMING,
    );
    expect((await quiet.next()).value?.event).toEqual({ kind: "ready" });
    await quiet.return();

    // A change while nobody watched (the view lingers): only that one comes again.
    t += 1_000;
    values.songs = 2;
    hub.touch("songs");
    await hub.flush();
    const back = hub.open(
      request(subs(), { lastEventId: lastId }),
      hub.reserve("c", null),
      NO_TIMING,
    );
    expect((await back.next()).value?.event).toEqual({
      kind: "value",
      topic: "songs",
      param: null,
      data: { n: 2 },
    });
    expect((await back.next()).value?.event).toEqual({ kind: "ready" });
    await back.return();
  });

  it("sends every value again for an id it cannot resume from", async () => {
    let t = 0;
    const hub = new PushHub({ now: () => t, timers: false, run: "r1" });
    const subs = () => [{ sub: STATUS, watch: watch("status", () => ({ n: 1 })) }];
    const gen = hub.open(request(subs()), hub.reserve("c", null), NO_TIMING);
    await gen.next();
    const id = (await gen.next()).value?.id ?? "";
    await gen.return();
    const [, seq, hash] = id.split(".");
    const stale = [
      `r0.${seq}.${hash}`, // another run of the Core
      `r1.${seq}.other`, // other topics
      `r1.99999.${hash}`, // ahead of this hub
      "garbage",
    ];
    for (const lastEventId of stale) {
      const again = hub.open(request(subs(), { lastEventId }), hub.reserve("c", null), NO_TIMING);
      expect((await again.next()).value?.event.kind).toBe("value");
      await again.return();
    }
    // Too old: the view was forgotten after nobody watched it for the linger.
    t += PUSH_LINGER_MS;
    await hub.sweep();
    expect(hub.size.views).toBe(0);
    const late = hub.open(request(subs(), { lastEventId: id }), hub.reserve("c", null), NO_TIMING);
    expect((await late.next()).value?.event.kind).toBe("value");
    await late.return();
  });

  it("refuses a topic with its route's status and keeps the others", async () => {
    const hub = new PushHub({ now: () => 0, timers: false });
    const gen = hub.open(
      request([
        {
          sub: { topic: "rooms", param: "B" },
          watch: { refused: { status: 403, message: "你不在這個伺服器裡" } },
        },
        { sub: STATUS, watch: watch("status", () => ({ n: 1 })) },
      ]),
      hub.reserve("c", null),
      NO_TIMING,
    );
    expect((await gen.next()).value?.event).toEqual({
      kind: "refused",
      topic: "rooms",
      param: "B",
      status: 403,
      message: "你不在這個伺服器裡",
    });
    expect((await gen.next()).value?.event.kind).toBe("value");
    expect((await gen.next()).value?.event.kind).toBe("ready");
  });

  it("turns a view that fails into a refusal, and back into values", async () => {
    const hub = new PushHub({ now: () => 0, timers: false });
    let up = true;
    const gen = hub.open(
      request([
        {
          sub: STATUS,
          watch: watch("status", () => {
            if (!up) throw new Error("module stopped");
            return { n: 1 };
          }),
        },
      ]),
      hub.reserve("c", null),
      NO_TIMING,
    );
    await gen.next();
    await gen.next();
    up = false;
    hub.touch("status");
    await hub.flush();
    expect(((await nextOrNone(gen)) as { event: PushEvent }).event).toMatchObject({
      kind: "refused",
      status: 500,
    });
    up = true;
    hub.touch("status");
    await hub.flush();
    expect(((await nextOrNone(gen)) as { event: PushEvent }).event).toMatchObject({
      kind: "value",
    });
  });

  it("keeps one unsent value per view and drops a reader that stopped reading", async () => {
    let t = 0;
    const hub = new PushHub({ now: () => t, timers: false });
    let n = 0;
    const drop = vi.fn();
    const gen = hub.open(
      request([{ sub: STATUS, watch: watch("status", () => ({ n })) }], { drop }),
      hub.reserve("c", null),
      NO_TIMING,
    );
    await gen.next();
    await gen.next();
    // The reader stops; changes keep coming.
    for (let i = 0; i < 50; i++) {
      n += 1;
      hub.touch("status");
      await hub.flush();
      t += 1_000;
    }
    await hub.sweep();
    expect(drop).toHaveBeenCalledTimes(1);
    expect(hub.size.streams).toBe(0);
    // Its place is free again.
    expect(t).toBeGreaterThanOrEqual(PUSH_SLOW_MS);
  });

  it("does not drop a reader that keeps up", async () => {
    let t = 0;
    const hub = new PushHub({ now: () => t, timers: false });
    let n = 0;
    const drop = vi.fn();
    const gen = hub.open(
      request([{ sub: STATUS, watch: watch("status", () => ({ n })) }], { drop }),
      hub.reserve("c", null),
      NO_TIMING,
    );
    await gen.next();
    await gen.next();
    for (let i = 0; i < 50; i++) {
      const next = gen.next();
      n += 1;
      hub.touch("status");
      await hub.flush();
      expect((await next).value?.event).toMatchObject({ data: { n } });
      t += 1_000;
    }
    await hub.sweep();
    expect(drop).not.toHaveBeenCalled();
    expect(hub.size.streams).toBe(1);
  });

  it("limits streams per client, per account and in all", () => {
    const hub = new PushHub({
      now: () => 0,
      timers: false,
      limits: { perClient: 2, perAccount: 2, total: 6 },
    });
    const a = hub.reserve("1.1.1.1", null);
    hub.reserve("1.1.1.1", null);
    expect(() => hub.reserve("1.1.1.1", null)).toThrow(expect.objectContaining({ status: 429 }));
    a.release();
    a.release(); // twice is once
    hub.reserve("1.1.1.1", null);
    hub.reserve("2.2.2.2", "discord:1");
    expect(() => hub.reserve("3.3.3.3", "discord:1")).not.toThrow();
    expect(() => hub.reserve("4.4.4.4", "discord:1")).toThrow(
      expect.objectContaining({ status: 429 }),
    );
    hub.reserve("5.5.5.5", null);
    hub.reserve("6.6.6.6", null);
    expect(() => hub.reserve("7.7.7.7", null)).toThrow(expect.objectContaining({ status: 503 }));
  });

  it("asks about each stream again every RECHECK_MS and ends one that may no longer see", async () => {
    let t = 0;
    const hub = new PushHub({ now: () => t, timers: false });
    let allowed = true;
    const recheck = vi.fn(async () => allowed);
    const gen = hub.open(
      request([{ sub: STATUS, watch: watch("status", () => ({ n: 1 })) }], { recheck }),
      hub.reserve("c", null),
      NO_TIMING,
    );
    await gen.next();
    await gen.next();
    const waiting = gen.next();
    t += RECHECK_MS - 1;
    await hub.sweep();
    expect(recheck).not.toHaveBeenCalled();
    t += 1;
    await hub.sweep();
    expect(recheck).toHaveBeenCalledTimes(1);
    allowed = false;
    t += RECHECK_MS;
    await hub.sweep();
    expect((await waiting).done).toBe(true);
    expect(hub.size.streams).toBe(0);
  });

  it("ends a stream whose client went away, even while it waits", async () => {
    const hub = new PushHub({ now: () => 0, timers: false });
    const ctl = new AbortController();
    const gen = hub.open(
      request([{ sub: STATUS, watch: watch("status", () => ({ n: 1 })) }], { signal: ctl.signal }),
      hub.reserve("c", null),
      NO_TIMING,
    );
    await gen.next();
    await gen.next();
    const waiting = gen.next();
    ctl.abort();
    expect((await waiting).done).toBe(true);
    expect(hub.size.streams).toBe(0);
    // The client's place is free.
    expect(() => {
      for (let i = 0; i < 6; i++) hub.reserve("c", null);
    }).not.toThrow();
  });

  it("pings a stream that has nothing to send, and a change puts the ping off", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const hub = new PushHub({ now: () => 0, timers: false, pingMs: 1_000 });
    let n = 1;
    const gen = hub.open(
      request([{ sub: STATUS, watch: watch("status", () => ({ n })) }]),
      hub.reserve("c", null),
      NO_TIMING,
    );
    await gen.next();
    await gen.next();
    const ping = gen.next();
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await ping).value).toEqual({ event: { kind: "ping" }, id: null });
    const change = gen.next();
    await vi.advanceTimersByTimeAsync(600);
    n = 2;
    hub.touch("status");
    await hub.flush();
    expect((await change).value?.event).toMatchObject({ kind: "value", data: { n: 2 } });
    const after = gen.next();
    await vi.advanceTimersByTimeAsync(999);
    await settle();
    expect(await Promise.race([after.then(() => "ping"), Promise.resolve("none")])).toBe("none");
    await vi.advanceTimersByTimeAsync(1);
    expect((await after).value?.event).toEqual({ kind: "ping" });
  });

  it("builds a view again on its tick, for changes no event announces", async () => {
    let t = 0;
    const hub = new PushHub({ now: () => t, timers: false });
    let n = 1;
    const gen = hub.open(
      request([{ sub: STATUS, watch: watch("status", () => ({ n })) }]),
      hub.reserve("c", null),
      () => ({ triggers: [], everyMs: 5_000 }),
    );
    await gen.next();
    await gen.next();
    n = 2;
    t += 4_999;
    await hub.sweep();
    const next = gen.next();
    expect(await nextOrNone(gen, next)).toBe("none");
    t += 1;
    await hub.sweep();
    expect((await next).value?.event).toMatchObject({ data: { n: 2 } });
  });
});

describe("?topics=", () => {
  it("reads names and parameters, each once", () => {
    expect(parseTopics("status, songs~spaceA,status", "public")).toEqual([
      { topic: "status", param: null },
      { topic: "songs", param: "spaceA" },
    ]);
  });

  it("refuses a member topic on the public stream, a bad parameter, too many", () => {
    expect(() => parseTopics("rooms", "public")).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => parseTopics("danmaku", "member")).not.toThrow();
    expect(() => parseTopics("songs~a/b", "public")).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    expect(() => parseTopics("status~x", "public")).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    expect(() => parseTopics("nope", "member")).toThrow(expect.objectContaining({ status: 400 }));
    const many = Array.from({ length: 9 }, (_, i) => `songs~s${i}`).join(",");
    expect(() => parseTopics(many, "public")).toThrow(expect.objectContaining({ status: 400 }));
  });
});

// ---- the streams through the app ----------------------------------------------------------------

const TOKEN = "push-test-token";
const TERMS = { currency: "點數", price: 10, prize: 5, finish: 1, rounds: 3, max_singers: 4 };
const ALICE: AccountRef = { platform: "discord", id: "1" };
const BOB: AccountRef = { platform: "discord", id: "2" };

function session(
  account: AccountRef,
  name: string,
  tier: "member" | "admin" = "member",
): SessionRecord {
  return {
    account,
    name,
    avatar_url: null,
    tier,
    created_at: "2026-11-20T00:00:00.000Z",
    expires_at: "2026-12-20T00:00:00.000Z",
  };
}

/** A bus that delivers each emitted type to the subscriptions it matches. */
class FakeBus {
  readonly subs = new Set<{ filter: TopicFilter; push: () => void; close: () => void }>();

  subscribe(filter: string | readonly string[]) {
    const queue: number[] = [];
    let wake: (() => void) | null = null;
    let closed = false;
    const entry = {
      filter: TopicFilter.from(filter),
      push: () => {
        queue.push(1);
        wake?.();
      },
      close: () => {
        closed = true;
        wake?.();
      },
    };
    this.subs.add(entry);
    const subs = this.subs;
    return {
      close: () => entry.close(),
      async *[Symbol.asyncIterator]() {
        try {
          while (!closed) {
            if (queue.length === 0) {
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
              continue;
            }
            queue.shift();
            yield {};
          }
        } finally {
          subs.delete(entry);
        }
      },
    };
  }

  emit(type: string): void {
    for (const sub of this.subs) if (sub.filter.matches(type)) sub.push();
  }
}

interface World {
  clock: { t: number };
  bus: FakeBus;
  state: ApiState;
  sessions: Map<string, SessionRecord>;
  activity: { live: boolean };
  songs: Record<string, string[]>;
  rooms: Record<string, boolean>;
  /** The exchange's last price of each code. */
  prices: Record<string, number>;
  views: string[];
  stop(): void;
}

/** One exchange line, every field the schema names. */
function line(code: string, price: number) {
  return {
    code,
    name: code,
    market: "tw",
    price,
    basis: "quote",
    price_date: "2026-11-22",
    price_note: null,
    next_open: null,
    currency: "TWD",
    local: null,
    coin_price: price,
    age_minutes: 1,
    source: "test",
    change: null,
    at: "2026-11-22T04:00:00.000Z",
    open: true,
    stale: false,
    quotes: "intraday",
  };
}

function world(): World {
  const clock = { t: Date.UTC(2026, 10, 22, 12) };
  const bus = new FakeBus();
  const ctl = new AbortController();
  const activity = { live: false };
  const songs: Record<string, string[]> = { gA: ["Alpha"], gB: ["Bravo"] };
  const rooms: Record<string, boolean> = { spaceA: false, spaceB: false };
  const prices: Record<string, number> = { "2330.TW": 1000 };
  const views: string[] = [];
  const spaces = [
    { id: "spaceA", platform: "discord", external_id: "gA", name: "A", primary: true },
    { id: "spaceB", platform: "discord", external_id: "gB", name: "B", primary: false },
  ];
  const memberOf: Record<string, string[]> = { "p-1": ["spaceA"], "p-2": ["spaceB"] };
  const services = new Map<unknown, unknown>([
    [
      ActivityManagerKey,
      {
        snapshot: () => ({
          activity: null,
          broadcast: { type: activity.live ? "live" : "off" },
          presence: { type: activity.live ? "in" : "out" },
        }),
      },
    ],
    [
      SingerKey,
      {
        list: {
          all: () =>
            Object.entries(songs).flatMap(([guild, titles]) =>
              titles.map((title) => ({
                state: "ready",
                guild,
                song: { title, artist: null, duration_s: 200 },
              })),
            ),
        },
        playing: () => null,
        singing: () => false,
      },
    ],
    [
      PlacesKey,
      {
        space: (id: string) => spaces.find((s) => s.id === id) ?? null,
        primary: () => spaces[0],
        spaces: () => spaces,
        isMember: (person: string, space: string) => memberOf[person]?.includes(space) ?? false,
        spacesOf: (person: string) => spaces.filter((s) => memberOf[person]?.includes(s.id)),
      },
    ],
    [PeopleStoreKey, { personByAccount: async (a: AccountRef) => ({ id: `p-${a.id}` }) }],
    [
      KaraokeRoomsKey,
      {
        overview: async (account: AccountRef, _admin: boolean, space: string) => ({
          available: rooms[space] === true,
          reason: rooms[space] === true ? null : "她不在這個伺服器的語音頻道",
          terms: TERMS,
          balance: account.id === "1" ? 50 : 7,
          mine: null,
        }),
      },
    ],
    [
      EconomyKey,
      {
        danmakuView: async (account: AccountRef) => ({
          open: true,
          live: activity.live,
          currency: "點數",
          price: 2,
          max_chars: 30,
          cooldown_s: 20,
          per_day: 10,
          sent_today: account.id === "1" ? 1 : 0,
          wait_s: 0,
          balance: 9,
          why: activity.live ? null : "她現在沒在直播",
        }),
      },
    ],
    // Every title passes moderation here.
    [ModerationKey, { screen: () => ({ ok: true }) }],
    [
      ExchangeKey,
      {
        personOf: async (a: AccountRef) => `p-${a.id}`,
        lists: {
          rows: (_kind: string, person: string | null) =>
            Object.entries(prices).map(([code, price]) => ({
              ...line(code, price),
              holders: person === "p-1" ? 1 : null,
            })),
          watching: () => false,
        },
        real: {
          history: (code: string) =>
            prices[code] === undefined ? null : { line: line(code, prices[code] ?? 0), points: [] },
          noteView: (person: string, code: string) => views.push(`${person}:${code}`),
        },
      },
    ],
  ]);
  const sessions = new Map<string, SessionRecord>([
    ["alice", session(ALICE, "Alice")],
    ["bob", session(BOB, "Bob")],
    ["owner", session({ platform: "discord", id: "9" }, "Owner", "admin")],
  ]);
  const ctx = {
    clock: { now: () => clock.t },
    services: {
      get: (key: unknown) => services.get(key),
    },
    subscribe: (filter: string | readonly string[]) => bus.subscribe(filter),
    signal: ctl.signal,
    log: { info: () => {}, warn: () => {}, debug: () => {} },
  };
  const auth = {
    token: Buffer.from(TOKEN),
    oauth: {},
    cookieSecure: false,
    sessions: {
      lookup: async (_store: unknown, _authorizer: unknown, token: string) => {
        const record = sessions.get(token);
        return record ? { record, access: { panel: record.tier === "admin", write: true } } : null;
      },
    },
  };
  const side = new PublicSide(PublicConfigSchema.parse({ enabled: true }), () => clock.t);
  const state = new ApiState(
    ctx as never,
    auth as never,
    new Monitor(),
    null,
    () => [],
    [],
    undefined,
    undefined,
    undefined,
    side,
  );
  return {
    clock,
    bus,
    state,
    sessions,
    activity,
    songs,
    rooms,
    prices,
    views,
    stop: () => ctl.abort(),
  };
}

interface Sse {
  event: string;
  id: string | null;
  data: unknown;
}

/** Reads SSE messages (and counts comments) from a streamed response. */
class SseReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #decoder = new TextDecoder();
  #buffer = "";
  comments = 0;
  done = false;

  constructor(response: Response) {
    this.#reader = (response.body as ReadableStream<Uint8Array>).getReader();
  }

  /** The next message; comments are counted and skipped. `null` once the stream ended. */
  async next(): Promise<Sse | null> {
    for (;;) {
      const end = this.#buffer.indexOf("\n\n");
      if (end >= 0) {
        const block = this.#buffer.slice(0, end);
        this.#buffer = this.#buffer.slice(end + 2);
        const lines = block.split("\n");
        if (lines.every((l) => l.startsWith(":"))) {
          this.comments++;
          continue;
        }
        let event = "message";
        let id: string | null = null;
        let data = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) event = line.slice(7);
          else if (line.startsWith("id: ")) id = line.slice(4);
          else if (line.startsWith("data: ")) data += line.slice(6);
        }
        return { event, id, data: data === "" ? undefined : JSON.parse(data) };
      }
      const { value, done } = await this.#reader.read();
      if (done) {
        this.done = true;
        return null;
      }
      this.#buffer += this.#decoder.decode(value, { stream: true });
    }
  }

  /** Messages until `ready` (that one included). */
  async untilReady(): Promise<Sse[]> {
    const out: Sse[] = [];
    for (;;) {
      const m = await this.next();
      if (m === null) return out;
      out.push(m);
      if ((m.data as PushEvent | undefined)?.kind === "ready") return out;
    }
  }

  cancel(): Promise<void> {
    return this.#reader.cancel();
  }
}

const cookie = (token: string) => ({ cookie: `miyoria_session=${token}` });

describe("push streams through the app", () => {
  const worlds: World[] = [];
  afterEach(() => {
    for (const w of worlds.splice(0)) w.stop();
  });
  const make = () => {
    const w = world();
    worlds.push(w);
    return w;
  };

  it("answers an event stream that is never cached nor buffered, values first", async () => {
    const w = make();
    const app = createApp(w.state, { responseCheck: "strict" });
    const res = await app.request("/api/public/stream?topics=status,songs");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    const sse = new SseReader(res);
    const first = await sse.untilReady();
    expect(first.map((m) => m.data)).toEqual([
      expect.objectContaining({
        kind: "value",
        topic: "status",
        data: expect.objectContaining({ state: "idle", live: false }),
      }),
      {
        kind: "value",
        topic: "songs",
        param: null,
        // The primary's songs only.
        data: {
          playing: null,
          upcoming: [{ title: "Alpha", artist: null, duration_s: 200, ready: true }],
          recent: [],
        },
      },
      { kind: "ready" },
    ]);
    expect(first.at(-1)?.id).toMatch(/^[0-9a-z]+\.\d+\.[0-9a-z]+$/);

    // She goes live: the status follows after the bus says so.
    w.activity.live = true;
    w.bus.emit("activity.changed");
    await hubOf(w.state).flush();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await hubOf(w.state).flush();
    const change = await sse.next();
    expect(change?.data).toMatchObject({
      kind: "value",
      topic: "status",
      data: { state: "live", live: true },
    });
    expect(change?.id).not.toBeNull();
    await sse.cancel();
  });

  it("resumes with Last-Event-ID, and snapshots again for a stale one", async () => {
    const w = make();
    const app = createApp(w.state, { responseCheck: "strict" });
    const one = new SseReader(await app.request("/api/public/stream?topics=songs~spaceB"));
    const first = await one.untilReady();
    expect(first[0]?.data).toMatchObject({
      topic: "songs",
      param: "spaceB",
      data: { upcoming: [{ title: "Bravo" }] },
    });
    const id = first.at(-1)?.id ?? "";
    await one.cancel();
    await settle();

    const resumed = new SseReader(
      await app.request("/api/public/stream?topics=songs~spaceB", {
        headers: { "last-event-id": id },
      }),
    );
    expect((await resumed.untilReady()).map((m) => (m.data as PushEvent).kind)).toEqual(["ready"]);
    await resumed.cancel();

    const stale = new SseReader(
      await app.request("/api/public/stream?topics=songs~spaceB", {
        headers: { "last-event-id": "x.1.y" },
      }),
    );
    expect((await stale.untilReady()).map((m) => (m.data as PushEvent).kind)).toEqual([
      "value",
      "ready",
    ]);
    await stale.cancel();
  });

  it("never sends one server's queue to a stream of another", async () => {
    const w = make();
    const app = createApp(w.state, { responseCheck: "strict" });
    const a = new SseReader(await app.request("/api/public/stream?topics=songs~spaceA"));
    await a.untilReady();
    w.songs.gB = ["Bravo", "Charlie"];
    w.bus.emit("queue.changed");
    await hubOf(w.state).flush();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await hubOf(w.state).flush();
    w.songs.gA = ["Alpha", "Delta"];
    w.bus.emit("queue.changed");
    await new Promise((resolve) => setTimeout(resolve, 200));
    await hubOf(w.state).flush();
    // The first change was B's: A's stream gets nothing until A's own.
    const next = await a.next();
    expect(next?.data).toMatchObject({
      topic: "songs",
      param: "spaceA",
      data: { upcoming: [{ title: "Alpha" }, { title: "Delta" }] },
    });
    await a.cancel();
  });

  it("checks a member's server the way the polled route does, and keeps each member's own", async () => {
    const w = make();
    const app = createApp(w.state, { responseCheck: "strict" });
    // Alice is a member of A only: B is refused with the route's own 403.
    const alice = new SseReader(
      await app.request("/api/member/stream?topics=rooms~spaceA,rooms~spaceB,danmaku", {
        headers: cookie("alice"),
      }),
    );
    expect(alice.done).toBe(false);
    const first = (await alice.untilReady()).map((m) => m.data);
    expect(first).toEqual([
      {
        kind: "value",
        topic: "rooms",
        param: "spaceA",
        data: expect.objectContaining({ available: false, balance: 50 }),
      },
      {
        kind: "refused",
        topic: "rooms",
        param: "spaceB",
        status: 403,
        message: "你不在這個伺服器裡",
      },
      {
        kind: "value",
        topic: "danmaku",
        param: null,
        data: expect.objectContaining({ sent_today: 1 }),
      },
      { kind: "ready" },
    ]);
    const polled = await app.request("/api/member/karaoke/rooms?space=spaceB", {
      headers: cookie("alice"),
    });
    expect(polled.status).toBe(403);

    const bob = new SseReader(
      await app.request("/api/member/stream?topics=rooms~spaceB", { headers: cookie("bob") }),
    );
    expect((await bob.untilReady())[0]?.data).toMatchObject({
      topic: "rooms",
      data: { balance: 7 },
    });

    // A room opens up in B: Bob hears of it, Alice does not.
    w.rooms.spaceB = true;
    w.bus.emit("activity.changed");
    await new Promise((resolve) => setTimeout(resolve, 200));
    await hubOf(w.state).flush();
    expect((await bob.next())?.data).toMatchObject({
      topic: "rooms",
      param: "spaceB",
      data: { available: true },
    });
    w.rooms.spaceA = true;
    w.bus.emit("activity.changed");
    await new Promise((resolve) => setTimeout(resolve, 200));
    await hubOf(w.state).flush();
    expect((await alice.next())?.data).toMatchObject({
      topic: "rooms",
      param: "spaceA",
      data: { available: true },
    });
    await alice.cancel();
    await bob.cancel();
  });

  it("refuses a member stream without a session, and a member topic on the public one", async () => {
    const w = make();
    const app = createApp(w.state, { responseCheck: "strict" });
    expect((await app.request("/api/member/stream?topics=danmaku")).status).toBe(401);
    expect((await app.request("/api/public/stream?topics=danmaku")).status).toBe(400);
    expect((await app.request("/api/public/stream")).status).toBe(400);
  });

  it("ends a member's stream once their session has ended", async () => {
    const w = make();
    const app = createApp(w.state, { responseCheck: "strict" });
    const sse = new SseReader(
      await app.request("/api/member/stream?topics=danmaku", { headers: cookie("alice") }),
    );
    await sse.untilReady();
    w.sessions.delete("alice");
    w.clock.t += RECHECK_MS;
    await hubOf(w.state).sweep();
    expect(await sse.next()).toBeNull();
    // Reconnecting is refused as at any connect.
    expect(
      (await app.request("/api/member/stream?topics=danmaku", { headers: cookie("alice") })).status,
    ).toBe(401);
  });

  it("limits the streams one client holds open", async () => {
    const w = make();
    const app = createApp(w.state, { responseCheck: "strict" });
    const open: SseReader[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await app.request("/api/public/stream?topics=status");
      expect(res.status).toBe(200);
      const sse = new SseReader(res);
      await sse.untilReady();
      open.push(sse);
    }
    const seventh = await app.request("/api/public/stream?topics=status");
    expect(seventh.status).toBe(429);
    await open[0]?.cancel();
    await settle();
    const again = await app.request("/api/public/stream?topics=status");
    expect(again.status).toBe(200);
    await again.body?.cancel();
    for (const sse of open.slice(1)) await sse.cancel();
  });

  it("pings every 15 s while nothing changes, as an event the client can see", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const w = make();
    const app = createApp(w.state, { responseCheck: "strict" });
    const sse = new SseReader(await app.request("/api/public/stream?topics=status"));
    await sse.untilReady();
    // Well under a tunnel's idle timeout (100 s): something by 15 s, every 15 s.
    for (let i = 0; i < 3; i++) {
      const next = sse.next().then((m) => m?.data);
      await vi.advanceTimersByTimeAsync(14_999);
      await settle();
      expect(await Promise.race([next, Promise.resolve("none")])).toBe("none");
      await vi.advanceTimersByTimeAsync(1);
      expect(await next).toEqual({ kind: "ping" });
    }
    // A ping is no change: it carries no id, so a resume still starts from the last one.
    await sse.cancel();
  });

  it("serves the push streams on the public listener and keeps the admin stream off it", async () => {
    const w = make();
    const pub = createApp(w.state, { side: "public", responseCheck: "strict" });
    const res = await pub.request("/api/public/stream?topics=status");
    expect(res.status).toBe(200);
    await res.body?.cancel();
    const admin = await pub.request("/api/events", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(admin.status).toBe(404);
    // The one listener of an install without `public_bind` has both.
    const one = createApp(w.state, { responseCheck: "strict" });
    const events = await one.request("/api/events", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(events.status).toBe(200);
    await events.body?.cancel();
  });

  it("finds the exchange's new quotes on its tick, and refuses a ticker nobody looked up", async () => {
    const w = make();
    const app = createApp(w.state, { responseCheck: "strict" });
    const sse = new SseReader(
      await app.request(
        "/api/member/stream?topics=exchange_list~tw,exchange_ticker~2330.TW,exchange_ticker~NOPE,exchange_list~bogus",
        {
          headers: cookie("alice"),
        },
      ),
    );
    const first = (await sse.untilReady()).map((m) => m.data as PushEvent);
    expect(
      first.map((e) =>
        e.kind === "ready" || e.kind === "ping" ? e.kind : `${e.kind}:${e.topic}~${e.param}`,
      ),
    ).toEqual([
      "value:exchange_list~tw",
      "value:exchange_ticker~2330.TW",
      "refused:exchange_ticker~NOPE",
      "refused:exchange_list~bogus",
      "ready",
    ]);
    expect(first[2]).toMatchObject({ status: 404 });
    expect(first[3]).toMatchObject({ status: 400 });
    // Building the ticker counts as her viewing it, as each poll did.
    expect(w.views).toContain("p-1:2330.TW");

    // A pass fetched a new price; no event says so: the tick finds it.
    w.prices["2330.TW"] = 1010;
    w.clock.t += 10_000;
    await hubOf(w.state).sweep();
    const changes = [await sse.next(), await sse.next()].map((m) => m?.data as PushEvent);
    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          topic: "exchange_list",
          data: expect.objectContaining({ rows: [expect.objectContaining({ price: 1010 })] }),
        }),
        expect.objectContaining({
          topic: "exchange_ticker",
          data: expect.objectContaining({ line: expect.objectContaining({ price: 1010 }) }),
        }),
      ]),
    );
    await sse.cancel();
  });

  it("ends the admin event stream when the admin session ends", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const w = make();
    const app = createApp(w.state, { responseCheck: "strict" });
    const res = await app.request("/api/events", { headers: cookie("owner") });
    expect(res.status).toBe(200);
    const sse = new SseReader(res);
    const ended = sse.next();
    w.sessions.delete("owner");
    await vi.advanceTimersByTimeAsync(RECHECK_MS);
    vi.useRealTimers();
    expect(await ended).toBeNull();
  });
});
