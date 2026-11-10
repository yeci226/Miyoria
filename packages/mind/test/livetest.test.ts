// The live-test scenario (busy voice channel, she kept starting conversations about the same
// stale topics and retrying `game.start` while Minecraft was not running), reproduced against
// Plan. Without the Arbiter her own floor applies (these tests); with it, the Arbiter decides.

import { defineCapability } from "@miyoria/actions";
import { MockProvider } from "@miyoria/llm";
import {
  type ContextKey,
  contextKeyString,
  customEvent,
  type Event,
  type Thought,
  toTimestamp,
  type VoiceParticipant,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { MindLoop } from "../src/index.js";
import { texts } from "./fakes.js";
import { HER, OWEN, type Rig, rig, stopRigs, TEXT, VOICE, wait } from "./helpers.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-11-02T10:20:00.000Z")); // 18:20 at UTC+8
});

afterEach(async () => {
  await stopRigs();
  vi.useRealTimers();
});

const MIN = 60_000;
const AQUA = { platform: "discord", id: "300" };
const HERE = contextKeyString(TEXT);

function reply(impulses: unknown[], thought = "嗯。"): string {
  return JSON.stringify({ thought, impulses });
}

const speak = (hint: string, why: string) => ({
  kind: "speak",
  capability: "chat.start",
  place: HERE,
  why,
  hint,
});

/** A rig whose loop does not plan on its own (paused): the test drives every Plan. */
async function manual(
  provider: MockProvider,
): Promise<Rig & { plan(c?: ContextKey): Promise<Thought> }> {
  const r = await rig(provider, { config: { min_interval_secs: 0, max_calls_per_hour: 100 } });
  await r.registry.setPaused(true);
  let n = 0;
  r.intents.outcome = () => ({ status: "started", detail: "queued", turn: `T${++n}` });
  const loop = r.mind() as unknown as MindLoop;
  return Object.assign(r, {
    async plan(context: ContextKey = TEXT): Promise<Thought> {
      const t = await loop.plan([{ kind: "manual", detail: "", context }]);
      await wait(10);
      return r
        .mind()
        .thoughts()
        .find((x) => x.id === t?.id) as Thought;
    },
  });
}

/** Her intent turn `turn` opened and she said `text` in it. */
function spoke(r: Rig, turn: string, context: ContextKey, text: string): void {
  r.publish({
    type: "agent_decision",
    data: { turn, context, respond: true, score: 0, reasons: ["intent:chat.start"] },
  });
  r.publish({ type: "agent_turn_completed", data: { turn, context, text } });
}

/** Someone addressed her in `context` (attention's decision on their message). */
function addressed(r: Rig, context: ContextKey): void {
  r.publish({
    type: "agent_decision",
    data: {
      turn: `R${Date.now()}`,
      context,
      respond: true,
      score: 0.8,
      reasons: ["mode ambient", "direct: name `小鯨`"],
    },
  });
}

const status = (t: Thought) => t.intents.map((i) => [i.capability, i.status, i.detail]);

describe("announcements (v2 §5 item 12)", () => {
  it("a song announcement nobody answers is no topic of hers", async () => {
    const r = await manual(new MockProvider("p"));
    for (const [i, reason] of ["initiative:song_start", "initiative:song_done"].entries()) {
      r.publish({
        type: "agent_decision",
        data: { turn: `S${i}`, context: TEXT, respond: true, score: 0, reasons: [reason] },
      });
      r.publish({
        type: "agent_turn_completed",
        data: { turn: `S${i}`, context: TEXT, text: "下一首要開始囉" },
      });
    }
    await wait(30 * 60_000);
    expect(r.mind().unanswered?.(TEXT)).toEqual([]);
  });
});

