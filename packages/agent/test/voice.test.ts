// Port of `tests/voice.rs`: utterances in, `speak` actions out. Playback events that the voice
// module would publish are simulated by the tests.

import { CommandRegistryKey } from "@miyoria/commands";
import { MockProvider } from "@miyoria/llm";
import {
  type ContextKey,
  type Event,
  type PlaybackState,
  type TurnId,
  toTimestamp,
  type VoiceParticipant,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentTurns } from "../src/metrics.js";
import {
  account,
  channel,
  command,
  done,
  Harness,
  incoming,
  nextTs,
  Paced,
  Probe,
  stopHarnesses,
  textDelta,
  wait,
} from "./harness.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  await stopHarnesses();
  vi.useRealTimers();
});

function voiceCtx(): ContextKey {
  return { platform: "test", scope: "guild", channel: "vc", kind: "voice" };
}

/** No LLM check, no cooldown; `mode` is the voice default mode. */
function voiceConfig(mode: string) {
  return { attention: { llm_check: false }, voice: { default_mode: mode, cooldown_ms: 0 } };
}

function member(id: string, isSelf: boolean): VoiceParticipant {
  return { account: account(id), display_name: id, is_self: isSelf, muted: false, deafened: false };
}

function joined(): Event {
  return {
    type: "voice_joined",
    data: {
      context: voiceCtx(),
      participants: [member("Owen", false), member("阿明", false), member("her", true)],
    },
  };
}

let nextUtterance = 0;

