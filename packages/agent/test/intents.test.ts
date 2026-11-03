// Her intents as turns she starts herself (principal `self`, with tools, through the gate), and
// her talkativeness steering attention in text and voice.

import { ActuatorRegistry, defaultActionsConfig, defineCapability } from "@miyoria/actions";
import { ServiceRegistry } from "@miyoria/kernel";
import { MockProvider } from "@miyoria/llm";
import { ToolRegistry } from "@miyoria/tools";
import {
  type AccountRef,
  type ContextKey,
  type EffectiveTalkativeness,
  type Event,
  type Intent,
  type IntentSink,
  IntentSinkKey,
  type JsonValue,
  MindKey,
  newId,
  type PlatformSink,
  PlatformSinks,
  PlatformSinksKey,
  type PlaybackState,
  type Principal,
  type SelfState,
  SelfStateKey,
  type TalkativenessInput,
  type TurnId,
  toTimestamp,
  type VoiceParticipant,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  account,
  channel,
  done,
  Harness,
  incoming,
  nextTs,
  noCheck,
  Paced,
  SlowProvider,
  stopHarnesses,
  toolCall,
  wait,
} from "./harness.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  await stopHarnesses();
  vi.useRealTimers();
});

const OWEN: AccountRef = account("Owen");
const AMY: AccountRef = account("200");
const DM: ContextKey = { platform: "test", scope: null, channel: "dm-amy", kind: "dm" };
const VOICE: ContextKey = { platform: "test", scope: "guild", channel: "vc", kind: "voice" };

/** `SelfState` with only the talkativeness part, recording what was set. */
class FakeSelf {
  level: number | null = null;
  readonly set: [string, TalkativenessInput][] = [];

  talkativeness(): EffectiveTalkativeness | null {
    if (this.level === null) return null;
    return { level: this.level, until: null, why: "", set_at: toTimestamp(0), scope: "*" };
  }

  setTalkativeness(scope: string, input: TalkativenessInput) {
    this.set.push([scope, input]);
    this.level = input.level;
    return { level: input.level, until: null, why: input.why, set_at: toTimestamp(0) };
  }

  asSelf(): SelfState {
    return this as unknown as SelfState;
  }
}

interface Rig {
  h: Harness;
  registry: ActuatorRegistry;
  intents: IntentSink;
  /** Principals the `test.wave` capability ran for. */
  waved: Principal[];
}

/** Agent with an app registry (tools shared), the `test.wave` tool and a DM-capable sink. */
async function rig(mode: string, config: JsonValue, chat: MockProvider | SlowProvider | Paced) {
  const tools = new ToolRegistry();
  const services = new ServiceRegistry();
  const sinks = new PlatformSinks();
  const sink: PlatformSink = {
    platform: "test",
    send: async (context) => ({ context, id: "m" }),
    react: async () => {},
    typing: async () => {},
    openDm: async () => DM,
  };
  sinks.register(sink);
  services.provide("app", PlatformSinksKey, sinks);
  const registry = new ActuatorRegistry({ services, tools, builtins: false });
  registry.configure({ ...defaultActionsConfig(), dm_strangers: true });
  const waved: Principal[] = [];
  registry.register(
    defineCapability({
      name: "test.wave",
      summary: "揮手",
      risk: "low",
      args: z.object({}),
      permission: null,
      tool: { name: "wave", description: "揮手", properties: {} },
      async execute(_args, ctx) {
        waved.push(ctx.principal);
        return "waved";
      },
    }),
  );
  registry.register(
    defineCapability({
      name: "voice.join",
      summary: "加入語音頻道",
      risk: "medium",
      args: z.object({ channel: z.string() }),
      permission: "voice.join",
      async execute(args) {
        return { text: `joined voice channel ${args.channel}`, data: { channel: args.channel } };
      },
    }),
  );
  const h = await Harness.build(mode, config, chat, null, {
    appTools: tools,
    actuators: registry,
    roll: 0.5,
  });
  const intents = h.sup.services.require(IntentSinkKey);
  return { h, registry, intents, waved } satisfies Rig;
}

function intent(capability: string, context: ContextKey | null, extra: Partial<Intent> = {}) {
  const now = Date.now();
  return {
    id: newId(),
    capability,
    args: {},
    why: "想找大家聊天",
    opening: "欸,你們在聊什麼",
    context,
    about: null,
    created_at: toTimestamp(now),
    expires_at: toTimestamp(now + 120_000),
    ...extra,
  } satisfies Intent;
}

