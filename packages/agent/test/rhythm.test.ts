// v4 §7.1 to §7.4 on the main line, end to end (the real agent, Floor and fact layer, a fake
// scheduler and a scripted model): who a line is for, a look instead of the dice, the cheapest
// rung (an emoji) with a limit of its own, messages spaced like typing, long content in one
// message, the context menus, and the voice channel's text chat with nobody listening.

import { ArbiterModule } from "@miyoria/arbiter";
import { FactsModule } from "@miyoria/facts";
import type { ChatProvider, ChatRequest, ChatStream, StreamEvent } from "@miyoria/llm";
import {
  type Action,
  type ContextKey,
  type Envelope,
  FloorKey,
  type IncomingMessage,
  type JsonValue,
  MESSAGE_EXCLUDED_TOPIC,
  MessageActionsKey,
  PipelineKey,
  toTimestamp,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FALLBACK_LINES } from "../src/mainline/main.js";
import { EXCLUDED_LINE } from "../src/runtime.js";
import {
  account,
  channel,
  done,
  Harness,
  incoming,
  mention,
  noCheck,
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

  /** What the `n`-th call was shown. */
  prompt(n: number): string {
    return JSON.stringify(this.requests[n]?.messages ?? []);
  }
}

function reply(text: string, ...calls: [string, string][]): StreamEvent[] {
  return [
    textDelta(text),
    ...calls.map(([name, args], i) => toolCall(i, `c${i}`, name, args)),
    done(),
  ];
}

async function rig(chat: ChatProvider, config: object = {}): Promise<Harness> {
  return Harness.build("normal", { ...(noCheck() as object), ...config }, chat, null, {
    provide: (services) => services.provide("app", PipelineKey, { pipeline: "v3" as const }),
    before: [[new FactsModule(null, "p"), null]],
    modules: [[new ArbiterModule("p"), { quiet_start_hour: 0, quiet_end_hour: 0 }]],
  });
}

const C = channel("c");

/** Alice called her and she answered: what follows is right after her line. */
async function answered(h: Harness): Promise<void> {
  h.say(mention(C, "Alice", "早"));
  await wait(3000);
  h.traces();
}

/** Alice replies to her answer. */
function replyToHer(text: string, extra: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    ...incoming(C, "Alice", text),
    reply_to_self: true,
    reply_to: { context: C, id: "her-line" },
    referenced: { author: account("her"), author_name: "DeepSeek-chan", text: "早啊" },
    ...extra,
  };
}

const bob = { account: account("Bob"), display_name: "Bob", is_bot: false };

describe("who a line is for (§7.1)", () => {
  it("2026-11-10: a reply to her that talks about her to someone else is not answered as if to her", async () => {
    // The second call returns nothing at all: for a line someone waits for, that would be a
    // fixed line (`FALLBACK_LINES`); for a line that is not hers, it is just nothing.
    const llm = new Scripted([reply("早啊"), [done()]]);
    const h = await rig(llm);
    await answered(h);
    h.say(
      replyToHer("@Bob 她一直跳針,第六次了", {
        mentions_others: [bob],
        opens_with_other_mention: true,
      }),
    );
    await wait(3000);
    const trace = h.traces().at(-1);
    expect(trace?.reasons).toContain("about her, said to Bob: hers to join or pass");
    expect(trace?.reasons.some((r) => r.startsWith("direct"))).toBe(false);
    // She was told it is about her and not said to her.
    expect(llm.prompt(1)).toContain("跟別人講到你(不是對你說,真的需要才插話)");
    expect(h.sink.texts()).toEqual(["早啊"]);
  });

  it("a reply that only laughs: she may react and pass, and a failed call says no fixed line", async () => {
    const llm = new Scripted([reply("早啊"), reply("<silence/>", ["react", '{"emoji":"😤"}'])]);
    const h = await rig(llm);
    await answered(h);
    const floor = h.sup.services.require(FloorKey);
    const used = floor.budget(C).used;
    h.say(replyToHer("LOL"));
    await wait(3000);
    expect(h.traces().at(-1)?.reasons).toContain("a reaction to her line: hers to answer or pass");
    expect(llm.prompt(1)).toContain("對你的話反應(不用回也可以)");
    expect(h.sink.reactions().map(([, emoji]) => emoji)).toEqual(["😤"]);
    expect(h.sink.texts()).toEqual(["早啊"]);
    // The emoji is no line of hers: neither the Floor's budget nor her history counts it.
    expect(floor.budget(C).used).toBe(used);

    const failing = await rig(new Scripted([reply("早啊"), "fail"]));
    await answered(failing);
    failing.say(replyToHer("哈哈哈哈"));
    await wait(5000);
    expect(failing.sink.texts()).toEqual(["早啊"]);
    expect(FALLBACK_LINES.some((l) => failing.sink.texts().includes(l))).toBe(false);
  });
});

