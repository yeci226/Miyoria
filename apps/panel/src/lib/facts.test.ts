import { describe, expect, it } from "vitest";
import type { LogEvent } from "@/api/types";
import { axisTicks, buildAxis, chainOf, describe as say, isBackground, laneOf } from "./consciousness";
import { turnE2e, turnFacts, ulidTime } from "./turn-events";

const T0 = 1_000_000;
const ev = (id: string, secs: number, kind: LogEvent["kind"], source: string, body: unknown, cause: string | null = null): LogEvent => ({
  id,
  at: new Date(T0 + secs * 1000).toISOString(),
  kind,
  source,
  cause,
  context: null,
  person: null,
  body,
});
const obs = (id: string, secs: number, salience: string, extra: Record<string, unknown> = {}, speech = false) =>
  ev(id, secs, "observation", "s", { observation: { summary: id, salience, attention_key: "k", addressed_to_her: false, ...extra }, speech });

describe("lanes", () => {
  it("puts each kind where she did it", () => {
    expect(laneOf(obs("a", 0, "notable"))).toBe(0);
    expect(laneOf(obs("a", 0, "ambient", { attention_key: "task:1" }))).toBe(3);
    expect(laneOf(ev("a", 0, "decision", "agent", {}))).toBe(1);
    expect(laneOf(ev("a", 0, "directive", "owner", {}))).toBe(1);
    expect(laneOf(ev("a", 0, "delivered", "delivery.voice", {}))).toBe(2);
    expect(laneOf(ev("a", 0, "steer", "agent", {}))).toBe(3);
    expect(laneOf(ev("a", 0, "result", "gate", {}))).toBe(3);
  });

  it("keeps only ambient, unspoken, non-task observations in the background", () => {
    expect(isBackground(obs("a", 0, "ambient"))).toBe(true);
    expect(isBackground(obs("a", 0, "ambient", {}, true))).toBe(false);
    expect(isBackground(obs("a", 0, "ambient", { addressed_to_her: true }))).toBe(false);
    expect(isBackground(obs("a", 0, "ambient", { attention_key: "task:9" }))).toBe(false);
    expect(isBackground(obs("a", 0, "notable"))).toBe(false);
    expect(isBackground(ev("a", 0, "thought", "mind", {}))).toBe(false);
  });
});

describe("describe", () => {
  it("reads the bodies the log writes and falls back to the source", () => {
    expect(say(ev("a", 0, "utterance", "delivery.voice", { said: "你好", channel: "voice" }))).toEqual({ title: "你好", detail: "語音" });
    expect(say(ev("a", 0, "result", "gate", { allowed: false, capability: "game.start", reason: "規則擋下" }))).toEqual({
      title: "被擋下 · game.start",
      detail: "規則擋下",
    });
    expect(say(ev("a", 0, "result", "delivery.voice", { delivery: "interrupted", reason: null })).title).toBe("被打斷");
    expect(say(ev("a", 0, "result", "agent", { turn_outcome: { turn: "T", outcome: { type: "sent", parts: 2 } } })).title).toBe("說了 2 則");
    expect(say(ev("a", 0, "steer", "activity", { phase: "request", owner: "game.minecraft", task: "k", patch: {}, why: "先去找鐵", by: "self" }))).toEqual({
      title: "先去找鐵",
      detail: "已要求",
    });
    expect(say(ev("a", 0, "steer", "game.minecraft", { phase: "outcome", task: "k", steer: "s", outcome: "too_late", detail: "任務已經結束" }))).toEqual({
      title: "任務已經結束",
      detail: "來不及",
    });
    expect(say(ev("a", 0, "steer", "agent", { weird: 1 }))).toEqual({ title: "改方向", detail: null });
    expect(say(ev("a", 0, "thought", "mind", { thought: "想玩遊戲", changes: [], intents: [], error: null }))).toEqual({ title: "想玩遊戲", detail: "mind" });
    expect(say(ev("a", 0, "thought", "mind", { thought: "", changes: [], intents: [], error: "逾時" })).title).toBe("逾時");
    const director = { game: "minecraft", trigger: ["天黑了"], goal: "蓋房子", action: null, verdict: null, busy: false };
    expect(say(ev("a", 0, "thought", "game.director", { ...director, commentary: "要天黑了" })).title).toBe("要天黑了");
    expect(say(ev("a", 0, "thought", "game.director", { ...director, commentary: null })).title).toBe("目標:蓋房子");
    expect(say(ev("a", 0, "thought", "mind", { surprise: 1 })).title).toBe("mind");
    const e2e = { complete: true, total_ms: 1500, segments: {} };
    expect(say(ev("a", 0, "result", "voice.latency", { turn: "T", e2e })).title).toBe("語音延遲 1.50 s");
  });
});

