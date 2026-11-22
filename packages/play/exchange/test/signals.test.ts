// Her real things as the local stocks' signal: each source's counting rule on a real event log
// (SQLite in memory) with the Taipei day boundary, the baseline (no history, all zeros, an
// outlier), each company's direction, a missing source, the lag (today's events never reach
// today's open), and the plain line. Every number and row here is made up; no names.

import { openTestDb, type TestDb } from "@miyoria/store/testing";
import { type JsonValue, newId, toTimestamp } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { exchangeConfig, localCompaniesOf } from "../src/config.js";
import {
  LOCAL_ROLES,
  LocalProvider,
  type LocalRole,
  nextPrice,
  signalMove,
  taipeiDay,
  taipeiDayWindow,
} from "../src/real/local.js";
import {
  baselineOf,
  type CountSource,
  type DayCount,
  LocalSignalBook,
  mappingOf,
  readSignal,
} from "../src/real/signals.js";
import { eventLogSources } from "../src/real/sources.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Monday 2026-11-23 12:00 Taipei: today's first tick. */
const NOON = Date.UTC(2026, 10, 23, 4, 0);
const TODAY = taipeiDay(NOON);
const Y = TODAY - 1;
const { start: Y0, end: Y1 } = taipeiDayWindow(Y);
const config = exchangeConfig();
const COMPANIES = localCompaniesOf(config);
const RICE = COMPANIES.find((c) => c.code === "RICE") as (typeof COMPANIES)[number];