function playback(turn: TurnId, state: PlaybackState, text: string): Event {
  return { type: "voice_playback", data: { context: VOICE, turn, state, text } };
}

function member(id: string, isSelf: boolean): VoiceParticipant {
  return { account: account(id), display_name: id, is_self: isSelf, muted: false, deafened: false };
}

function joined(): Event {
  return {
    type: "voice_joined",
    // Two people besides her: a group, not a one-on-one (where everything is said to her).
    data: {
      context: VOICE,
      participants: [member("Owen", false), member("阿明", false), member("her", true)],
    },
  };
}

function utterance(who: string, text: string): Event {
  const now = nextTs();
  return {
    type: "voice_utterance",
    data: {
      id: newId(),
      context: VOICE,
      speaker: { account: account(who), display_name: who, is_bot: false },
      text,
      language: "zh",
      emotion: null,
      audio_events: [],
      started_at: toTimestamp(now - 1000),
      ended_at: toTimestamp(now),
      asr_ms: 200,
    },
  };
}

describe("intents", () => {
  it("open a turn she starts herself, with tools that run as `self` through the gate", async () => {
    const chat = new MockProvider("chat")
      .events([toolCall(0, "c1", "wave", "{}"), done()])
      .reply("嗨大家!");
    const r = await rig("ambient", noCheck(), chat);
    const c = channel("c");
    const outcome = await r.intents.submit(intent("chat.start", c));
    expect(outcome.status).toBe("started");
    await wait(100);
    expect(r.h.sink.sent()).toEqual([["嗨大家!", "initiative"]]);
    expect(r.waved.map((p) => p.kind)).toEqual(["self"]);
    const [first] = chat.requests();
    expect(first?.tools?.map((t) => t.name)).toContain("wave");
    // Her plan is data (user role); the system messages carry none of it.
    const system = first?.messages.filter((m) => m.role === "system").map((m) => m.content);
    expect(system?.join("\n")).not.toContain("你們在聊什麼");
    const data = first?.messages.find(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("你的打算"),
    );
    expect(data?.content).toContain("欸,你們在聊什麼");
    const trace = r.h.traces().find((t) => t.turn === outcome.turn);
    expect(trace?.reasons).toContain("intent:chat.start");
  });

  it("are told what she raised there that nobody picked up, as her own state", async () => {
    const chat = new MockProvider("chat").reply("換個話題好了。");
    const r = await rig("ambient", noCheck(), chat);
    const c = channel("c");
    const asked: (ContextKey | null)[] = [];
    r.h.sup.services.provide("mind", MindKey, {
      accepting: true,
      suggest: () => false,
      thoughts: () => [],
      stats: () => ({}) as never,
      unanswered: (context) => {
        asked.push(context);
        return [
          { text: "那個 bypass 別找了啦", context: c, at: toTimestamp(0), status: "ignored" },
        ];
      },
    });
    await r.intents.submit(intent("chat.start", c));
    await wait(100);
    expect(asked).toEqual([c]);
    const system = chat
      .requests()[0]
      ?.messages.filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    expect(system).toContain(
      "你最近在這裡自己提過、沒人接的話題:「那個 bypass 別找了啦」。一陣子內不要再提",
    );
  });

  it("wait for a turn in flight and drop when expired", async () => {
    // The turn in flight stays quiet (an empty reply after 2s).
    const chat = new Paced([[[2000, done()]]]);
    const r = await rig("always", noCheck(), chat);
    const c = channel("c");
    r.h.say(incoming(c, "Owen", "在嗎"));
    await wait(1600);
    expect(chat.requests.length).toBe(1);
    expect((await r.intents.submit(intent("chat.start", c))).status).toBe("started");
    await wait(500);
    expect(chat.requests.length, "does not interrupt the turn").toBe(1);
    await wait(2000);
    expect(chat.requests.length, "starts once the context is free").toBe(2);
    expect(JSON.stringify(chat.requests[1]?.messages)).toContain("你的打算");

    const stale = intent("chat.start", c, { expires_at: toTimestamp(Date.now() - 1) });
    expect(await r.intents.submit(stale)).toMatchObject({ status: "dropped", detail: "expired" });
  });

  it("are dropped when she answered there while they waited", async () => {
    const chat = new SlowProvider(2000);
    const r = await rig("always", noCheck(), chat);
    const c = channel("c");
    r.h.say(incoming(c, "Owen", "在嗎"));
    await wait(1600);
    const waiting = await r.intents.submit(intent("chat.start", c));
    expect(waiting.status).toBe("started");
    await wait(3000);
    expect(r.h.sink.texts()).toEqual(["reply 1"]);
    expect(chat.calls, "decided before her answer: not said after it").toBe(1);
    const trace = r.h.traces().find((t) => t.turn === waiting.turn);
    expect(trace?.reasons).toEqual(["intent:chat.start", "skipped: she just answered here"]);
  });

  it("wait in voice until her speech played", async () => {
    const chat = new MockProvider("chat").reply("好啊。等我一下。").reply("欸,你們在聊什麼");
    const config = { attention: { llm_check: false }, voice: { default_mode: "always" } };
    const r = await rig("ambient", config, chat);
    r.h.publish(joined());
    await wait(10);
    r.h.publish(utterance("Owen", "要唱歌嗎"));
    await wait(3000);
    expect(r.h.sink.speeches().map(([t]) => t)).toEqual(["好啊。", "等我一下。"]);
    const turn = r.h.sink.speakActions()[0]?.turn as TurnId;
    r.h.publish(playback(turn, "started", "好啊。"));
    await wait(10);
    expect((await r.intents.submit(intent("chat.start", VOICE))).status).toBe("started");
    await wait(100);
    r.h.publish(playback(turn, "finished", "好啊。"));
    r.h.publish(playback(turn, "started", "等我一下。"));
    await wait(100);
    expect(chat.requests().length, "not over her own speech").toBe(1);
    r.h.publish(playback(turn, "finished", "等我一下。"));
    await wait(100);
    expect(chat.requests().length, "starts once she is done").toBe(2);
    expect(r.h.sink.speeches().at(-1)?.[0]).toBe("欸,你們在聊什麼");
  });

  it("respect the approach and DM opt-outs and the channel mode", async () => {
    const r = await rig("ambient", noCheck(), new MockProvider("chat").reply("嗨"));
    const c = channel("c");
    await r.registry.privacy.set(OWEN, { approach: false });
    const approach = await r.intents.submit(intent("chat.start", c, { about: OWEN }));
    expect(approach).toMatchObject({ status: "denied" });
    expect(approach.detail).toContain("approached");
    await r.registry.privacy.set(AMY, { dm: false });
    const dm = await r.intents.submit(intent("chat.dm", c, { args: { to: "200" } }));
    expect(dm).toMatchObject({ status: "denied", detail: "the person opted out of DMs from her" });

    await r.registry.privacy.set(AMY, { dm: true });
    expect((await r.intents.submit(intent("chat.dm", c, { args: { to: "200" } }))).status).toBe(
      "started",
    );
    await wait(100);
    const dmSent = r.h.sink.actions.filter(
      (a) => a.payload.type === "send_message" && a.payload.context.channel === DM.channel,
    );
    expect(dmSent.length).toBe(1);

    await r.h.handle().setChannelMode(channel("quiet"), "mention-only");
    const quiet = await r.intents.submit(intent("chat.start", channel("quiet")));
    expect(quiet.status).toBe("failed");
    expect(quiet.detail).toContain("mention-only");
  });

  it("join voice first, then greet there once she arrived", async () => {
    const chat = new MockProvider("chat").reply("我只是剛好路過喔。");
    const r = await rig("ambient", noCheck(), chat);
    const join = intent("voice.join", channel("c"), {
      args: { channel: "vc" },
      opening: "假裝剛好路過",
    });
    const outcome = await r.intents.submit(join);
    expect(outcome).toMatchObject({ status: "started", detail: "joined voice channel vc" });
    await wait(100);
    expect(r.h.sink.speeches()).toEqual([]);
    r.h.publish(joined());
    await wait(100);
    expect(r.h.sink.speeches().map(([t]) => t)).toEqual(["我只是剛好路過喔。"]);
    const data = JSON.stringify(chat.requests()[0]?.messages);
    expect(data).toContain("你已經做了:加入語音頻道");
  });
});

