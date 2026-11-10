// Port of `tests/signals.rs`: tool registry from the app, prompt contributors, social and mood
// signals, initiative and the LLM budget.

import { contentText, MockProvider } from "@miyoria/llm";
import { ToolRegistryKey } from "@miyoria/tools";
import {
  type AffectState,
  AffectStateKey,
  type Attitude,
  type ContextKey,
  type DecisionTrace,
  type Event,
  MoodSignalsKey,
  newId,
  type PromptContributor,
  PromptContributors,
  PromptContributorsKey,
  type PromptRequest,
  type PromptSection,
  type SocialSignals,
  SocialSignalsKey,
  toTimestamp,
  type VoiceParticipant,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXHAUSTED_LINE, FOCUS_HEAD } from "../src/index.js";
import {
  account,
  channel,
  Harness,
  incoming,
  mention,
  noCheck,
  Probe,
  SlowProvider,
  stopHarnesses,
  ToolRegistry,
  wait,
} from "./harness.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  await stopHarnesses();
  vi.useRealTimers();
});

const APP = "app";

function hasReason(trace: DecisionTrace, prefix: string): boolean {
  return trace.reasons.some((r) => r.startsWith(prefix));
}

function lastTrace(h: Harness): DecisionTrace {
  const trace = h.traces().at(-1);
  if (!trace) throw new Error("expected a decision");
  return trace;
}

/** The per-turn situation message (the last one) of request `i`. */
function situation(mock: MockProvider, i: number): string {
  const msgs = mock.requests()[i]?.messages ?? [];
  expect(msgs.at(-1)?.role).toBe("system");
  return contentText(msgs.at(-1)?.content ?? "");
}

/** The user-role data message right before the situation. */
function data(mock: MockProvider, i: number): string {
  const msgs = mock.requests()[i]?.messages ?? [];
  expect(msgs.at(-2)?.role).toBe("user");
  // The data block, without the message(s) the turn answers that follow it.
  const text = contentText(msgs.at(-2)?.content ?? "");
  const focus = text.indexOf(`\n\n${FOCUS_HEAD}`);
  return focus < 0 ? text : text.slice(0, focus);
}

// ---------------------------------------------------------------- tools

describe("tool registry", () => {
  it("uses_the_app_tool_registry", async () => {
    const mock = new MockProvider("chat").reply("好");
    const appTools = new ToolRegistry();
    appTools.register(new Probe("app_tool"));
    const h = await Harness.build("always", noCheck(), mock, null, {
      appTools,
      tools: [new Probe("early")],
    });
    // The service is still the app's, and it got `react` and the tool registered on the module
    // before start.
    expect(h.sup.services.require(ToolRegistryKey)).toBe(appTools);
    // `channel_activeness` is her capability tool (the gate decides when it is called).
    expect(appTools.names()).toEqual([
      "app_tool",
      "channel_activeness",
      "drop_note",
      "early",
      "keep_note",
      "react",
    ]);

    // Tools registered on the app's registry later are offered too.
    appTools.register(new Probe("later"));
    h.say(incoming(channel("c"), "Owen", "嗨"));
    await wait(3000);
    expect(mock.requests()[0]?.tools?.map((t) => t.name)).toEqual([
      "app_tool",
      "channel_activeness",
      "drop_note",
      "early",
      "keep_note",
      "later",
      "react",
    ]);

    // Stopping the agent removes `react` but leaves the app's service.
    await h.sup.disable("agent");
    expect(appTools.names()).toEqual(["app_tool", "early", "later"]);
    expect(h.sup.services.require(ToolRegistryKey)).toBe(appTools);
  });

  it("provides_its_own_registry_without_one_from_the_app", async () => {
    const h = await Harness.create("always", noCheck(), new MockProvider("chat").reply("好"));
    expect(h.sup.services.require(ToolRegistryKey).names()).toEqual([
      "drop_note",
      "keep_note",
      "react",
    ]);
  });
});

// ---------------------------------------------------------------- contributors

/** Answers fixed sections after `delay` ms (or fails). */
class Contributor implements PromptContributor {
  readonly requests: PromptRequest[] = [];

  constructor(
    readonly key: string,
    readonly sections: PromptSection[],
    readonly delay = 0,
    readonly fail = false,
  ) {}

