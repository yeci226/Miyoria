// The live-test scenario (busy voice channel, she kept starting conversations about the same
// stale topics and retrying `game.start` while Minecraft was not running), reproduced.

import { defineCapability } from "@miyoria/actions";
import { MockProvider } from "@miyoria/llm";
import {
  type ContextKey,
  customEvent,
  type Event,
  SelfStateKey,
  type Thought,
  type ThoughtTrigger,
  toTimestamp,
  type VoiceParticipant,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { MindLoop } from "../src/index.js";
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

function reply(intents: unknown[], thought = "嗯。"): string {
  return JSON.stringify({ thought, intents });
}

function systemText(provider: MockProvider, n: number): string {
  return (provider.requests()[n]?.messages ?? [])
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");
}

function dataText(provider: MockProvider, n: number): string {
  return (provider.requests()[n]?.messages ?? [])
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join("\n");
}

/** A rig whose loop does not think on its own (paused): the test drives every thought. */
async function manual(
  provider: MockProvider,
): Promise<Rig & { think(c?: ContextKey): Promise<Thought> }> {
  const r = await rig(provider, { config: { min_interval_secs: 0, max_calls_per_hour: 100 } });
  await r.registry.setPaused(true);
  let n = 0;
  r.intents.outcome = () => ({ status: "started", detail: "queued", turn: `T${++n}` });
  const loop = r.mind() as unknown as MindLoop;
  return Object.assign(r, {
    async think(context: ContextKey = TEXT): Promise<Thought> {
      const trigger: ThoughtTrigger = {
        kind: "manual",
        detail: "",
        context,
        at: toTimestamp(Date.now()),
      };
      const t = await loop.think([trigger]);
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

describe("self-started conversations", () => {
  it("backs off, doubling, when nobody responds, and resets after a real exchange", async () => {
    const same = reply([
      { action: "chat.start", place: "p1", why: "想聊天", opening: "大家在幹嘛" },
    ]);
    // Replies are used in order (the last one repeats).
    const provider = new MockProvider("p")
      .reply(same)
      .reply(same)
      .reply(same)
      .reply(reply([{ action: "chat.start", place: "p1", why: "換個話題", opening: "晚餐吃啥" }]))
      .reply(reply([{ action: "chat.start", place: "p1", why: "再聊", opening: "週末要幹嘛" }]));
    const r = await manual(provider);
    const first = await r.think();
    expect(status(first)).toEqual([["chat.start", "started", "queued"]]);
    spoke(r, "T1", TEXT, "大家在幹嘛~");
    await wait(10);

    // Within the 10-minute text gap.
    await wait(5 * MIN);
    expect(status(await r.think())[0]?.[2]).toMatch(/^backoff: .*next in 5 min$/);
    // Nobody responded within the window: the gap doubled to 20 minutes.
    await wait(6 * MIN);
    expect(status(await r.think())[0]?.[2]).toMatch(/1 ignored in a row; next in 9 min$/);
    await wait(10 * MIN);
    expect(status(await r.think())).toEqual([["chat.start", "started", "queued"]]);
    expect(r.intents.intents).toHaveLength(2);
    // Someone answers her this time: back to the base gap.
    spoke(r, "T2", TEXT, "你們晚餐吃什麼?");
    await wait(2 * MIN);
    addressed(r, TEXT);
    await wait(9 * MIN);
    expect(status(await r.think())).toEqual([["chat.start", "started", "queued"]]);
  });

  it("does not bring up a topic again that nobody picked up, and tells her so", async () => {
    const provider = new MockProvider("p")
      .reply(
        reply([{ action: "chat.start", place: "p1", why: "提醒他", opening: "bypass 別找了" }]),
      )
      .reply(
        reply([
          {
            action: "chat.start",
            place: "p1",
            why: "再提醒",
            opening: "你那個 bypass 找不到就先放著啦",
          },
        ]),
      )
      .reply(reply([{ action: "chat.start", place: "p1", why: "好奇", opening: "今天天氣怎樣" }]));
    const r = await manual(provider);
    await r.think();
    spoke(r, "T1", TEXT, "那個 bypass 別找了啦");
    await wait(25 * MIN);
    const again = await r.think();
    expect(status(again)[0]?.[2]).toContain("already raised there and nobody picked it up");
    expect(r.intents.intents).toHaveLength(1);
    // Her own state, in the mind prompt and for her turns.
    expect(systemText(provider, 1)).toContain("# 你最近自己提過、沒人接的話題");
    expect(systemText(provider, 1)).toContain("「那個 bypass 別找了啦」");
    expect(
      r
        .mind()
        .unanswered?.(TEXT)
        .map((t) => t.text),
    ).toEqual(["那個 bypass 別找了啦"]);
    // A different topic is fine.
    expect(status(await r.think())).toEqual([["chat.start", "started", "queued"]]);
  });
});

describe("failed actions", () => {
  it("holds a failed game.start (and its agenda item) until the game is available", async () => {
    const provider = new MockProvider("p").reply(
      reply([{ action: "game.start", place: "p1", why: "想玩麥塊", agenda: "g1" }]),
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
    const self = r.sup.services.require(SelfStateKey);
    const item = self.addAgenda({ text: "過來陪我玩麥塊" });

    const first = await r.think();
    expect(status(first)).toEqual([["game.start", "failed", "Minecraft 還沒開,沒辦法開始玩。"]]);
    expect(first.changes).toEqual(
      expect.arrayContaining([
        "暫停 game.start(Minecraft 還沒開,沒辦法開始玩。)",
        "議程「過來陪我玩麥塊」先擱著",
      ]),
    );
    expect(self.agenda()[0]).toMatchObject({
      id: item.id,
      blocked: { capability: "game.start", reason: "Minecraft 還沒開,沒辦法開始玩。" },
    });

    // Not retried while nothing changed; she sees it is on hold.
    await wait(2 * MIN);
    const second = await r.think();
    expect(status(second)[0]?.[1]).toBe("dropped");
    expect(status(second)[0]?.[2]).toContain("on hold until things change");
    expect(dataText(provider, 1)).toContain("暫時做不到的事");
    expect(dataText(provider, 1)).toContain("(暫時做不到:Minecraft 還沒開");
    expect(r.intents.intents).toHaveLength(1);

    // The game adapter starts publishing: the game runs now.
    gameRunning = true;
    r.publish(customEvent("game.minecraft.chat", { sender: "Steve", message: "hi" }));
    await wait(10);
    expect(self.agenda()[0]?.blocked).toBeNull();
    const third = await r.think();
    expect(status(third)).toEqual([["game.start", "done", "開始玩 Minecraft"]]);
    expect(r.intents.intents).toHaveLength(2);
  });

  it("tries a failed watch again when someone else goes live", async () => {
    const provider = new MockProvider("p").reply(
      reply([{ action: "watch.start", place: "p1", why: "想看直播" }]),
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
    await r.think(VOICE);
    await wait(2 * MIN);
    expect(status(await r.think(VOICE))[0]?.[2]).toContain("on hold");

    r.world.voiceMembers = [...r.world.voiceMembers, { account: AQUA, name: "阿夸", streaming: true }];
    await wait(2 * MIN);
    expect(status(await r.think(VOICE))[0]?.[1]).toBe("failed");
  });

  it("lifts the hold after blocked_retry_mins even if nothing visible changed", async () => {
    const provider = new MockProvider("p").reply(
      reply([{ action: "voice.join", place: "p1", why: "想進語音" }]),
    );
    const r = await manual(provider);
    r.intents.outcome = () => ({ status: "failed", detail: "voice node offline", turn: null });
    r.world.voiceMembers = [{ account: OWEN, name: "Owen" }];
    await r.think(VOICE);
    await wait(10 * MIN);
    expect(status(await r.think(VOICE))[0]?.[2]).toContain("on hold");
    await wait(21 * MIN);
    expect(status(await r.think(VOICE))[0]?.[1]).toBe("failed");
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
    expect(
      r
        .mind()
        .thoughts()
        .filter((t) => t.triggers.some((x) => x.kind === "voice_quiet")),
    ).toEqual([]);

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
    expect(
      r
        .mind()
        .thoughts()
        .some((t) => t.triggers.some((x) => x.kind === "voice_quiet")),
    ).toBe(false);

    // Whatever wakes her, she reads the channel as busy.
    r.mind().suggest({ source: "test", reason: "x", context: VOICE, hint: "看看", about: [] });
    await wait(5000);
    const n = provider.requests().length - 1;
    expect(dataText(provider, n)).toContain("正在聊天:最近 14 句(Owen、Aquatf),最後一句 5 秒前");
    expect(systemText(provider, n)).toContain("就不是冷場");
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
  it("a turn she started herself ending does not wake another thought", async () => {
    const provider = new MockProvider("p").reply(
      reply([{ action: "chat.start", place: "p1", why: "想聊天", opening: "嗨" }]),
    );
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
    // Her intent turn takes long to open (the channel was busy): it ends 6 minutes later.
    await wait(6 * MIN);
    spoke(r, "T1", TEXT, "嗨大家~");
    // An initiative turn (not through the mind) is hers too.
    r.publish({
      type: "agent_decision",
      data: {
        turn: "I1",
        context: TEXT,
        respond: true,
        score: 0,
        reasons: ["initiative:greeting"],
      },
    });
    r.publish({ type: "agent_turn_completed", data: { turn: "I1", context: TEXT, text: "早安" } });
    await wait(5000);
    expect(provider.requests()).toHaveLength(1);
  });

  it("a thought after her reply cannot start a conversation where she just spoke", async () => {
    const provider = new MockProvider("p").reply(
      reply([{ action: "chat.start", place: "p1", why: "繼續聊", opening: "對了" }]),
    );
    const r = await rig(provider, { config: { min_interval_secs: 0 } });
    // Her ordinary reply to someone.
    r.publish({
      type: "agent_decision",
      data: { turn: "R1", context: TEXT, respond: true, score: 0.9, reasons: ["direct: mention"] },
    });
    r.publish({ type: "agent_turn_completed", data: { turn: "R1", context: TEXT, text: "好啊" } });
    await wait(5000);
    const [thought] = r.mind().thoughts();
    expect(thought?.triggers.map((t) => t.kind)).toEqual(["turn"]);
    expect(status(thought as Thought)).toEqual([["chat.start", "dropped", "she just spoke there"]]);
    expect(r.intents.intents).toEqual([]);
  });
});

describe("channel levels", () => {
  it("are shown with the place, and a level that blocks her start drops the chat.start", async () => {
    const start = reply([{ action: "chat.start", place: "p1", why: "想聊天", opening: "大家好" }]);
    const provider = new MockProvider("p").reply(start).reply(start);
    const r = await manual(provider);
    let blocked: string | null = null;
    r.intents.levels = (c) =>
      c.kind === "voice" ? null : { mode: "quiet", label: "安靜", blocked };
    expect(status(await r.think())).toEqual([["chat.start", "started", "queued"]]);
    expect(dataText(provider, 0)).toContain("聊天等級「安靜」");
    expect(systemText(provider, 0)).toContain("「安靜」的頻道很少主動開口");

    blocked = "level quiet: she started talking here 0 min ago; next in 180 min";
    r.intents.intents.length = 0;
    // Past her own backoff, still inside the level's gap.
    await wait(11 * MIN);
    const second = await r.think();
    expect(dataText(provider, 1)).toContain("聊天等級「安靜」,現在不能主動開口");
    expect(status(second)).toEqual([["chat.start", "dropped", blocked]]);
    expect(r.intents.intents).toEqual([]);
  });
});