describe("self-started conversations (her own floor, without the Arbiter)", () => {
  it("backs off, doubling, when nobody responds, and resets after a real exchange", async () => {
    const same = reply([speak("大家在幹嘛", "想聊天")]);
    const provider = new MockProvider("p")
      .reply(same)
      .reply(same)
      .reply(same)
      .reply(reply([speak("晚餐吃啥", "換個話題")]))
      .reply(reply([speak("週末要幹嘛", "再聊")]));
    const r = await manual(provider);
    const first = await r.plan();
    expect(status(first)).toEqual([["chat.start", "started", "queued"]]);
    spoke(r, "T1", TEXT, "大家在幹嘛~");
    await wait(10);

    // Within the 10-minute text gap; she sees the wait in her limits.
    await wait(5 * MIN);
    expect(status(await r.plan())[0]?.[2]).toMatch(/^backoff: .*next in 5 min$/);
    expect(texts(provider.requests()[1]).system).toContain(`在 ${HERE} 要再等 5 分鐘才能主動開口`);
    // Nobody responded within the window: the gap doubled to 20 minutes.
    await wait(6 * MIN);
    expect(status(await r.plan())[0]?.[2]).toMatch(/1 ignored in a row; next in 9 min$/);
    expect(texts(provider.requests()[2]).system).toContain("最近連續 1 次主動開口沒人接");
    await wait(10 * MIN);
    expect(status(await r.plan())).toEqual([["chat.start", "started", "queued"]]);
    expect(r.intents.intents).toHaveLength(2);
    // Someone answers her this time: back to the base gap.
    spoke(r, "T2", TEXT, "你們晚餐吃什麼?");
    await wait(2 * MIN);
    addressed(r, TEXT);
    await wait(9 * MIN);
    expect(status(await r.plan())).toEqual([["chat.start", "started", "queued"]]);
  });

  it("does not bring up a topic again that nobody picked up, and tells her so", async () => {
    const provider = new MockProvider("p")
      .reply(reply([speak("bypass 別找了", "提醒他")]))
      .reply(reply([speak("你那個 bypass 找不到就先放著啦", "再提醒")]))
      .reply(reply([speak("今天天氣怎樣", "好奇")]));
    const r = await manual(provider);
    await r.plan();
    spoke(r, "T1", TEXT, "那個 bypass 別找了啦");
    await wait(25 * MIN);
    const again = await r.plan();
    expect(status(again)[0]?.[2]).toContain("already raised there and nobody picked it up");
    expect(r.intents.intents).toHaveLength(1);
    const { data } = texts(provider.requests()[1]);
    expect(data).toContain("你最近自己提過、沒人接的話題");
    expect(data).toContain("「那個 bypass 別找了啦」");
    expect(
      r
        .mind()
        .unanswered?.(TEXT)
        .map((t) => t.text),
    ).toEqual(["那個 bypass 別找了啦"]);
    // A different topic is fine.
    expect(status(await r.plan())).toEqual([["chat.start", "started", "queued"]]);
  });
});

describe("failed actions (her own floor, without the Arbiter)", () => {
  it("holds a failed game.start until the activity snapshot shows the game", async () => {
    const provider = new MockProvider("p").reply(
      reply([{ kind: "act", capability: "game.start", place: HERE, why: "想玩麥塊" }]),
    );
    const r = await manual(provider);
    r.registry.register(
      defineCapability({
        name: "game.start",
        summary: "開始玩遊戲",
        risk: "medium",
        args: z.looseObject({}),
        permission: null,
        async execute() {
          return "ok";
        },
      }),
    );
    let gameRunning = false;
    let n = 0;
    r.intents.outcome = (intent) =>
      intent.capability === "game.start" && !gameRunning
        ? { status: "failed", detail: "Minecraft 還沒開,沒辦法開始玩。", turn: `G${++n}` }
        : { status: "done", detail: "開始玩 Minecraft", turn: `G${++n}` };

    const first = await r.plan();
    expect(status(first)).toEqual([["game.start", "failed", "Minecraft 還沒開,沒辦法開始玩。"]]);
    expect(first.changes).toContain("暫停 game.start(Minecraft 還沒開,沒辦法開始玩。)");

    // Not retried while nothing changed; she sees it is on hold, and why.
    await wait(2 * MIN);
    const second = await r.plan();
    expect(status(second)[0]?.[1]).toBe("dropped");
    expect(status(second)[0]?.[2]).toContain("on hold until things change");
    const { system, data } = texts(provider.requests()[1]);
    expect(system).toContain("game.start 暫時做不到");
    expect(data).toContain("game.start 暫時做不到:Minecraft 還沒開");
    expect(r.intents.intents).toHaveLength(1);

    // A game adapter merely publishing is not "the game runs" (a disconnect is not either).
    r.publish(customEvent("game.minecraft.disconnected", { reason: "eof" }));
    await wait(10);
    expect(status(await r.plan())[0]?.[2]).toContain("on hold");

    // The activity snapshot (the one owner of what she is doing) shows the game running.
    gameRunning = true;
    r.publish(
      customEvent("activity.changed", {
        version: 2,
        at: toTimestamp(Date.now()),
        presence: { type: "none" },
        broadcast: { type: "off" },
        activity: {
          type: "game",
          target: "minecraft",
          phase: "running",
          task: null,
          failure: null,
          since: toTimestamp(Date.now()),
        },
        override: null,
        scene: null,
      }),
    );
    await wait(10);
    const third = await r.plan();
    expect(status(third)).toEqual([["game.start", "done", "開始玩 Minecraft"]]);
    expect(r.intents.intents).toHaveLength(2);
  });

  it("tries a failed watch again when someone else goes live", async () => {
    const provider = new MockProvider("p").reply(
      reply([
        { kind: "act", capability: "watch.start", place: contextKeyString(VOICE), why: "想看直播" },
      ]),
    );
    const r = await manual(provider);
    r.registry.register(
      defineCapability({
        name: "watch.start",
        summary: "看直播",
        risk: "low",
        args: z.looseObject({}),
        permission: null,
        async execute() {
          return "ok";
        },
      }),
    );
    r.intents.outcome = () => ({ status: "failed", detail: "連不上這場直播", turn: null });
    r.world.herVoice = VOICE;
    r.world.voiceMembers = [{ account: OWEN, name: "Owen", streaming: true }];
    await r.plan(VOICE);
    await wait(2 * MIN);
    expect(status(await r.plan(VOICE))[0]?.[2]).toContain("on hold");

    r.world.voiceMembers.push({ account: AQUA, name: "阿夸", streaming: true });
    await wait(2 * MIN);
    expect(status(await r.plan(VOICE))[0]?.[1]).toBe("failed");
  });

  it("lifts the hold after blocked_retry_mins even if nothing visible changed", async () => {
    const provider = new MockProvider("p").reply(
      reply([
        { kind: "act", capability: "voice.join", place: contextKeyString(VOICE), why: "想進語音" },
      ]),
    );
    const r = await manual(provider);
    r.intents.outcome = () => ({ status: "failed", detail: "voice node offline", turn: null });
    r.world.voiceMembers = [{ account: OWEN, name: "Owen" }];
    await r.plan(VOICE);
    await wait(10 * MIN);
    expect(status(await r.plan(VOICE))[0]?.[2]).toContain("on hold");
    await wait(21 * MIN);
    expect(status(await r.plan(VOICE))[0]?.[1]).toBe("failed");
  });
});

