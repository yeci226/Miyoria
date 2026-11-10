import { MockProvider } from "@miyoria/llm";
import { MemorySettingsStore } from "@miyoria/store";
import {
  AffectStateKey,
  customEvent,
  DIRECTIVE_CHANGED_TOPIC,
  type Directive,
  type DirectiveGoal,
  type Directives,
  DirectivesKey,
  type Event,
  GoalAgendaKey,
  type JsonValue,
  SelfStateKey,
  type Thought,
  toTimestamp,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GOAL_PREFIX, type MindLoop, THOUGHT_PREFIX } from "../src/index.js";
import { callKind, ScriptedProvider, texts } from "./fakes.js";
import { OWEN, type Rig, rig, salient, stopRigs, TEXT, VOICE, wait } from "./helpers.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-11-02T12:00:00.000Z")); // 20:00 at UTC+8
});

afterEach(async () => {
  await stopRigs();
  vi.useRealTimers();
});

const MIN = 60_000;
const VOICE_REF = "discord:g1:voice:v1";

const PLAN = JSON.stringify({
  thought: "Owen 進語音了耶……就說我剛好路過。",
  goals: {
    add: [
      {
        what: "問 Owen 報告的結果",
        why: "好幾天沒聊了",
        trigger: { kind: "when_online", person: "Owen" },
        expires_in_hours: 24,
      },
    ],
  },
  impulses: [
    {
      kind: "act",
      capability: "voice.join",
      place: VOICE_REF,
      person: "Owen",
      why: "想找 Owen",
      hint: "假裝路過",
    },
    { kind: "act", capability: "speak", place: VOICE_REF, why: "x" },
  ],
});

function message(text: string, addressed: boolean): Event {
  return {
    type: "platform_message_created",
    data: {
      id: { context: TEXT, id: `m${Date.now()}` },
      author: { account: OWEN, display_name: "Owen", is_bot: false },
      text,
      mentions_self: addressed,
      reply_to_self: false,
      attachments: [],
      ts: toTimestamp(Date.now()),
    },
  };
}

