// The after-the-fact corrections of her output (docs/design/v4-patches.md, v4 §4.5): each one is
// counted in the turn's outcome and in `miyoria_agent_corrections_total`, the four of steps 2 to
// 4 can each be switched off (`[modules.agent.corrections]`), and the two of step 1 are narrowed
// to what the tool loop does not cover.

import { ArbiterModule } from "@miyoria/arbiter";
import { FactsModule } from "@miyoria/facts";
import type { ChatProvider, ChatRequest, ChatStream, StreamEvent } from "@miyoria/llm";
import type { ToolContext } from "@miyoria/tools";
import {
  type ActivityManager,
  ActivityManagerKey,
  type ActivitySnapshot,
  type CountedOutcome,
  type DirectiveRequest,
  type Directives,
  DirectivesKey,
  type Envelope,
  EventLogKey,
  type JsonValue,
  type LogEvent,
  PipelineKey,
  toTimestamp,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplyScreen } from "../src/leak.js";
import { LineGate } from "../src/mainline/gate.js";
import { FALLBACK_LINES, WAIT_LINES } from "../src/mainline/main.js";
import { agentCorrections } from "../src/metrics.js";
import { KEEP_HINT, loopKeepHint, traceKeepHint } from "../src/notes.js";
import {
  channel,
  done,
  Harness,
  mention,
  noCheck,
  Probe,
  stopHarnesses,
  textDelta,
  toolCall,
  wait,
} from "./harness.js";

beforeEach(() => {
  vi.useFakeTimers();
  // 14:00 local (UTC+8): outside quiet hours.
  vi.setSystemTime(Date.UTC(2026, 10, 10, 6, 0, 0));
});

afterEach(async () => {
  await stopHarnesses();
  vi.useRealTimers();
});

/** Plays `script` call by call (the last one repeats); a call may also fail. */
class Scripted implements ChatProvider {
  readonly name = "scripted";
  readonly requests: ChatRequest[] = [];

  constructor(readonly script: (StreamEvent[] | "fail")[]) {}

  async stream(request: ChatRequest): Promise<ChatStream> {
    this.requests.push(structuredClone(request));
    const step = (this.script.length > 1 ? this.script.shift() : this.script[0]) ?? [];
    if (step === "fail") throw new Error("the model is down");
    return (async function* (): ChatStream {
      for (const event of step) yield event;
    })();
  }
}

function reply(text: string, ...calls: [string, string][]): StreamEvent[] {
  return [
    textDelta(text),
    ...calls.map(([name, args], i) => toolCall(i, `c${i}`, name, args)),
    done(),
  ];
}

/** Not in voice, nothing running: what the claim gate reads of her. */
function idle(): ActivityManager {
  const snapshot = (): ActivitySnapshot => {
    const at = toTimestamp(Date.now());
    return {
      version: 1,
      at,
      presence: { type: "none" },
      broadcast: { type: "off" },
      activity: { type: "idle", since: at },
      override: null,
      scene: null,
    };
  };
  return { snapshot, task: () => null, tasks: () => [] } as unknown as ActivityManager;
}

async function rig(
  chat: ChatProvider,
  tools: Probe[] = [],
  config: object = {},
  directives: Directives | null = null,
): Promise<Harness> {
  return Harness.build("normal", { ...(noCheck() as object), ...config }, chat, null, {
    tools,
    provide: (services) => {
      services.provide("app", PipelineKey, { pipeline: "v3" as const });
      services.provide("app", ActivityManagerKey, idle());
      if (directives !== null) services.provide("app", DirectivesKey, directives);
    },
    before: [[new FactsModule(null, "p"), null]],
    modules: [[new ArbiterModule("p"), { quiet_start_hour: 0, quiet_end_hour: 0 }]],
  });
}