describe("a busy voice channel", () => {
  const member = (id: string, self: boolean): VoiceParticipant => ({
    account: { platform: "discord", id },
    display_name: id,
    is_self: self,
    muted: false,
    deafened: false,
  });
  const utterance = (who: { platform: string; id: string }, name: string): Event => ({
    type: "voice_utterance",
    data: {
      id: `u${Date.now()}`,
      context: VOICE,
      speaker: { account: who, display_name: name, is_bot: false },
      text: "然後我就把它挖掉了",
      language: "zh",
      emotion: null,
      audio_events: [],
      started_at: toTimestamp(Date.now()),
      ended_at: toTimestamp(Date.now()),
      asr_ms: 100,
    },
  });
  const join = (r: Rig) => {
    r.publish({ type: "platform_ready", data: { platform: "discord", self_account: HER } });
    r.publish({
      type: "voice_joined",
      data: {
        context: VOICE,
        participants: [member(OWEN.id, false), member(AQUA.id, false), member(HER.id, true)],
      },
    });
  };
  const lulls = (r: Rig) =>
    r
      .mind()
      .thoughts()
      .filter((t) => t.triggers.some((x) => x.detail.includes("秒沒說話了")));

  it("is never judged quiet while people keep talking, and the prompt says they are", async () => {
    const provider = new MockProvider("p").reply('{"thought": "大家聊得好開心。"}');
    const r = await rig(provider);
    r.world.herVoice = VOICE;
    r.world.voiceMembers = [
      { account: OWEN, name: "Owen" },
      { account: AQUA, name: "Aquatf" },
    ];
    join(r);
    // Six minutes of continuous conversation, a line every 20 seconds.
    for (let i = 0; i < 18; i++) {
      r.publish(utterance(i % 2 === 0 ? OWEN : AQUA, i % 2 === 0 ? "Owen" : "Aquatf"));
      await wait(20_000);
    }
    expect(lulls(r)).toEqual([]);

    // The world still hears them although the mind missed some lines: not a lull either.
    r.world.voiceActivity = {
      recent_utterances: 14,
      per_minute: 2.8,
      last_at: toTimestamp(Date.now() - 5000),
      secs_since_last: 5,
      recent_speakers: ["Owen", "Aquatf"],
      lively: true,
      her_last_at: null,
    };
    await wait(60_000);
    expect(lulls(r)).toEqual([]);

    // Whatever wakes her, she reads the channel as busy.
    r.mind().suggest({ source: "test", reason: "x", context: VOICE, hint: "看看", about: [] });
    await wait(50_000);
    const plans = provider.requests().filter((q) => q.reasoning_purpose === "plan");
    expect(texts(plans.at(-1)).data).toContain("正在聊天:最近 14 句(Owen、Aquatf),最後一句 5 秒前");
  });

  it("world's channel_quiet for her voice channel wakes Plan (the one cold-channel signal)", async () => {
    const provider = new MockProvider("p").reply('{"thought": "大家怎麼不說話了。"}');
    const r = await rig(provider, { config: { min_interval_secs: 0 } });
    join(r);
    const quiet = (context: typeof VOICE | typeof TEXT, detail: string) =>
      r.publish({
        type: "custom",
        data: {
          topic: "world.salient",
          payload: {
            kind: "channel_quiet",
            key: `channel_quiet:${context.channel}`,
            account: null,
            person: null,
            display_name: null,
            context: { ...context },
            detail,
            score: 0.3,
            count: 1,
            first_at: toTimestamp(Date.now()),
            at: toTimestamp(Date.now()),
          },
        },
      });
    // A text channel going quiet stays below her wake score.
    quiet(TEXT, "剛剛很熱鬧的頻道安靜下來了");
    await wait(10_000);
    expect(lulls(r)).toEqual([]);
    quiet(VOICE, "語音裡大家 45 秒沒說話了(之前 5 分鐘 6 句)");
    await wait(10_000);
    expect(lulls(r)).toHaveLength(1);
  });

  it("does not count her own lines as a conversation that went quiet", async () => {
    const provider = new MockProvider("p").reply('{"thought": "嗯。"}');
    const r = await rig(provider);
    join(r);
    r.publish(utterance(OWEN, "Owen"));
    for (let i = 0; i < 3; i++) {
      await wait(5000);
      r.publish({
        type: "voice_playback",
        data: { context: VOICE, turn: null, state: "started", text: "過來陪我玩麥塊" },
      });
    }
    await wait(60_000);
    expect(provider.requests()).toHaveLength(0);
  });
});

