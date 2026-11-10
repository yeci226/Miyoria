import { describe, expect, it } from "vitest";
import type { Delivery, LogEvent } from "@/api/types";
import type { EvalData, Loaded } from "./eval-data";
import { bootTimes } from "./eval-data";
import { floorMix, meets, metricOf, read, repeats, trend, unansweredRuns } from "./metrics";

const T0 = Date.parse("2026-11-07T10:00:00.000Z");
const iso = (secs: number) => new Date(T0 + secs * 1000).toISOString();
const VOICE = { platform: "discord", scope: "g", channel: "v", kind: "voice" as const };
const TEXT = { platform: "discord", scope: "g", channel: "t", kind: "channel" as const };

const ev = (id: string, secs: number, kind: LogEvent["kind"], source: string, body: unknown, context: LogEvent["context"] = VOICE): LogEvent => ({
  id,
  at: iso(secs),
  kind,
  source,
  cause: null,
  context,
  person: null,
  body,
});

const focus = (id: string, secs: number, turn: string, reason: string) => ev(id, secs, "decision", "agent.focus", { turn, reason });
const utterance = (id: string, secs: number, turn: string, channel = "voice") => ev(id, secs, "utterance", "delivery.voice", { turn, channel, said: "x" });
const delivery = (line: string, secs: number, over: Partial<Delivery> = {}): Delivery => ({
  attention_key: `k:${line}`,
  revision: 1,
  channel: "voice",
  context: VOICE,
  said: "x",
  delivered_at: iso(secs),
  audience: [],
  answered_by: [],
  line,
  ...over,
});

const loaded = <T,>(items: T[], from = T0): Loaded<T> => ({ items, from });
const NOW = T0 + 3_600_000;

function data(over: Partial<EvalData> = {}): EvalData {
  return {
    now: NOW,
    since: T0,
    focus: loaded([]),
    floor: loaded([]),
    utterances: loaded([]),
    latency: loaded([]),
    commitments: loaded([]),
    deliveries: loaded([]),
    boots: [],
    ...over,
  };
}

describe("addressed and reply rates", () => {
  it("counts a voice turn as answered only when a line of it was delivered", () => {
    const d = data({
      focus: loaded([focus("f1", 10, "t1", "addressed"), focus("f2", 20, "t2", "addressed"), focus("f3", 30, "t3", "addressed"), focus("f1b", 11, "t1", "addressed")]),
      utterances: loaded([utterance("u1", 12, "t1"), utterance("u2", 22, "t2")]),
      // t2's line never arrived; t3 never opened one.
      deliveries: loaded([delivery("u1", 13)]),
    });
    const r = read("addressed", d, T0, NOW);
    expect(r).toMatchObject({ value: 1 / 3, n: 3, hit: 1 });
  });

  it("keeps the reasons apart and ignores text channels", () => {
    const d = data({
      focus: loaded([
        focus("f1", 10, "t1", "addressed"),
        focus("f2", 20, "t2", "reply_to_her"),
        focus("f3", 30, "t3", "reply_to_her"),
        { ...focus("f4", 40, "t4", "reply_to_her"), context: TEXT },
      ]),
      utterances: loaded([utterance("u2", 21, "t2"), utterance("u3", 31, "t3", "text")]),
      deliveries: loaded([delivery("u2", 22), delivery("u3", 32)]),
    });
    expect(read("reply", d, T0, NOW)).toMatchObject({ value: 0.5, n: 2, hit: 1 });
    expect(read("addressed", d, T0, NOW)).toMatchObject({ value: 0, n: 1 });
  });

  it("says nothing was measured instead of reporting zero", () => {
    expect(read("addressed", data(), T0, NOW)).toMatchObject({ value: null, n: 0 });
  });

  it("starts where the sources reach back, not where it was asked", () => {
    const d = data({
      focus: loaded([focus("f1", 10, "t1", "addressed"), focus("f2", 2000, "t2", "addressed")]),
      utterances: loaded([utterance("u2", 2001, "t2")]),
      deliveries: loaded([delivery("u2", 2002)], T0 + 1000_000),
    });
    const r = read("addressed", d, T0, NOW);
    expect(r.from).toBe(T0 + 1000_000);
    expect(r).toMatchObject({ value: 1, n: 1 });
  });
});