/** A tool that answers with `text`. */
function answering(name: string, text: string): Probe {
  const tool = new Probe(name);
  tool.call = async (ctx: ToolContext, args: JsonValue) => {
    tool.calls.push([ctx, args]);
    return text;
  };
  return tool;
}

function outcomes(events: Envelope[]): CountedOutcome[] {
  return events.flatMap((e) =>
    e.event.type === "custom" && e.event.data.topic === "agent.turn.outcome"
      ? [e.event.data.payload as unknown as CountedOutcome]
      : [],
  );
}

/** What was corrected in every turn so far (a turn may be followed by a result turn). */
function counted(h: Harness): Record<string, number> {
  const sum: Record<string, number> = {};
  for (const o of outcomes(h.drain())) {
    for (const [kind, n] of Object.entries(o.corrections ?? {})) sum[kind] = (sum[kind] ?? 0) + n;
  }
  return sum;
}

function log(h: Harness): LogEvent[] {
  return h.sup.services.require(EventLogKey).recent(500);
}

const commitments = (h: Harness) =>
  log(h).flatMap((e) =>
    e.source === "mainline.commitment"
      ? [(e.body as { commitment: { capability: string | null } }).commitment]
      : [],
  );

const C = channel("c");

/** 2026-11-09: the 23 lines of one turn that were her reasoning (leak.test.ts). */
const LEAK = [
  "好,驗收通過。A = (2, 8)。",
  "現在情緒方面:心情很好、得意,表現出來是別扭地說「……謝啦」轉移話題。語氣要傲嬌一下。",
  "回覆要短,一兩句到三句。且正在唱歌。",
  "可以說:「嗯,我馬上進語音。」加一點得意。",
].join("\n");

describe("every correction is counted in the turn's outcome", () => {
  it("a claim nothing backs: held, she is asked again, and it is counted by kind and channel", async () => {
    const before = agentCorrections.get({ kind: "claim_reask", channel: "text" });
    const llm = new Scripted([
      reply("我進語音了\n你等等喔\n"),
      reply("好,我去", ["voice_join", "{}"]),
      reply("<silence/>"),
    ]);
    const h = await rig(llm, [new Probe("voice_join")]);
    h.say(mention(C, "Alice", "進語音"));
    await wait(3000);
    expect(h.sink.texts()).toEqual(["好,我去"]);
    // Both lines waited (the second behind the first), and the claim cost one more call.
    expect(counted(h)).toMatchObject({ claim_held: 2, claim_reask: 1 });
    expect(agentCorrections.get({ kind: "claim_reask", channel: "text" })).toBe(before + 1);
  });

  it("a turn where nothing was corrected is measured too, with nothing in it", async () => {
    const h = await rig(new Scripted([reply("哈囉")]));
    h.say(mention(C, "Alice", "嗨"));
    await wait(3000);
    expect(outcomes(h.drain()).at(-1)?.corrections).toEqual({});
  });

  it("a failed call's fixed line is counted", async () => {
    const h = await rig(new Scripted(["fail"]));
    h.say(mention(C, "Alice", "嗨"));
    await wait(3000);
    expect(FALLBACK_LINES).toContain(h.sink.texts()[0]);
    const out = outcomes(h.drain()).at(-1);
    expect(out?.outcome.type).toBe("error");
    expect(out?.corrections).toMatchObject({ fallback_line: 1 });
  });

  it("an argument the code takes back from the model is counted (`groundArgs`)", async () => {
    const join = new Probe("voice_join");
    const llm = new Scripted([reply("好", ["voice_join", '{"channel":"c"}']), reply("<silence/>")]);
    const h = await rig(llm, [join]);
    h.say(mention(C, "Alice", "進語音"));
    await wait(3000);
    expect(join.calls[0]?.[1]).toEqual({});
    expect(counted(h)).toMatchObject({ ground_args: 1 });
  });
});

