// Voice on the new runner: utterances in, `speak` actions out through the mouth, her sentences in
// the transcript once they play. The playback events the voice module would publish are
// simulated here; the model is scripted. Real time, with the waits of the voice config made short.

import { defineTool, type ToolRegistry } from "@miyoria/llm/tools";
import { sleep } from "@miyoria/runtime/kernel";
import {
  type ContextKey,
  type DecisionTrace,
  DeliveryLedgerKey,
  Events,
  FloorKey,
  type InterruptLevel,
  type JsonValue,
  MouthKey,
  type PlaybackState,
  type TurnOutcomeRecord,
  toTimestamp,
  type VoiceParticipant,
  type VoiceTurnMark,
  type VoiceTurns,
  VoiceTurnsKey,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { PROFILES, serialiseMessages, serialiseTools } from "../../self/src/index.js";
import { silentWaits } from "../src/index.js";
import { joinSaid } from "../src/voice-outlet.js";
import { notInVoice } from "../src/voice-texts.js";
import { books } from "./books.js";
import {
  account,
  calls,
  mention,
  Rig,
  type RigOptions,
  says,
  stopRigs,
  textOf,
  until,
} from "./harness.js";

afterEach(async () => {
  await stopRigs();
});

const VC: ContextKey = { platform: "test", scope: "guild", channel: "vc", kind: "voice" };
/** The voice channel's text chat: the same channel, kind `channel`. */
const VC_CHAT: ContextKey = { platform: "test", scope: "guild", channel: "vc", kind: "channel" };

function member(id: string, self = false): VoiceParticipant {
  return { account: account(id), display_name: id, is_self: self, muted: false, deafened: false };
}

/** Short waits; no early start unless a test asks for one. */
const VOICE = {
  default_mode: "normal",
  debounce_ms: 150,
  direct_debounce_ms: 80,
  turn_debounce_ms: 20,
  max_debounce_ms: 1_500,
  speculate: false,
  live_context_ms: 50,
};

async function voiceRig(voice: Record<string, JsonValue> = {}, o: RigOptions = {}): Promise<Rig> {
  const rig = await Rig.create({ ...o, config: { ...o.config, voice: { ...VOICE, ...voice } } });
  rig.sup.bus.publish("voice.test", Events.VoiceJoined, {
    context: VC,
    participants: [member("owen"), member("amy"), member("her", true)],
  });
  await sleep(20);
  return rig;
}

let nextUtterance = 0;

function hear(rig: Rig, who: string, text: string, complete = false): void {
  const now = Date.now();
  rig.sup.bus.publish("voice.test", Events.VoiceUtteranceEvent, {
    id: `u${nextUtterance++}`,
    context: VC,
    speaker: { account: account(who), display_name: who, is_bot: false },
    text,
    language: "zh",
    emotion: null,
    audio_events: [],
    started_at: toTimestamp(now - 800),
    ended_at: toTimestamp(now),
    asr_ms: 200,
    ...(complete ? { turn: { ended_by: "turn", probability: 0.9 } } : {}),
  });
}

function speaking(rig: Rig, who: string, on: boolean): void {
  rig.sup.bus.publish("voice.test", Events.VoiceSpeaking, {
    context: VC,
    account: account(who),
    speaking: on,
  });
}

function play(
  rig: Rig,
  turn: string,
  state: PlaybackState,
  text: string,
  extra: Record<string, JsonValue> = {},
): void {
  rig.sup.bus.publish("voice.test", Events.VoicePlaybackEvent, {
    context: VC,
    turn,
    state,
    text,
    ...extra,
  });
}

/** `[text, emotion, turn]` of every `speak` action. */
function speeches(rig: Rig): [string, string | null, string | null][] {
  return rig.sink.actions.flatMap((a) =>
    a.payload.type === "speak" ? [[a.payload.text, a.payload.emotion, a.turn]] : [],
  ) as [string, string | null, string | null][];
}

const outcomes = (rig: Rig) => rig.of<TurnOutcomeRecord>(Events.AgentTurnOutcome.type);
const own = (rig: Rig) =>
  rig.entries(VC).filter((e) => e.kind === "self" || e.kind === "tool_calls");

/** A tool for voice runs that takes `ms` (cut by the run's signal). */
function slowTool(name: string, ms: number, answer = "查到了") {
  let ran = 0;
  const tool = defineTool({
    name,
    description: `測試用的 ${name}。`,
    parameters: z.object({ q: z.string().optional() }),
    effect: "read",
    speed: "instant",
    risk: "low",
    group: "test",
    core: true,
    next: true,
    readOnly: true,
    async call(ctx) {
      ran += 1;
      await sleep(ms, ctx.signal);
      return answer;
    },
  });
  return { tool, ran: () => ran };
}

describe("called by name in voice", () => {
  it("answers aloud sentence by sentence; her line enters the transcript when it starts playing", async () => {
    const rig = await voiceRig();
    rig.model.push(says("<emo:happy>在喔!今天想聊什麼?"));
    hear(rig, "owen", "小鯨魚你在嗎");
    await until(() => speeches(rig).length === 2, 3_000, "her sentences");
    const said = speeches(rig);
    expect(said.map(([t, e]) => [t, e])).toEqual([
      ["在喔!", "happy"],
      ["今天想聊什麼?", "happy"],
    ]);
    const turn = said[0]?.[2] as string;
    // Every line is the main line's, on the voice lane, and nothing went to a text channel.
    expect(rig.sup.services.get(MouthKey)?.owns(turn)).toBe(true);
    expect(
      rig.sink.actions
        .filter((a) => a.payload.type === "speak")
        .every((a) => a.lane === "voice:test:guild"),
    ).toBe(true);
    expect(rig.sink.texts()).toEqual([]);
    // The request: voice reasoning, the voice note at the end, the room in <now>.
    const request = rig.model.requests[0];
    expect(request).toMatchObject({
      reasoning: "off",
      reasoning_purpose: "chat_voice",
      max_tokens: 600,
    });
    const last = String(request?.messages.at(-1)?.content ?? "");
    expect(last).toContain("## 語音");
    expect(last).toContain("語音頻道裡現在有:owen、amy");
    expect(last).toContain("owen 在語音裡跟你說話");
    expect(textOf(request)).toContain("owen(語音): 小鯨魚你在嗎");
    // Nothing of hers is in the transcript before it plays.
    await until(() => outcomes(rig).length === 1, 3_000, "the outcome");
    expect(own(rig)).toEqual([]);
    play(rig, turn, "started", "在喔!");
    await until(() => own(rig).length === 1, 3_000, "her first sentence");
    play(rig, turn, "finished", "在喔!");
    play(rig, turn, "started", "今天想聊什麼?");
    await until(() => own(rig).length === 2, 3_000, "her second sentence");
    expect(own(rig).map((e) => [e.content, e.spoken, e.turn])).toEqual([
      ["在喔!", true, turn],
      ["今天想聊什麼?", true, turn],
    ]);
    const [outcome] = outcomes(rig);
    expect(outcome?.outcome).toEqual({ type: "sent", parts: 2 });
    expect(outcome?.reason).toBe("addressed");
    expect(outcome?.voice_stages).toMatchObject({ speculative: false });
    expect(outcome?.voice_stages?.first_sentence_ms).not.toBeNull();
    const decision = rig.of<DecisionTrace>(Events.AgentDecision.type).at(-1);
    expect(decision?.reasons).toEqual(["runner self", "voice", "addressed: name"]);
  });

  it("an interrupted sentence keeps only the part heard; what was not said never enters", async () => {
    const rig = await voiceRig();
    rig.model.push(says("我跟你說一個很長的故事。後面還有很多。"));
    hear(rig, "owen", "小鯨魚講故事");
    await until(() => speeches(rig).length === 2, 3_000, "her sentences");
    const turn = speeches(rig)[0]?.[2] as string;
    play(rig, turn, "started", "我跟你說一個很長的故事。");
    play(rig, turn, "interrupted", "我跟你說一個很長的故事。", { heard_ms: 500, total_ms: 1000 });
    await until(() => own(rig)[0]?.interrupted === true, 3_000, "the cut");
    const [entry] = own(rig);
    expect(own(rig)).toHaveLength(1);
    expect(entry?.content).toBe("我跟你說一個很長的故事。");
    expect(entry?.heard).toBe("我跟你說一個");
    // The rest of her speech is dropped from the scheduler.
    expect(rig.sink.cancelled).toContain(turn);
    // The next request shows what was heard, marked.
    rig.model.push(says("好啦。"));
    hear(rig, "owen", "小鯨魚停一下");
    await until(() => rig.model.requests.length === 2, 3_000, "the next run");
    expect(textOf(rig.model.requests[1])).toContain("我跟你說一個(被打斷)");
    expect(textOf(rig.model.requests[1])).not.toContain("後面還有很多");
  });

  it("a barge-in during her run stops it: the outcome says who cut in", async () => {
    const search = slowTool("web_search", 800);
    const rig = await voiceRig({}, { provide: (_sup, tools) => tools.register(search.tool) });
    rig.model.push(
      {
        events: [
          { type: "text_delta", text: "我查一下喔。" },
          ...calls("web_search", { q: "鯨魚" }),
        ],
      },
      says("找到了。"),
    );
    hear(rig, "owen", "小鯨魚幫我查鯨魚");
    await until(() => speeches(rig).length === 1, 3_000, "her first sentence");
    const turn = speeches(rig)[0]?.[2] as string;
    play(rig, turn, "started", "我查一下喔。");
    play(rig, turn, "interrupted", "我查一下喔。", { heard_ms: 200, total_ms: 1000 });
    await until(() => outcomes(rig).length === 1, 3_000, "the outcome");
    expect(outcomes(rig)[0]?.outcome).toMatchObject({ type: "cancelled", cause: "barge_in" });
    expect(speeches(rig).map(([t]) => t)).toEqual(["我查一下喔。"]);
  });
});

describe("the waits", () => {
  it("are pushed out while someone is speaking, and the run starts once they stop", async () => {
    const rig = await voiceRig();
    rig.model.push(says("嗯嗯。"));
    speaking(rig, "owen", true);
    hear(rig, "owen", "小鯨魚我跟你說");
    await sleep(400);
    expect(rig.model.requests).toHaveLength(0);
    speaking(rig, "owen", false);
    await until(() => rig.model.requests.length === 1, 3_000, "the run");
  });

  it("a speaker the turn model judged done is answered after the short wait", async () => {
    const rig = await voiceRig({ direct_debounce_ms: 600 });
    rig.model.push(says("好。"));
    hear(rig, "owen", "小鯨魚你覺得呢", true);
    await sleep(250);
    expect(rig.model.requests).toHaveLength(1);
  });

  it("an early start runs the model at once and says nothing until the wait is over", async () => {
    const rig = await voiceRig({ speculate: true, direct_debounce_ms: 500 });
    rig.model.push(says("在這。"));
    hear(rig, "owen", "小鯨魚");
    await until(() => rig.model.requests.length === 1, 300, "the early model call");
    expect(speeches(rig)).toEqual([]);
    await until(() => speeches(rig).length === 1, 3_000, "her line after the wait");
    await until(() => outcomes(rig).length === 1, 3_000, "the outcome");
    expect(outcomes(rig)[0]?.voice_stages?.speculative).toBe(true);
    const latency = rig.of<{ stage: string; result?: string }>(Events.VoiceLatency.type);
    expect(latency.find((l) => l.stage === "speculation")?.result).toBe("confirmed");
  });

  it("an early start is dropped without a trace when they go on; the merged run answers both", async () => {
    const rig = await voiceRig({ speculate: true, direct_debounce_ms: 500 });
    rig.model.push(says("第一次的回答。"), says("合起來的回答。"));
    hear(rig, "owen", "小鯨魚");
    await until(() => rig.model.requests.length === 1, 300, "the early model call");
    hear(rig, "owen", "今天晚餐吃什麼好");
    await until(() => speeches(rig).length === 1, 3_000, "the merged answer");
    expect(speeches(rig).map(([t]) => t)).toEqual(["合起來的回答。"]);
    expect(textOf(rig.model.requests[1])).toContain("今天晚餐吃什麼好");
    const latency = rig.of<{ stage: string; result?: string }>(Events.VoiceLatency.type);
    expect(latency.find((l) => l.stage === "speculation")?.result).toBe("dropped");
    await until(() => outcomes(rig).length === 1, 3_000, "the merged run's outcome");
    await sleep(50);
    // One outcome (the merged run's); the dropped run left nothing in the transcript.
    expect(outcomes(rig)).toHaveLength(1);
    expect(own(rig)).toEqual([]);
    expect(rig.entries(VC).filter((e) => e.kind === "note" || e.kind === "tool_result")).toEqual(
      [],
    );
  });
});

describe("what is typed in the voice channel's chat", () => {
  it("belongs to the voice conversation and is answered aloud", async () => {
    const rig = await voiceRig();
    rig.model.push(says("看到了!"));
    rig.say(mention(VC_CHAT, "amy", "@她 打字給你"));
    await until(() => speeches(rig).length === 1, 3_000, "her spoken answer");
    expect(rig.sink.texts()).toEqual([]);
    const typed = rig.entries(VC).find((e) => e.content === "@她 打字給你");
    expect(typed?.spoken).toBe(false);
    expect(rig.entries(VC_CHAT)).toEqual([]);
  });
});

describe("the kept screens, per sentence", () => {
  it("leaves out a sentence that is her reasoning and says the rest", async () => {
    const rig = await voiceRig();
    rig.model.push(says("好啊。回覆要簡短。我們明天見!"));
    hear(rig, "owen", "小鯨魚明天見");
    await until(() => outcomes(rig).length === 1, 3_000, "the outcome");
    expect(speeches(rig).map(([t]) => t)).toEqual(["好啊。", "我們明天見!"]);
    expect(outcomes(rig)[0]?.corrections).toEqual({ leak_dropped: 1 });
  });
});

describe("tools in voice", () => {
  it("refuses a tool that is not on the voice list, telling her why", async () => {
    const coins = slowTool("give_coins", 0, "給了");
    const rig = await voiceRig({}, { provide: (_sup, tools) => tools.register(coins.tool) });
    rig.model.push(calls("give_coins", { q: "owen" }), says("在語音裡不行耶。"));
    hear(rig, "owen", "小鯨魚給我金幣");
    await until(() => outcomes(rig).length === 1, 3_000, "the outcome");
    expect(coins.ran()).toBe(0);
    // The tool is offered (the prefix is text's), the call refused at call time.
    expect(rig.model.requests[0]?.tools?.map((t) => t.name)).toContain("give_coins");
    const result = rig.entries(VC).find((e) => e.kind === "tool_result");
    expect(result?.content).toBe(notInVoice("give_coins"));
  });

  it("a slow tool gets no wait line: silence, counted", async () => {
    const search = slowTool("web_search", 1_100);
    const rig = await voiceRig({}, { provide: (_sup, tools) => tools.register(search.tool) });
    rig.model.push(calls("web_search", { q: "天氣" }), says("明天會下雨。"));
    const before = silentWaits.get();
    hear(rig, "owen", "小鯨魚明天天氣");
    await until(() => outcomes(rig).length === 1, 5_000, "the outcome");
    expect(speeches(rig).map(([t]) => t)).toEqual(["明天會下雨。"]);
    expect(silentWaits.get() - before).toBe(1);
  });
});

describe("a long tool's result in voice", () => {
  it("a receipt given as an array is followed by a result wake when the task ends", async () => {
    const long = defineTool({
      name: "web_search",
      description: "測試用的長工具。",
      parameters: z.object({}),
      effect: "read",
      speed: "long",
      risk: "low",
      group: "test",
      core: true,
      next: true,
      readOnly: true,
      async call(ctx) {
        ctx.report?.([{ status: "started", task: "job-v1", resource: "x" }]);
        return "開始了";
      },
    });
    const rig = await voiceRig({}, { provide: (_sup, tools) => tools.register(long) });
    rig.model.push(calls("web_search", {}), says("開始囉。"), says("好了。"));
    hear(rig, "owen", "小鯨魚幫我查", true);
    await until(() => outcomes(rig).length === 1, 5_000, "the first outcome");
    expect(String(rig.model.requests[1]?.messages.at(-1)?.content)).toContain("代號 job-v1");
    play(rig, speeches(rig)[0]?.[2] as string, "started", "開始囉。");
    rig.sup.bus.publish(
      "test",
      Events.TaskDone,
      { type: "done", task: "job-v1", detail: "查完了", data: null, at: toTimestamp(Date.now()) },
      { type: "test.task.done" },
    );
    await until(() => outcomes(rig).length === 2, 5_000, "the result's outcome");
    expect(textOf(rig.model.requests[2])).toContain("代號 job-v1");
  });
});

describe("the prefix", () => {
  it("a voice request starts like a text-profile request of the same session", async () => {
    const rig = await voiceRig();
    rig.model.push(says("嗨。"));
    hear(rig, "owen", "小鯨魚嗨");
    await until(() => outcomes(rig).length === 1, 3_000, "the voice run");
    const host = rig.host;
    if (host === null) throw new Error("no host");
    // A text-profile run of the same session, then a voice run: the voice one opens with the text
    // one's prefix up to its transcript.
    rig.model.push(says("文字。"), says("語音。"));
    await host.runner.run({
      session: { id: host.sessionOf(VC), context: VC },
      wake: { kind: "glance", lines: 1 },
      profile: PROFILES.text,
      signal: new AbortController().signal,
      turn: "text-run",
    });
    hear(rig, "owen", "小鯨魚再一次");
    await until(() => rig.model.requests.length === 3, 3_000, "the second voice run");
    const text = rig.model.requests[1];
    const voice = rig.model.requests[2];
    const head = (text?.messages.length ?? 0) - 2;
    expect(head).toBeGreaterThan(1);
    expect(serialiseMessages(voice?.messages.slice(0, head) ?? [])).toEqual(
      serialiseMessages(text?.messages.slice(0, head) ?? []),
    );
    expect(serialiseTools(voice?.tools ?? [])).toEqual(serialiseTools(text?.tools ?? []));
  });
});

describe("a wake of her own in voice", () => {
  it("runs in the voice conversation and is said aloud; a place with no voice declines it", async () => {
    const rig = await voiceRig();
    rig.model.push(says("對了,蛋糕該出爐了。"));
    expect(rig.host?.voice.wake(VC, { kind: "timer", note: "蛋糕" })).toBe(true);
    await until(() => speeches(rig).length === 1, 3_000, "her line");
    expect(speeches(rig)[0]?.[0]).toBe("對了,蛋糕該出爐了。");
    expect(rig.sink.texts()).toEqual([]);
    expect(rig.model.requests[0]?.reasoning_purpose).toBe("chat_voice");
    expect(rig.host?.voice.wake(VC_CHAT, { kind: "timer", note: "蛋糕" })).toBe(false);
  });
});

describe("her inbox in voice", () => {
  it("is shown in a voice run and seen once that run finished, not before", async () => {
    const rig = await voiceRig();
    rig.sup.bus.publish("world", Events.WorldSalient, {
      kind: "channel_active",
      key: "k1",
      account: null,
      person: null,
      display_name: null,
      context: null,
      detail: "Owen 在別的伺服器得獎了",
      score: 0.8,
      count: 1,
      first_at: toTimestamp(Date.now()),
      at: toTimestamp(Date.now()),
    } as never);
    await sleep(50);
    rig.model.push(says("在喔!"), says("還在喔!"));
    hear(rig, "owen", "小鯨魚你在嗎");
    await until(() => speeches(rig).length === 1, 3_000, "the first answer");
    expect(textOf(rig.model.requests[0])).toContain("Owen 在別的伺服器得獎了");
    await until(() => outcomes(rig).length === 1, 3_000, "the first outcome");
    hear(rig, "owen", "小鯨魚你還在嗎");
    await until(() => speeches(rig).length === 2, 3_000, "the second answer");
    expect(textOf(rig.model.requests[1])).not.toContain("Owen 在別的伺服器得獎了");
  });
});

/** A `search` call after a first sentence: the run holds the Floor and is in flight. */
function searchingRun(rig: Rig): void {
  rig.model.push(
    {
      events: [{ type: "text_delta", text: "我查一下喔。" }, ...calls("web_search", { q: "鯨魚" })],
    },
    says("找到了。"),
  );
}

const holder = (rig: Rig) => rig.sup.services.get(FloorKey)?.holder(VC) ?? null;

/** The Floor and the delivery ledger on one log, as the event log's projections see them. */
function floored(extra?: (tools: ToolRegistry) => void): RigOptions {
  const b = books({ budget: { base_lines: 10 } });
  return {
    provide: (sup, tools) => {
      sup.services.provide("app", DeliveryLedgerKey, b.ledger);
      sup.services.provide("app", FloorKey, b.floor);
      extra?.(tools);
    },
  };
}

describe("a claim from elsewhere cuts into her speech (yieldTo)", () => {
  const LEVELS: InterruptLevel[] = ["wrap_up", "cut_short", "interrupt"];

  it("queue changes nothing: the run goes on and says the rest", async () => {
    const search = slowTool("web_search", 300);
    const rig = await voiceRig(
      {},
      floored((tools) => tools.register(search.tool)),
    );
    searchingRun(rig);
    hear(rig, "owen", "小鯨魚幫我查鯨魚");
    await until(() => speeches(rig).length === 1, 3_000, "her first sentence");
    rig.host?.voice.yieldTo(VC, "queue");
    await until(() => outcomes(rig).length === 1, 5_000, "the outcome");
    expect(outcomes(rig)[0]?.outcome.type).toBe("sent");
    expect(speeches(rig).map(([t]) => t)).toEqual(["我查一下喔。", "找到了。"]);
    expect(rig.sink.cancelled).toEqual([]);
    expect(rig.sink.interrupted).toEqual([]);
  });

  for (const level of LEVELS) {
    it(`${level}: the run that speaks ends, what it queued is dropped${level === "wrap_up" ? ", the sentence playing is left" : ", the sentence playing stops too"}`, async () => {
      const search = slowTool("web_search", 1_000);
      const rig = await voiceRig(
        {},
        floored((tools) => tools.register(search.tool)),
      );
      searchingRun(rig);
      hear(rig, "owen", "小鯨魚幫我查鯨魚");
      await until(() => speeches(rig).length === 1, 3_000, "her first sentence");
      const turn = speeches(rig)[0]?.[2] as string;
      expect(holder(rig)?.turn).toBe(turn);
      rig.host?.voice.yieldTo(VC, level);
      await until(() => outcomes(rig).length === 1, 5_000, "the outcome");
      expect(outcomes(rig)[0]?.outcome).toMatchObject({ type: "cancelled", cause: "superseded" });
      expect(rig.sink.cancelled).toContain(turn);
      expect(rig.sink.interrupted).toEqual(level === "wrap_up" ? [] : [turn]);
      await sleep(150);
      expect(speeches(rig).map(([t]) => t)).toEqual(["我查一下喔。"]);
    });

    it(`${level}: speech of a run that already ended is dropped as well`, async () => {
      const rig = await voiceRig({}, floored());
      rig.model.push(says("我跟你說一個很長的故事。後面還有很多。"));
      hear(rig, "owen", "小鯨魚講故事");
      await until(() => outcomes(rig).length === 1, 3_000, "the outcome");
      const turn = speeches(rig)[0]?.[2] as string;
      // Her speech is queued and none of it played: she still holds the Floor.
      expect(holder(rig)?.turn).toBe(turn);
      rig.host?.voice.yieldTo(VC, level);
      await until(() => rig.sink.cancelled.includes(turn), 2_000, "the queued speech dropped");
      expect(rig.sink.interrupted).toEqual(level === "wrap_up" ? [] : [turn]);
    });
  }

  it("a place that has no run and no hold has nothing to cut", async () => {
    const rig = await voiceRig({}, floored());
    rig.host?.voice.yieldTo(VC, "interrupt");
    await sleep(100);
    expect(rig.sink.cancelled).toEqual([]);
    expect(rig.sink.interrupted).toEqual([]);
    rig.host?.voice.yieldTo({ ...VC, channel: "other" }, "interrupt");
  });
});

describe("giving way to someone who speaks", () => {
  it("an early start stays held while they speak, and says its line once they stop", async () => {
    const rig = await voiceRig({ speculate: true, direct_debounce_ms: 300 });
    rig.model.push(says("在這。"));
    hear(rig, "owen", "小鯨魚");
    await until(() => rig.model.requests.length === 1, 300, "the early model call");
    speaking(rig, "owen", true);
    // Past the wait the line opened: someone is speaking, so it is pushed out.
    await sleep(500);
    expect(speeches(rig)).toEqual([]);
    speaking(rig, "owen", false);
    await until(() => speeches(rig).length === 1, 3_000, "her line");
    await until(() => outcomes(rig).length === 1, 3_000, "the outcome");
    expect(outcomes(rig)[0]?.voice_stages?.speculative).toBe(true);
    expect(own(rig)).toEqual([]);
  });

  it("a line while her run thinks does not cut it: its answer is said, the line gets the next run", async () => {
    const rig = await voiceRig();
    rig.model.push({ events: says("先回你這個。"), delay: 400 }, says("再回你那個。"));
    hear(rig, "owen", "小鯨魚你在嗎");
    await until(() => rig.model.requests.length === 1, 3_000, "the first run");
    hear(rig, "owen", "小鯨魚還有一件事想問你");
    await until(() => speeches(rig).length === 2, 5_000, "both answers");
    expect(speeches(rig).map(([t]) => t)).toEqual(["先回你這個。", "再回你那個。"]);
    expect(speeches(rig)[0]?.[2]).not.toBe(speeches(rig)[1]?.[2]);
    expect(textOf(rig.model.requests[1])).toContain("小鯨魚還有一件事想問你");
    expect(rig.sink.cancelled).toEqual([]);
    await until(() => outcomes(rig).length === 2, 3_000, "both outcomes");
    expect(outcomes(rig).map((o) => o.outcome.type)).toEqual(["sent", "sent"]);
  });

  it("a run she started herself gives way to someone calling her: nothing of it is said", async () => {
    const rig = await voiceRig();
    rig.model.push({ events: says("我想說…"), delay: 600 }, says("在喔。"));
    expect(rig.host?.voice.wake(VC, { kind: "timer", note: "蛋糕" })).toBe(true);
    await until(() => rig.model.requests.length === 1, 3_000, "her own run");
    hear(rig, "owen", "小鯨魚你在嗎");
    await until(() => speeches(rig).length === 1, 5_000, "the answer");
    expect(speeches(rig).map(([t]) => t)).toEqual(["在喔。"]);
    await until(() => outcomes(rig).length === 2, 3_000, "both outcomes");
    const cut = outcomes(rig).find((o) => o.outcome.type === "cancelled");
    expect(cut?.outcome).toMatchObject({ cause: "superseded", by: "owen" });
  });

  it("speech of her own start that is queued is dropped when someone calls her; the sentence playing is left", async () => {
    const rig = await voiceRig({}, floored());
    rig.model.push(says("對了,蛋糕該出爐了。"), says("在喔。"));
    // What she says of her own accord spends her budget: a caller cuts into it.
    expect(rig.host?.voice.wake(VC, { kind: "world", what: "蛋糕出爐了", claim: "notable" })).toBe(
      true,
    );
    await until(() => speeches(rig).length === 1, 3_000, "her own line");
    const first = speeches(rig)[0]?.[2] as string;
    await until(() => outcomes(rig).length === 1, 3_000, "her own outcome");
    hear(rig, "owen", "小鯨魚你在嗎");
    await until(() => speeches(rig).length === 2, 5_000, "the answer");
    expect(speeches(rig)[1]?.[0]).toBe("在喔。");
    expect(rig.sink.cancelled).toContain(first);
    expect(rig.sink.interrupted).toEqual([]);
  });

  it("speech that answers a person is not cut by a second call: both are answered", async () => {
    const rig = await voiceRig({}, floored());
    rig.model.push(says("在喔。"), says("對啊。"));
    hear(rig, "owen", "小鯨魚你在嗎");
    await until(() => outcomes(rig).length === 1, 3_000, "the first outcome");
    hear(rig, "amy", "小鯨魚我也在");
    await until(() => speeches(rig).length === 2, 5_000, "the second answer");
    expect(rig.sink.cancelled).toEqual([]);
    expect(rig.sink.interrupted).toEqual([]);
  });

  it("while sentences wait to play the next run's wake waits for them; a started sentence frees it", async () => {
    const rig = await voiceRig();
    rig.model.push(says("好。"), says("對了,蛋糕該出爐了。"));
    hear(rig, "owen", "小鯨魚好不好");
    await until(() => outcomes(rig).length === 1, 3_000, "the outcome");
    const turn = speeches(rig)[0]?.[2] as string;
    // A result of hers waits until her speech has played.
    expect(rig.host?.voice.wake(VC, { kind: "timer", note: "蛋糕" })).toBe(true);
    await sleep(300);
    expect(rig.model.requests).toHaveLength(1);
    play(rig, turn, "started", "好。");
    await until(() => speeches(rig).length === 2, 3_000, "the wake's line");
  });
});

/** A `VoiceTurns` that keeps what it is told. */
class Turns implements VoiceTurns {
  readonly marks: { turn: string; mark: VoiceTurnMark; at: number; focus: number }[] = [];
  readonly expected: { turn: string; startedAt: number; at: number }[] = [];
  readonly settled: string[] = [];
  mark(turn: string, focus: readonly unknown[], mark: VoiceTurnMark, at: number): void {
    this.marks.push({ turn, mark, at, focus: focus.length });
  }
  expect(_context: ContextKey, turn: string, startedAt: number): void {
    this.expected.push({ turn, startedAt, at: Date.now() });
  }
  settle(turn: string): void {
    this.settled.push(turn);
  }
  marked(turn: string): VoiceTurnMark[] {
    return this.marks.filter((m) => m.turn === turn).map((m) => m.mark);
  }
}

function voiceTurns(): { turns: Turns; opts: RigOptions } {
  const turns = new Turns();
  return {
    turns,
    opts: { provide: (sup) => sup.services.provide("app", VoiceTurnsKey, turns) },
  };
}

describe("the voice module hears of a run", () => {
  it("marks, in order, where its time went; the outcome and the latency record carry them", async () => {
    const { turns, opts } = voiceTurns();
    const rig = await voiceRig({}, opts);
    rig.model.push(says("在喔。"));
    hear(rig, "owen", "小鯨魚你在嗎");
    await until(() => outcomes(rig).length === 1, 3_000, "the outcome");
    const turn = speeches(rig)[0]?.[2] as string;
    expect(turns.marked(turn)).toEqual(["started", "decided", "context", "request", "first_token"]);
    // Each mark answers the line it was for.
    expect(turns.marks.every((m) => m.focus === 1)).toBe(true);
    const at = turns.marks.map((m) => m.at);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    // She will answer: a filler may cover a long silence; the run ended, so it is settled.
    expect(turns.expected.map((e) => e.turn)).toEqual([turn]);
    expect(turns.expected[0]?.startedAt).toBe(turns.marks[0]?.at);
    expect(turns.settled).toEqual([turn]);
    const stages = outcomes(rig)[0]?.voice_stages;
    expect(stages).toMatchObject({ speculative: false });
    for (const part of [
      stages?.heard_ms,
      stages?.wait_ms,
      stages?.decide_ms,
      stages?.context_ms,
      stages?.prompt_ms,
      stages?.first_token_ms,
      stages?.held_ms,
      stages?.first_sentence_ms,
    ]) {
      expect(part).not.toBeNull();
      expect(part).toBeGreaterThanOrEqual(0);
    }
    const latency = rig
      .of<{ stage: string; turn: string; model: string; first_token_ms: number }>(
        Events.VoiceLatency.type,
      )
      .filter((l) => l.stage === "llm");
    expect(latency).toHaveLength(1);
    expect(latency[0]).toMatchObject({ turn, model: "scripted:m" });
    expect(latency[0]?.first_token_ms).toBeGreaterThanOrEqual(0);
  });

  it("an early start: the filler waits for the confirmation, which is a mark of its own", async () => {
    const { turns, opts } = voiceTurns();
    const rig = await voiceRig({ speculate: true, direct_debounce_ms: 500 }, opts);
    rig.model.push(says("在這。"));
    hear(rig, "owen", "小鯨魚");
    await until(() => rig.model.requests.length === 1, 300, "the early model call");
    // The model call went out but the wait is not over: no filler yet.
    expect(turns.expected).toEqual([]);
    await until(() => outcomes(rig).length === 1, 3_000, "the outcome");
    const turn = speeches(rig)[0]?.[2] as string;
    expect(turns.marked(turn)).toEqual([
      "started",
      "decided",
      "context",
      "request",
      "first_token",
      "confirmed",
    ]);
    const request = turns.marks.find((m) => m.mark === "request")?.at ?? 0;
    expect(turns.expected).toHaveLength(1);
    expect((turns.expected[0]?.at ?? 0) - request).toBeGreaterThanOrEqual(300);
    const stages = outcomes(rig)[0]?.voice_stages;
    expect(stages?.speculative).toBe(true);
    expect(stages?.held_ms).toBeGreaterThanOrEqual(300);
  });

  it("an early start that is dropped gets no filler and is settled; the merged run gets one", async () => {
    const { turns, opts } = voiceTurns();
    const rig = await voiceRig({ speculate: true, direct_debounce_ms: 500 }, opts);
    rig.model.push(says("第一次的回答。"), says("合起來的回答。"));
    hear(rig, "owen", "小鯨魚");
    await until(() => rig.model.requests.length === 1, 300, "the early model call");
    hear(rig, "owen", "今天晚餐吃什麼好");
    await until(() => outcomes(rig).length === 1, 3_000, "the merged run's outcome");
    const turn = speeches(rig)[0]?.[2] as string;
    expect(turns.expected.map((e) => e.turn)).toEqual([turn]);
    const dropped = [...new Set(turns.marks.map((m) => m.turn))].filter((t) => t !== turn);
    expect(dropped).toHaveLength(1);
    expect(turns.marked(dropped[0] as string)).not.toContain("confirmed");
    expect(turns.settled).toContain(dropped[0]);
    expect(turns.settled).toContain(turn);
  });

  it("a wake of her own is marked but expects nothing, and its outcome has no stages", async () => {
    const { turns, opts } = voiceTurns();
    const rig = await voiceRig({}, opts);
    rig.model.push(says("對了,蛋糕該出爐了。"));
    expect(rig.host?.voice.wake(VC, { kind: "timer", note: "蛋糕" })).toBe(true);
    await until(() => outcomes(rig).length === 1, 3_000, "the outcome");
    const turn = speeches(rig)[0]?.[2] as string;
    expect(turns.marked(turn)).toEqual(["started", "decided", "context", "request", "first_token"]);
    expect(turns.expected).toEqual([]);
    expect(turns.settled).toEqual([turn]);
    expect(outcomes(rig)[0]?.voice_stages).toBeUndefined();
  });
});

describe("links and code are written, not read aloud", () => {
  const chat = (rig: Rig) => rig.sink.sent().filter(([channel]) => channel === "vc");

  it("a link goes to the voice channel's chat; the sentences around it are said", async () => {
    const rig = await voiceRig();
    rig.model.push(says("我貼給你喔。https://example.com/a?b=1 你看看。"));
    hear(rig, "owen", "小鯨魚給我連結");
    await until(() => outcomes(rig).length === 1, 3_000, "the outcome");
    expect(speeches(rig).map(([t]) => t)).toEqual(["我貼給你喔。", "你看看。"]);
    expect(chat(rig)).toEqual([["vc", "https://example.com/a?b=1"]]);
    // The written line is in the voice conversation's transcript at once, not as spoken.
    const written = rig.entries(VC).find((e) => e.content === "https://example.com/a?b=1");
    expect(written?.kind).toBe("self");
    expect(written?.spoken).toBe(false);
    expect(outcomes(rig)[0]?.outcome).toEqual({ type: "sent", parts: 3 });
  });

  it("a code block goes to the chat whole", async () => {
    const rig = await voiceRig();
    rig.model.push(says("寫法在這:\n```ts\nconst a = 1;\n```\n就是這樣。"));
    hear(rig, "owen", "小鯨魚寫給我看");
    await until(() => outcomes(rig).length === 1, 3_000, "the outcome");
    expect(chat(rig)).toEqual([["vc", "```ts\nconst a = 1;\n```"]]);
    for (const [text] of speeches(rig)) {
      expect(text).not.toContain("```");
      expect(text).not.toContain("const");
    }
    expect(
      speeches(rig)
        .map(([t]) => t)
        .join(""),
    ).toContain("就是這樣");
  });

  it("without text_aside it is neither written nor read, and she is told why", async () => {
    const rig = await voiceRig({ text_aside: false });
    rig.model.push(says("我貼給你喔。https://example.com/a?b=1 你看看。"));
    hear(rig, "owen", "小鯨魚給我連結");
    await until(() => outcomes(rig).length === 1, 3_000, "the outcome");
    expect(speeches(rig).map(([t]) => t)).toEqual(["我貼給你喔。", "你看看。"]);
    expect(chat(rig)).toEqual([]);
    const note = rig.entries(VC).find((e) => e.kind === "note");
    expect(note?.content).toContain("連結和程式碼念不出來");
  });
});

// The owner's `text_echo` (2026-11-03): her spoken reply is also written in the voice channel's
// chat, the text as she wrote it (Chinese while `tts_translate` has her speak Japanese). It was
// lost when voice moved to this runner (2026-11-18: 「中文的不見了」).
describe("text_echo: what she said is also written in the voice channel's chat", () => {
  const chat = (rig: Rig) => rig.sink.sent().filter(([channel]) => channel === "vc");

  it("writes a spoken reply once, whole, when the run is over", async () => {
    const rig = await voiceRig({ text_echo: true });
    rig.model.push(says("好喔。我去看看。"));
    hear(rig, "owen", "小鯨魚幫我看一下");
    await until(() => outcomes(rig).length === 1, 3_000, "the outcome");
    await until(() => chat(rig).length > 0, 3_000, "the echo");
    expect(speeches(rig).map(([t]) => t)).toEqual(["好喔。", "我去看看。"]);
    expect(chat(rig)).toEqual([["vc", "好喔。我去看看。"]]);
    // Said once in the conversation: the written copy is not a second line of hers.
    expect(rig.entries(VC).filter((e) => e.content === "好喔。我去看看。")).toEqual([]);
  });

  it("joins the sentences, with a space only between two that would run into each other", () => {
    expect(joinSaid(["好喔。", "OK.", "Sure thing.", " 走吧 ", ""])).toBe(
      "好喔。OK. Sure thing.走吧",
    );
  });

  it("writes nothing unless it is switched on", async () => {
    const rig = await voiceRig();
    rig.model.push(says("好喔。我去看看。"));
    hear(rig, "owen", "小鯨魚幫我看一下");
    await until(() => outcomes(rig).length === 1, 3_000, "the outcome");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(chat(rig)).toEqual([]);
  });
});