describe("talkativeness", () => {
  it("decides whether she joins in in text", async () => {
    const chat = new MockProvider("chat").reply("我也覺得");
    const config = { attention: { llm_check: false, cooldown_ms: 0 } };
    const r = await rig("lively", config, chat);
    const self = new FakeSelf();
    r.h.sup.services.provide("self", SelfStateKey, self.asSelf());
    const c = channel("c");
    r.h.say(incoming(c, "Owen", "哈哈"));
    await wait(3000);
    expect(r.h.decisions(), "unset: the configured numbers").toEqual([false]);
    self.level = 1;
    r.h.say(incoming(c, "Owen", "哈哈"));
    await wait(3000);
    const [trace] = r.h.traces();
    expect(trace?.respond, trace?.reasons.join("; ")).toBe(true);
    expect(trace?.reasons.some((x) => x.startsWith("talkativeness 1.00"))).toBe(true);
    self.level = 0;
    r.h.say(incoming(c, "Owen", "鯨魚是什麼?"));
    await wait(3000);
    expect(r.h.traces()[0]?.reasons).toContain("she wants to stay quiet here");
  });

  it("makes her join a voice conversation, and `channel_activeness` sets it", async () => {
    const chat = new MockProvider("chat")
      .events([
        toolCall(0, "c1", "channel_activeness", '{"level": "high", "on_own": true}'),
        done(),
      ])
      .reply("好啊我多說點")
      .reply("我們可以去吃拉麵");
    const config = { attention: { llm_check: false }, voice: { cooldown_ms: 0 } };
    const r = await rig("ambient", config, chat);
    const self = new FakeSelf();
    r.h.sup.services.provide("self", SelfStateKey, self.asSelf());
    r.h.publish(joined());
    await wait(10);
    r.h.publish(utterance("Owen", "我們等一下要去吃飯"));
    await wait(3000);
    expect(r.h.decisions(), "unset: 0.5 × the voice factor").toEqual([false]);

    // Someone asks her to liven up: she sets it herself, for this voice channel.
    r.h.publish(utterance("Owen", "DeepSeek 你可以活躍一點嗎"));
    await wait(3000);
    expect(self.set.map(([scope, t]) => [scope, t.level])).toEqual([["test:guild:voice:vc", 0.85]]);
    // (Her reply never "plays" here; once its speech TTL passed it no longer counts as queued.)
    await wait(31_000);
    r.h.drain();
    // The scripted roll is 0.5; with her talkativeness up she now joins in.
    r.h.publish(utterance("Owen", "我們等一下要去吃飯"));
    await wait(3000);
    const decisions = r.h.traces();
    expect(decisions.at(-1)?.respond, decisions.at(-1)?.reasons.join("; ")).toBe(true);
    expect(r.h.sink.speeches().map(([t]) => t)).toContain("我們可以去吃拉麵");
  });
});