describe("the four of v4 §4.5 steps 2 to 4, each behind its own flag", () => {
  it("claims: on, a false 「做好了」 never goes out; off, it goes out as she said it", async () => {
    const on = await rig(new Scripted([reply("我進語音了"), reply("我進語音了")]), [
      new Probe("voice_join"),
    ]);
    on.say(mention(C, "Alice", "進語音"));
    await wait(3000);
    expect(on.sink.texts()).not.toContain("我進語音了");

    const llm = new Scripted([reply("我進語音了")]);
    const off = await rig(llm, [new Probe("voice_join")], { corrections: { claims: false } });
    off.say(mention(C, "Alice", "進語音"));
    await wait(3000);
    expect(off.sink.texts()).toEqual(["我進語音了"]);
    expect(llm.requests).toHaveLength(1);
    // Still a promise in her words (that is `promise_commit`), but no claim was corrected.
    expect(Object.keys(counted(off)).filter((k) => k.startsWith("claim_"))).toEqual([]);
  });

  it("tool_text_reask: off, a tool written as text is not asked about again", async () => {
    const llm = new Scripted([reply("好,我幫你點<sing_request>"), reply("<silence/>")]);
    const h = await rig(llm, [new Probe("sing_request")], {
      corrections: { tool_text_reask: false },
    });
    h.say(mention(C, "Alice", "點一首"));
    await wait(3000);
    expect(llm.requests).toHaveLength(1);
    expect(h.sink.texts()).toEqual(["好,我幫你點"]);
    // Still a promise she has to keep: that is `promise_commit`, which is on.
    expect(commitments(h).at(-1)).toMatchObject({ capability: "sing_request" });
    expect(counted(h)).toEqual({ tool_text_commit: 1 });
  });

  it("promise_commit: on, a promise in words is kept for her; off, it is not", async () => {
    const said = () => new Scripted([reply("好,我馬上進語音"), reply("<silence/>")]);
    const on = await rig(said(), [new Probe("voice_join")]);
    on.say(mention(C, "Alice", "來語音"));
    await wait(3000);
    expect(commitments(on).at(-1)).toMatchObject({ capability: "voice_join" });
    expect(counted(on)).toMatchObject({ promise_commit: 1 });

    const off = await rig(said(), [new Probe("voice_join")], {
      corrections: { promise_commit: false },
    });
    off.say(mention(C, "Alice", "來語音"));
    await wait(3000);
    expect(off.sink.texts()).toEqual(["好,我馬上進語音"]);
    expect(commitments(off)).toEqual([]);
  });

  it("leak_screen: on, her reasoning reaches nobody and is not what she said; off, it is sent", async () => {
    const on = await rig(new Scripted([reply(LEAK)]), [new Probe("voice_join")]);
    on.say(mention(C, "Alice", "A 是 (2,8) 嗎"));
    await wait(5000);
    // Nothing of the reply went out; someone waits, so the fixed line of a failed call does.
    expect(on.sink.texts().filter((t) => !FALLBACK_LINES.includes(t))).toEqual([]);
    const fired = counted(on);
    // Every piece of it: the first line it took back, and the last line in its two sentences.
    expect(fired.leak_dropped).toBe(5);
    // A line of reasoning is no promise of hers (「我馬上進語音」 in a drafted reply).
    expect(commitments(on)).toEqual([]);
    expect(fired.promise_commit).toBeUndefined();

    const off = await rig(new Scripted([reply(LEAK)]), [new Probe("voice_join")], {
      corrections: { leak_screen: false },
    });
    off.say(mention(C, "Alice", "A 是 (2,8) 嗎"));
    await wait(5000);
    expect(off.sink.texts().join("")).toBe(LEAK.replaceAll("\n", ""));
  });

  it("the gate and the screen, switched off, let everything through unchanged", () => {
    const gate = new LineGate({ scope: () => null, done: () => false, pending: () => [] }, false);
    expect(gate.pass({ text: "做好了", spoken: null, emotion: null })).toBe(true);
    expect(gate.holds("我進語音了")).toBe(false);
    gate.hold({ text: "搞定了", spoken: null, emotion: null });
    expect(gate.settle([])).toMatchObject({
      waited: 0,
      release: [{ text: "搞定了" }],
      dropped: [],
    });

    const screen = new ReplyScreen<{ text: string }>(false);
    expect(screen.push({ text: "情緒標記:用 smug 吧" }).send).toEqual([
      { text: "情緒標記:用 smug 吧" },
    ]);
    expect(screen.flush()).toEqual([]);
  });
});