describe("mind module: Plan", () => {
  it("plans about a salient change: short system, data blocks, reasoning `plan`", async () => {
    const provider = new ScriptedProvider(() => PLAN);
    const r = await rig(provider);
    const goals = r.sup.bus.subscribe("plan.goal");
    r.publish(salient("Owen 進了語音頻道「聊天室」"));
    await wait(2000);
    expect(provider.requests().length, "coalescing").toBe(0);
    await wait(2000);
    expect(provider.requests().map(callKind)).toEqual(["plan"]);
    const request = provider.requests()[0];
    expect(request?.json_mode).toBe(true);
    expect(request?.reasoning).toBe("medium");
    expect(request?.model).toBe("mind");
    const { system, data } = texts(request);
    expect(system.startsWith("你是住在深海的鯨魚娘。\n\n# 計畫")).toBe(true);
    for (const derived of ["Owen", "聊天室", "海豚"])
      expect(system, derived).not.toContain(derived);
    expect(data).toContain("⟦資料 來源=world");
    expect(data).toContain("Owen 進了語音頻道");
    expect(data).toContain(`${VOICE_REF}:語音頻道 v1`);

    await wait(10);
    // voice.join went to the agent (no Arbiter here) with the channel from the place.
    expect(r.intents.intents.map((i) => [i.capability, i.args, i.opening])).toEqual([
      ["voice.join", { channel: "v1", guild: "g1" }, "假裝路過"],
    ]);
    const [thought] = r.mind().thoughts();
    expect(thought?.intents.map((i) => [i.capability, i.status])).toEqual([
      ["voice.join", "started"],
      ["speak", "dropped"],
    ]);
    expect(thought?.changes).toEqual(["目標 +「問 Owen 報告的結果」(Owen 上線時)"]);
    const agenda = r.sup.services.require(GoalAgendaKey);
    expect(agenda.goals().map((g) => [g.what, g.trigger])).toEqual([
      ["問 Owen 報告的結果", { kind: "when_online", person: "Owen" }],
    ]);
    expect(goals.tryRecv()?.event).toMatchObject({ data: { topic: "plan.goal" } });
    // She does not write emotions, drives or talkativeness from a plan.
    const self = r.sup.services.require(SelfStateKey);
    expect(Object.keys(self.snapshot().policy.talkativeness)).toEqual([]);
  });

  it("does not plan while autonomy is paused", async () => {
    const provider = new ScriptedProvider(() => "{}");
    const r = await rig(provider);
    await r.registry.setPaused(true);
    r.publish(salient("Owen 進了語音頻道"));
    await wait(30 * MIN);
    expect(provider.requests()).toHaveLength(0);
    expect(r.mind().stats().idle_reason).toBe("paused");
    await r.registry.setPaused(false);
    await wait(40 * MIN);
    expect(provider.requests().length).toBeGreaterThan(0);
  });

  it("writes her day plan on the first Plan of the day (reasoning `plan_daily`), once", async () => {
    const provider = new ScriptedProvider((req) =>
      callKind(req) === "plan_daily"
        ? JSON.stringify({ thought: "今天想等 Owen。", day_plan: "Owen 通常晚上來,等他再開台。" })
        : "{}",
    );
    const r = await rig(provider, { config: { daily_hour: 6 } });
    await wait(5000);
    expect(provider.requests().map(callKind)).toEqual(["plan_daily"]);
    expect(provider.requests()[0]?.reasoning).toBe("high");
    const loop = r.mind() as unknown as MindLoop;
    expect(loop.dayPlan()).toBe("Owen 通常晚上來,等他再開台。");
    r.publish(salient("Owen 上線了"));
    await wait(50_000);
    expect(provider.requests().map(callKind)).toEqual(["plan_daily", "plan"]);
    expect(texts(provider.requests()[1]).data).toContain("Owen 通常晚上來,等他再開台。");
    expect(await r.store.get("p", "mind:plan:state")).toMatchObject({ last_daily: "2026-11-02" });
  });

  it("lengthens the heartbeat after empty runs and skips one when nothing changed", async () => {
    const provider = new ScriptedProvider(() => '{"thought": "沒事。"}');
    const r = await rig(provider, { config: { min_interval_secs: 0 } });
    const loop = r.mind() as unknown as MindLoop;
    const next = () => Date.parse(r.mind().stats().next_heartbeat_at ?? "") - Date.now();
    await wait(1000);
    const first = next();
    expect(first).toBeGreaterThanOrEqual(10 * MIN);
    expect(first).toBeLessThanOrEqual(20 * MIN);
    await wait(first + 1000);
    expect(provider.requests()).toHaveLength(1);
    expect(loop.planStats()).toMatchObject({ runs: 1, empty: 1, empty_streak: 1 });
    expect(next()).toBeGreaterThan(first);
    // Nothing changed since that empty plan: the next heartbeat does not ask the model.
    await wait(next() + 1000);
    expect(provider.requests()).toHaveLength(1);
    expect(loop.planStats().empty_streak).toBe(2);
    // Something happens: she plans again.
    r.publish(salient("Owen 進了語音頻道"));
    await wait(5000);
    expect(provider.requests()).toHaveLength(2);
  });

  it("is woken when an activity ends, and fires `after_activity` goals", async () => {
    const provider = new ScriptedProvider(() => "{}");
    const r = await rig(provider);
    await wait(10);
    const agenda = r.sup.services.require(GoalAgendaKey);
    const g = agenda.add({
      what: "玩完就收台聊天",
      why: "",
      trigger: { kind: "after_activity", activity: "game" },
      expires: toTimestamp(Date.now() + 6 * 60 * MIN),
      source: "plan",
    });
    const snapshot = (activity: JsonValue) => ({
      version: 1,
      at: toTimestamp(Date.now()),
      presence: { type: "none" },
      broadcast: { type: "off" },
      activity,
      override: null,
      scene: null,
    });
    r.publish(
      customEvent(
        "activity.changed",
        snapshot({
          type: "game",
          target: "minecraft",
          phase: "running",
          task: null,
          failure: null,
          since: toTimestamp(Date.now()),
        }),
      ),
    );
    await wait(1000);
    expect(provider.requests()).toHaveLength(0);
    r.publish(
      customEvent("activity.changed", snapshot({ type: "idle", since: toTimestamp(Date.now()) })),
    );
    await wait(5000);
    expect(provider.requests()).toHaveLength(1);
    const { data } = texts(provider.requests()[0]);
    expect(data).toContain("剛剛的活動結束了:game(minecraft) 結束了");
    expect(data).toContain("你之前定的目標,觸發條件到了");
    expect(data).toContain("玩完就收台聊天;觸發:game 結束之後(到了)");
    expect(agenda.goal(g.id)?.status).toBe("active");
  });

  it("is woken when her mood drops", async () => {
    const provider = new ScriptedProvider(() => "{}");
    const r = await rig(provider, { config: { min_interval_secs: 0 } });
    r.publish(salient("Owen 上線了"));
    await wait(5000);
    expect(provider.requests()).toHaveLength(1);
    const mood = r.sup.services.require(AffectStateKey).snapshot().mood;
    r.publish(customEvent("affect.changed", { mood: { ...mood, valence: mood.valence - 0.1 } }));
    await wait(5000);
    expect(provider.requests()).toHaveLength(1);
    r.publish(customEvent("affect.changed", { mood: { ...mood, valence: mood.valence - 0.4 } }));
    await wait(5000);
    expect(provider.requests()).toHaveLength(2);
    expect(texts(provider.requests()[1]).data).toContain("你的心情變了");
  });

  it("falls back to the chat chain and records failures in the journal", async () => {
    const provider = new MockProvider("p").fail("upstream down");
    const r = await rig(provider, { chatOnly: true });
    r.publish(salient("Owen 進了語音頻道"));
    await wait(5000);
    expect(provider.requests()[0]?.model).toBe("chat");
    const [thought] = r.mind().thoughts();
    expect(thought?.error).toContain("upstream down");
  });

  it("asks once more when her reply has no JSON, then uses the fixed one", async () => {
    const provider = new MockProvider("p").reply("嗯……我想想").reply('{"thought": "好。"}');
    const r = await rig(provider);
    r.publish(salient("Owen 進了語音頻道"));
    await wait(5000);
    expect(provider.requests()).toHaveLength(2);
    expect(texts(provider.requests()[1]).data).toContain("上面的回覆不能用");
    expect(r.mind().thoughts()[0]).toMatchObject({ thought: "好。", attempts: 2, error: null });
  });

  it("keeps her journal and goals across restarts, and migrates the old agenda once", async () => {
    const store = new MemorySettingsStore();
    const provider = new ScriptedProvider(() => '{"thought": "嗯。"}');
    const r = await rig(provider, { store });
    r.publish(salient("Owen 進了語音頻道"));
    await wait(5000);
    expect((await store.list("p", THOUGHT_PREFIX)).size).toBe(1);
    const self = r.sup.services.require(SelfStateKey);
    self.addAgenda({ text: "等 Owen 上線問他報告結果", why: "說好的" });
    await r.sup.restart("mind");
    await wait(100);
    const agenda = () => r.sup.services.require(GoalAgendaKey).goals();
    expect(agenda().map((g) => [g.what, g.trigger.kind, g.source])).toEqual([
      ["等 Owen 上線問他報告結果", "whenever", "plan"],
    ]);
    await r.sup.restart("mind");
    await wait(100);
    expect(agenda()).toHaveLength(1);
    expect((await store.list("p", GOAL_PREFIX)).size).toBe(1);
    expect(r.mind().thoughts()).toHaveLength(1);
  });

  it("turns a followup suggestion into a goal that waits for the person", async () => {
    const provider = new ScriptedProvider(() => "{}");
    const r = await rig(provider);
    await wait(10);
    expect(
      r.mind().suggest({
        source: "memory",
        reason: "followup",
        context: TEXT,
        hint: "問 Owen 面試結果",
        about: [OWEN],
      }),
    ).toBe(true);
    const [g] = r.sup.services.require(GoalAgendaKey).goals();
    expect(g).toMatchObject({ what: "問 Owen 面試結果", why: "之前說好要問的", context: TEXT });
  });
});