describe("channel levels", () => {
  const initiative = (context: ContextKey, reason: string): Event => ({
    type: "agent_initiative",
    data: { context, reason, hint: "", about: [] },
  });

  it("quiet bounds her own starts there: intents and initiative, not game commentary", async () => {
    const chat = new MockProvider("chat").reply("欸大家").reply("這關好難").reply("我又來了");
    const config = { attention: { llm_check: false, cooldown_ms: 0 } };
    const r = await rig("quiet", config, chat);
    const c = channel("c");
    expect(r.intents.ceiling?.(c)).toEqual({ mode: "quiet", label: "安靜", blocked: null });
    expect(r.intents.ceiling?.(VOICE)).toBeNull();

    expect((await r.intents.submit(intent("chat.start", c))).status).toBe("started");
    await wait(100);
    expect(r.h.sink.texts()).toEqual(["欸大家"]);
    // She is told the channel's level (system: the owner's setting).
    const system = chat
      .requests()[0]
      ?.messages.filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    expect(system).toContain("這個頻道的聊天等級是「安靜」");

    // Past `chat.start`'s own cooldown, but within the level's gap.
    await wait(2 * 60_000);
    expect(r.intents.ceiling?.(c)?.blocked).toMatch(/^level quiet: .*next in \d+ min$/);
    const again = await r.intents.submit(intent("chat.start", c));
    expect(again.status).toBe("failed");
    expect(again.detail).toContain("level quiet");
    r.h.drain();
    r.h.publish(initiative(c, "idle_channel"));
    await wait(100);
    expect(r.h.traces().at(-1)?.reasons[1]).toMatch(/^skipped: level quiet/);
    // Live game commentary is not her starting a conversation.
    r.h.publish(initiative(c, "game"));
    await wait(100);
    expect(r.h.sink.texts()).toEqual(["欸大家", "這關好難"]);

    // A normal channel has no gap of its own.
    await r.h.handle().setChannelMode(channel("n"), "normal");
    expect(r.intents.ceiling?.(channel("n"))).toEqual({
      mode: "normal",
      label: "一般",
      blocked: null,
    });

    await wait(3 * 60 * 60_000);
    expect((await r.intents.submit(intent("chat.start", c))).status).toBe("started");
    await wait(100);
    expect(r.h.sink.texts().at(-1)).toBe("我又來了");
  });
});