  async contribute(request: PromptRequest): Promise<PromptSection[]> {
    this.requests.push(structuredClone(request));
    await new Promise((resolve) => setTimeout(resolve, this.delay));
    if (this.fail) throw new Error("database is down");
    return structuredClone(this.sections);
  }
}

const section = (key: string, title: string, body: string, order: number): PromptSection => ({
  key,
  title,
  body,
  order,
});

describe("prompt contributors", () => {
  it("contributor_sections_are_added_to_the_situation", async () => {
    const mock = new MockProvider("chat").reply("哼,當然記得");
    const h = await Harness.create("always", noCheck(), mock);
    const registry = new PromptContributors();
    h.sup.services.provide(APP, PromptContributorsKey, registry);

    const memory = new Contributor("memory", [
      section("memory", "你記得的事", "Owen 明天要考數學", 10),
    ]);
    const social = new Contributor("social", [section("social", "關係", "Owen 是你的朋友", 0)]);
    const world = new Contributor("world", [section("world", "周遭", "大家都在線", 0)]);
    const slow = new Contributor("slow", [section("slow", "太慢", "不該出現", 5)], 60_000);
    const broken = new Contributor("broken", [section("broken", "壞掉", "不該出現", 5)], 0, true);
    for (const c of [memory, social, world, slow, broken]) registry.register(c);

    const c = channel("c");
    h.say(incoming(c, "阿明", "安安"));
    await wait(3000);
    h.drain();
    const before = mock.requests().length;
    h.say(incoming(c, "Owen", "妳還記得我明天要幹嘛嗎"));
    // Debounce (0.8 s) plus at most the contributor timeout (0.8 s).
    await wait(800 + 700);
    expect(mock.requests().length, "waited for the contributors").toBe(before);
    await wait(200);
    expect(mock.requests().length, "slow contributor skipped").toBe(before + 1);
    await wait(1000);

    // Contributed sections are data blocks in the user-role data message, never system text;
    // the people present have one renderer, the agent's own (`social` is not repeated).
    const d = data(mock, before);
    expect(
      d.endsWith(
        "⟦資料 來源=world 標題=周遭⟧\n大家都在線\n⟦/資料⟧\n\n" +
          "⟦資料 來源=memory 標題=你記得的事⟧\nOwen 明天要考數學\n⟦/資料⟧",
      ),
      d,
    ).toBe(true);
    expect(d).not.toContain("不該出現");
    expect(d).not.toContain("Owen 是你的朋友");
    expect(situation(mock, before)).not.toContain("Owen 明天要考數學");

    const trace = lastTrace(h);
    expect(trace.respond).toBe(true);
    expect(trace.reasons).toContain("context from: memory, social, world");
    expect(trace.reasons).toContain("rendered by the agent: social");
    expect(trace.reasons).toContain("context skipped: broken (failed), slow (timed out)");

    // What the contributors saw.
    const request = memory.requests.at(-1) as PromptRequest;
    expect(request.context).toEqual(c);
    expect(request.profile).toBe("test-chan");
    expect(request.speakers).toEqual([account("Owen")]);
    expect(request.query).toBe("Owen: 妳還記得我明天要幹嘛嗎");
    expect(request.recent).toEqual(["阿明: 安安", "DeepSeek-chan: 哼,當然記得"]);
    expect(request.voice).toBe(false);
    expect(request.participants.map((p) => p.display_name).sort()).toEqual(["Owen", "阿明"]);
    // Contributors are only asked for turns she answers.
    expect(memory.requests.length).toBe(2);
  });

  it("contributed_context_is_capped", async () => {
    const mock = new MockProvider("chat").reply("嗯");
    const config = { attention: { llm_check: false }, max_context_chars: 80 };
    const h = await Harness.create("always", config, mock);
    const registry = new PromptContributors();
    h.sup.services.provide(APP, PromptContributorsKey, registry);
    registry.register(
      new Contributor("memory", [
        section("a", "短", "第一段", 0),
        section("b", "長", "很長".repeat(100), 1),
      ]),
    );
    h.say(incoming(channel("c"), "Owen", "嗨"));
    await wait(3000);
    const d = data(mock, 0);
    const tail = d.slice(d.indexOf("⟦資料 來源=a"));
    expect([...tail].length, tail).toBeLessThanOrEqual(80);
    expect(tail).toContain("第一段");
    expect(tail.endsWith("…\n⟦/資料⟧"), tail).toBe(true);
  });
});

// ---------------------------------------------------------------- social