describe("mind module: one agenda", () => {
  it("closes the old free-text agenda items that became goals", async () => {
    const r = await rig(new ScriptedProvider(() => "{}"));
    const self = r.sup.services.require(SelfStateKey);
    const item = self.addAgenda({ text: "等 Owen 上線問他報告結果" });
    // The next start migrates it (as the first start after an upgrade does).
    await r.sup.restart("mind");
    const goals = r.sup.services.require(GoalAgendaKey).goals();
    expect(goals.map((g) => [g.id, g.what])).toEqual([[`agenda-${item.id}`, item.text]]);
    expect(self.agenda()).toEqual([]);
    // Restarting again changes nothing.
    await r.sup.restart("mind");
    expect(r.sup.services.require(GoalAgendaKey).goals()).toHaveLength(1);
  });
});

describe("mind module: Appraise", () => {
  it("appraises a segment once it ended (reasoning `appraise`), into her affect", async () => {
    const provider = new ScriptedProvider((req) =>
      callKind(req) === "appraise"
        ? JSON.stringify({
            appraisals: [
              { emotion: "joy", strength: "strong", toward: null, cause: "Owen 誇我唱得好" },
            ],
          })
        : "{}",
    );
    const r = await rig(provider);
    await wait(10);
    r.publish(message("你今天唱得超好聽", true));
    await wait(2000);
    r.publish({
      type: "agent_turn_completed",
      data: { turn: "R1", context: TEXT, text: "哼,那當然" },
    });
    await wait(2000);
    r.publish(message("真的啦", false));
    r.publish(message("再唱一首", true));
    await wait(60_000);
    expect(provider.requests()).toHaveLength(0);
    // Her turn ending is not a reason to plan; the segment ends after two quiet minutes.
    await wait(70_000);
    expect(provider.requests().map(callKind)).toEqual(["appraise"]);
    expect(provider.requests()[0]?.reasoning).toBe("low");
    const { system, data } = texts(provider.requests()[0]);
    expect(system.startsWith("你是住在深海的鯨魚娘。\n\n# 感受")).toBe(true);
    expect(system).not.toContain("Owen");
    expect(data).toContain("Owen(對你說):你今天唱得超好聽");
    expect(data).toContain("你:哼,那當然");
    const joy = r.sup.services
      .require(AffectStateKey)
      .emotions(0)
      .find((e) => e.name === "joy");
    expect(joy?.intensity ?? 0).toBeGreaterThan(0.2);
    const [thought] = r.mind().thoughts() as Thought[];
    expect(thought?.triggers[0]?.kind).toBe("turn");
    expect(thought?.thought).toContain("感受 喜(強)");
  });

  it("does not appraise conversations she was not part of", async () => {
    const provider = new ScriptedProvider(() => "{}");
    const r = await rig(provider);
    await wait(10);
    for (let i = 0; i < 6; i++) r.publish(message(`閒聊 ${i}`, false));
    await wait(5 * MIN);
    expect(provider.requests().filter((q) => callKind(q) === "appraise")).toHaveLength(0);
    void VOICE;
  });
});

