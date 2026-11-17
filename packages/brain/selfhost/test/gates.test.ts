import type { ContextKey } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { arbiterConfig } from "../../arbiter/src/index.js";
import {
  GateBook,
  type GateConfig,
  type GateFacts,
  keyOf,
  type Opportunity,
  type OpportunityKind,
} from "../src/index.js";
import { gateConfig, initiativeSettings } from "../src/initiative-config.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
/** 2026-11-17 14:00 at UTC+8: outside the default quiet hours (01:00-07:00). */
const T0 = Date.UTC(2026, 10, 17, 6, 0, 0);
const CLOCK = arbiterConfig();
const C1: ContextKey = { platform: "test", scope: "g", channel: "c1", kind: "channel" };
const C2: ContextKey = { platform: "test", scope: "g", channel: "c2", kind: "channel" };
const DM: ContextKey = { platform: "test", scope: null, channel: "dm-owen", kind: "dm" };

function config(overrides: Partial<GateConfig> = {}): GateConfig {
  return { ...gateConfig(initiativeSettings(), CLOCK), ...overrides };
}

function facts(now: number, overrides: Partial<GateFacts> = {}): GateFacts {
  return {
    now,
    paused: false,
    budget: "ok",
    level: () => "normal",
    consent: () => null,
    ...overrides,
  };
}

let n = 0;
function opp(
  kind: OpportunityKind,
  place: ContextKey | null = C1,
  extra: Partial<Opportunity> = {},
): Opportunity {
  n += 1;
  return {
    id: `${kind}:${n}`,
    kind,
    place,
    person: null,
    account: null,
    dm: false,
    note: kind,
    item: null,
    ...extra,
  };
}

/** Starts `o` at `at` and checks it passed. */
function start(book: GateBook, o: Opportunity, at: number): void {
  expect(book.check(o, facts(at))).toEqual({ pass: true });
  book.started(o, at);
}

describe("each gate stops what it should, and says which", () => {
  it("no_place: nowhere to wake her", () => {
    const v = new GateBook(config()).check(opp("morning", null), facts(T0));
    expect(v).toMatchObject({ pass: false, gate: "no_place" });
  });

  it("switch: the panel's pause", () => {
    const v = new GateBook(config()).check(opp("timer"), facts(T0, { paused: true }));
    expect(v).toMatchObject({ pass: false, gate: "switch" });
  });

  it("quiet_hours: the Arbiter's, with when they end", () => {
    const night = Date.UTC(2026, 10, 16, 18, 0, 0); // 02:00 local
    const v = new GateBook(config()).check(opp("timer"), facts(night));
    expect(v).toMatchObject({ pass: false, gate: "quiet_hours" });
    if (!v.pass) expect(v.retryAt).toBe(Date.UTC(2026, 10, 16, 23, 0, 0)); // 07:00 local
  });

  it("budget: exhausted stops all; degraded lets only what someone is owed through", () => {
    const book = new GateBook(config());
    expect(book.check(opp("followup"), facts(T0, { budget: "exhausted" }))).toMatchObject({
      gate: "budget",
    });
    expect(book.check(opp("world"), facts(T0, { budget: "degraded" }))).toMatchObject({
      gate: "budget",
    });
    expect(book.check(opp("followup"), facts(T0, { budget: "degraded" }))).toEqual({ pass: true });
  });

  it("consent: a DM to someone who opted out", () => {
    const o = opp("longing", DM, { dm: true, account: { platform: "test", id: "owen" } });
    const book = new GateBook(config());
    expect(book.check(o, facts(T0, { consent: () => "對方不收她的私訊" }))).toMatchObject({
      pass: false,
      gate: "consent",
      detail: "對方不收她的私訊",
    });
    expect(book.check(o, facts(T0))).toEqual({ pass: true });
  });

  it("level: the owner's channel level and the opt-out list", () => {
    const book = new GateBook(config());
    expect(book.check(opp("world"), facts(T0, { level: () => "mention-only" }))).toMatchObject({
      gate: "level",
    });
    const optedOut = new GateBook(config({ disabled: (p) => p.channel === "c1" }));
    expect(optedOut.check(opp("world"), facts(T0))).toMatchObject({ gate: "level" });
  });

  it("daily_cap: her starts today over all places", () => {
    const book = new GateBook(config({ maxPerDay: 2, minGapMs: 0, gapMs: 0 }));
    start(book, opp("timer", C1), T0);
    start(book, opp("timer", C2), T0 + MIN);
    expect(book.check(opp("timer", C1), facts(T0 + 2 * MIN))).toMatchObject({ gate: "daily_cap" });
    // Her next day (from 04:00 local) starts afresh.
    expect(book.check(opp("timer", C1), facts(T0 + 24 * HOUR))).toEqual({ pass: true });
  });

  it("place_cap: her starts today in one place", () => {
    const book = new GateBook(config({ maxPerPlacePerDay: 1, minGapMs: 0, gapMs: 0 }));
    start(book, opp("timer", C1), T0);
    expect(book.check(opp("timer", C1), facts(T0 + MIN))).toMatchObject({ gate: "place_cap" });
    expect(book.check(opp("timer", C2), facts(T0 + MIN))).toEqual({ pass: true });
  });

  it("person_cap: her starts today aimed at one person", () => {
    const book = new GateBook(config({ maxPerPersonPerDay: 1, minGapMs: 0, gapMs: 0 }));
    start(book, opp("timer", C1, { person: "owen" }), T0);
    expect(book.check(opp("timer", C2, { person: "owen" }), facts(T0 + MIN))).toMatchObject({
      gate: "person_cap",
    });
  });

  it("min_gap: between any two of her starts", () => {
    const book = new GateBook(config());
    start(book, opp("timer", C1), T0);
    expect(book.check(opp("timer", C2), facts(T0 + 30_000))).toMatchObject({ gate: "min_gap" });
    expect(book.check(opp("timer", C2), facts(T0 + 61_000))).toEqual({ pass: true });
  });

  it("backoff: the gap between two starts in one place", () => {
    const book = new GateBook(config());
    start(book, opp("timer", C1), T0);
    expect(book.check(opp("timer", C1), facts(T0 + 5 * MIN))).toMatchObject({ gate: "backoff" });
    expect(book.check(opp("timer", C1), facts(T0 + 10 * MIN))).toEqual({ pass: true });
  });

  it("unanswered: max_unanswered starts with nobody speaking", () => {
    const book = new GateBook(config({ gapMs: 0, minGapMs: 0, maxUnanswered: 2 }));
    const place = keyOf(C1);
    for (const at of [T0, T0 + MIN]) {
      start(book, opp("timer", C1), at);
      book.spoke(place, at);
    }
    expect(book.check(opp("timer", C1), facts(T0 + 2 * MIN))).toMatchObject({ gate: "unanswered" });
    book.heard(place, false);
    expect(book.check(opp("timer", C1), facts(T0 + 2 * MIN))).toEqual({ pass: true });
  });

  it("cooldown: between two starts of the same kind", () => {
    const book = new GateBook(config());
    start(book, opp("world", C1), T0);
    start(book, opp("quiet", C2), T0 + 2 * MIN);
    // 20 minutes later: another kind came between, the world one still waits its 30.
    expect(book.check(opp("world", C2), facts(T0 + 20 * MIN))).toMatchObject({ gate: "cooldown" });
    expect(book.check(opp("world", C2), facts(T0 + 31 * MIN))).toEqual({ pass: true });
  });

  it("same_kind: not the same kind twice in a row (her timers are exempt)", () => {
    const book = new GateBook(config({ cooldownMs: {} }));
    start(book, opp("followup", C1), T0);
    expect(book.check(opp("followup", C2), facts(T0 + 2 * MIN))).toMatchObject({
      gate: "same_kind",
    });
    // Another kind in between clears it.
    start(book, opp("timer", C2), T0 + 2 * MIN);
    expect(book.check(opp("followup", C2, {}), facts(T0 + 4 * MIN))).toMatchObject({
      gate: "backoff",
    });
    expect(book.check(opp("followup", C1), facts(T0 + 12 * MIN))).toEqual({ pass: true });
    // Two of her timers in a row are fine.
    const timers = new GateBook(config());
    start(timers, opp("timer", C1), T0);
    expect(timers.check(opp("timer", C2), facts(T0 + 2 * MIN))).toEqual({ pass: true });
  });
});