describe("a look instead of the dice (§7.2)", () => {
  it("a topic of hers opens a turn where she picks the rung, up to the cap", async () => {
    const llm = new Scripted([reply("<silence/>", ["react", '{"emoji":"🐋"}'])]);
    const h = await rig(llm, {
      attention: { llm_check: false, keywords: ["鯨魚"] },
      rhythm: { looks_per_hour: 1 },
    });
    h.say(incoming(C, "Alice", "昨天在海邊看到鯨魚"));
    await wait(3000);
    const first = h.traces().at(-1);
    expect(first?.respond).toBe(true);
    expect(first?.reasons.some((r) => r.startsWith("a look: topic `鯨魚`"))).toBe(true);
    // The ladder is in her prompt.
    expect(llm.prompt(0)).toContain("呼叫 react 工具按一個表情(不算你講話");
    expect(h.sink.reactions()).toHaveLength(1);
    expect(h.sink.texts()).toEqual([]);
    // One look an hour here: the next is seen, not looked at.
    h.say(incoming(C, "Bob", "鯨魚很大隻"));
    await wait(3000);
    const second = h.traces().at(-1);
    expect(second?.respond).toBe(false);
    expect(second?.reasons.some((r) => r.includes("looks spent (1/1"))).toBe(true);
    expect(llm.requests).toHaveLength(1);
  });

  it("plain chatter costs nothing: no call at all", async () => {
    const llm = new Scripted([reply("嗯")]);
    const h = await rig(llm);
    h.say(incoming(C, "Alice", "今天好熱"));
    await wait(3000);
    expect(h.traces().at(-1)?.reasons).toContain("nothing worth a look");
    expect(llm.requests).toHaveLength(0);
  });

  it("a question nobody answered gets a look once it stood 20 s, not if someone answered", async () => {
    const llm = new Scripted([reply("八點啦")]);
    const h = await rig(llm);
    h.say(incoming(C, "Alice", "明天幾點集合?"));
    await wait(3000);
    expect(llm.requests).toHaveLength(0);
    await wait(20_000);
    const traces = h.traces();
    const looks = traces.filter((t) =>
      t.reasons.some((r) => r.startsWith("a look: a question nobody answered")),
    );
    expect(looks, JSON.stringify(traces.map((t) => t.reasons))).toHaveLength(1);
    expect(h.sink.texts()).toEqual(["八點啦"]);

    const other = await rig(new Scripted([reply("八點啦")]));
    other.say(incoming(C, "Alice", "明天幾點集合?"));
    await wait(5000);
    other.say(incoming(C, "Bob", "八點"));
    await wait(30_000);
    expect(other.sink.texts()).toEqual([]);
  });

  it("an emoji has a limit of its own", async () => {
    const llm = new Scripted([reply("<silence/>", ["react", '{"emoji":"🐋"}'])]);
    const h = await rig(llm, {
      attention: { llm_check: false, keywords: ["鯨魚"] },
      rhythm: { reactions_per_hour: 1 },
    });
    h.say(incoming(C, "Alice", "鯨魚"));
    await wait(3000);
    h.say(incoming(C, "Bob", "鯨魚!"));
    await wait(3000);
    expect(llm.requests).toHaveLength(2);
    expect(h.sink.reactions()).toHaveLength(1);
  });
});

describe("the shape of her messages (§7.3)", () => {
  it("several short messages go out spaced by their length, with typing in between", async () => {
    const llm = new Scripted([reply("嗯\n今天練了一整天的歌\n好累")]);
    const h = await rig(llm);
    const at: [string, number][] = [];
    const submit = h.sink.submit.bind(h.sink);
    h.sink.submit = async (action: Action) => {
      const p = action.payload;
      at.push([p.type === "send_message" ? p.message.text : p.type, Date.now()]);
      await submit(action);
    };
    h.say(mention(C, "Alice", "妳今天幹嘛"));
    await wait(6000);
    expect(h.sink.texts()).toEqual(["嗯", "今天練了一整天的歌", "好累"]);
    const sent = at.filter(([t]) => t !== "typing" && t !== "react");
    const gaps = sent.slice(1).map(([, t], i) => t - (sent[i]?.[1] ?? 0));
    // 9 characters × 40 ms = 360 ms; 2 characters: the 300 ms floor.
    expect(gaps[0]).toBeGreaterThanOrEqual(360);
    expect(gaps[1]).toBeGreaterThanOrEqual(300);
    // Typing is shown before each message that waits.
    const order = at.map(([t]) => t);
    const second = order.indexOf("今天練了一整天的歌");
    expect(order[second - 1]).toBe("typing");
  });

  it("a list goes as one message, with the line that leads into it", async () => {
    const llm = new Scripted([reply("推薦這幾首:\n1. 晴天\n2. 稻香\n3. 七里香\n要聽哪首?")]);
    const h = await rig(llm);
    h.say(mention(C, "Alice", "推薦歌"));
    await wait(6000);
    expect(h.sink.texts()).toEqual(["推薦這幾首:\n1. 晴天\n2. 稻香\n3. 七里香", "要聽哪首?"]);
  });

  it("links and code stay whole at the end of a reply too", async () => {
    const llm = new Scripted([
      reply("給你:\nhttps://a.example/1\nhttps://a.example/2\n```\nprint(1)\nprint(2)\n```"),
    ]);
    const h = await rig(llm);
    h.say(mention(C, "Alice", "連結"));
    await wait(6000);
    expect(h.sink.texts()).toEqual([
      "給你:\nhttps://a.example/1\nhttps://a.example/2",
      "```\nprint(1)\nprint(2)\n```",
    ]);
  });
});

