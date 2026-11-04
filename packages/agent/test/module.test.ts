// Port of the crate's module-level tests (`tests.rs`).

import { CommandRegistryKey } from "@miyoria/commands";
import { contentText, contextSession, MockProvider } from "@miyoria/llm";
import { ToolRegistryKey } from "@miyoria/tools";
import { type ContextKey, eventTopic, isJsonObject } from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PersonaHandleKey } from "../src/index.js";
import {
  account,
  channel,
  command,
  done,
  Harness,
  incoming,
  MemorySettingsStore,
  mention,
  noCheck,
  Probe,
  SlowProvider,
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

/** Content of the last (tool result) message of request `n`. */
function lastToolResult(mock: MockProvider, n: number): string {
  const last = mock.requests()[n]?.messages.at(-1);
  expect(last?.role).toBe("tool");
  return contentText(last?.content ?? "");
}

describe("agent module", () => {
  it("debounce_merges_messages_into_one_turn", async () => {
    const mock = new MockProvider("chat").events([
      { type: "reasoning_delta", text: "思考中……" },
      textDelta("<emo:annoyed>現在都中午了"),
      textDelta("好嗎……<emo:ne"),
      textDelta("utral>早啦。"),
      done(),
    ]);
    const h = await Harness.create("always", noCheck(), mock);
    const c = channel("c");
    h.say(incoming(c, "Owen", "早安"));
    await wait(1000);
    h.say(incoming(c, "Owen", "DeepSeek 在嗎"));
    await wait(1000);
    h.say(incoming(c, "阿明", "安安"));
    await wait(1000);
    expect(mock.requests(), "turn started too early").toEqual([]);
    await wait(5000);

    const requests = mock.requests();
    expect(requests.length).toBe(1);
    const msgs = requests[0]?.messages ?? [];
    // Stable persona first, history next, then the per-turn data (user role) and situation.
    expect(msgs.length).toBe(4);
    expect(msgs[0]?.role).toBe("system");
    expect(msgs[0]?.content).toBe("你是住在深海的鯨魚娘。");
    expect(msgs[1]?.role).toBe("user");
    expect(msgs[1]?.content).toBe("Owen: 早安\nOwen: DeepSeek 在嗎\n阿明: 安安");
    expect(msgs[2]?.role).toBe("user");
    expect(msgs[2]?.content).toContain("標題=在場的人⟧\n阿明、Owen\n⟦/資料⟧");
    expect(msgs[3]?.role).toBe("system");
    expect(msgs[3]?.content).toContain("目前情境");
    expect(msgs[3]?.content).not.toContain("阿明");
    // Text replies think first.
    expect(requests[0]?.thinking).toBe(true);
    expect(requests[0]?.tools?.map((t) => t.name)).toEqual(["react"]);

    expect(h.sink.sent()).toEqual([["現在都中午了好嗎……早啦。", "direct"]]);
    expect(h.sink.typing()).toBe(1);
    const events = h.drain();
    expect(events.map((e) => eventTopic(e.event))).toEqual([
      "agent.turn.started",
      "agent.decision",
      "agent.emotion",
      "agent.emotion",
      "agent.turn.completed",
    ]);
    const turn = events[0]?.correlation;
    expect(turn).toBeTruthy();
    expect(events.every((e) => e.correlation === turn)).toBe(true);
    const emotions = events.flatMap((e) =>
      e.event.type === "custom" && isJsonObject(e.event.data.payload)
        ? [e.event.data.payload.emotion]
        : [],
    );
    expect(emotions).toEqual(["annoyed", "neutral"]);
    const last = events[4]?.event;
    expect(last?.type === "agent_turn_completed" && last.data.text).toBe(
      "現在都中午了好嗎……早啦。",
    );
  });

  it("typing_extends_debounce_up_to_the_cap", async () => {
    const mock = new MockProvider("chat").reply("嗯");
    const h = await Harness.create("always", noCheck(), mock);
    const c = channel("c");
    h.say(incoming(c, "Owen", "我跟你說"));
    for (let i = 0; i < 3; i++) {
      await wait(1000);
      h.publish({ type: "platform_typing", data: { context: c, account: account("Owen") } });
    }
    // Without typing the turn would have started at 1.5s.
    expect(mock.requests()).toEqual([]);
    await wait(1100);
    expect(mock.requests().length, "capped at max_debounce_ms").toBe(1);
  });

  it("mention_only_replies_only_when_addressed", async () => {
    const mock = new MockProvider("chat").reply("幹嘛");
    const h = await Harness.create("mention-only", noCheck(), mock);
    const c = channel("c");
    h.say(incoming(c, "Owen", "今天好熱"));
    await wait(3000);
    expect(mock.requests()).toEqual([]);
    expect(h.decisions()).toEqual([false]);

    h.say(mention(c, "Owen", "妳覺得呢"));
    await wait(3000);
    h.say(incoming(c, "阿明", "小鯨魚你好"));
    await wait(3000);
    h.say({ ...incoming(c, "阿明", "嗯?"), reply_to_self: true });
    await wait(3000);
    const dm: ContextKey = { ...channel("dm1"), scope: null, kind: "dm" };
    h.say(incoming(dm, "Owen", "安安"));
    await wait(3000);
    expect(h.decisions()).toEqual([true, true, true, true]);
    expect(h.sink.texts()).toEqual(["幹嘛", "幹嘛", "幹嘛", "幹嘛"]);
  });

  it("off_mode_and_channel_overrides", async () => {
    const mock = new MockProvider("chat").reply("好");
    const config = { attention: { llm_check: false }, channels: { loud: "always" } };
    const h = await Harness.create("off", config, mock);
    h.say(mention(channel("quiet"), "Owen", "DeepSeek!"));
    await wait(3000);
    expect(h.decisions()).toEqual([false]);
    h.say(incoming(channel("loud"), "Owen", "隨便聊"));
    await wait(3000);
    expect(h.decisions()).toEqual([true]);
    expect(h.sink.texts()).toEqual(["好"]);
  });

  it("ambient_uses_fast_check_in_gray_zone", async () => {
    const chat = new MockProvider("chat").reply("鯨魚當然比較大");
    const fast = new MockProvider("fast")
      .reply('{"respond": false, "reason": "跟她無關"}')
      .reply('{"respond": true, "reason": "在聊她的話題"}');
    const config = {
      attention: { keywords: ["鯨魚"], llm_yes_probability: 1.0, cooldown_ms: 0 },
    };
    const h = await Harness.create("ambient", config, chat, fast);
    const c = channel("c");

    // Low salience: ignored without asking anyone.
    h.say(incoming(c, "Owen", "哈哈"));
    await wait(3000);
    expect(h.decisions()).toEqual([false]);
    expect(fast.requests()).toEqual([]);

    // Gray zone, fast model says no.
    h.say(incoming(c, "Owen", "你們看過鯨魚嗎?"));
    await wait(3000);
    expect(h.decisions()).toEqual([false]);
    expect(fast.requests().length).toBe(1);
    expect(fast.requests()[0]?.json_mode).toBe(true);
    expect(chat.requests()).toEqual([]);

    // Gray zone, fast model says yes.
    h.say(incoming(c, "阿明", "鯨魚跟海豚哪個大?"));
    await wait(3000);
    expect(fast.requests().length).toBe(2);
    const decisions = h.traces();
    expect(decisions.length).toBe(1);
    expect(decisions[0]?.respond).toBe(true);
    expect(
      decisions[0]?.reasons.some((r) => r.includes("fast model: respond")),
      decisions[0]?.reasons.join("; "),
    ).toBe(true);
    expect(h.sink.sent()).toEqual([["鯨魚當然比較大", "initiative"]]);

    // One stable session id per conversation; the attention check adds a suffix.
    const session = contextSession("test-chan", c);
    expect(session.startsWith("miyoria-test-chan-")).toBe(true);
    expect(session).not.toContain("guild");
    expect(chat.requests()[0]?.session).toBe(session);
    for (const request of fast.requests()) expect(request.session).toBe(`${session}-attention`);
  });

  it("own_messages_are_history_not_input", async () => {
    const mock = new MockProvider("chat").reply("早啦").reply("又怎樣");
    const h = await Harness.create("always", noCheck(), mock);
    const c = channel("c");
    h.publish({ type: "platform_ready", data: { platform: "test", self_account: account("her") } });
    h.say(incoming(c, "her", "我先說一句"));
    await wait(3000);
    expect(h.decisions()).toEqual([]);
    expect(mock.requests()).toEqual([]);

    h.say(incoming(c, "Owen", "早安"));
    await wait(3000);
    expect(h.sink.texts()).toEqual(["早啦"]);
    // The platform echoes her reply back; it must not be duplicated.
    h.say(incoming(c, "her", "早啦"));
    h.say(incoming(c, "Owen", "妳在幹嘛"));
    await wait(3000);

    const requests = mock.requests();
    expect(requests.length).toBe(2);
    const msgs = requests[1]?.messages ?? [];
    expect(msgs.slice(1, -2).map((m) => [m.role, m.content])).toEqual([
      ["assistant", "我先說一句"],
      ["user", "Owen: 早安"],
      ["assistant", "早啦"],
      ["user", "Owen: 妳在幹嘛"],
    ]);
  });

  it("undelivered_reply_is_forgotten", async () => {
    const mock = new MockProvider("chat").reply("第一句").reply("第二句");
    const h = await Harness.create("always", noCheck(), mock);
    const c = channel("c");
    h.say(incoming(c, "Owen", "嗨"));
    await wait(3000);
    const action = h.sink.actions.find((a) => a.payload.type === "send_message");
    expect(action).toBeDefined();
    h.publish({
      type: "action_completed",
      data: {
        action: action?.id ?? "",
        turn: action?.turn ?? null,
        ok: false,
        error: "expired",
        message: null,
      },
    });
    h.say(incoming(c, "Owen", "人呢"));
    await wait(3000);
    const requests = mock.requests();
    expect(requests[1]?.messages[1]?.content).toBe("Owen: 嗨\nOwen: 人呢");
    expect(requests[1]?.messages.length).toBe(4);
  });

  it("silence_and_empty_replies_send_nothing", async () => {
    const mock = new MockProvider("chat")
      .reply("<silence/>")
      .reply("<emo:sad>   ")
      .reply("DeepSeek-chan: 好啦");
    const h = await Harness.create("always", noCheck(), mock);
    const c = channel("c");
    for (const text of ["一", "二", "三"]) {
      h.say(incoming(c, "Owen", text));
      await wait(3000);
    }
    expect(mock.requests().length).toBe(3);
    expect(h.sink.texts()).toEqual(["好啦"]);
    expect(h.sink.typing()).toBe(3);
    expect(completedTexts(h)).toEqual(["", "", "好啦"]);
  });

  it("new_message_cancels_and_regenerates", async () => {
    const slow = new SlowProvider(3000);
    const h = await Harness.create("always", noCheck(), slow);
    const c = channel("c");
    h.say(incoming(c, "Owen", "問妳喔"));
    // Turn starts at 1.5s and would finish at 4.5s.
    await wait(2500);
    expect(slow.calls).toBe(1);
    h.say(incoming(c, "Owen", "算了換個問題"));
    await wait(8000);

    expect(slow.calls).toBe(2);
    expect(h.sink.texts()).toEqual(["reply 2"]);
    expect(slow.requests[1]?.messages[1]?.content).toBe("Owen: 問妳喔\nOwen: 算了換個問題");

    const events = h.drain();
    const firstTurn = events[0]?.correlation;
    expect(h.sink.cancelled).toEqual([firstTurn]);
    const completed = events.flatMap((e) =>
      e.event.type === "agent_turn_completed" ? [[e.event.data.turn, e.event.data.text]] : [],
    );
    expect(completed.length).toBe(2);
    expect(completed[0]).toEqual([firstTurn, ""]);
    expect(completed[1]?.[1]).toBe("reply 2");
  });

  it("message_after_submission_starts_a_follow_up_turn", async () => {
    const slow = new SlowProvider(1000);
    const h = await Harness.create("always", noCheck(), slow);
    const c = channel("c");
    h.say(incoming(c, "Owen", "一"));
    await wait(3000);
    expect(h.sink.texts()).toEqual(["reply 1"]);
    h.say(incoming(c, "Owen", "二"));
    await wait(3000);
    expect(h.sink.texts()).toEqual(["reply 1", "reply 2"]);
    expect(h.sink.cancelled).toEqual([]);
  });

  it("contexts_generate_concurrently", async () => {
    const slow = new SlowProvider(3000);
    const h = await Harness.create("always", noCheck(), slow);
    h.say(incoming(channel("a"), "Owen", "a"));
    h.say(incoming(channel("b"), "Owen", "b"));
    // 1.5s debounce + 3s generation, in parallel.
    await wait(5000);
    expect(h.sink.texts().length).toBe(2);
  });

  it("long_replies_are_split", async () => {
    const long = `${"啊".repeat(1500)}。${"嗯".repeat(1000)}`;
    const mock = new MockProvider("chat").reply(long);
    const h = await Harness.create("always", noCheck(), mock);
    h.say(incoming(channel("c"), "Owen", "講長一點"));
    await wait(3000);
    const texts = h.sink.texts();
    expect(texts.length).toBe(2);
    expect(texts.every((t) => [...t].length <= 1900)).toBe(true);
    expect(texts.join("")).toBe(long);
    expect(h.sink.actions.every((a) => a.turn !== null)).toBe(true);
  });

  it("persona_edits_apply_to_the_next_turn", async () => {
    const mock = new MockProvider("chat").reply("好");
    const h = await Harness.create("always", noCheck(), mock);
    const persona = h.sup.services.require(PersonaHandleKey);
    persona.setSection("identity", "新的人格");
    persona.setSection("style", "說話很短");
    h.say(incoming(channel("c"), "Owen", "嗨"));
    await wait(3000);
    expect(mock.requests()[0]?.messages[0]?.content).toBe("新的人格\n\n說話很短");
  });

  it("ignores_other_bots_by_default", async () => {
    const mock = new MockProvider("chat").reply("好");
    const h = await Harness.create("always", noCheck(), mock);
    const msg = incoming(channel("c"), "otherbot", "beep");
    h.say({ ...msg, author: { ...msg.author, is_bot: true } });
    await wait(3000);
    expect(h.decisions()).toEqual([]);
    h.say(incoming(channel("c"), "Owen", "嗨"));
    await wait(3000);
    expect(mock.requests()[0]?.messages[1]?.content).toBe("otherbot(bot): beep\nOwen: 嗨");
  });

  it("stops_cleanly_mid_generation", async () => {
    const slow = new SlowProvider(30_000);
    const h = await Harness.create("always", noCheck(), slow);
    h.say(incoming(channel("c"), "Owen", "嗨"));
    await wait(2000);
    expect(slow.calls).toBe(1);
    let stopped = false;
    const stop = h.sup.stopAll().then(() => {
      stopped = true;
    });
    await wait(1000);
    expect(stopped, "stop timed out").toBe(true);
    await stop;
    expect(h.sink.texts()).toEqual([]);
  });

  it("typing_is_refreshed_while_generating", async () => {
    const slow = new SlowProvider(20_000);
    const h = await Harness.create("always", noCheck(), slow);
    h.say(incoming(channel("c"), "Owen", "想一下再回我"));
    // The turn starts at 1.5s; typing at 1.5s, 9.5s and 17.5s; reply at 21.5s.
    await wait(1600);
    expect(h.sink.typing()).toBe(1);
    await wait(8000);
    expect(h.sink.typing()).toBe(2);
    await wait(15_000);
    expect(h.sink.texts()).toEqual(["reply 1"]);
    expect(h.sink.typing()).toBe(3);
    await wait(30_000);
    expect(h.sink.typing(), "typing stops once the reply is submitted").toBe(3);
    const typing = h.sink.actions.filter((a) => a.payload.type === "typing");
    expect(typing.every((a) => a.coalesce_key === "typing:test:guild:c")).toBe(true);
  });

  it("cancelled_turn_stops_typing", async () => {
    const slow = new SlowProvider(20_000);
    const h = await Harness.create("always", noCheck(), slow);
    const c = channel("c");
    h.say(incoming(c, "Owen", "一"));
    await wait(5000);
    expect(h.sink.typing()).toBe(1);
    h.say(incoming(c, "Owen", "二"));
    // The old turn is dropped at 5s (its refresh would be due at 9.5s); the new one starts at
    // 6.5s and refreshes at 14.5s.
    await wait(5000);
    expect(h.sink.typing()).toBe(2);
  });

  it("react_tool_round_trip", async () => {
    const mock = new MockProvider("chat")
      .events([
        textDelta("哼,"),
        toolCall(0, "call_a", "react", '{"emo'),
        toolCall(0, null, null, 'ji": "🐋"}'),
        done(),
      ])
      .reply("才不是為了你按的。");
    const h = await Harness.create("always", noCheck(), mock);
    const msg = incoming(channel("c"), "Owen", "給我一隻鯨魚");
    h.say(msg);
    await wait(3000);

    expect(h.sink.reactions()).toEqual([[msg.id, "🐋"]]);
    // Text from the tool-call response goes out before the tool runs, the final reply after.
    expect(h.sink.texts()).toEqual(["哼,", "才不是為了你按的。"]);

    const requests = mock.requests();
    expect(requests.length).toBe(2);
    const msgs = requests[1]?.messages ?? [];
    const n = msgs.length;
    expect(msgs[n - 3]?.content).toContain("目前情境");
    expect(msgs[n - 2]?.role).toBe("assistant");
    expect(msgs[n - 2]?.content).toBe("哼,");
    expect(msgs[n - 2]?.tool_calls).toEqual([
      { id: "call_a", name: "react", arguments: '{"emoji": "🐋"}' },
    ]);
    expect(msgs[n - 1]?.tool_call_id).toBe("call_a");
    expect(msgs[n - 1]?.content).toBe("reacted with 🐋");
    // The first request's prefix is kept, so it can be served from cache.
    expect(msgs.slice(0, n - 2)).toEqual(requests[0]?.messages);

    const react = h.sink.actions.find((a) => a.payload.type === "react");
    expect(react?.turn).not.toBeNull();
    expect(react?.lane).toBe("text:test:guild:c");
    const toolEvents = h
      .drain()
      .filter((e) => eventTopic(e.event) === "agent.tool")
      .map((e) => (e.event.type === "custom" ? e.event.data.payload : null));
    expect(toolEvents.length).toBe(1);
    expect(toolEvents[0]).toMatchObject({ tool: "react", ok: true });
  });

  it("text_beside_tool_calls_is_sent_once", async () => {
    const mock = new MockProvider("chat")
      .events([textDelta("好啦按給你。"), toolCall(0, "a", "react", '{"emoji":"👍"}'), done()])
      .reply("<silence/>")
      .events([toolCall(0, "b", "react", '{"emoji":"😤"}'), done()])
      .reply("<silence/>");
    const h = await Harness.create("always", noCheck(), mock);
    const c = channel("c");
    h.say(incoming(c, "Owen", "按個讚"));
    await wait(3000);
    expect(h.sink.texts()).toEqual(["好啦按給你。"]);
    // A reaction alone, then silence: nothing is sent.
    h.say(incoming(c, "Owen", "哈哈"));
    await wait(3000);
    expect(h.sink.texts()).toEqual(["好啦按給你。"]);
    expect(h.sink.reactions().map(([, e]) => e)).toEqual(["👍", "😤"]);
    expect(mock.requests().length).toBe(4);
  });

  it("tool_errors_go_back_to_the_model", async () => {
    const probe = new Probe("probe");
    const mock = new MockProvider("chat")
      .events([
        toolCall(0, "x", "nope", "{}"),
        toolCall(1, "y", "probe", "{bad"),
        toolCall(2, null, "react", '{"emoji":""}'),
        done(),
      ])
      .reply("嗯?");
    const h = await Harness.build("always", noCheck(), mock, null, { tools: [probe] });
    h.say(incoming(channel("c"), "Owen", "試試看"));
    await wait(3000);
    expect(probe.calls).toEqual([]);
    expect(h.sink.reactions()).toEqual([]);
    expect(h.sink.texts()).toEqual(["嗯?"]);
    const requests = mock.requests();
    const results = (requests[1]?.messages ?? [])
      .filter((m) => m.role === "tool")
      .map((m) => [m.tool_call_id, m.content] as const);
    expect(results.length).toBe(3);
    expect(results[0]?.[0]).toBe("x");
    expect(results[0]?.[1]).toContain("unknown tool");
    expect(results[1]?.[1]).toContain("not valid JSON");
    expect(results[2]?.[0]).toBe("call_2");
    expect(results[2]?.[1]).toContain("emoji");
    expect(requests[0]?.tools?.map((t) => t.name)).toEqual(["probe", "react"]);
  });

  it("an internal tool cannot be called by name from a turn", async () => {
    const hidden = new Probe("internal_threads_feed");
    const mock = new MockProvider("chat")
      .events([toolCall(0, "x", "internal_threads_feed", "{}"), done()])
      .reply("嗯?");
    const h = await Harness.build("always", noCheck(), mock, null, { tools: [hidden] });
    h.say(incoming(channel("c"), "Owen", "試試看"));
    await wait(3000);
    expect(hidden.calls).toEqual([]);
    const results = (mock.requests()[1]?.messages ?? []).filter((m) => m.role === "tool");
    expect(results[0]?.content).toContain("unknown tool");
  });

  it("tool_permissions_follow_the_triggering_users", async () => {
    const script = (mock: MockProvider, turns: number) => {
      for (let i = 0; i < turns; i++) {
        mock.events([toolCall(0, "p", "probe", '{"x": 1}'), done()]).reply("好");
      }
      return mock;
    };

    // Without an authorizer, tools that need a permission are denied.
    let probe = new Probe("probe", "admin.secret");
    let mock = script(new MockProvider("chat"), 1);
    let h = await Harness.build("always", noCheck(), mock, null, { tools: [probe] });
    h.say(incoming(channel("c"), "Owen", "用一下"));
    await wait(3000);
    expect(probe.calls).toEqual([]);
    expect(lastToolResult(mock, 1)).toContain("permission denied");
    await h.sup.stopAll();

    // With the commands module's authorizer: owners only.
    probe = new Probe("probe", "admin.secret");
    mock = script(new MockProvider("chat"), 3);
    h = await Harness.build("always", noCheck(), mock, null, {
      owners: ["test:Owen"],
      tools: [probe],
    });
    const c = channel("c");
    const msg = incoming(c, "Owen", "用一下");
    h.say(msg);
    await wait(3000);
    expect(lastToolResult(mock, 1)).toBe("done");
    expect(probe.calls.length).toBe(1);
    const [ctx, args] = probe.calls[0] ?? [];
    expect(ctx?.account).toEqual(account("Owen"));
    expect(ctx?.message).toEqual(msg.id);
    expect(ctx?.context).toEqual(c);
    expect(args).toEqual({ x: 1 });

    h.say(incoming(c, "阿明", "我也要用"));
    await wait(3000);
    expect(lastToolResult(mock, 3)).toContain("permission denied");

    // A turn mixing an owner and a user is denied, whoever spoke last.
    h.say(incoming(c, "阿明", "幫我"));
    h.say(incoming(c, "Owen", "嗯"));
    await wait(3000);
    expect(lastToolResult(mock, 5)).toContain("permission denied");
    expect(probe.calls.length).toBe(1);
  });

  it("tool_loop_is_bounded_and_timed_out", async () => {
    const probe = new Probe("probe", null, 60_000);
    // Always asks for another tool call.
    const mock = new MockProvider("chat").events([toolCall(0, "p", "probe", "{}"), done()]);
    const config = { attention: { llm_check: false }, max_tool_steps: 2, tool_timeout_ms: 1000 };
    const h = await Harness.build("always", config, mock, null, { tools: [probe] });
    h.say(incoming(channel("c"), "Owen", "一直用"));
    await wait(10_000);
    expect(mock.requests().length).toBe(3);
    expect(probe.calls.length).toBe(2);
    expect(lastToolResult(mock, 2)).toBe("error: timed out");
    expect(h.sink.texts()).toEqual([]);
  });

  it("tools_can_be_disabled", async () => {
    const mock = new MockProvider("chat").events([
      textDelta("好"),
      toolCall(0, "a", "react", '{"emoji":"👍"}'),
      done(),
    ]);
    const config = { attention: { llm_check: false }, tools_enabled: false };
    const h = await Harness.create("always", config, mock);
    h.say(incoming(channel("c"), "Owen", "嗨"));
    await wait(3000);
    const requests = mock.requests();
    expect(requests.length).toBe(1);
    expect(requests[0]?.tools).toEqual([]);
    expect(h.sink.reactions()).toEqual([]);
    expect(h.sink.texts()).toEqual(["好"]);
  });

  it("tools_registered_later_are_offered", async () => {
    const mock = new MockProvider("chat").reply("好");
    const h = await Harness.create("always", noCheck(), mock);
    const registry = h.sup.services.require(ToolRegistryKey);
    registry.register(new Probe("later"));
    h.say(incoming(channel("c"), "Owen", "嗨"));
    await wait(3000);
    expect(registry.unregister("later")).toBe(true);
    h.say(incoming(channel("c"), "Owen", "再一次"));
    await wait(3000);
    const requests = mock.requests();
    expect(requests[0]?.tools?.map((t) => t.name)).toEqual(["later", "react"]);
    expect(requests[1]?.tools?.map((t) => t.name)).toEqual(["react"]);
  });

  it("runtime_overrides_are_applied_and_persisted", async () => {
    const store = new MemorySettingsStore();
    await store.set("test-chan", "channel_mode:test:guild:loud", "always");
    await store.set("test-chan", "channel_mode:test:guild:bad", "shouty");
    const mock = new MockProvider("chat").reply("好");
    const h = await Harness.build("off", noCheck(), mock, null, { store });
    let handle = h.handle();
    const [c, loud] = [channel("c"), channel("loud")];
    expect(handle.channelMode(loud)).toBe("always");
    expect(handle.channelMode(channel("bad"))).toBe("off");
    expect(handle.channelMode(c)).toBe("off");

    h.say(incoming(c, "Owen", "嗨"));
    await wait(3000);
    expect(h.decisions()).toEqual([false]);

    await handle.setChannelMode(c, "always");
    expect(handle.channelModeOverride(c)).toBe("always");
    expect(await store.get("test-chan", "channel_mode:test:guild:c")).toBe("always");
    h.say(incoming(c, "Owen", "嗨嗨"));
    await wait(3000);
    expect(h.decisions()).toEqual([true]);
    expect(h.sink.texts()).toEqual(["好"]);

    await handle.setChannelMode(c, null);
    expect(handle.channelMode(c)).toBe("off");
    expect(await store.get("test-chan", "channel_mode:test:guild:c")).toBeNull();

    expect(handle.activeness(c)).toBe("medium");
    await handle.setActiveness(c, "high");
    expect(handle.activeness(c)).toBe("high");
    expect(handle.activeness(loud)).toBe("medium");
    expect(await store.get("test-chan", "activeness:test:guild:c")).toBe("high");

    // Reloaded after a restart.
    await h.sup.restart("agent");
    handle = h.handle();
    expect(handle.activeness(c)).toBe("high");
    expect(handle.channelMode(loud)).toBe("always");
    expect(handle.channelMode(c)).toBe("off");
  });

  it("overrides_survive_restarts_without_a_store", async () => {
    const mock = new MockProvider("chat").reply("好");
    const h = await Harness.create("off", noCheck(), mock);
    const c = channel("c");
    await h.handle().setChannelMode(c, "normal");
    await h.sup.restart("agent");
    expect(h.handle().channelMode(c)).toBe("normal");
  });

  it("agent_commands", async () => {
    const mock = new MockProvider("chat").reply("好");
    const h = await Harness.build("ambient", noCheck(), mock, null, { owners: ["test:Owen"] });
    const reg = h.sup.services.require(CommandRegistryKey);
    const handle = h.handle();
    const c = channel("c");
    const run = (inv: ReturnType<typeof command>) => reg.dispatch(inv);

    // Everyone may look at the setting (view node); the card carries a select to change it.
    let shown = await run(command("channel mode", "阿明"));
    expect(shown.text).toContain("`normal`");
    expect(shown.text).toContain("（預設）");
    expect(reg.get(["channel", "mode"])?.ephemeral).toBe(true);
    const select = shown.card?.blocks.find((b) => b.type === "select");
    expect(select?.type === "select" && select.select.id).toBe("mi:channel:mode:set");

    // Changing needs the change node, by argument or by the select.
    const denied = await run(command("channel mode", "阿明", { mode: "off" }));
    expect(denied.text).toContain("admin.channel.mode");
    const viaSelect = await reg.dispatchComponent({
      ...command("x", "阿明"),
      custom_id: "mi:channel:mode:set",
      values: ["off"],
    });
    expect(viaSelect?.result.type).toBe("reply");
    expect(handle.channelMode(c)).toBe("normal");

    const bad = await run(command("channel mode", "Owen", { mode: "loud" }));
    expect(bad.tone).toBe("warn");

    await run(command("channel mode", "Owen", { mode: "mention-only" }));
    expect(handle.channelMode(c)).toBe("mention-only");
    shown = await run(command("channel mode", "Owen"));
    expect(shown.text).toContain("`mention-only`");
    expect(shown.text).toContain("（已自訂）");
    const reset = await run(command("channel mode", "Owen", { mode: "reset" }));
    expect(reset.text).toContain("恢復為預設：`normal`");
    expect(handle.channelModeOverride(c)).toBeNull();
    const picked = await reg.dispatchComponent({
      ...command("x", "Owen"),
      custom_id: "mi:channel:mode:set",
      values: ["always"],
    });
    expect(picked?.result.type).toBe("update");
    expect(handle.channelMode(c)).toBe("always");

    await run(command("channel activeness", "Owen", { level: "high" }));
    expect(handle.activeness(c)).toBe("high");
    shown = await run(command("channel activeness", "Owen"));
    expect(shown.text).toContain("`high`");
    await run(command("channel activeness", "Owen", { level: "reset" }));
    expect(handle.activenessOverride(c)).toBeNull();

    const voice = await run(command("voice mode", "Owen"));
    expect(voice.tone).toBe("warn");

    const persona = await run(command("admin persona show", "Owen"));
    expect(reg.get(["admin", "persona", "show"])?.ephemeral).toBe(true);
    expect(persona.text).toContain("`identity`　11 字");
    expect((await run(command("admin persona show", "阿明"))).text).toContain("權限");

    // A restarted `commands` module keeps the same registry, so the agent commands stay.
    await h.sup.restart("commands");
    await wait(10);
    const after = h.sup.services.require(CommandRegistryKey);
    expect(after).toBe(reg);
    expect(after.get(["channel", "mode"])).toBeDefined();

    // Stopping the agent removes them.
    await h.sup.disable("agent");
    expect(after.get(["channel", "mode"])).toBeUndefined();
    expect(after.get(["admin", "persona", "show"])).toBeUndefined();
    expect(after.get(["help"])).toBeDefined();
  });
});

function completedTexts(h: Harness): string[] {
  return h
    .drain()
    .flatMap((e) => (e.event.type === "agent_turn_completed" ? [e.event.data.text] : []));
}