describe("buildAxis", () => {
  it("drops what is outside the window and ambient noise, links causes on the axis", () => {
    const a = obs("a", 5, "notable");
    const b = ev("b", 8, "decision", "agent", {}, "a");
    const c = ev("c", 9, "action", "gate", {}, "gone");
    const noise = obs("n", 6, "ambient");
    const old = obs("o", -500, "notable");
    const m = buildAxis([c, noise, b, old, a], T0, T0 + 20_000);
    expect(m.nodes.map((n) => n.event.id)).toEqual(["a", "b", "c"]);
    expect(m.links).toEqual([{ from: "a", to: "b" }]);
    expect(m.hidden).toBe(1);
  });

  it("keeps a background observation that is on the chain", () => {
    const n = obs("n", 6, "ambient");
    expect(buildAxis([n], T0, T0 + 20_000, new Set(["n"])).nodes).toHaveLength(1);
  });

  it("merges a chain once, oldest first", () => {
    const a = ev("a", 1, "observation", "s", {});
    const b = ev("b", 2, "decision", "agent", {}, "a");
    const c = ev("c", 3, "action", "gate", {}, "b");
    expect(chainOf(b, [a, b], [c, b]).map((e) => e.id)).toEqual(["a", "b", "c"]);
  });
});

describe("axisTicks", () => {
  it("ticks on round seconds for a minute and on round minutes for an hour", () => {
    const t0 = new Date(2026, 10, 7, 14, 22, 15).getTime();
    const minute = axisTicks(t0, t0 + 60_000).map((t) => t.label);
    expect(minute.slice(0, 3)).toEqual(["14:22:20", "14:22:30", "14:22:40"]);
    const hour = axisTicks(t0, t0 + 3_600_000).map((t) => t.label);
    expect(hour.every((l) => /^\d\d:\d\d$/.test(l))).toBe(true);
    expect(hour.length).toBeGreaterThan(2);
  });
});

describe("turn facts", () => {
  it("collects a turn's lines, how each ended, and what it did", () => {
    const events = [
      ev("d", 1, "decision", "agent.focus", { turn: "T", reason: "addressed" }),
      ev("u1", 2, "utterance", "delivery.voice", { said: "第一句", channel: "voice", turn: "T" }, "d"),
      ev("ok", 3, "delivered", "delivery.voice", { said: "第一句", channel: "voice" }, "u1"),
      ev("u2", 4, "utterance", "delivery.voice", { said: "第二句", channel: "voice", turn: "T" }, "d"),
      ev("no", 5, "result", "delivery.voice", { delivery: "interrupted", reason: null }, "u2"),
      ev("u3", 6, "utterance", "delivery.voice", { said: "第三句", channel: "text", turn: "T" }, "d"),
      ev("act", 7, "action", "gate", { capability: "voice.join", allowed: true, turn: "T" }),
      ev("task", 8, "observation", "activity", { observation: { summary: "完成", attention_key: "task:1", salience: "ambient" } }, "act"),
      ev("out", 9, "result", "agent", { turn_outcome: { turn: "T", outcome: { type: "sent", parts: 3 } } }, "d"),
      ev("lat", 10, "result", "voice.latency", { turn: "T", e2e: { complete: true, total_ms: 900, segments: { endpoint: 900 } } }, "d"),
      ev("other", 3, "utterance", "delivery.voice", { said: "別的回合", turn: "X" }),
    ];
    const f = turnFacts(events, "T");
    expect(f.lines.map((l) => [l.said, l.end.state])).toEqual([
      ["第一句", "delivered"],
      ["第二句", "interrupted"],
      ["第三句", "pending"],
    ]);
    expect(f.actions.map((e) => e.id)).toEqual(["act", "task"]);
    expect(f.decisions.map((e) => e.id)).toEqual(["d"]);
    expect(f.total).toBe(10);
    // The measurement is the turn's own, not something she did.
    expect(turnE2e(events, "T")).toMatchObject({ turn: "T", complete: true, total_ms: 900 });
    expect(turnE2e(events, "X")).toBeNull();
  });

  it("reads when a ULID was made", () => {
    expect(ulidTime("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(1469922850259);
    expect(ulidTime("TURN1")).toBeNull();
  });
});
