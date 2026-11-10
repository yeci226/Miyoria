// The 2026-11-07 run: she said she would close the game and rejoin voice, and did neither.
// A promise counts as a claim like "done" does: until a tool call, an accepted task or her state
// backs it, it is not sent as it stands (claims.ts, turn.ts).

import { MockProvider } from "@miyoria/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unbackedClaim } from "../src/claims.js";
import { channel, Harness, mention, noCheck, Probe, toolCall } from "./harness.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const OFFERED = new Set(["game_stop", "voice_join"]);
const BARE = { requests: new Set<never>(), tools: new Set<string>(), scope: null };

describe("leaving voice in plain words", () => {
  // 2026-11-09: asked to leave so the others could talk, she said so and stayed.
  const LEAVE = new Set(["voice_leave"]);
  it("is a claim when she says she is going and does not", () => {
    expect(unbackedClaim("算了,好啦……那我先出去喔,要叫我再回來。", LEAVE, BARE)?.tool).toBe(
      "voice_leave",
    );
    expect(unbackedClaim("好,我先走了。", LEAVE, BARE)?.tool).toBe("voice_leave");
    expect(unbackedClaim("我離開語音了。", LEAVE, BARE)?.tool).toBe("voice_leave");
  });
  it("is not one when she refuses, or when the tool did it", () => {
    expect(unbackedClaim("我才不要出去。", LEAVE, BARE)).toBeNull();
    expect(
      unbackedClaim("那我先出去喔。", LEAVE, { ...BARE, tools: new Set(["voice_leave"]) }),
    ).toBeNull();
    expect(unbackedClaim("那我先出去喔。", new Set(["voice_join"]), BARE)).toBeNull(); // not in voice: no tool
  });
});

describe("a promise with no action behind it", () => {
  it("is a claim until the request or the tool call that backs it is there", () => {
    const text = "好啦,我馬上關麥塊。";
    expect(unbackedClaim(text, OFFERED, BARE)?.tool).toBe("game_stop");
    expect(
      unbackedClaim(text, OFFERED, { ...BARE, requests: new Set(["stop" as const]) }),
    ).toBeNull();
    expect(unbackedClaim(text, OFFERED, { ...BARE, tools: new Set(["game_stop"]) })).toBeNull();
    // Refusing or talking about it is not promising it.
    expect(unbackedClaim("我不關麥塊。", OFFERED, BARE)).toBeNull();
  });

  it("does not go out as a promise: one reminder, then what really happened", async () => {
    const mock = new MockProvider("chat")
      .reply("算了,我馬上進語音。")
      .events([
        toolCall(0, "c1", "voice_join", "{}"),
        { type: "done", finish_reason: "tool_calls", usage: null },
      ])
      .reply("進來了。");
    const join = new Probe("voice_join");
    const h = await Harness.build("always", noCheck(), mock, null, { tools: [join] });
    h.say(mention(channel("c"), "Alice", "come to voice please"));
    await vi.advanceTimersByTimeAsync(3000);
    expect(join.calls).toHaveLength(1);
    expect(h.sink.texts()).toEqual(["進來了。"]);
    const reminder = mock.requests()[1]?.messages ?? [];
    expect(String(reminder.at(-1)?.content)).toContain("voice_join");
  });

  it("a promise she does not keep is not sent: she is told once, then says so", async () => {
    const mock = new MockProvider("chat").reply("算了,我馬上進語音。").reply("我現在進不去。");
    const join = new Probe("voice_join");
    const h = await Harness.build("always", noCheck(), mock, null, { tools: [join] });
    h.say(mention(channel("c"), "Alice", "come to voice please"));
    await vi.advanceTimersByTimeAsync(3000);
    expect(join.calls).toHaveLength(0);
    // She said so honestly after the reminder; the unkept promise itself was never sent.
    expect(h.sink.texts()).toEqual(["我現在進不去。"]);
  });

  it("a tool written as a tag is the same: she is asked once to call it", async () => {
    const mock = new MockProvider("chat")
      .reply("好啊<sing_request>")
      .events([
        toolCall(0, "c1", "sing_request", '{"query":"x"}'),
        { type: "done", finish_reason: "tool_calls", usage: null },
      ])
      .reply("點好了,等一下喔。");
    const sing = new Probe("sing_request");
    const h = await Harness.build("always", noCheck(), mock, null, { tools: [sing] });
    h.say(mention(channel("c"), "Alice", "幫我點 x"));
    await vi.advanceTimersByTimeAsync(3000);
    expect(sing.calls).toHaveLength(1);
    expect(String(mock.requests()[1]?.messages.at(-1)?.content)).toContain("寫成文字");
    expect(h.sink.texts()).toEqual(["點好了,等一下喔。"]);
  });
});
