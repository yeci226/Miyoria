// Context she did not see live (backfill, reply chains), images, voice-channel text chat and
// user mentions, through the real agent module with fake platform services. No network.

import { contentText, hasImages, MockProvider } from "@miyoria/llm";
import { type LogEntry, type MessageLog, MessageLogKey } from "@miyoria/store";
import {
  type AccountRef,
  type Attachment,
  type ContextKey,
  type Event,
  type HistoryQuery,
  type IncomingMessage,
  type MessageRef,
  PlatformHistories,
  PlatformHistoriesKey,
  type PlatformHistory,
  type PlatformSink,
  PlatformSinks,
  PlatformSinksKey,
  toTimestamp,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FetchLike } from "../src/index.js";
import {
  account,
  channel,
  done,
  Harness,
  incoming,
  mention,
  noCheck,
  type Setup,
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

/** A message `minutesAgo` before now, with a fixed id. */
function past(ctx: ContextKey, id: string, who: string, text: string, minutesAgo: number) {
  return {
    ...incoming(ctx, who, text),
    id: { context: ctx, id },
    ts: toTimestamp(Date.now() - minutesAgo * 60_000),
  };
}

class FakeHistory implements PlatformHistory {
  readonly platform = "test";
  readonly queries: [ContextKey, HistoryQuery][] = [];
  readonly fetched: string[] = [];
  delayMs = 0;

  constructor(
    readonly earlier: IncomingMessage[] = [],
    readonly byId: Map<string, IncomingMessage> = new Map(),
  ) {}

  async recent(context: ContextKey, query: HistoryQuery): Promise<IncomingMessage[]> {
    this.queries.push([context, query]);
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    return this.earlier.slice(-query.limit);
  }

  async fetch(ref: MessageRef): Promise<IncomingMessage | null> {
    this.fetched.push(ref.id);
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    return this.byId.get(ref.id) ?? null;
  }
}

function withHistory(history: PlatformHistory, extra: Setup = {}): Setup {
  return {
    ...extra,
    provide: (services) => {
      const histories = new PlatformHistories();
      histories.register(history);
      services.provide("app", PlatformHistoriesKey, histories);
      extra.provide?.(services);
    },
  };
}

function historyText(mock: MockProvider, n = 0): string {
  const msgs = mock.requests()[n]?.messages ?? [];
  return msgs
    .slice(1, -2)
    .map((m) => contentText(m.content))
    .join("\n");
}

describe("backfill", () => {
  it("a_cold_session_starts_with_the_messages_before_it", async () => {
    const c = channel("c");
    const history = new FakeHistory([
      past(c, "e1", "阿明", "昨天的話題", 120),
      past(c, "e2", "DeepSeek-chan", "我記得", 119),
    ]);
    const mock = new MockProvider("chat").reply("嗯哼。");
    const h = await Harness.build("mention-only", noCheck(), mock, null, withHistory(history));
    h.publish({
      type: "platform_ready",
      data: { platform: "test", self_account: account("DeepSeek-chan") },
    });
    const trigger = mention(c, "Owen", "妳還記得嗎");
    h.say(trigger);
    await wait(2000);
    // min(backfill 20, prompt_history 30, history_limit 50), before the first message.
    expect(history.queries).toEqual([[c, { before: trigger.id.id, limit: 20 }]]);
    const msgs = mock.requests()[0]?.messages ?? [];
    expect(msgs.slice(1, -2).map((m) => [m.role, contentText(m.content)])).toEqual([
      ["user", "阿明: 昨天的話題"],
      ["assistant", "我記得"],
      ["user", "—— 過了 2 小時 ——\nOwen: 妳還記得嗎"],
    ]);
    // Only once per session.
    h.say(mention(c, "Owen", "再一次"));
    await wait(2000);
    expect(history.queries).toHaveLength(1);
  });

  it("falls_back_to_the_message_log_without_a_history_reader", async () => {
    const c = channel("c");
    const entries: LogEntry[] = [
      {
        id: "L1",
        profile: "test-chan",
        context: c,
        author: account("阿明"),
        author_name: "阿明",
        text: "記錄裡的話",
        is_self: false,
        ts: toTimestamp(Date.now() - 5 * 60_000),
        turn: null,
      },
    ];
    const asked: number[] = [];
    const log: MessageLog = {
      append: async () => undefined,
      authoredSince: async () => [],
      recent: async (_p, _c, limit) => {
        asked.push(limit);
        return entries;
      },
      purge: async () => 0,
    };
    const mock = new MockProvider("chat").reply("嗯。");
    const h = await Harness.build("mention-only", noCheck(), mock, null, {
      provide: (services) => services.provide("app", MessageLogKey, log),
    });
    h.say(mention(c, "Owen", "嗨"));
    await wait(2000);
    expect(asked).toEqual([21]);
    expect(historyText(mock)).toBe("阿明: 記錄裡的話\nOwen: 嗨");
  });

  it("a_slow_reader_never_holds_the_reply_past_the_timeout", async () => {
    const c = channel("c");
    const history = new FakeHistory([past(c, "e1", "阿明", "太晚到的", 10)]);
    history.delayMs = 60_000;
    const mock = new MockProvider("chat").reply("在。");
    const h = await Harness.build("mention-only", noCheck(), mock, null, withHistory(history));
    h.say(mention(c, "Owen", "在嗎"));
    await wait(2000);
    expect(mock.requests()).toEqual([]);
    // history.timeout_ms (3 s) after the fetch started.
    await wait(1500);
    expect(mock.requests()).toHaveLength(1);
    expect(historyText(mock)).toBe("Owen: 在嗎");
    expect(h.sink.texts()).toEqual(["在。"]);
  });
});

describe("reply chains", () => {
  it("fetches_up_to_three_missing_parents_and_quotes_them", async () => {
    const c = channel("c");
    const ref = (id: string): MessageRef => ({ context: c, id });
    const chain = new Map<string, IncomingMessage>([
      ["p0", { ...past(c, "p0", "甲", "最早", 30), reply_to: null }],
      ["p1", { ...past(c, "p1", "乙", "第一層", 29), reply_to: ref("p0") }],
      ["p2", { ...past(c, "p2", "丙", "第二層", 28), reply_to: ref("p1") }],
      ["p3", { ...past(c, "p3", "丁", "第三層", 27), reply_to: ref("p2") }],
    ]);
    const history = new FakeHistory([], chain);
    const mock = new MockProvider("chat").reply("原來如此。");
    const h = await Harness.build("mention-only", noCheck(), mock, null, withHistory(history));
    h.say({ ...mention(c, "Owen", "妳覺得呢"), reply_to: ref("p3") });
    await wait(2000);
    expect(history.fetched).toEqual(["p3", "p2", "p1"]);
    // Each quoted line says how long before the reply it was.
    expect(historyText(mock)).toBe(
      "> (29 分鐘前) 乙: 第一層\n> (28 分鐘前) 丙: 第二層\n> (27 分鐘前) 丁: 第三層\nOwen(回覆 丁): 妳覺得呢",
    );
    // The quotes stay with the message in later turns.
    h.say(mention(c, "Owen", "還有"));
    await wait(2000);
    expect(historyText(mock, 1)).toContain("> (27 分鐘前) 丁: 第三層\nOwen(回覆 丁): 妳覺得呢");
    expect(history.fetched).toHaveLength(3);
  });

  it("uses_the_parent_delivered_with_the_reply_without_a_reader", async () => {
    const c = channel("c");
    const mock = new MockProvider("chat").reply("哼。");
    const h = await Harness.build("mention-only", noCheck(), mock, null, {});
    h.publish({
      type: "platform_ready",
      data: { platform: "test", self_account: account("DeepSeek-chan") },
    });
    h.say({
      ...mention(c, "Owen", "妳上次說的"),
      reply_to: { context: c, id: "old" },
      referenced: {
        author: account("DeepSeek-chan"),
        author_name: "DeepSeek-chan",
        text: "才不要",
      },
    });
    await wait(2000);
    // Only what came with the reply: its time is unknown.
    expect(historyText(mock)).toBe("> (較早) 你: 才不要\nOwen(回覆 你): 妳上次說的");
  });

  it("a_failed_or_slow_fetch_still_quotes_the_parent_that_came_with_the_reply", async () => {
    // 2026-11-08 14:22: the fetch failed, so the reply reached her with nothing about 「麥克風忘記關」.
    const c = channel("c");
    const history = new FakeHistory();
    history.fetch = async () => {
      throw new Error("discord 500");
    };
    const mock = new MockProvider("chat").reply("是那句。");
    const h = await Harness.build("mention-only", noCheck(), mock, null, withHistory(history));
    h.say({
      ...mention(c, "Owen", "我回覆的訊息是什麼?"),
      reply_to: { context: c, id: "mic" },
      referenced: { author: account("小v"), author_name: "小v", text: "麥克風忘記關" },
    });
    await wait(2000);
    expect(historyText(mock)).toBe(
      "> (較早) 小v: 麥克風忘記關\nOwen(回覆 小v): 我回覆的訊息是什麼?",
    );
  });

  it("a_parent_already_in_the_session_is_not_fetched", async () => {
    const c = channel("c");
    const history = new FakeHistory();
    const mock = new MockProvider("chat").reply("嗯。");
    const h = await Harness.build("always", noCheck(), mock, null, withHistory(history));
    const first = incoming(c, "阿明", "我先說");
    h.say(first);
    h.say({ ...incoming(c, "Owen", "我同意"), reply_to: first.id });
    await wait(5000);
    expect(history.fetched).toEqual([]);
    expect(historyText(mock)).toBe("阿明: 我先說\nOwen(回覆 阿明「我先說」): 我同意");
  });
});

const CDN = "https://cdn.discordapp.com/attachments/1/2";

function picture(id: string): Attachment {
  return {
    url: `${CDN}/${id}.png?ex=1`,
    filename: `${id}.png`,
    content_type: "image/png",
    id,
    size: 4,
    description: "一隻貓",
  };
}

function imageServer(): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (url) => {
      calls.push(url);
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        headers: { "content-type": "image/png" },
      });
    },
  };
}

