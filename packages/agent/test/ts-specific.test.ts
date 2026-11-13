// Behaviour specific to the TypeScript port: cancellation of providers that ignore their
// signal, idle session retirement, JSON shapes and the manifest.

import { manifestJson } from "@miyoria/kernel";
import {
  type ChatProvider,
  type ChatRequest,
  type ChatStream,
  contentText,
  MockProvider,
} from "@miyoria/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentModule } from "../src/index.js";
import {
  channel,
  done,
  Harness,
  incoming,
  mention,
  noCheck,
  profile,
  stopHarnesses,
  textDelta,
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

/** Ignores its abort signal: answers after `delay` no matter what. */
class Stubborn implements ChatProvider {
  readonly name = "stubborn";
  calls = 0;

  constructor(readonly delay: number) {}

  async stream(_request: ChatRequest): Promise<ChatStream> {
    const n = ++this.calls;
    const delay = this.delay;
    return (async function* (): ChatStream {
      await new Promise((resolve) => setTimeout(resolve, delay));
      yield { type: "text_delta", text: `late ${n}` };
      yield { type: "done", finish_reason: null, usage: null };
    })();
  }
}

describe("ts port", () => {
  it("a cancelled turn stays silent even if the provider ignores the abort", async () => {
    const stubborn = new Stubborn(3000);
    const h = await Harness.create("always", noCheck(), stubborn);
    const c = channel("c");
    h.say(incoming(c, "Owen", "我想問一件事"));
    await wait(2000);
    // The focus person adds something substantial: the turn starts over (once).
    h.say(incoming(c, "Owen", "其實是別的問題啦"));
    await wait(10_000);
    expect(stubborn.calls).toBe(2);
    expect(h.sink.texts()).toEqual(["late 2"]);
    const completed = h
      .drain()
      .flatMap((e) => (e.event.type === "agent_turn_completed" ? [e.event.data.text] : []));
    expect(completed).toEqual(["", "late 2"]);
  });

  it("stops while a stubborn provider is still generating", async () => {
    const h = await Harness.create("always", noCheck(), new Stubborn(30_000));
    h.say(incoming(channel("c"), "Owen", "嗨"));
    await wait(2000);
    await h.sup.stopAll();
    await wait(40_000);
    expect(h.sink.texts()).toEqual([]);
  });

  it("idle text contexts forget their session", async () => {
    const mock = new MockProvider("chat").reply("嗯");
    const config = { attention: { llm_check: false }, session_idle_ms: 60_000 };
    const h = await Harness.create("always", config, mock);
    const c = channel("c");
    h.say(incoming(c, "Owen", "舊的話"));
    await wait(3000);
    await wait(61_000);
    h.say(incoming(c, "Owen", "新的話"));
    await wait(3000);
    const requests = mock.requests();
    expect(requests.length).toBe(2);
    expect(requests[1]?.messages.slice(1, -2).map((m) => m.content)).toEqual(["Owen: 新的話"]);
  });

  it("reply_reference replies to the last input of direct turns", async () => {
    const mock = new MockProvider("chat").reply(`${"啊".repeat(15)}。${"嗯".repeat(10)}`);
    const config = {
      attention: { llm_check: false },
      reply_reference: true,
      max_message_chars: 20,
    };
    const h = await Harness.create("mention-only", config, mock);
    const msg = mention(channel("c"), "Owen", "DeepSeek");
    h.say(msg);
    await wait(3000);
    const sends = h.sink.actions.flatMap((a) =>
      a.payload.type === "send_message" ? [a.payload.message.reply_to] : [],
    );
    expect(sends).toEqual([msg.id, null]);
  });

  it("with two people at once, [回覆 N] picks who each line quotes; unmarked quotes nobody", async () => {
    // 2026-11-08 14:07: one turn answered two people and quoted the first while talking to the second.
    // One turn for both: what voice still does (text gives each caller a turn of their own).
    const config = {
      attention: { llm_check: false },
      reply_reference: true,
      one_caller_per_turn: false,
    };
    const marked = new MockProvider("chat").reply(
      "[回覆 2] 那是她的專長沒錯\n[回覆 1] 中文的話我很行",
    );
    const h = await Harness.create("mention-only", config, marked);
    const c = channel("c");
    const a = mention(c, "Sakana", "中文");
    const b = mention(c, "Owen", "Claude 專長是寫程式沒錯呀");
    h.say(a);
    h.say(b);
    await wait(3000);
    const sent = h.sink.actions.flatMap((x) =>
      x.payload.type === "send_message"
        ? [[x.payload.message.text, x.payload.message.reply_to]]
        : [],
    );
    expect(sent).toEqual([
      ["那是她的專長沒錯", b.id],
      ["中文的話我很行", a.id],
    ]);
    // The mark never reaches the channel.
    expect(sent.some(([text]) => String(text).includes("回覆"))).toBe(false);
    const prompt = contentText(marked.requests()[0]?.messages.at(-2)?.content ?? "");
    expect(prompt).toContain("[1] Sakana");
    expect(prompt).toContain("[2] Owen");

    const plain = new MockProvider("chat").reply("你們兩個都很吵");
    const h2 = await Harness.create("mention-only", config, plain);
    h2.say(mention(c, "Sakana", "中文"));
    h2.say(mention(c, "Owen", "Claude 專長是寫程式沒錯呀"));
    await wait(3000);
    const replyTo = h2.sink.actions.flatMap((x) =>
      x.payload.type === "send_message" ? [x.payload.message.reply_to] : [],
    );
    expect(replyTo).toEqual([null]);
  });

  it("two people calling her at once in text get a turn each, each quoting its own", async () => {
    // 2026-11-13 03:06: one turn answered 阿鰻 and When You See It, and the second answer read as
    // said to 阿鰻.
    const config = { attention: { llm_check: false }, reply_reference: true };
    const llm = new MockProvider("chat").reply("中文的話我很行").reply("那是她的專長沒錯");
    const h = await Harness.create("mention-only", config, llm);
    const c = channel("c");
    const a = mention(c, "Sakana", "中文");
    const b = mention(c, "Owen", "Claude 專長是寫程式沒錯呀");
    h.say(a);
    h.say(b);
    await wait(6000);
    const sent = h.sink.actions.flatMap((x) =>
      x.payload.type === "send_message"
        ? [[x.payload.message.text, x.payload.message.reply_to]]
        : [],
    );
    expect(sent).toEqual([
      ["中文的話我很行", a.id],
      ["那是她的專長沒錯", b.id],
    ]);
    const first = contentText(llm.requests()[0]?.messages.at(-2)?.content ?? "");
    expect(first).toContain("Sakana");
    expect(first).not.toContain("[1]");
  });

  it("tool and emotion events carry the legacy JSON payloads", async () => {
    const mock = new MockProvider("chat")
      .events([textDelta("<emo:smug>"), toolCall(0, "a", "react", '{"emoji":"🐋"}'), done()])
      .reply("哼");
    const h = await Harness.create("always", noCheck(), mock);
    const c = channel("c");
    h.say(incoming(c, "Owen", "嗨"));
    await wait(3000);
    const custom = h
      .drain()
      .flatMap((e) =>
        e.event.type === "custom" && ["agent.emotion", "agent.tool"].includes(e.event.data.topic)
          ? [[e.event.data.topic, e.event.data.payload]]
          : [],
      );
    const turn = h.sink.actions[0]?.turn;
    expect(custom).toEqual([
      ["agent.emotion", { turn, context: c, emotion: "smug" }],
      ["agent.tool", { turn, context: c, tool: "react", ok: true, result: "reacted with 🐋" }],
    ]);
  });

  it("manifest matches legacy", () => {
    const json = manifestJson(new AgentModule(profile("always")).manifest);
    expect(json).toMatchObject({
      id: "agent",
      name: "Agent",
      description: "Attention, conversation and reply generation",
      requires: ["llm", "scheduler"],
      optional: ["commands", "facts"],
    });
    expect(json.config_schema).not.toBeNull();
  });
});