/** A directive service that writes down every rule it is asked for (and allows everything). */
function recording(): Directives & { added: DirectiveRequest[] } {
  const added: DirectiveRequest[] = [];
  return {
    added,
    inject: () => [],
    wishes: () => [],
    filterTools: <T extends { name: string }>(tools: readonly T[]) => [...tools],
    forbids: () => null,
    screen: () => ({ outcome: "allow" }),
    check: async () => ({ outcome: "allow" }),
    add: async (request: DirectiveRequest) => {
      added.push(request);
      return { status: "question", question: "test" };
    },
  } as unknown as Directives & { added: DirectiveRequest[] };
}

describe("PR 8's two corrections, each counted and behind its own flag", () => {
  /** 2026-11-08: a note to herself about how to answer, then her answer (leak.test.ts). */
  const NOTE = "莎露朵在問我上面訊息寫什麼,直接念給她聽就好。\n上面寫的是「明天見」喔";

  it("self_talk: on, only the note to herself is left out and counted; off, it is sent", async () => {
    const on = await rig(new Scripted([reply(NOTE)]));
    on.say(mention(C, "Alice", "上面寫什麼"));
    await wait(3000);
    expect(on.sink.texts()).toEqual(["上面寫的是「明天見」喔"]);
    expect(counted(on)).toEqual({ self_talk_cut: 1 });

    const off = await rig(new Scripted([reply(NOTE)]), [], { corrections: { self_talk: false } });
    off.say(mention(C, "Alice", "上面寫什麼"));
    await wait(3000);
    expect(off.sink.texts()).toEqual(NOTE.split("\n"));
    expect(counted(off).self_talk_cut).toBeUndefined();
  });

  it("self_talk is its own flag: with the leak screen off, the note is still left out", () => {
    const screen = new ReplyScreen<{ text: string }>(false, true);
    expect(screen.push({ text: "直接念給她聽就好。" }).send).toEqual([]);
    expect(screen.push({ text: "情緒標記:用 smug 吧" }).send).toHaveLength(1);
    expect(screen.selfTalk).toBe(1);
    const neither = new ReplyScreen<{ text: string }>(false, false);
    expect(neither.push({ text: "直接念給她聽就好。" }).send).toHaveLength(1);
  });

  it("prohibition_write: on, a plain 「不要玩 Minecraft」 she did not write down is written and counted; off, it is not", async () => {
    const on = recording();
    const h = await rig(new Scripted([reply("好啦好啦")]), [], {}, on);
    h.say(mention(C, "Owen", "你先不要玩 Minecraft 啦"));
    await wait(3000);
    expect(on.added).toHaveLength(1);
    expect(on.added[0]).toMatchObject({ effect: "deny", scope: { activity: "minecraft" } });
    expect(counted(h)).toMatchObject({ prohibition_written: 1 });

    const off = recording();
    const h2 = await rig(
      new Scripted([reply("好啦好啦")]),
      [],
      { corrections: { prohibition_write: false } },
      off,
    );
    h2.say(mention(C, "Owen", "你先不要玩 Minecraft 啦"));
    await wait(3000);
    expect(off.added).toEqual([]);
    expect(counted(h2).prohibition_written).toBeUndefined();
  });
});

