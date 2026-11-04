// `channel.activeness`: her temporary activeness, through the gate, reverting on its own; and
// tool calls in a reactive turn carry the `user` principal.

import { ActuatorRegistry } from "@miyoria/actions";
import { configureLogging, ServiceRegistry } from "@miyoria/kernel";
import { MockProvider } from "@miyoria/llm";
import { type ToolContext, ToolRegistry } from "@miyoria/tools";
import {
  type AccountRef,
  Principals,
  type SelfState,
  type TalkativenessInput,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activenessCapability } from "../src/actions.js";
import { channel, Harness, incoming, mention, noCheck, Probe } from "./harness.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const OWEN: AccountRef = { platform: "test", id: "Owen" };

describe("channel.activeness", () => {
  it("sets her activeness here for a while, then reverts", async () => {
    const h = await Harness.create("always", noCheck(), new MockProvider("chat").reply("好"));
    const handle = h.handle();
    const c = channel("c");
    const before = handle.activeness(c);
    const tools = new ToolRegistry();
    const registry = new ActuatorRegistry({ services: h.sup.services, tools, builtins: false });
    registry.register(activenessCapability(handle, { now: () => Date.now() }));
    const ctx: ToolContext = {
      turn: "01JC0000000000000000000000",
      context: c,
      account: OWEN,
      principal: Principals.user(OWEN, c),
      message: { context: c, id: "m" },
      priority: "direct",
      signal: new AbortController().signal,
    };
    const tool = tools.get("channel_activeness");
    // Owen may not change the channel setting; she may choose to be livelier herself.
    await expect(tool?.call(ctx, { level: "high" })).rejects.toThrow(/not allowed/);
    expect(handle.activeness(c)).toBe(before);
    expect(await tool?.call(ctx, { level: "high", minutes: 10, on_own: true })).toContain(
      "for 10 min",
    );
    expect(handle.activeness(c)).toBe("high");
    expect(handle.activeness(channel("other"))).toBe(before);
    vi.advanceTimersByTime(10 * 60_000);
    expect(handle.activeness(c), "reverted").toBe(before);
    await expect(tool?.call(ctx, { level: "loud", on_own: true })).rejects.toThrow(/invalid/);
  });

  it("with `self`: her talkativeness, silent to high, for up to a day, under the level", async () => {
    const h = await Harness.create("quiet", noCheck(), new MockProvider("chat").reply("好"));
    const c = channel("c");
    const set: [string, TalkativenessInput][] = [];
    const self = {
      setTalkativeness: (scope: string, input: TalkativenessInput) => set.push([scope, input]),
    } as unknown as SelfState;
    const tools = new ToolRegistry();
    const registry = new ActuatorRegistry({ services: h.sup.services, tools, builtins: false });
    registry.register(activenessCapability(h.handle(), { now: () => Date.now() }, () => self));
    const ctx: ToolContext = {
      turn: "01JC0000000000000000000000",
      context: c,
      account: OWEN,
      principal: Principals.user(OWEN, c),
      message: { context: c, id: "m" },
      priority: "direct",
      signal: new AbortController().signal,
    };
    const tool = tools.get("channel_activeness");
    // 「安靜點」: she decides how quiet and for how long.
    expect(await tool?.call(ctx, { level: "silent", minutes: 120, on_own: true })).toContain(
      "for 120 min",
    );
    // 「可以多聊」 in a quiet channel: hers is set, the level caps it.
    const more = await tool?.call(ctx, { level: "high", minutes: 1440, on_own: true });
    expect(more).toContain("capped by the channel level quiet (安靜)");
    expect(set.map(([scope, t]) => [scope, t.level, t.forMs])).toEqual([
      ["test:guild:c", 0, 120 * 60_000],
      ["test:guild:c", 0.85, 24 * 60 * 60_000],
    ]);
    await expect(tool?.call(ctx, { level: "low", minutes: 1441, on_own: true })).rejects.toThrow(
      /invalid/,
    );
  });

  it("tool calls in a reactive turn run for the speaker", async () => {
    const mock = new MockProvider("chat")
      .events([
        { type: "tool_call_delta", index: 0, id: "c1", name: "probe", arguments: "{}" },
        { type: "done", finish_reason: "tool_calls", usage: null },
      ])
      .reply("好了");
    const probe = new Probe("probe");
    const h = await Harness.build("always", noCheck(), mock, null, { tools: [probe] });
    h.say(incoming(channel("c"), "Owen", "幫我一下"));
    await vi.advanceTimersByTimeAsync(3000);
    const [ctx] = probe.calls[0] ?? [];
    expect(ctx?.principal).toEqual(Principals.user(OWEN, channel("c")));
  });

  it("tool calls run for the one who asked her, not whoever spoke last", async () => {
    const mock = new MockProvider("chat")
      .events([
        { type: "tool_call_delta", index: 0, id: "c1", name: "probe", arguments: "{}" },
        { type: "done", finish_reason: "tool_calls", usage: null },
      ])
      .reply("好了");
    const probe = new Probe("probe");
    const h = await Harness.build("always", noCheck(), mock, null, { tools: [probe] });
    h.say(mention(channel("c"), "Owen", "幫我跑個程式"));
    h.say(incoming(channel("c"), "Mini", "哈哈"));
    await vi.advanceTimersByTimeAsync(3000);
    const [ctx] = probe.calls[0] ?? [];
    expect(ctx?.principal).toEqual(Principals.user(OWEN, channel("c")));
  });

  it("a claimed action without its tool call gets one reminder", async () => {
    const mock = new MockProvider("chat")
      .reply("好啦，我游過去了。")
      .events([
        { type: "tool_call_delta", index: 0, id: "c1", name: "voice_join", arguments: "{}" },
        { type: "done", finish_reason: "tool_calls", usage: null },
      ])
      .reply("到了。");
    const join = new Probe("voice_join");
    const h = await Harness.build("always", noCheck(), mock, null, { tools: [join] });
    h.say(mention(channel("c"), "Owen", "進語音"));
    await vi.advanceTimersByTimeAsync(3000);
    expect(join.calls).toHaveLength(1);
    // The claim was never sent; the reply after the real join was.
    expect(h.sink.texts()).toEqual(["到了。"]);
    const second = mock.requests()[1]?.messages ?? [];
    expect(String(second.at(-1)?.content)).toContain("voice_join");
  });

  describe("a song she promises", () => {
    const request = (mock: MockProvider) =>
      mock
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
        .reply("好了。");

    it.each([
      "好啦,這首我會去抓,等我一下。",
      "好啦好啦,我先把邦友の酒弄好,你們繼續聊。",
      "好,我去準備一下。",
      "我排進去了。",
    ])("is requested after a reminder: %s", async (claim) => {
      const mock = request(new MockProvider("chat").reply(claim));
      const sing = new Probe("sing_request");
      const h = await Harness.build("always", noCheck(), mock, null, { tools: [sing] });
      h.say(mention(channel("c"), "Owen", "唱這個 https://www.bilibili.com/video/BV1"));
      await vi.advanceTimersByTimeAsync(3000);
      expect(sing.calls).toHaveLength(1);
      const second = mock.requests()[1]?.messages ?? [];
      expect(String(second.at(-1)?.content)).toContain("sing_request");
    });

    it("is not asked about when nobody talked about a song", async () => {
      const mock = new MockProvider("chat").reply("我先把報告弄好。");
      const sing = new Probe("sing_request");
      const h = await Harness.build("always", noCheck(), mock, null, { tools: [sing] });
      h.say(mention(channel("c"), "Owen", "你在忙什麼"));
      await vi.advanceTimersByTimeAsync(3000);
      expect(mock.requests()).toHaveLength(1);
      expect(h.sink.texts()).toEqual(["我先把報告弄好。"]);
    });

    it.each(["《朋友的酒》我練好了,唱歪了別怪我。", "歌我弄好了,等一下就唱。"])(
      "is not asked about when it is already done: %s",
      async (said) => {
        const mock = new MockProvider("chat").reply(said);
        const sing = new Probe("sing_request");
        const h = await Harness.build("always", noCheck(), mock, null, { tools: [sing] });
        h.say(mention(channel("c"), "Owen", "唱歌"));
        await vi.advanceTimersByTimeAsync(3000);
        expect(mock.requests()).toHaveLength(1);
      },
    );
  });

  it("logs every tool call at info, so a call that went wrong shows in the log", async () => {
    const lines: string[] = [];
    configureLogging({ level: "info", destination: { write: (line) => lines.push(line) } });
    try {
      const mock = new MockProvider("chat")
        .events([
          { type: "tool_call_delta", index: 0, id: "c1", name: "nope", arguments: "{}" },
          { type: "done", finish_reason: "tool_calls", usage: null },
        ])
        .reply("好");
      const h = await Harness.build("always", noCheck(), mock, null, {});
      h.say(mention(channel("c"), "Owen", "幫我跑個程式"));
      await vi.advanceTimersByTimeAsync(3000);
      const call = lines.map((l) => JSON.parse(l)).find((l) => l.msg === "tool call");
      expect(call).toMatchObject({ tool: "nope", ok: false });
    } finally {
      configureLogging();
    }
  });

  it("registers in the app's actuator registry while running", async () => {
    const appTools = new ToolRegistry();

    const services = new ServiceRegistry();
    const app = new ActuatorRegistry({ services, tools: appTools, builtins: false });
    const h = await Harness.build("always", noCheck(), new MockProvider("chat").reply("好"), null, {
      appTools,
      actuators: app,
    });
    expect(app.names()).toEqual(["channel.activeness", "chat.dm", "chat.start"]);
    expect(appTools.names()).toContain("channel_activeness");
    await h.sup.disable("agent");
    expect(app.names()).toEqual([]);
  });
});