const dbs: TestDb[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

function log() {
  const t = openTestDb();
  dbs.push(t);
  const events = t.events;
  const add = (type: string, at: number, data: JsonValue, source = "test") =>
    events.append([{ draft: { id: newId(), type, at: toTimestamp(at), data }, source }]);
  const sources = (present: Partial<Record<LocalRole, boolean>> = {}) =>
    eventLogSources({
      events: () => events,
      present: {
        feeding: () => present.feeding ?? true,
        songs: () => present.songs ?? true,
        silence: () => present.silence ?? true,
        game: () => present.game ?? true,
        model: () => present.model ?? true,
      },
      slowMs: () => 30_000,
    });
  return { events, add, sources };
}

let n = 0;
const posted = (reason: string, delta: number, ref: string | null, person = "p1") => ({
  entry_id: `e${++n}`,
  person_id: person,
  delta,
  reason,
  ref,
  idem_key: null,
  balance: 100,
});
const observed = (topic: string, data: JsonValue) => ({
  observation: { summary: "x" },
  origin: { module: "m", topic, event: { type: topic, v: 1, data }, turn: null },
});
const call = (status: "ok" | "error" | "aborted", duration: number | null) => ({
  call_id: `c${++n}`,
  log_day: null,
  requested_at: toTimestamp(Y0),
  purpose: "chat",
  chain: "chat",
  kind: "chat",
  module: null,
  label: null,
  model: "p:m",
  provider: "p",
  status,
  error_kind: status === "error" ? "timeout" : null,
  finish_reason: null,
  reasoning: "off",
  usage: null,
  cost_usd: null,
  duration_ms: duration,
  first_token_ms: null,
  fallbacks: [],
  retries: 0,
  tools: [],
});

/** The log has a row from long ago: the days since are whole on record. */
const OLD = Y0 - 30 * DAY;

describe("the sources over the event log", () => {
  it("feeding (RICE) counts bowls and food gifts of the Taipei day, refunds, objects and her purse out", async () => {
    const { add, sources } = log();
    add("economy.posted", OLD, posted("checkin", 10, null));
    add("economy.posted", Y0, posted("feed", -30, "rice:3"));
    add("economy.posted", Y0 + 5 * HOUR, posted("gift", -60, "g1:90:珍奶"));
    // A thing that is not food takes no hunger.
    add("economy.posted", Y0 + 6 * HOUR, posted("gift", -500, "g2:0:電吉他"));
    // Refused the next morning: the refund names the charge.
    const refused = posted("gift", -40, "g3:60:蛋糕");
    add("economy.posted", Y0 + 7 * HOUR, refused);
    add("economy.posted", Y1 + 2 * HOUR, posted("refund", 40, refused.entry_id));
    add("economy.posted", Y0 + 8 * HOUR, posted("feed", -40, "big_bowl:1", "self"));
    add("economy.posted", Y0 + 9 * HOUR, posted("checkin", 10, null));
    // The last moment of the day counts; the first of the next does not.
    add("economy.posted", Y1 - 1, posted("feed", -10, "rice:1"));
    add("economy.posted", Y1, posted("feed", -50, "rice:5"));
    const rice = sources().feeding as CountSource;
    expect(await rice.count(Y, NOON)).toEqual({ value: 5, parts: { feeds: 5 } });
  });

  it("songs (WHLE) counts songs sung to the end, not stopped, failed or started ones", async () => {
    const { add, sources } = log();
    add("economy.posted", OLD, posted("checkin", 10, null));
    const song = (at: number, data: JsonValue) =>
      add("facts.observation.ambient", at, observed("sing.cue", data), "sing");
    song(Y0 + HOUR, { state: "started", song: "a", title: "A" });
    song(Y0 + 2 * HOUR, { state: "ended", song: "a", outcome: "finished" });
    song(Y0 + 3 * HOUR, { state: "ended", song: "b", outcome: "interrupted" });
    song(Y0 + 4 * HOUR, { state: "ended", song: "c", outcome: "error" });
    song(Y1 - HOUR, { state: "ended", song: "d", outcome: "finished" });
    song(Y1 + HOUR, { state: "ended", song: "e", outcome: "finished" });
    // Another source's ambient row with the same shape does not count.
    add(
      "facts.observation.ambient",
      Y0 + HOUR,
      observed("sing.cue", { state: "ended", outcome: "finished" }),
      "x",
    );
    const whle = sources().songs as CountSource;
    expect(await whle.count(Y, NOON)).toEqual({ value: 2, parts: { songs: 2 } });
    // Ambient rows are folded after 14 days: an older day is not whole on record.
    expect(await whle.count(Y - 12, NOON)).toEqual({ value: 0, parts: { songs: 0 } });
    expect(await whle.count(Y - 13, NOON)).toBeNull();
  });

  it("silence (NAPS) counts the Taipei hours with no line of hers delivered and no failed model call", async () => {
    const { add, sources } = log();
    add("economy.posted", OLD, posted("checkin", 10, null));
    add("facts.delivered", Y0 + 30 * 60_000, { channel: "text" }, "delivery.text");
    add("facts.delivered", Y0 + 13 * HOUR, { channel: "voice" }, "delivery.voice");
    add("facts.delivered", Y0 + 13 * HOUR + 59 * 60_000, { channel: "text" }, "delivery.text");
    // Making her model fail never makes her look quiet: that hour is not silent.
    add("llm.call", Y0 + 5 * HOUR, call("error", 1000), "llm");
    add("llm.call", Y0 + 6 * HOUR, call("ok", 1000), "llm");
    // The next day's lines are not this day's.
    add("facts.delivered", Y1 + 10, { channel: "text" }, "delivery.text");
    const naps = sources().silence as CountSource;
    expect(await naps.count(Y, NOON)).toEqual({ value: 21, parts: { hours: 21 } });
  });

  it("game (CUBE) is goals reached less deaths; no game played is a neutral zero", async () => {
    const { add, sources } = log();
    add("economy.posted", OLD, posted("checkin", 10, null));
    const cube = sources().game as CountSource;
    expect(await cube.count(Y, NOON)).toEqual({ value: 0, parts: { goals: 0, deaths: 0 } });
    add(
      "facts.observation",
      Y0 + HOUR,
      observed("game.director.goal", { status: "done" }),
      "game.director",
    );
    add(
      "facts.observation",
      Y0 + 2 * HOUR,
      observed("game.director.goal", { status: "failed" }),
      "game.director",
    );
    add(
      "facts.observation",
      Y0 + 3 * HOUR,
      observed("game.minecraft.event", { type: "death" }),
      "game.minecraft",
    );
    add("facts.observation", Y0 + 4 * HOUR, observed("game.minecraft.death", {}), "game.minecraft");
    add(
      "facts.observation",
      Y0 + 5 * HOUR,
      observed("game.minecraft.event", { type: "low_health" }),
      "game.minecraft",
    );
    expect(await cube.count(Y, NOON)).toEqual({ value: -1, parts: { goals: 1, deaths: 2 } });
  });

  it("model (DPSK) counts failed calls and slow answers, not cancelled ones", async () => {
    const { add, sources } = log();
    add("economy.posted", OLD, posted("checkin", 10, null));
    add("llm.call", Y0 + HOUR, call("error", 500), "llm");
    add("llm.call", Y0 + 2 * HOUR, call("error", null), "llm");
    add("llm.call", Y0 + 3 * HOUR, call("ok", 45_000), "llm");
    add("llm.call", Y0 + 4 * HOUR, call("ok", 30_000), "llm");
    add("llm.call", Y0 + 5 * HOUR, call("aborted", 90_000), "llm");
    const dpsk = sources().model as CountSource;
    expect(await dpsk.count(Y, NOON)).toEqual({ value: 3, parts: { errors: 2, slow: 1 } });
  });

  it("count only whole days: not today, not before the log began", async () => {
    const { add, sources } = log();
    // A new instance: the log began during yesterday.
    add("economy.posted", Y0 + HOUR, posted("feed", -10, "rice:1"));
    const rice = sources().feeding as CountSource;
    expect(await rice.count(Y, NOON)).toBeNull();
    expect(await rice.count(TODAY, NOON)).toBeNull();
    expect(await rice.count(TODAY, NOON + DAY)).toEqual({ value: 0, parts: { feeds: 0 } });
  });

  it("are missing when their module is off or there is no log", () => {
    const { sources } = log();
    expect(sources({ game: false }).game?.missing()).toBe("game 沒有開");
    expect(sources().feeding?.missing()).toBeNull();
    const none = eventLogSources({
      events: () => null,
      present: {
        feeding: () => true,
        songs: () => true,
        silence: () => true,
        game: () => true,
        model: () => true,
      },
      slowMs: () => 1,
    });
    expect(none.feeding?.missing()).toBe("沒有事件紀錄");
  });
});

describe("the mapping", () => {
  const rice = mappingOf(config, "feeding");

  it("needs history: none, or fewer days than min_history_days, is no signal", () => {
    expect(readSignal(50, [], rice)).toBeNull();
    expect(readSignal(50, [10, 10, 10, 10, 10, 10], rice)).toBeNull();
    expect(readSignal(50, [10, 10, 10, 10, 10, 10, 10], rice)).not.toBeNull();
  });

  it("is neutral on days of zeros, and an outlier in the window moves neither median nor spread much", () => {
    const zeros = Array(14).fill(0);
    expect(readSignal(0, zeros, rice)?.signal).toBe(0);
    for (const code of LOCAL_ROLES)
      expect(readSignal(0, zeros, mappingOf(config, code))?.signal).toBe(0);
    const usual = [10, 12, 9, 11, 10, 13, 8, 10, 11, 9, 12, 10, 11, 10];
    const outlier = [...usual.slice(0, 13), 500];
    expect(Math.abs(baselineOf(outlier).median - baselineOf(usual).median)).toBeLessThanOrEqual(
      0.5,
    );
    expect(baselineOf(outlier).spread).toBeLessThan(baselineOf(usual).spread * 1.5);
    const a = readSignal(16, outlier, rice)?.signal ?? 0;
    const b = readSignal(16, usual, rice)?.signal ?? 0;
    expect(Math.abs(a - b)).toBeLessThan(0.1);
  });

  it("has a floor: a full signal needs at least `floor` more than usual", () => {
    const usual = Array(14).fill(10);
    expect(readSignal(15, usual, rice)?.signal).toBeCloseTo(0.5, 9);
    expect(readSignal(20, usual, rice)?.signal).toBe(1);
    expect(readSignal(500, usual, rice)?.signal).toBe(1);
    expect(readSignal(0, usual, rice)?.signal).toBe(-1);
  });

  it("points each company its own way, and the model stock never up", () => {
    const usual = Array(14).fill(10);
    for (const code of ["feeding", "songs", "silence", "game"] as const) {
      expect(readSignal(100, usual, mappingOf(config, code))?.signal).toBe(1);
      expect(readSignal(0, usual, mappingOf(config, code))?.signal).toBe(-1);
    }
    const dpsk = mappingOf(config, "model");
    expect(readSignal(100, usual, dpsk)?.signal).toBeCloseTo(-0.6, 9);
    expect(readSignal(0, usual, dpsk)?.signal).toBe(0);
    // Even when the owner sets it: up stays 0, and the fall stays under a round trip's fees.
    const loose = exchangeConfig({
      local_signals: { ...config.local_signals, model: { floor: 1, up: 1, down: 1 } },
    });
    expect(mappingOf(loose, "model").up).toBe(0);
    expect(mappingOf(loose, "model").down).toBeCloseTo(0.6, 9);
    // The first character's codes are still read as their roles' tables.
    const legacy = exchangeConfig({
      local_signals: { ...config.local_signals, RICE: { floor: 4, up: 0.5, down: 1 } },
    });
    expect(mappingOf(legacy, "feeding")).toMatchObject({ floor: 4, up: 0.5 });
    expect(mappingOf(legacy, "songs").floor).toBe(3);
  });
});

/** A source of fixed counts by day; records the days it was asked. */
function fixed(counts: Record<number, number>, parts: (v: number) => Record<string, number>) {
  const asked: number[] = [];
  const source: CountSource = {
    label: "test",
    missing: () => null,
    count: async (day): Promise<DayCount | null> => {
      asked.push(day);
      const v = counts[day];
      return v === undefined ? null : { value: v, parts: parts(v) };
    },
  };
  return { source, asked };
}

const history = (x: number, today: Record<number, number> = {}) => {
  const out: Record<number, number> = { ...today };
  for (let d = Y - 14; d < Y; d++) out[d] = 10;
  out[Y] = x;
  return out;
};

describe("the book", () => {
  it("prices today's open from yesterday only: today's events never reach it", async () => {
    // Today's count so far is huge; yesterday's is usual.
    const feeds = fixed(history(10, { [TODAY]: 9999 }), (v) => ({ feeds: v }));
    const book = new LocalSignalBook({ sources: { feeding: feeds.source }, config: () => config });
    const stored = { price: 100, at: NOON - 13 * HOUR, prev_close: 100 };
    const provider = new LocalProvider(
      "s",
      (c, d) => book.signal(c, d),
      () => COMPANIES,
      () => stored,
      (days, now) => book.prepare(days, now),
    );
    const q = await provider.quotes(["RICE"], NOON + 30 * 60_000);
    expect(feeds.asked).not.toContain(TODAY);
    expect(Math.max(...feeds.asked)).toBe(Y);
    const neutral = nextPrice(
      "s",
      RICE,
      NOON,
      { price: 100, at: stored.at, close: 100 },
      () => null,
      100,
    );
    expect(q.get("RICE")?.price).toBe(neutral.price);

    // A big yesterday moves today's open by the gap, at the first tick only.
    const big = fixed(history(20), (v) => ({ feeds: v }));
    const book2 = new LocalSignalBook({ sources: { feeding: big.source }, config: () => config });
    const p2 = new LocalProvider(
      "s",
      (c, d) => book2.signal(c, d),
      () => COMPANIES,
      () => stored,
      (days, now) => book2.prepare(days, now),
    );
    const open = (await p2.quotes(["RICE"], NOON)).get("RICE")?.price ?? 0;
    const pushed = nextPrice(
      "s",
      RICE,
      NOON,
      { price: 100, at: stored.at, close: 100 },
      () => ({ signal: 1 }),
      100,
    );
    expect(open).toBe(pushed.price);
    expect(book2.fact("feeding", NOON)?.move).toBe(signalMove({ signal: 1 }));
  });

  it("is neutral for a missing source and says so in one plain line", async () => {
    const book = new LocalSignalBook({ sources: {}, config: () => config });
    await book.prepare([Y], NOON);
    expect(book.signal("feeding", Y)).toBeNull();
    expect(book.missing("feeding")).toBe("沒有來源");
    expect(book.line("feeding", NOON)).toBe("昨天沒有她的紀錄 → 今天開盤 +0.0%");
    const off: CountSource = {
      label: "off",
      missing: () => "economy 沒有開",
      count: async () => ({ value: 99, parts: {} }),
    };
    const book2 = new LocalSignalBook({ sources: { feeding: off }, config: () => config });
    await book2.prepare([Y], NOON);
    expect(book2.signal("feeding", Y)).toBeNull();
  });

  it("writes the card's line from the numbers, for each company", async () => {
    const sources = {
      feeding: fixed(history(16), (v) => ({ feeds: v })).source,
      songs: fixed(history(8), (v) => ({ songs: v })).source,
      silence: fixed(history(10), (v) => ({ hours: v })).source,
      game: fixed(
        { ...Object.fromEntries(Array.from({ length: 15 }, (_, i) => [Y - 14 + i, 0])) },
        () => ({ goals: 0, deaths: 0 }),
      ).source,
      model: fixed(history(40), (v) => ({ errors: v - 5, slow: 5 })).source,
    };
    const book = new LocalSignalBook({ sources, config: () => config });
    await book.prepare([Y], NOON);
    expect(book.line("feeding", NOON)).toBe("昨天她被餵了 16 次,比平常多 → 今天開盤 +1.8%");
    expect(book.line("songs", NOON)).toBe("昨天她唱完 8 首歌,比平常少 → 今天開盤 -1.2%");
    expect(book.line("silence", NOON)).toBe(
      "昨天她有 10 個小時沒說話,跟平常差不多 → 今天開盤 +0.0%",
    );
    expect(book.line("game", NOON)).toBe(
      "昨天她在遊戲裡達成 0 個目標、死了 0 次,跟平常差不多 → 今天開盤 +0.0%",
    );
    expect(book.line("model", NOON)).toBe(
      "昨天她的模型出錯 35 次、太慢 5 次,比平常多 → 今天開盤 -1.8%",
    );
    // The same facts, told to her about her own companies.
    const codeOf = (role: LocalRole) => COMPANIES.find((c) => c.role === role)?.code ?? role;
    const note =
      book.herNote((role) => ({ code: codeOf(role), name: `公司${codeOf(role)}` }), NOON) ?? "";
    expect(note).toContain("公司RICE(RICE):昨天你被餵了 16 次,比平常多 → 今天開盤 +1.8%");
    expect(note.split(";")).toHaveLength(5);
  });

  it("says when there is not enough history yet", async () => {
    const book = new LocalSignalBook({
      sources: { feeding: fixed({ [Y]: 3, [Y - 1]: 2 }, (v) => ({ feeds: v })).source },
      config: () => config,
    });
    await book.prepare([Y], NOON);
    expect(book.signal("feeding", Y)).toBeNull();
    expect(book.line("feeding", NOON)).toBe(
      "昨天她被餵了 3 次,她平常的樣子還不到 7 天的紀錄 → 今天開盤 +0.0%",
    );
  });
});