describe("a rule on her goals (§9)", () => {
  const goals = (r: Rig) => r.sup.services.require(GoalAgendaKey);
  const later = {
    trigger: { kind: "whenever" },
    expires: toTimestamp(Date.now() + 86_400_000),
    source: "plan",
  } as const;

  async function ruled(forbids: (goal: DirectiveGoal) => Directive | null) {
    return rig(new MockProvider("p").reply("{}"), {
      extra: (sup) =>
        sup.services.provide("app", DirectivesKey, { forbids } as unknown as Directives),
    });
  }

  const added = (effect: string, text = "不要玩 Minecraft") =>
    customEvent(DIRECTIVE_CHANGED_TOPIC, {
      op: "add",
      text,
      directive: { effect, text },
      by: "discord:1",
    });

  it("a deny drops what it forbids and nothing else, with why", async () => {
    const r = await ruled((goal) =>
      goal.what.includes("Minecraft") ? ({ text: "不要玩 Minecraft" } as Directive) : null,
    );
    const book = goals(r);
    const mc = book.add({ what: "玩 Minecraft", why: "想玩", ...later });
    book.add({ what: "找 Owen 聊天", why: "想他", ...later });
    r.publish(added("deny"));
    await wait(10);
    expect(book.goals().map((g) => g.what)).toEqual(["找 Owen 聊天"]);
    expect(book.goal(mc.id)).toMatchObject({
      status: "dropped",
      close_reason: "規則:不要玩 Minecraft",
    });
  });

  it("anything but a new deny leaves her goals alone", async () => {
    const r = await ruled(() => ({ text: "x" }) as Directive);
    const book = goals(r);
    book.add({ what: "玩 Minecraft", why: "想玩", ...later });
    r.publish(added("avoid"));
    r.publish(
      customEvent(DIRECTIVE_CHANGED_TOPIC, { op: "remove", text: "", directive: null, by: "x" }),
    );
    await wait(10);
    expect(book.goals()).toHaveLength(1);
  });
});