class FakeSocial implements SocialSignals {
  readonly attitudes = new Map<string, Attitude>();

  set(id: string, affinity: number, blocked: boolean, callName: string | null = null): void {
    this.attitudes.set(id, {
      person: newId(),
      affinity,
      trust: 50,
      familiarity: 50,
      blocked,
      label: "",
      call_name: callName,
    });
  }

  attitude(account: { id: string }): Attitude | null {
    return this.attitudes.get(account.id) ?? null;
  }
}

function provideSocial(h: Harness): FakeSocial {
  const social = new FakeSocial();
  h.sup.services.provide(APP, SocialSignalsKey, social);
  return social;
}

describe("social signals", () => {
  it("a feeling's cause reaches the turn only with its person present", async () => {
    const mock = new MockProvider("chat").reply("嗯").reply("嗯");
    const h = await Harness.create("always", noCheck(), mock);
    const social = provideSocial(h);
    social.set("Owen", 50, false);
    const owen = social.attitudes.get("Owen")?.person ?? null;
    let about: string | null = "someone-who-told-her-in-a-dm";
    const top = (person: string | null) => ({
      name: "sorrow" as const,
      intensity: 0.8,
      cause: "他說他被裁員了",
      at: toTimestamp(0),
      person,
    });
    h.sup.services.provide(APP, AffectStateKey, {
      snapshot: () => ({
        at: toTimestamp(0),
        drives: {},
        boredom: 0,
        top: [top(about)],
        mood: { valence: 0, arousal: 0.5, energy: 0.5 },
        mood_line: "",
        shown: null,
        biases: { talkativeness: 0, initiative: 0, wants: [] },
      }),
      cardByHandle: () => null,
      card: () => null,
    } as unknown as AffectState);

    h.say(mention(channel("c"), "Owen", "早安"));
    await wait(3000);
    expect(data(mock, 0)).not.toContain("被裁員");

    about = owen;
    h.say(mention(channel("c2"), "Owen", "在嗎"));
    await wait(3000);
    expect(data(mock, 1)).toContain("讓你很難過的事:他說他被裁員了");
  });

  it("blocked_people_are_ignored_and_hidden", async () => {
    const mock = new MockProvider("chat").reply("嗯");
    const h = await Harness.create("always", noCheck(), mock);
    const social = provideSocial(h);
    social.set("troll", 0, true);
    const c = channel("c");
    h.say(mention(c, "troll", "DeepSeek 理我"));
    await wait(3000);
    expect(mock.requests(), "blocked people never start a turn").toEqual([]);
    expect(h.traces()).toEqual([]);

    h.say(incoming(c, "Owen", "早安"));
    await wait(3000);
    const requests = mock.requests();
    expect(requests.length).toBe(1);
    const history = (requests[0]?.messages ?? []).map((m) => m.content).join("");
    expect(history).not.toContain("理我");
    expect(history).toContain("Owen: 早安");
  });

  it("affinity_shapes_replies_and_tone", async () => {
    const mock = new MockProvider("chat").reply("……幹嘛");
    // Rolls 0.5: probabilities below that lose.
    const h = await Harness.build("mention-only", noCheck(), mock, null, { roll: 0.5 });
    const social = provideSocial(h);
    social.set("rude", -50, false);
    social.set("hater", -90, false);
    social.set("Owen", 80, false, "歐文");
    const c = channel("c");

    // Disliked, but addressed: she still answers, coldly.
    h.say(mention(c, "rude", "喂"));
    await wait(3000);
    expect(mock.requests().length).toBe(1);
    // One line per person, one relationship scale.
    expect(data(mock, 0)).toContain("⟦資料 來源=people 標題=在場的人⟧\n- rude:很討厭\n⟦/資料⟧");
    let trace = lastTrace(h);
    expect(trace.respond).toBe(true);

    // Affinity no longer multiplies attention (v2 §3.3): very low affinity shapes her tone, not
    // whether she answers someone who addressed her (blocking someone is the social module's).
    h.say(mention(channel("c2"), "hater", "喂"));
    await wait(3000);
    expect(mock.requests().length).toBe(2);
    trace = lastTrace(h);
    expect(trace.respond, trace.reasons.join("; ")).toBe(true);
    expect(hasReason(trace, "very low affinity")).toBe(false);

    // Friends get a warm tone and their call name.
    h.say(mention(channel("c3"), "Owen", "早"));
    await wait(3000);
    expect(data(mock, 2)).toContain("- Owen:摯友;你叫他「歐文」");
  });

  it("affinity no longer scales the ambient probability (her talkativeness does)", async () => {
    const mock = new MockProvider("chat").reply("鯨魚最大").reply("鯨魚最大");
    const config = { attention: { llm_check: false, keywords: ["鯨魚"] } };
    const h = await Harness.build("ambient", config, mock, null, { roll: 0.45 });
    const social = provideSocial(h);
    social.set("friend", 100, false);
    social.set("stranger", -100, false);
    // Same message, different speakers, separate channels.
    h.say(incoming(channel("a"), "stranger", "你們看過鯨魚嗎?"));
    await wait(3000);
    h.say(incoming(channel("b"), "friend", "你們看過鯨魚嗎?"));
    await wait(3000);
    const traces = h.traces();
    expect(traces.length).toBe(2);
    expect(traces[0]?.respond, traces[0]?.reasons.join("; ")).toBe(true);
    expect(traces[1]?.respond, traces[1]?.reasons.join("; ")).toBe(true);
    expect(traces[0]?.reasons.some((r) => r.startsWith("affinity"))).toBe(false);
    expect(mock.requests().length).toBe(2);
  });
});