describe("latency", () => {
  const rec = (id: string, secs: number, total: number | null, complete = true, kind: "voice" | "channel" = "voice") =>
    ev(id, secs, "result", "voice.latency", { turn: `t${id}`, e2e: { context: { ...VOICE, kind }, utterance: "u", complete, reason: null, total_ms: total, segments: {}, unattributed_ms: null, prefetched: false, provider: null } });

  it("takes the median of complete voice replies", () => {
    const d = data({ latency: loaded([rec("a", 10, 1000), rec("b", 20, 3000), rec("c", 30, 5000), rec("d", 40, null, false), rec("e", 50, 100, true, "channel")]) });
    expect(read("latency", d, T0, NOW)).toMatchObject({ value: 3000, n: 3 });
  });

  it("buckets a trend and leaves empty buckets null", () => {
    const d = data({ latency: loaded([rec("a", 10, 1000), rec("b", 3700, 2000)]) });
    const end = T0 + 7_200_000;
    const points = trend("latency", d, T0, end, 3_600_000);
    expect(points.map((p) => p.value)).toEqual([1000, 2000]);
    expect(trend("latency", data(), T0, end, 3_600_000).map((p) => p.value)).toEqual([null, null]);
  });
});

describe("repeat rate", () => {
  it("is a key delivered again at the same or an older revision", () => {
    const ds = [
      delivery("a", 1, { attention_key: "k", revision: 1 }),
      delivery("b", 2, { attention_key: "k", revision: 2 }),
      delivery("c", 3, { attention_key: "k", revision: 2 }),
      delivery("d", 4, { attention_key: "other", revision: 1 }),
    ];
    expect(repeats(ds)).toEqual([false, false, true, false]);
    expect(read("repeat", data({ deliveries: loaded(ds) }), T0, NOW)).toMatchObject({ value: 0.25, n: 4, hit: 1 });
  });
});

describe("lines nobody answered", () => {
  it("runs per place, restarts after an answered line and skips the newest", () => {
    const ds = [
      delivery("a", 10),
      delivery("b", 20),
      delivery("c", 30, { answered_by: ["h"] }),
      delivery("d", 40),
      delivery("e", 50, { context: TEXT }),
      delivery("f", 3590),
    ];
    const runs = unansweredRuns(ds, NOW).map((r) => r.run);
    expect(runs).toEqual([1, 2, 0, 1, 1]);
    expect(read("monologue", data({ deliveries: loaded(ds) }), T0, NOW)).toMatchObject({ value: 2, n: 5 });
  });
});

describe("broken promises", () => {
  const promise = (id: string, status: string, secs: number) =>
    ev(`${id}${status}`, secs, "decision", "mainline.commitment", { commitment: { id, status, made_at: iso(0), due: iso(60), context: VOICE } });

  it("takes each promise at its last state", () => {
    const d = data({ commitments: loaded([promise("p1", "open", 1), promise("p1", "kept", 5), promise("p2", "open", 2), promise("p2", "broken", 3000), promise("p3", "open", 3)]) });
    expect(read("broken", d, T0, NOW)).toMatchObject({ value: 1, n: 3 });
  });
});

describe("floor mix", () => {
  it("counts a turn once and lists the claims in the order of the floor", () => {
    const d = data({
      floor: loaded([
        ev("1", 1, "decision", "floor", { floor_turn: "a", kind: "wish" }),
        ev("2", 2, "decision", "floor", { floor_turn: "a", kind: "wish" }),
        ev("3", 3, "decision", "floor", { floor_turn: "b", kind: "addressed" }),
      ]),
    });
    expect(floorMix(d, T0, NOW)).toEqual([
      { kind: "addressed", count: 1 },
      { kind: "wish", count: 1 },
    ]);
  });
});

describe("targets and boots", () => {
  it("applies strict and inclusive targets as §18.1 writes them", () => {
    expect(meets(metricOf("addressed"), 0.95)).toBe(false);
    expect(meets(metricOf("addressed"), 0.96)).toBe(true);
    expect(meets(metricOf("latency"), 2500)).toBe(true);
    expect(meets(metricOf("repeat"), 0.03)).toBe(false);
    expect(meets(metricOf("broken"), 0)).toBe(true);
  });

  it("finds the starts of the Core in the lifecycle lines", () => {
    const boot = (id: string, secs: number, key: string) => ev(id, secs, "observation", "core.lifecycle", { observation: { attention_key: key } }, null);
    expect(bootTimes([boot("b", 600, "system:boot"), boot("a", 100, "system:boot"), boot("s", 300, "system:shutdown")])).toEqual([T0 + 100_000, T0 + 600_000]);
  });
});