describe("the context menus (MessageActionsKey)", () => {
  it("要她回這則: an addressed turn on that message", async () => {
    const llm = new Scripted([reply("好喔")]);
    const h = await rig(llm);
    const msg = incoming(C, "Alice", "今天好熱");
    h.say(msg);
    await wait(3000);
    expect(llm.requests).toHaveLength(0);
    const actions = h.sup.services.require(MessageActionsKey);
    const asked = await actions.replyTo({
      message: msg.id,
      author: msg.author.account,
      requested_by: account("Bob"),
    });
    expect(asked).toEqual({ ok: true });
    await wait(3000);
    expect(h.traces().at(-1)?.reasons).toContain("direct: mention");
    expect(h.sink.texts()).toEqual(["好喔"]);
    // A message she does not have, or a channel where she does not talk: a neutral no.
    const unknown = await actions.replyTo({
      message: { context: C, id: "nope" },
      author: null,
      requested_by: account("Bob"),
    });
    expect(unknown.ok).toBe(false);
    await h.handle().setChannelMode(C, "off");
    const off = await actions.replyTo({
      message: msg.id,
      author: msg.author.account,
      requested_by: account("Bob"),
    });
    expect(off).toEqual({ ok: false, reason: "她在這個頻道不說話。" });
  });

  it("不要記住這個: gone from her prompts, and the rest of her memory is told", async () => {
    const llm = new Scripted([reply("嗯")]);
    const h = await rig(llm);
    const events = h.sup.bus.subscribe(MESSAGE_EXCLUDED_TOPIC);
    const secret = incoming(C, "Alice", "我的密碼是 hunter2");
    h.say(secret);
    await wait(3000);
    const actions = h.sup.services.require(MessageActionsKey);
    const done = await actions.dontRemember({
      message: secret.id,
      author: secret.author.account,
      requested_by: secret.author.account,
    });
    expect(done).toEqual({ ok: true });
    h.say(mention(C, "Alice", "剛剛說了什麼"));
    await wait(3000);
    expect(llm.prompt(0)).not.toContain("hunter2");
    expect(llm.prompt(0)).toContain(EXCLUDED_LINE);
    const env: Envelope | null = events.tryRecv();
    const payload = env?.event.type === "custom" ? (env.event.data.payload as JsonValue) : null;
    expect(payload).toMatchObject({
      message: { id: secret.id.id },
      requested_by: { id: "Alice" },
    });
    expect(JSON.stringify(payload)).not.toContain("hunter2");
    // And no turn can be opened on it any more.
    const again = await actions.replyTo({
      message: secret.id,
      author: secret.author.account,
      requested_by: account("Bob"),
    });
    expect(again.ok).toBe(false);
  });
});

describe("typing or speaking (§7.4)", () => {
  const VOICE: ContextKey = { platform: "test", scope: "guild", channel: "v1", kind: "voice" };
  const chat: ContextKey = { ...VOICE, kind: "channel" };

  function join(h: Harness, deafened: boolean): void {
    h.publish({
      type: "voice_joined",
      data: {
        context: VOICE,
        participants: [
          { account: account("p0"), display_name: "P0", is_self: false, muted: false, deafened },
        ],
      },
    });
  }

  it("typed in the voice channel's chat: spoken while someone listens, typed when nobody does", async () => {
    const heard = await rig(new Scripted([reply("嗨嗨")]));
    join(heard, false);
    await wait(10);
    heard.say(mention(chat, "P0", "嗨"));
    await wait(3000);
    expect(heard.sink.speeches().map(([t]) => t)).toEqual(["嗨嗨"]);
    expect(heard.sink.texts()).toEqual([]);

    const nobody = await rig(new Scripted([reply("嗨嗨")]));
    join(nobody, true);
    await wait(10);
    nobody.say({ ...mention(chat, "P0", "嗨"), ts: toTimestamp(Date.now()) });
    await wait(3000);
    expect(nobody.sink.speeches()).toEqual([]);
    expect(nobody.sink.texts()).toEqual(["嗨嗨"]);
  });
});