describe("after her turns", () => {
  it("no turn of hers, started herself or not, wakes Plan", async () => {
    const provider = new MockProvider("p").reply(reply([speak("嗨", "想聊天")]));
    const r = await rig(provider, { config: { min_interval_secs: 0 } });
    let n = 0;
    r.intents.outcome = () => ({ status: "started", detail: "queued", turn: `T${++n}` });
    r.mind().suggest({
      source: "initiative",
      reason: "idle_channel",
      context: TEXT,
      hint: "冷場",
      about: [],
    });
    await wait(5000);
    expect(provider.requests()).toHaveLength(1);
    await wait(6 * MIN);
    spoke(r, "T1", TEXT, "嗨大家~");
    r.publish({
      type: "agent_decision",
      data: { turn: "R1", context: TEXT, respond: true, score: 0.9, reasons: ["direct: mention"] },
    });
    r.publish({ type: "agent_turn_completed", data: { turn: "R1", context: TEXT, text: "好啊" } });
    await wait(5000);
    expect(provider.requests()).toHaveLength(1);
  });
});

describe("channel levels", () => {
  it("are shown with the place, and a level that blocks her start drops the chat.start", async () => {
    const start = reply([speak("大家好", "想聊天")]);
    const provider = new MockProvider("p").reply(start).reply(start);
    const r = await manual(provider);
    let blocked: string | null = null;
    r.intents.levels = (c) =>
      c.kind === "voice" ? null : { mode: "quiet", label: "安靜", blocked };
    expect(status(await r.plan())).toEqual([["chat.start", "started", "queued"]]);
    expect(texts(provider.requests()[0]).data).toContain("聊天等級「安靜」");
    expect(texts(provider.requests()[0]).system).toContain("「安靜」的頻道很少主動開口");

    blocked = "level quiet: she started talking here 0 min ago; next in 180 min";
    r.intents.intents.length = 0;
    // Past her own backoff, still inside the level's gap.
    await wait(11 * MIN);
    const second = await r.plan();
    expect(texts(provider.requests()[1]).data).toContain("聊天等級「安靜」,現在不能主動開口");
    expect(status(second)).toEqual([["chat.start", "dropped", blocked]]);
    expect(r.intents.intents).toEqual([]);
  });
});
