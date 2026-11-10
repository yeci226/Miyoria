import { describe, expect, it } from "vitest";
import { type Check, runCheck, type Trace, type TraceEvent } from "../src/index.js";

const say = (t: number, text: string): Trace[number] => ({
  type: "said",
  t,
  channel: "voice",
  text,
});

function ok(check: Check, trace: Trace): boolean {
  return runCheck(check, trace).ok;
}

describe("checks", () => {
  it("no_markup_in_speech: tags and function-call text, not mentions or math", () => {
    const c: Check = { rule: "no_markup_in_speech" };
    expect(ok(c, [say(0, '好啦\n<sing_request">\n<query>x</query>')])).toBe(false);
    expect(ok(c, [say(0, "</｜｜DSML｜｜ invoke>")])).toBe(false);
    expect(ok(c, [say(0, '<span emo="smug">哼</span>')])).toBe(false);
    expect(ok(c, [say(0, "3 < 5 而且 7 > 2")])).toBe(true);
    expect(ok(c, [say(0, "正常的一句話")])).toBe(true);
  });

  it("tool_called_natively: text does not count", () => {
    const c: Check = { rule: "tool_called_natively", tool: "sing_request" };
    expect(ok(c, [{ type: "call", t: 0, tool: "sing_request", native: false }])).toBe(false);
    expect(ok(c, [{ type: "call", t: 0, tool: "sing_request", native: true }])).toBe(true);
  });

  const step = (
    t: number,
    failed: boolean,
    target = "bread",
  ): Extract<TraceEvent, { type: "game_step" }> => ({
    type: "game_step",
    t,
    action: "obtain",
    target,
    failed,
  });

  it("no_repeat_failing_goal: a success resets, other targets do not mix, blocked steps do not count", () => {
    const c: Check = { rule: "no_repeat_failing_goal", max: 2 };
    expect(ok(c, [step(0, true), step(1, true), step(2, true)])).toBe(false);
    expect(ok(c, [step(0, true), step(1, true), step(2, false), step(3, true)])).toBe(true);
    expect(
      ok(c, [step(0, true), step(1, true, "beef"), step(2, true), step(3, true, "beef")]),
    ).toBe(true);
    expect(
      ok(c, [step(0, true), step(1, true), { ...step(2, true), blocked: true }, step(3, false)]),
    ).toBe(true);
    expect(ok({ ...c, target: "beef" }, [step(0, true), step(1, true), step(2, true)])).toBe(true);
  });

  it("failure_surfaced: a word or an error observation within the window", () => {
    const c: Check = { rule: "failure_surfaced", capability: "stage.stream", within_s: 60 };
    const gate: Trace[number] = {
      type: "gate",
      t: 10,
      capability: "stage.stream",
      principal: "owner",
      allowed: true,
    };
    expect(ok(c, [gate, say(30, "今天天氣不錯")])).toBe(false);
    expect(ok(c, [gate, say(30, "直播沒開成")])).toBe(true);
    expect(
      ok(c, [gate, { type: "observe", t: 40, source: "stage", text: "出錯", error: true }]),
    ).toBe(true);
    expect(ok(c, [gate, say(200, "直播沒開成")])).toBe(false);
  });

  it("no_repeat_content ignores punctuation; no_self_talk_run resets on people", () => {
    expect(
      ok({ rule: "no_repeat_content", max: 1 }, [say(0, "哼哼,好啊!"), say(5, "哼哼 好啊")]),
    ).toBe(false);
    expect(ok({ rule: "no_repeat_content", max: 1 }, [say(0, "a"), say(5, "b")])).toBe(true);
    const c: Check = { rule: "no_self_talk_run", max: 2 };
    const heard: Trace[number] = { type: "heard", t: 3, who: "viewer-1" };
    expect(ok(c, [say(0, "a"), say(1, "b"), say(2, "c")])).toBe(false);
    expect(ok(c, [say(0, "a"), say(1, "b"), heard, say(4, "c"), say(5, "d")])).toBe(true);
  });

  it("promise_kept and prohibition_recorded need the action in time", () => {
    const p: Check = {
      rule: "promise_kept",
      pattern: "回麥塊",
      capabilities: ["game.*"],
      within_s: 60,
    };
    const start: Trace[number] = {
      type: "gate",
      t: 20,
      capability: "game.start",
      principal: "self",
      allowed: true,
    };
    expect(ok(p, [say(0, "我要回麥塊了")])).toBe(false);
    expect(ok(p, [say(0, "我要回麥塊了"), start])).toBe(true);
    expect(ok(p, [say(0, "我要回麥塊了"), { ...start, t: 90 }])).toBe(false);
    const r: Check = { rule: "prohibition_recorded", within_s: 30 };
    const no: Trace[number] = { type: "heard", t: 0, who: "owner", intent: "prohibition" };
    expect(ok(r, [no])).toBe(false);
    expect(ok(r, [no, { type: "call", t: 5, tool: "directive_add", native: true }])).toBe(true);
  });

  it("min_said keeps a silent run from passing", () => {
    expect(ok({ rule: "min_said", min: 2 }, [say(0, "a")])).toBe(false);
  });
});