describe("vision", () => {
  it("images_of_the_message_she_answers_go_to_the_chat_model", async () => {
    const c = channel("c");
    const srv = imageServer();
    const mock = new MockProvider("chat").reply("好可愛!");
    const h = await Harness.build("mention-only", noCheck(), mock, null, { fetchImage: srv.fetch });
    h.say({ ...mention(c, "Owen", "看我的貓"), attachments: [picture("cat")] });
    await wait(2000);
    expect(srv.calls).toEqual([`${CDN}/cat.png?ex=1`]);
    const msgs = mock.requests()[0]?.messages ?? [];
    expect(hasImages(msgs)).toBe(true);
    expect(msgs[1]?.content).toEqual([
      { type: "text", text: "Owen: 看我的貓 [圖片: cat.png(一隻貓)]" },
      { type: "text", text: "(Owen 傳的圖片 cat.png)" },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,AQIDBA==", detail: "auto" },
        alt: "[圖片: cat.png]",
      },
    ]);
    const decision = h.traces().at(-1);
    expect(decision?.reasons).toContain("looking at 1 image(s)");
    // A follow-up of the same person shortly after still looks at it (from the cache)...
    h.say(mention(c, "Owen", "對吧"));
    await wait(2000);
    expect(hasImages(mock.requests()[1]?.messages ?? [])).toBe(true);
    expect(srv.calls).toHaveLength(1);
    // ...later turns only keep the caption text.
    await wait(120_000);
    h.say(mention(c, "Owen", "還在嗎"));
    await wait(2000);
    expect(hasImages(mock.requests()[2]?.messages ?? [])).toBe(false);
    expect(historyText(mock, 2)).toContain("[圖片: cat.png(一隻貓)]");
  });

  it("text_only_models_get_no_download", async () => {
    const c = channel("c");
    const srv = imageServer();
    const mock = new MockProvider("chat").reply("看不到耶。");
    const h = await Harness.build("mention-only", noCheck(), mock, null, {
      fetchImage: srv.fetch,
      imageInput: new Map([["chat", false]]),
    });
    h.say({ ...mention(c, "Owen", "看"), attachments: [picture("cat")] });
    await wait(2000);
    expect(srv.calls).toEqual([]);
    expect(mock.requests()[0]?.messages[1]?.content).toBe("Owen: 看 [圖片: cat.png(一隻貓)]");
  });
});