function utterance(who: string, text: string): Event {
  const n = nextUtterance++;
  const now = nextTs();
  return {
    type: "voice_utterance",
    data: {
      id: `u${n}`,
      context: voiceCtx(),
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

function speaking(who: string, on: boolean): Event {
  return {
    type: "voice_speaking",
    data: { context: voiceCtx(), account: account(who), speaking: on },
  };
}

function playback(turn: TurnId, state: PlaybackState, text: string): Event {
  return { type: "voice_playback", data: { context: voiceCtx(), turn, state, text } };
}

function texts(h: Harness): string[] {
  return h.sink.speeches().map(([t]) => t);
}

function decisionReasons(h: Harness): [boolean, string[]][] {
  return h.traces().map((d) => [d.respond, d.reasons]);
}

function completedTexts(h: Harness): string[] {
  return h
    .drain()
    .flatMap((e) => (e.event.type === "agent_turn_completed" ? [e.event.data.text] : []));
}

describe("voice", () => {
  it("a spoken promise of a song gets the reminder too", async () => {
    const mock = new MockProvider("chat")
      .reply("好啦,這首我會去抓,等我一下。")
      .events([
        {
          type: "tool_call_delta",
          index: 0,
          id: "c1",
          name: "sing_request",
          arguments: '{"query":"朋友的酒"}',
        },
        { type: "done", finish_reason: "tool_calls", usage: null },
      ])
      .reply("");
    const sing = new Probe("sing_request");
    const h = await Harness.build("off", voiceConfig("always"), mock, null, { tools: [sing] });
    h.publish(joined());
    h.publish(utterance("Owen", "唱朋友的酒"));
    await wait(1500);
    expect(sing.calls).toHaveLength(1);
  });

  it("utterances_are_debounced_and_merged", async () => {
    const mock = new MockProvider("chat").reply("<emo:happy>考完啦?辛苦了。");
    const h = await Harness.create("off", voiceConfig("always"), mock);
    h.publish(joined());
    h.publish(utterance("Owen", "我跟你說"));
    await wait(400);
    h.publish(utterance("Owen", "今天考試考完了"));
    await wait(500);
    expect(mock.requests(), "the speaker may continue").toEqual([]);
    await wait(400);

    const requests = mock.requests();
    expect(requests.length).toBe(1);
    const msgs = requests[0]?.messages ?? [];
    expect(msgs.length).toBe(4);
    expect(msgs[1]?.content).toBe("Owen(語音): 我跟你說\nOwen(語音): 今天考試考完了");
    expect(msgs[2]?.role).toBe("user");
    expect(msgs[2]?.content).toContain("標題=語音頻道裡的人⟧\nOwen、阿明");
    const situation = msgs[3]?.content ?? "";
    expect(situation).toContain("一到兩句");
    // Spoken replies start right away: no thinking.
    expect(requests[0]?.thinking).toBe(false);
    expect(requests[0]?.tools, "no `react` in voice").toEqual([]);

    expect(h.sink.speeches()).toEqual([
      ["考完啦?", "happy"],
      ["辛苦了。", "happy"],
    ]);
    const actions = h.sink.speakActions();
    expect(actions.every((a) => a.lane === "voice:test:guild")).toBe(true);
    expect(actions.every((a) => a.priority === "initiative")).toBe(true);
    expect(actions.every((a) => a.turn !== null)).toBe(true);
    expect(h.sink.texts()).toEqual([]);
    expect(h.sink.typing()).toBe(0);
    expect(completedTexts(h)).toEqual(["考完啦?辛苦了。"]);
  });

  it("no_reply_while_someone_is_speaking", async () => {
    const mock = new MockProvider("chat").reply("我看過喔。");
    const cfg = voiceConfig("ambient");
    // interrupt_scale 0: never join in over someone (the default only lowers the chance).
    const h = await Harness.create(
      "off",
      { ...cfg, voice: { ...cfg.voice, interrupt_scale: 0 } },
      mock,
    );
    h.publish(joined());

    // Speaking extends the debounce: the turn waits for the transcript.
    h.publish(utterance("Owen", "你們看過鯨魚嗎?"));
    await wait(300);
    h.publish(speaking("阿明", true));
    await wait(900);
    h.publish(speaking("阿明", false));
    await wait(500);
    expect(decisionReasons(h), "turn started too early").toEqual([]);
    await wait(300);
    let decisions = decisionReasons(h);
    expect(decisions.length).toBe(1);
    expect(decisions[0]?.[0], decisions[0]?.[1].join("; ")).toBe(true);
    expect(texts(h)).toEqual(["我看過喔。"]);

    // Someone keeps talking: at the cap she still does not join in.
    h.publish(speaking("阿明", true));
    h.publish(utterance("Owen", "那海豚呢?"));
    await wait(2000);
    expect(decisionReasons(h)).toEqual([]);
    await wait(600);
    decisions = decisionReasons(h);
    expect(decisions.length).toBe(1);
    expect(decisions[0]?.[0]).toBe(false);
    expect(decisions[0]?.[1]).toContain("someone is speaking");
    expect(mock.requests().length).toBe(1);
  });

  it("direct_address_by_nickname_in_transcript", async () => {
    const mock = new MockProvider("chat").reply("幹嘛啦。");
    const h = await Harness.create("always", voiceConfig("mention-only"), mock);
    h.publish(joined());
    for (const [who, said] of [
      ["Owen", "今天好熱"],
      ["阿明", "小鯨魚妳覺得呢"],
      ["Owen", "deep seek 在嗎"],
    ] as const) {
      h.publish(utterance(who, said));
      await wait(3000);
    }
    expect(h.decisions()).toEqual([false, true, true]);
    const actions = h.sink.speakActions();
    expect(actions.length).toBe(2);
    expect(actions.every((a) => a.priority === "direct")).toBe(true);

    // A question right after she spoke is for her too.
    const turn = actions[1]?.turn as TurnId;
    h.publish(playback(turn, "started", "幹嘛啦。"));
    h.publish(playback(turn, "finished", "幹嘛啦。"));
    h.publish(utterance("Owen", "妳在幹嘛?"));
    await wait(3000);
    expect(h.decisions()).toEqual([true]);
    const last = mock.requests().at(-1);
    const msgs = last?.messages ?? [];
    expect(msgs[msgs.length - 4]?.content).toBe("幹嘛啦。");
  });

  it("the_voice_gray_zone_check_never_thinks_text_checks_follow_config", async () => {
    const chat = new MockProvider("chat").reply("鯨魚最大。");
    const fast = new MockProvider("fast").reply('{"respond": true, "reason": "她的話題"}');
    const config = {
      attention: { keywords: ["鯨魚"], llm_yes_probability: 1.0, cooldown_ms: 0 },
      voice: { default_mode: "ambient", cooldown_ms: 0, llm_check: true, gray_low: 0 },
    };
    const h = await Harness.build("ambient", config, chat, fast, {
      thinking: new Map([
        ["fast", true],
        ["chat", true],
      ]),
    });
    h.publish(joined());
    h.publish(utterance("Owen", "你們看過鯨魚嗎?"));
    await wait(3000);
    expect(fast.requests().length).toBeGreaterThan(0);
    expect(fast.requests()[0]?.thinking, "voice check").toBe(false);

    h.say(incoming(channel("t"), "阿明", "鯨魚跟海豚哪個大?"));
    await wait(3000);
    const text = fast.requests().at(-1);
    expect(fast.requests().length).toBeGreaterThan(1);
    expect(text?.thinking, "text check uses [llm.thinking]").toBe(true);
  });

  it("sentences_are_spoken_while_the_model_still_streams", async () => {
    const paced = new Paced([
      [
        [0, textDelta("<emo:smug>哼,才不是在等你呢。")],
        [1000, textDelta("你回來啦?<emo:happy>")],
        [1000, textDelta("好啦好啦。")],
        [5000, done()],
      ],
    ]);
    const h = await Harness.create("off", voiceConfig("always"), paced);
    h.publish(joined());
    h.publish(utterance("Owen", "我回來了"));
    // The turn starts at 0.7s; chunks at 0.7s, 1.7s and 2.7s; done at 7.7s.
    await wait(1200);
    expect(h.sink.speeches(), "the end mark may continue").toEqual([]);
    await wait(1000);
    expect(h.sink.speeches()).toEqual([
      ["哼,才不是在等你呢。", "smug"],
      ["你回來啦?", "smug"],
    ]);
    await wait(1000);
    expect(h.sink.speeches().length, "held until more text or the end").toBe(2);
    expect(h.drain().some((e) => e.event.type === "agent_turn_completed")).toBe(false);
    await wait(5000);
    const all = h.sink.speeches();
    expect(all.length).toBe(3);
    expect(all[2]).toEqual(["好啦好啦。", "happy"]);
    const turns = h.sink.speakActions().map((a) => a.turn);
    expect(turns.every((t) => t === turns[0])).toBe(true);
  });

  it("queued_sentences_are_announced_to_the_voice_sink", async () => {
    const prepared: [ContextKey, string][] = [];
    const voiceSink = {
      prepare: (context: ContextKey, text: string) => prepared.push([context, text]),
      speak: async () => "completed" as const,
    };
    const mock = new MockProvider("chat").reply("<emo:smug>哼,才不是在等你呢。你回來啦?");
    const h = await Harness.build("off", voiceConfig("always"), mock, null, { voiceSink });
    h.publish(joined());
    h.publish(utterance("Owen", "我回來了"));
    await wait(3000);
    expect(texts(h)).toEqual(["哼,才不是在等你呢。", "你回來啦?"]);
    expect(prepared.map(([, t]) => t)).toEqual(texts(h));
    expect(prepared[0]?.[0]).toEqual(voiceCtx());
  });

  it("voice_lines_go_to_the_sink_with_the_written_text_and_ask_for_them", async () => {
    const prepared: [string, string | undefined][] = [];
    const voiceSink = {
      speaksIn: "Japanese",
      prepare: (_c: ContextKey, text: string, spoken?: string) => prepared.push([text, spoken]),
      speak: async () => "completed" as const,
    };
    const mock = new MockProvider("chat").reply(
      "<voice>えっ、本当に?</voice><emo:happy>欸,真的嗎?<voice>じゃあ行こう!</voice>那走吧!最後一句沒有日文。",
    );
    const h = await Harness.build("off", voiceConfig("always"), mock, null, { voiceSink });
    h.publish(joined());
    h.publish(utterance("Owen", "我中樂透了"));
    await wait(3000);
    // The written text only (subtitles, log); each spoken line goes with its text.
    expect(texts(h)).toEqual(["欸,真的嗎?", "那走吧!最後一句沒有日文。"]);
    expect(prepared).toEqual([
      ["欸,真的嗎?", "えっ、本当に?"],
      ["那走吧!最後一句沒有日文。", "じゃあ行こう!"],
    ]);
    expect(h.sink.speeches()[0]).toEqual(["欸,真的嗎?", "happy"]);
    const prompt = JSON.stringify(mock.requests()[0]?.messages);
    expect(prompt).toContain("<voice>");
    expect(prompt).toContain("用 Japanese 念出來");
  });

  it("voice_lines_after_their_written_sentence_go_with_it", async () => {
    const prepared: [string, string | undefined][] = [];
    const voiceSink = {
      speaksIn: "Japanese",
      prepare: (_c: ContextKey, text: string, spoken?: string) => prepared.push([text, spoken]),
      speak: async () => "completed" as const,
    };
    const mock = new MockProvider("chat").reply(
      "欸,真的嗎?好厲害!<voice>えっ、本当に?すごい!</voice><emo:happy>那走吧!<voice>じゃあ行こう!</voice><voice>誰も書いてない</voice>",
    );
    const h = await Harness.build("off", voiceConfig("always"), mock, null, { voiceSink });
    h.publish(joined());
    h.publish(utterance("Owen", "我中樂透了"));
    await wait(3000);
    // Two written sentences share one line; a line nobody wrote down is not said.
    expect(prepared).toEqual([
      ["欸,真的嗎?好厲害!", "えっ、本当に?すごい!"],
      ["那走吧!", "じゃあ行こう!"],
    ]);
    expect(h.sink.speeches()).toEqual([
      ["欸,真的嗎?好厲害!", null],
      ["那走吧!", "happy"],
    ]);
  });

  it("a_bilingual_reply_without_voice_lines_is_still_said_sentence_by_sentence", async () => {
    const prepared: [string, string | undefined][] = [];
    const voiceSink = {
      speaksIn: "Japanese",
      prepare: (_c: ContextKey, text: string, spoken?: string) => prepared.push([text, spoken]),
      speak: async () => "completed" as const,
    };
    const mock = new MockProvider("chat").reply("一。二。三。四。");
    const h = await Harness.build("off", voiceConfig("always"), mock, null, { voiceSink });
    h.publish(joined());
    h.publish(utterance("Owen", "數數看"));
    await wait(3000);
    expect(prepared).toEqual([
      ["一。", undefined],
      ["二。", undefined],
      ["三。", undefined],
      ["四。", undefined],
    ]);
  });

  it("first_token_latency_is_published_for_the_monitor", async () => {
    const paced = new Paced([
      [
        [640, textDelta("好啊。")],
        [200, textDelta("走吧。")],
        [0, done()],
      ],
    ]);
    const h = await Harness.create("off", voiceConfig("always"), paced);
    const latency = h.sup.bus.subscribe("voice.latency");
    const responded = agentTurns.get({ decision: "responded" });
    h.publish(joined());
    h.publish(utterance("Owen", "要不要去吃飯"));
    await wait(3000);
    expect(texts(h)).toEqual(["好啊。", "走吧。"]);
    const env = latency.tryRecv();
    expect(env?.event).toEqual({
      type: "custom",
      data: {
        topic: "voice.latency",
        payload: {
          stage: "llm",
          context: voiceCtx(),
          turn: env?.correlation ?? null,
          model: "chat:m",
          first_token_ms: 640,
        },
      },
    });
    expect(env?.correlation).not.toBeNull();
    expect(latency.tryRecv(), "once per turn").toBeNull();
    expect(agentTurns.get({ decision: "responded" })).toBe(responded + 1);
    latency.close();
  });

  it("silence_and_unspeakable_replies_say_nothing", async () => {
    const mock = new MockProvider("chat")
      .reply("<silence/>")
      .reply("<emo:sad>……")
      .reply("DeepSeek-chan: 好啦。");
    const h = await Harness.create("off", voiceConfig("always"), mock);
    h.publish(joined());
    for (const said of ["一", "二", "三"]) {
      h.publish(utterance("Owen", said));
      await wait(3000);
    }
    expect(mock.requests().length).toBe(3);
    expect(texts(h)).toEqual(["好啦。"]);
    expect(completedTexts(h)).toEqual(["", "", "好啦。"]);
  });

  it("utterance_before_playback_cancels_and_regenerates", async () => {
    const mock = new MockProvider("chat")
      .reply("第一個回答。")
      .reply("第二個回答。")
      .reply("第三個回答。");
    const h = await Harness.create("off", voiceConfig("always"), mock);
    h.publish(joined());
    h.publish(utterance("Owen", "一"));
    await wait(2000);
    const first = h.sink.speakActions()[0]?.turn as TurnId;
    // Her answer is queued but has not started playing yet.
    h.publish(utterance("Owen", "二"));
    await wait(2000);
    expect(h.sink.cancelled).toEqual([first]);
    let requests = mock.requests();
    expect(requests.length).toBe(2);
    expect(requests[1]?.messages[1]?.content).toBe("Owen(語音): 一\nOwen(語音): 二");

    // Once playback started, new input waits for a turn of its own.
    const second = h.sink.speakActions()[1]?.turn as TurnId;
    expect(second).not.toBe(first);
    h.publish(playback(second, "started", "第二個回答。"));
    await wait(100);
    h.publish(utterance("Owen", "三"));
    await wait(2000);
    expect(h.sink.cancelled).toEqual([first]);
    requests = mock.requests();
    expect(requests.length).toBe(3);
    const msgs = requests[2]?.messages ?? [];
    expect(msgs.slice(1, -2).map((m) => [m.role, m.content])).toEqual([
      ["user", "Owen(語音): 一\nOwen(語音): 二"],
      ["assistant", "第二個回答。"],
      ["user", "Owen(語音): 三"],
    ]);
  });

  it("interrupted_playback_stops_further_sentences", async () => {
    const paced = new Paced([
      [
        [0, textDelta("第一句。")],
        [1000, textDelta("第二句。")],
        [1000, textDelta("第三句。")],
        [1000, textDelta("第四句。")],
        [0, done()],
      ],
      [
        [0, textDelta("好啦。")],
        [0, done()],
      ],
    ]);
    const h = await Harness.create("off", voiceConfig("always"), paced);
    h.publish(joined());
    h.publish(utterance("Owen", "講個故事"));
    // Turn at 0.7s; "第一句。" is complete when the second chunk arrives (1.7s).
    await wait(1900);
    expect(texts(h)).toEqual(["第一句。"]);
    const turn = h.sink.speakActions()[0]?.turn as TurnId;
    h.publish(playback(turn, "started", "第一句。"));
    h.publish(playback(turn, "interrupted", "第一句。"));
    await wait(5000);
    expect(texts(h)).toEqual(["第一句。"]);
    expect(h.sink.cancelled).toEqual([turn]);

    // She knows she was cut off.
    h.publish(utterance("Owen", "抱歉妳繼續"));
    await wait(2000);
    expect(paced.requests.length).toBe(2);
    const msgs = paced.requests[1]?.messages ?? [];
    expect(msgs[2]?.role).toBe("assistant");
    expect(msgs[2]?.content).toBe("第一句。(被打斷)");
    expect(texts(h)).toEqual(["第一句。", "好啦。"]);
  });

  it("leaving_voice_clears_the_session", async () => {
    const mock = new MockProvider("chat").reply("嗯。");
    const h = await Harness.create("off", voiceConfig("always"), mock);
    h.publish(joined());
    h.publish(utterance("Owen", "舊的話"));
    await wait(2000);
    h.publish({ type: "voice_left", data: { context: voiceCtx(), reason: null } });
    await wait(10);
    expect(h.handle().voiceContext("test", "guild")).toBeNull();
    h.publish(joined());
    h.publish(utterance("Owen", "新的話"));
    await wait(2000);
    const requests = mock.requests();
    expect(requests.length).toBe(2);
    expect(requests[1]?.messages[1]?.content).toBe("Owen(語音): 新的話");
  });

  it("voice_mode_command", async () => {
    const mock = new MockProvider("chat").reply("嗯。");
    const h = await Harness.build("ambient", voiceConfig("ambient"), mock, null, {
      owners: ["test:Owen"],
    });
    const reg = h.sup.services.require(CommandRegistryKey);
    const handle = h.handle();
    const run = (inv: ReturnType<typeof command>) => reg.dispatch(inv);
    // Sent from a text channel of the guild.
    const notIn = await run(command("voice mode", "Owen"));
    expect(notIn.tone === "warn" && notIn.text.includes("語音"), notIn.text).toBe(true);

    h.publish(joined());
    await wait(10);
    const shown = await run(command("voice mode", "Owen"));
    expect(shown.text).toContain("`normal`");
    expect(shown.text).toContain("（預設）");

    const denied = await run(command("voice mode", "阿明", { mode: "off" }));
    expect(denied.text).toContain("admin.voice.mode");

    await run(command("voice mode", "Owen", { mode: "mention-only" }));
    const v = voiceCtx();
    expect(handle.channelMode(v)).toBe("mention-only");
    expect(handle.channelMode(channel("c"))).toBe("normal");
    // The mode applies to the voice context.
    h.publish(utterance("Owen", "你們看過鯨魚嗎?"));
    await wait(3000);
    expect(h.decisions()).toEqual([false]);

    const reset = await run(command("voice mode", "Owen", { mode: "reset" }));
    expect(reset.text).toContain("`normal`");
    expect(handle.channelModeOverride(v)).toBeNull();

    h.publish({ type: "voice_left", data: { context: v, reason: "kicked" } });
    await wait(10);
    expect((await run(command("voice mode", "Owen"))).tone).toBe("warn");
  });
});