describe("back-off", () => {
  it("grows when nobody answers and resets when someone does", () => {
    const book = new GateBook(config({ minGapMs: 0, maxPerDay: 0, maxPerPlacePerDay: 0 }));
    const place = keyOf(C1);
    let at = T0;
    const gaps: number[] = [];
    for (let i = 0; i < 5; i++) {
      start(book, opp("timer", C1), at);
      book.spoke(place, at);
      // The reply window (10 min) passes with nobody answering.
      at += 11 * MIN;
      expect(book.settle(at)).toEqual([place]);
      gaps.push(book.gapMs(place, at) / MIN);
      book.heard(place, false); // someone talks there, but not to her
      at += book.gapMs(place, at);
    }
    // 10 min doubled per miss, up to `max_backoff` (8×).
    expect(gaps).toEqual([20, 40, 80, 80, 80]);
    // Someone answers her: back to the base gap.
    start(book, opp("timer", C1), at);
    book.spoke(place, at);
    book.heard(place, true);
    expect(book.settle(at + 11 * MIN)).toEqual([]);
    expect(book.gapMs(place, at + 11 * MIN)).toBe(10 * MIN);
  });

  it("forgets one doubling per day without a new miss", () => {
    const book = new GateBook(config({ minGapMs: 0 }));
    const place = keyOf(C1);
    start(book, opp("timer", C1), T0);
    book.spoke(place, T0);
    book.settle(T0 + 11 * MIN);
    expect(book.misses(place, T0 + 12 * MIN)).toBe(1);
    expect(book.misses(place, T0 + 11 * MIN + 24 * HOUR)).toBe(0);
  });

  it("is kept across a restart", () => {
    const book = new GateBook(config({ minGapMs: 0 }));
    const place = keyOf(C1);
    start(book, opp("timer", C1), T0);
    book.spoke(place, T0);
    book.settle(T0 + 11 * MIN);
    const again = new GateBook(config({ minGapMs: 0 }), book.snapshot());
    expect(again.gapMs(place, T0 + 12 * MIN)).toBe(20 * MIN);
    expect(again.startsToday(T0 + 12 * MIN)).toBe(1);
  });
});