function voiceCtx(): ContextKey {
  return { platform: "test", scope: "guild", channel: "vc", kind: "voice" };
}

function joined(): Event {
  const member = (id: string, isSelf: boolean) => ({
    account: account(id),
    display_name: id,
    is_self: isSelf,
    muted: false,
    deafened: false,
  });
  return {
    type: "voice_joined",
    data: { context: voiceCtx(), participants: [member("Owen", false), member("her", true)] },
  };
}

describe("voice channel text chat", () => {
  it("is_answered_by_speaking_while_she_is_in_the_channel", async () => {
    const mock = new MockProvider("chat").events([
      textDelta("好啊,網址是 https://example.com/a?b=1 喔。"),
      textDelta("```\nprint(1)\n```"),
      done(),
    ]);
    const h = await Harness.build("mention-only", noCheck(), mock, null, {});
    h.publish(joined());
    // Typed in the voice channel's text chat (same channel id).
    const chat = channel("vc");
    h.say(mention(chat, "Owen", "給我網址"));
    await wait(3000);
    expect(h.sink.speeches().map(([t]) => t)).toEqual(["好啊,網址是 喔。"]);
    expect(h.sink.speakActions()[0]?.payload).toMatchObject({ context: voiceCtx() });
    // Links and code go to the text chat, nothing else does.
    const sent = h.sink.actions.filter((a) => a.payload.type === "send_message");
    expect(sent.map((a) => a.payload)).toEqual([
      {
        type: "send_message",
        context: chat,
        message: { text: "https://example.com/a?b=1\n```\nprint(1)\n```", reply_to: null },
      },
    ]);
    // The voice prompt shows the typed line without the spoken tag.
    expect(historyText(mock)).toBe("Owen: 給我網址");
  });

  it("is_a_text_conversation_when_she_is_not_there", async () => {
    const mock = new MockProvider("chat").reply("打字回你。");
    const h = await Harness.build("mention-only", noCheck(), mock, null, {});
    h.say(mention(channel("vc"), "Owen", "在嗎"));
    await wait(3000);
    expect(h.sink.texts()).toEqual(["打字回你。"]);
    expect(h.sink.speeches()).toEqual([]);
  });
});

describe("mentions", () => {
  it("at_names_of_people_present_become_platform_mentions", async () => {
    const sink: PlatformSink = {
      platform: "test",
      send: async (context) => ({ context, id: "x" }),
      react: async () => undefined,
      typing: async () => undefined,
      mention: (who: AccountRef) => `<@${who.id}>`,
    };
    const mock = new MockProvider("chat").reply("@阿明 @Owen 你們好,@everyone 不行。");
    const h = await Harness.build("always", noCheck(), mock, null, {
      provide: (services) => {
        const sinks = new PlatformSinks();
        sinks.register(sink);
        services.provide("app", PlatformSinksKey, sinks);
      },
    });
    const c = channel("c");
    h.say(incoming(c, "阿明", "嗨"));
    h.say(incoming(c, "Owen", "嗨嗨"));
    await wait(5000);
    expect(h.sink.texts()).toEqual(["<@阿明> <@Owen> 你們好,everyone 不行。"]);
  });
});
