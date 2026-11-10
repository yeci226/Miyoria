// 2026-11-09: a model with thinking off wrote its reasoning as the reply, and every line went to
// Discord as a message (23 in one turn). The net at the send boundary (leak.ts, turn.ts).

import { MockProvider } from "@miyoria/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isSelfTalk,
  looksLikeReasoning,
  ReasoningGuard,
  ReplyScreen,
  reasoningScore,
} from "../src/leak.js";
import { channel, Harness, mention, noCheck } from "./harness.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const INCIDENT = [
  "好，驗收通過。A = (2, 8)。",
  "現在情緒方面：心情很好、得意，表現出來是別扭地說「……謝啦」轉移話題。語氣要傲嬌一下。",
  "回覆要短，一兩句到三句。且正在唱歌。",
  "可以說：「嗯，A 就是 (2,8)，聯立那兩行沒偷懶。過關了。」加一點得意。",
  "情緒標記： 或 。他算對了，我有點得意。 用 smug 吧，但設定說表現是 embarrassed。",
];

describe("reasoning that is not a reply", () => {
  it("plans about tone, length, emotion tag and drafts are recognised", () => {
    expect(looksLikeReasoning(INCIDENT[1] ?? "")).toBe(true);
    expect(looksLikeReasoning(INCIDENT[2] ?? "")).toBe(true);
    expect(looksLikeReasoning(INCIDENT[3] ?? "")).toBe(true);
    expect(looksLikeReasoning(INCIDENT[4] ?? "")).toBe(true);
    expect(looksLikeReasoning("<think>先算一下</think>")).toBe(true);
  });

  it("her own words are not", () => {
    for (const line of [
      "嗯，A 就是 (2,8)，聯立那兩行沒偷懶。過關了。",
      "……謝啦。好了，這個話題結束！",
      "這題的答案是 x = 2，所以 A = (2, 8)。",
      "等一下，你剛剛說的是哪一題？",
      "我可以說的是，這首歌真的很好聽。",
    ]) {
      expect(reasoningScore(line)).toBeLessThan(2);
    }
  });

  it("two lines that think aloud are a leak, one is not", () => {
    const guard = new ReasoningGuard();
    expect(guard.drops("等一下，這張圖……他把斜率算成 1/2？")).toBe(false);
    expect(guard.drops("我得驗算。B(-4,-4)，C(5.6, 0.8)。")).toBe(true);
    expect(guard.leaking).toBe(true);
    // Everything after it goes too.
    expect(guard.drops("好啦，答案對了。")).toBe(true);
  });
});

describe("notes to herself", () => {
  it("a third-person instruction to herself is one, words to someone are not", () => {
    expect(isSelfTalk("莎露朵在問我上面訊息寫什麼,直接念給她聽就好。")).toBe(true);
    expect(isSelfTalk("直接念給她聽就好。")).toBe(true);
    expect(isSelfTalk("Owen 要我幫他查天氣，查完回他就好")).toBe(true);
    for (const line of [
      "你直接念給她聽就好。",
      "他在問我要不要一起玩，我說好啊！",
      "她叫我唱歌我就唱了。",
      "上面寫的是「明天見」。",
    ]) {
      expect(isSelfTalk(line), line).toBe(false);
    }
  });

  it("only that line is left out of the reply", () => {
    const screen = new ReplyScreen<{ text: string }>();
    const sent: string[] = [];
    for (const text of [
      "莎露朵在問我上面訊息寫什麼,直接念給她聽就好。",
      "上面寫的是「明天見」。",
      "就這樣～",
    ]) {
      sent.push(...screen.push({ text }).send.map((i) => i.text));
    }
    sent.push(...screen.flush().map((i) => i.text));
    expect(sent).toEqual(["上面寫的是「明天見」。", "就這樣～"]);
    expect(screen.selfTalk).toBe(1);
    expect(screen.dropped).toBe(false);
  });
});

describe("the send boundary", () => {
  it("a reply that is her reasoning reaches nobody, the innocent first line included", async () => {
    const mock = new MockProvider("chat").reply(INCIDENT.join("\n"));
    const h = await Harness.build("always", noCheck(), mock, null, { tools: [] });
    h.say(mention(channel("c"), "Alice", "A 是 (2,8) 嗎"));
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.sink.texts()).toEqual([]);
  });

  it("a normal reply of several lines goes out whole", async () => {
    const mock = new MockProvider("chat").reply("嗯，對了。\n聯立那兩行沒偷懶。\n過關。");
    const h = await Harness.build("always", noCheck(), mock, null, { tools: [] });
    h.say(mention(channel("c"), "Alice", "A 是 (2,8) 嗎"));
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.sink.texts()).toEqual(["嗯，對了。", "聯立那兩行沒偷懶。", "過關。"]);
  });

  it("a one-line reply still goes out", async () => {
    const mock = new MockProvider("chat").reply("嗯，對了。");
    const h = await Harness.build("always", noCheck(), mock, null, { tools: [] });
    h.say(mention(channel("c"), "Alice", "A 是 (2,8) 嗎"));
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.sink.texts()).toEqual(["嗯，對了。"]);
  });
});