// ---------------------------------------------------------------- mood

describe("mood signals", () => {
  it("mood_adds_a_hint", async () => {
    const mock = new MockProvider("chat").reply("好睏");
    const h = await Harness.create("always", noCheck(), mock);
    h.sup.services.provide(APP, MoodSignalsKey, {
      mood: () => ({ valence: 0.5, arousal: 0.1, energy: 0.1 }),
    });
    h.say(incoming(channel("c"), "Owen", "嗨"));
    await wait(3000);
    expect(situation(mock, 0)).toContain("- 你現在的心情:心情很好、很睏、很平靜");
  });
});

// ---------------------------------------------------------------- initiative

function initiative(context: ContextKey, hint: string): Event {
  return {
    type: "agent_initiative",
    data: { context, reason: "idle_channel", hint, about: [account("Owen")] },
  };
}

function ambientConfig(cooldownMs: number) {
  return {
    attention: { llm_check: false, cooldown_ms: cooldownMs },
    voice: { cooldown_ms: cooldownMs },
  };
}

function voiceCtx(): ContextKey {
  return { ...channel("vc"), kind: "voice" };
}

function voiceJoined(): Event {
  const member = (id: string, isSelf: boolean): VoiceParticipant => ({
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

function speeches(h: Harness): [string, string][] {
  return h.sink.actions.flatMap((a) =>
    a.payload.type === "speak" ? [[a.payload.text, a.priority] as [string, string]] : [],
  );
}

describe("initiative", () => {
  it("initiative_starts_a_turn_without_input", async () => {
    const mock = new MockProvider("chat").reply("欸,Owen,考試考得怎樣?");
    const h = await Harness.create("ambient", ambientConfig(0), mock);
    provideSocial(h).set("Owen", 60, false);
    const c = channel("c");
    h.say(incoming(c, "Owen", "我明天要考試"));
    await wait(3000);
    expect(mock.requests(), "plain chatter is not answered").toEqual([]);
    h.drain();

    h.publish(initiative(c, "問 Owen 考試考得怎樣"));
    await wait(100);
    const requests = mock.requests();
    expect(requests.length).toBe(1);
    expect(requests[0]?.tools, "no triggering message, no tools").toEqual([]);
    const s = situation(mock, 0);
    expect(s).toContain("是你自己想主動開啟話題");
    expect(s).toContain("你想到可以聊的事在參考資料「你想聊的事」裡。");
    expect(data(mock, 0)).toContain("標題=你想聊的事⟧\n問 Owen 考試考得怎樣\n⟦/資料⟧");
    expect(s).not.toContain("問 Owen 考試考得怎樣");
    expect(data(mock, 0)).toContain("- Owen:好朋友");
    expect(h.sink.sent()).toEqual([["欸,Owen,考試考得怎樣?", "initiative"]]);
    const trace = lastTrace(h);
    expect(trace.respond).toBe(true);
    expect(trace.reasons[0]).toBe("initiative:idle_channel");
  });

  it("initiative_may_stay_silent", async () => {
    const mock = new MockProvider("chat").reply("<silence/>");
    const h = await Harness.create("ambient", ambientConfig(0), mock);
    h.publish(initiative(channel("c"), ""));
    await wait(100);
    expect(mock.requests().length).toBe(1);
    expect(h.sink.sent()).toEqual([]);
  });

  it("initiative_is_skipped_when_not_appropriate", async () => {
    const mock = new MockProvider("chat").reply("嗯");
    const config = {
      attention: { llm_check: false, cooldown_ms: 60_000 },
      channels: { quiet: "mention-only", dead: "off" },
    };
    const h = await Harness.create("ambient", config, mock);
    const skipped = (): string => {
      const trace = lastTrace(h);
      expect(trace.respond).toBe(false);
      expect(trace.reasons[0]).toBe("initiative:idle_channel");
      return trace.reasons[1] ?? "";
    };

    h.publish(initiative(channel("quiet"), ""));
    await wait(100);
    expect(skipped()).toBe("skipped: mode mention-only");
    h.publish(initiative(channel("dead"), ""));
    await wait(100);
    expect(skipped()).toBe("skipped: mode off");

    // A debounce is pending.
    const c = channel("c");
    h.say(mention(c, "Owen", "DeepSeek"));
    await wait(500);
    h.publish(initiative(c, ""));
    await wait(100);
    expect(skipped()).toBe("skipped: messages are waiting for a turn");
    await wait(3000);
    expect(mock.requests().length).toBe(1);
    h.drain();

    // She just spoke there.
    h.publish(initiative(c, ""));
    await wait(100);
    expect(skipped().startsWith("skipped: cooldown")).toBe(true);

    // Not in that voice channel.
    h.publish(initiative(voiceCtx(), ""));
    await wait(100);
    expect(skipped()).toBe("skipped: not in this voice channel");
    expect(mock.requests().length).toBe(1);
  });

  it("initiative_is_skipped_while_a_turn_runs", async () => {
    const slow = new SlowProvider(5000);
    const h = await Harness.create("ambient", ambientConfig(0), slow);
    const c = channel("c");
    h.say(mention(c, "Owen", "DeepSeek"));
    await wait(2000);
    h.publish(initiative(c, ""));
    await wait(100);
    expect(lastTrace(h).reasons[1]).toBe("skipped: a turn is in flight");
    await wait(10_000);
    expect(slow.calls).toBe(1);
  });

  it("new_message_replaces_an_initiative_turn", async () => {
    const slow = new SlowProvider(5000);
    const h = await Harness.create("ambient", ambientConfig(0), slow);
    const c = channel("c");
    h.publish(initiative(c, "聊天"));
    await wait(1000);
    h.say(mention(c, "Owen", "DeepSeek 妳在嗎"));
    await wait(10_000);
    // The initiative turn was cancelled and the message answered instead.
    expect(slow.calls).toBe(2);
    expect(h.sink.sent()).toEqual([["reply 2", "direct"]]);
    expect(slow.requests[1]?.messages.at(-1)?.content).not.toContain("主動");
  });

  it("initiative_in_voice_is_spoken", async () => {
    const mock = new MockProvider("chat").reply("大家都好安靜喔。");
    const h = await Harness.create("ambient", ambientConfig(0), mock);
    h.publish(voiceJoined());
    await wait(100);
    h.publish(initiative(voiceCtx(), "大家都不講話"));
    await wait(1000);
    expect(situation(mock, 0)).toContain("你自己想主動用說的開個話題");
    expect(speeches(h)).toEqual([["大家都好安靜喔。", "initiative"]]);
  });

  it("game initiative bypasses her cooldown", async () => {
    const mock = new MockProvider("chat").reply("好險!");
    const config = { attention: { llm_check: false, cooldown_ms: 60_000 } };
    const h = await Harness.create("ambient", config, mock);
    const c = channel("c");
    h.say(mention(c, "Owen", "DeepSeek"));
    await wait(3000);
    expect(mock.requests().length).toBe(1);
    h.drain();
    h.publish({
      type: "agent_initiative",
      data: { context: c, reason: "game", hint: "Owen 差點掉進岩漿", about: [] },
    });
    await wait(100);
    expect(mock.requests().length).toBe(2);
    expect(lastTrace(h).reasons[0]).toBe("initiative:game");
  });
});

// ---------------------------------------------------------------- budget

function budget(state: string): Event {
  return { type: "custom", data: { topic: "llm.budget", payload: { state, spent_usd: 12.5 } } };
}

describe("llm budget", () => {
  it("degraded_budget_saves_tokens", async () => {
    const mock = new MockProvider("chat").reply("嗯");
    const config = { attention: { llm_check: false, cooldown_ms: 0, keywords: ["鯨魚"] } };
    const h = await Harness.create("ambient", config, mock);
    h.publish(budget("degraded"));
    await wait(10);
    expect(h.handle().llmBudget()).toBe("degraded");

    const c = channel("c");
    h.say(incoming(c, "Owen", "你們看過鯨魚嗎?"));
    await wait(3000);
    expect(mock.requests()).toEqual([]);
    let trace = lastTrace(h);
    expect(trace.respond).toBe(false);
    expect(hasReason(trace, "llm budget degraded: as mention-only"), trace.reasons.join()).toBe(
      true,
    );

    h.publish(initiative(c, ""));
    await wait(100);
    trace = lastTrace(h);
    expect(trace.reasons[1]).toBe("skipped: llm budget degraded");

    // Direct address is still answered.
    h.say(mention(c, "Owen", "鯨魚"));
    await wait(3000);
    expect(mock.requests().length).toBe(1);

    // Back to normal.
    h.publish(budget("ok"));
    await wait(10);
    expect(h.handle().llmBudget()).toBe("ok");
    h.say(incoming(channel("d"), "Owen", "你們看過鯨魚嗎?"));
    await wait(3000);
    expect(mock.requests().length).toBe(2);
  });

  it("exhausted_budget_stops_generation", async () => {
    const mock = new MockProvider("chat").reply("嗯");
    const h = await Harness.create("mention-only", noCheck(), mock);
    h.publish(budget("broke"));
    h.publish(budget("exhausted"));
    await wait(10);
    expect(h.handle().llmBudget()).toBe("exhausted");

    const c = channel("c");
    h.say(mention(c, "Owen", "DeepSeek"));
    await wait(3000);
    expect(h.sink.texts()).toEqual([EXHAUSTED_LINE]);
    let trace = lastTrace(h);
    expect(trace.respond).toBe(true);
    expect(hasReason(trace, "llm budget exhausted: out-of-energy line")).toBe(true);

    // Once per context per hour.
    h.say(mention(c, "Owen", "DeepSeek?"));
    await wait(3000);
    expect(h.sink.texts().length).toBe(1);
    trace = lastTrace(h);
    expect(trace.respond).toBe(false);
    h.say(mention(channel("other"), "Owen", "DeepSeek"));
    await wait(3000);
    expect(h.sink.texts().length).toBe(2);
    await wait(3600 * 1000);
    h.say(mention(c, "Owen", "DeepSeek!!"));
    await wait(3000);
    expect(h.sink.texts().length).toBe(3);

    // Not a single model call; initiative ignored.
    h.publish(initiative(channel("x"), ""));
    await wait(100);
    expect(mock.requests()).toEqual([]);

    h.publish(budget("ok"));
    await wait(10);
    h.say(mention(c, "Owen", "DeepSeek"));
    await wait(3000);
    expect(mock.requests().length).toBe(1);
    expect(h.sink.texts().at(-1)).toBe("嗯");
  });

  it("exhausted_budget_in_voice_speaks_the_line", async () => {
    const mock = new MockProvider("chat").reply("嗯。");
    const config = {
      attention: { llm_check: false },
      voice: { default_mode: "mention-only", cooldown_ms: 0 },
    };
    const h = await Harness.create("mention-only", config, mock);
    h.publish(voiceJoined());
    h.publish(budget("exhausted"));
    await wait(100);
    const now = new Date().toISOString();
    h.publish({
      type: "voice_utterance",
      data: {
        id: "u1",
        context: voiceCtx(),
        speaker: { account: account("Owen"), display_name: "Owen", is_bot: false },
        text: "deepseek 妳在嗎",
        language: null,
        emotion: null,
        audio_events: [],
        started_at: now,
        ended_at: now,
        asr_ms: 100,
      },
    });
    await wait(3000);
    expect(mock.requests()).toEqual([]);
    expect(speeches(h)).toEqual([[EXHAUSTED_LINE, "direct"]]);
  });

  it("budget_state_survives_restarts", async () => {
    const h = await Harness.create("always", noCheck(), new MockProvider("chat").reply("嗯"));
    h.publish(budget("degraded"));
    await wait(10);
    await h.sup.restart("agent");
    expect(h.handle().llmBudget()).toBe("degraded");
  });
});