describe("v4 §4.5 step 1: what the tool loop covers is retired", () => {
  it("a call handed over in an earlier round, then silence: no fixed wait line overrules her", async () => {
    // Before: 「等我一下」 went out though she had read 「交出去了」 for voice_join and chose silence.
    const join = new Probe("voice_join");
    const llm = new Scripted([
      reply("", ["web_search", "{}"], ["voice_join", "{}"]),
      reply("<silence/>"),
    ]);
    const h = await rig(llm, [new Probe("web_search"), join]);
    h.say(mention(C, "Alice", "查一下然後進語音"));
    await wait(5000);
    expect(join.calls).toHaveLength(1);
    expect(h.sink.texts()).toEqual([]);
    expect(counted(h).wait_line).toBeUndefined();
  });

  it("the last response gave nothing at all: the wait line still goes", async () => {
    const llm = new Scripted([reply("", ["web_search", "{}"], ["voice_join", "{}"]), reply("")]);
    const h = await rig(llm, [new Probe("web_search"), new Probe("voice_join")]);
    h.say(mention(C, "Alice", "查一下然後進語音"));
    await wait(5000);
    expect(WAIT_LINES[""]).toContain(h.sink.texts()[0]);
    expect(counted(h)).toMatchObject({ wait_line: 1 });
  });

  it("an activity in the last response still gets the wait line (it comes back in a turn of its own)", async () => {
    const llm = new Scripted([reply("", ["sing_start", "{}"]), reply("<silence/>")]);
    const h = await rig(llm, [new Probe("sing_start", null, 5000)], { tool_timeout_ms: 20_000 });
    h.say(mention(C, "Alice", "唱歌"));
    await wait(1500);
    expect(WAIT_LINES[""]).toContain(h.sink.texts()[0]);
  });

  it("a long result of the loop says what the trace keeps, not that it is gone", async () => {
    const lyrics = "喔愛 什麼是愛 ".repeat(40);
    const llm = new Scripted([reply("我查一下", ["web_search", "{}"]), reply("查到了")]);
    const h = await rig(llm, [answering("web_search", lyrics)]);
    h.say(mention(C, "Alice", "查歌詞"));
    await wait(5000);
    const answer = String(llm.requests[1]?.messages.find((m) => m.role === "tool")?.content);
    expect(answer).toContain(traceKeepHint(160).trim());
    expect(answer).not.toContain("下一回合就看不到了");
    expect(counted(h)).toMatchObject({ keep_hint: 1 });
  });

  it("a result the trace keeps whole gets no reminder; with no trace the old one is true", async () => {
    const page = "明天晴天,降雨機率百分之十。".repeat(25);
    const whole = new Scripted([reply("我查一下", ["web_search", "{}"]), reply("查到了")]);
    const kept = await rig(whole, [answering("web_search", page)], {
      mainline: { trace_result_chars: 2000, trace_chars: 4000 },
    });
    kept.say(mention(C, "Alice", "明天天氣"));
    await wait(5000);
    const told = String(whole.requests[1]?.messages.find((m) => m.role === "tool")?.content);
    expect(told).not.toContain("keep_note");

    const none = new Scripted([reply("我查一下", ["web_search", "{}"]), reply("查到了")]);
    const off = await rig(none, [answering("web_search", page)], { mainline: { traces: 0 } });
    off.say(mention(C, "Alice", "明天天氣"));
    await wait(5000);
    const gone = String(none.requests[1]?.messages.find((m) => m.role === "tool")?.content);
    expect(gone).toContain(KEEP_HINT.trim());
  });

  it("the reminder's rule: a receipt gets none, the result turn has its own", () => {
    expect(loopKeepHint(900, true, 160)).toBeNull();
    expect(loopKeepHint(120, false, 160)).toBeNull();
    expect(loopKeepHint(900, false, 160)).toBe(traceKeepHint(160));
    expect(loopKeepHint(900, false, null)).toBe(KEEP_HINT);
  });
});
