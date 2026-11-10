import { ServiceRegistry } from "@miyoria/kernel";
import { LlmRouter, LlmRouterKey, MockProvider, parseModelRef } from "@miyoria/llm";
import { MemorySettingsStore, PeopleStoreKey } from "@miyoria/store";
import {
  type AgendaInput,
  type CuratedNote,
  customEvent,
  ephemeralHandlesIn,
  type InsightInput,
  KnowledgeKey,
  LessonsKey,
  type MemoryCurator,
  MemoryCuratorKey,
  type PersonId,
  ReflectionKey,
  SelfStateKey,
  toTimestamp,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emojiTone,
  FeedbackTracker,
  KnowledgeStore,
  knowledgeConfig,
  LessonStore,
  phraseTone,
  Reflector,
  reflectConfig,
  shortId,
} from "../src/index.js";
import { AMY, OWEN, rig, stopRigs, TEXT, wait } from "./helpers.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-11-02T12:00:00.000Z")); // 20:00 at UTC+8
});

afterEach(async () => {
  await stopRigs();
  vi.useRealTimers();
});

class FakeCurator implements MemoryCurator {
  readonly insights: InsightInput[] = [];
  readonly superseded: [string, string][] = [];
  constructor(readonly list: CuratedNote[]) {}
  async notes(): Promise<CuratedNote[]> {
    return this.list;
  }
  async insight(input: InsightInput): Promise<string> {
    const scopes = new Set(input.from.map((id) => this.list.find((n) => n.id === id)?.scope));
    if (scopes.size !== 1) throw new Error("different scopes");
    this.insights.push(input);
    return "insight-1";
  }
  async supersede(old: string, by: string): Promise<boolean> {
    this.superseded.push([old, by]);
    return true;
  }
}

class FakeSelf {
  readonly agendaItems: AgendaInput[] = [];
  readonly feelings = new Map<PersonId, string>();
  agenda() {
    return this.agendaItems.map((a, i) => ({ id: String(i), text: a.text }));
  }
  addAgenda(input: AgendaInput) {
    this.agendaItems.push(input);
    return { id: "x", text: input.text };
  }
  feeling(person: PersonId) {
    const text = this.feelings.get(person);
    return text === undefined ? null : { person, text, updated_at: "", by: "self" };
  }
  async setFeeling(person: PersonId, text: string) {
    this.feelings.set(person, text);
    return null;
  }
}

const note = (
  id: string,
  content: string,
  scope = "guild:g1",
  subjects = ["p-owen"],
): CuratedNote => ({
  id,
  kind: "fact",
  content,
  subjects,
  scope,
  importance: 0.5,
  confidence: 0.8,
  created_at: toTimestamp(Date.now()),
  said_by: null,
});

function setup(reply: string) {
  const provider = new MockProvider("p").reply(reply);
  const services = new ServiceRegistry();
  const router = new LlmRouter(
    new Map([["p", provider]]),
    new Map([["summarizer", [parseModelRef("p:s")]]]),
  );
  services.provide("t", LlmRouterKey, router);
  const curator = new FakeCurator([
    note("m1", "Owen 喜歡拉麵"),
    note("m2", "Owen 每週五吃拉麵"),
    note("m3", "Owen 住台北"),
    note("m4", "Owen 搬到台中了"),
    note("m5", "Amy 的私事", "channel:discord:g2:c2", ["p-amy"]),
  ]);
  services.provide("t", MemoryCuratorKey, curator);
  const store = new MemorySettingsStore();
  const kb = new KnowledgeStore(store, "p", knowledgeConfig(), { now: () => Date.now() });
  services.provide("t", KnowledgeKey, kb);
  const self = new FakeSelf();
  services.provide("t", SelfStateKey, self as never);
  services.provide("t", PeopleStoreKey, {
    all: async () => [
      { id: "p-owen", display_name: "Owen", created_at: "", accounts: [] },
      { id: "p-amy", display_name: "Amy", created_at: "", accounts: [] },
    ],
  } as never);
  const config = reflectConfig();
  const clock = { now: () => Date.now() };
  const feedback = new FeedbackTracker(
    store,
    "p",
    {
      utcOffsetMinutes: 480,
      keepDays: 14,
      replyWindowMs: 600_000,
    },
    clock,
  );
  const lessons = new LessonStore(store, "p", config.max_lessons, clock);
  const reflector = new Reflector({
    config,
    profile: "p",
    name: "DeepSeek-chan",
    persona: () => "你是鯨魚娘。",
    services,
    store,
    clock,
    feedback,
    lessons,
  });
  return { provider, curator, kb, self, feedback, lessons, reflector };
}

describe("daily reflection", () => {
  it("merges memories, supersedes contradictions, writes lessons, documents, feelings and goals", async () => {
    const reply = JSON.stringify({
      summary: "今天 Owen 跟我聊了很多,我插話太多次了。",
      insights: [
        { from: ["n1", "n2"], content: "Owen 很愛拉麵,每週五都吃", kind: "fact", importance: 0.7 },
      ],
      outdated: [{ old: "n3", by: "n4" }],
      documents: [
        {
          type: "create",
          subject: "self",
          kind: "自我模型",
          title: "我",
          content: { 做得不好: "插話太多" },
        },
        {
          type: "create",
          subject: "Owen",
          kind: "人物卡",
          title: "Owen",
          content: { 喜歡: ["拉麵"] },
          said_by: "Owen",
        },
      ],
      feelings: [{ person: "Owen", note: "今天跟他聊得很開心" }],
      lessons: [
        { text: "Owen 講話時不要插嘴", person: "Owen", place: null, talk: -0.8, days: 10 },
        { text: "在這裡少說一點", person: null, place: "discord:g1:c1", talk: -0.5 },
      ],
      goals: [{ text: "學會 Owen 喜歡的拉麵店名字", why: "想跟他多聊", days: 7 }],
    });
    const { provider, curator, kb, self, lessons, reflector, feedback } = setup(reply);
    feedback.record({ account: OWEN, person: "p-owen", name: "Owen" }, TEXT, "negative", "你好吵");
    const run = await reflector.reflect("daily", null);
    expect(run?.error).toBeNull();
    const data = provider.requests()[0]?.messages[1]?.content as string;
    expect(data).toContain("n1 [fact,guild:g1,Owen] Owen 喜歡拉麵");
    expect(data).not.toMatch(/\bu\d\b|\bp\d\b/);
    expect(data).toContain("嫌你 1");
    expect(provider.requests()[0]?.messages[0]?.content).not.toContain("拉麵");
    expect(curator.insights).toEqual([
      { content: "Owen 很愛拉麵,每週五都吃", kind: "fact", from: ["m1", "m2"], importance: 0.7 },
    ]);
    expect(curator.superseded).toEqual([["m3", "m4"]]);
    // Her own judgment: even the self-model may be written, and nobody's words are claimed.
    const docs = kb.docs();
    expect(docs.map((d) => d.subject.type).sort()).toEqual(["person", "self"]);
    expect(docs.every((d) => d.sources[""]?.kind === "self")).toBe(true);
    expect(self.feelings.get("p-owen")).toBe("今天跟他聊得很開心");
    expect(self.agendaItems.map((a) => a.text)).toEqual(["學會 Owen 喜歡的拉麵店名字"]);
    const all = lessons.all();
    expect(all.map((l) => l.text).sort()).toEqual(["Owen 講話時不要插嘴", "在這裡少說一點"]);
    // Lessons scoped to Owen shift her talkativeness only when he is in the conversation.
    expect(lessons.talkShift(TEXT, ["p-owen"])).toBeLessThan(0);
    // However many "be quieter" lessons pile up, together they only nudge her.
    for (let i = 0; i < 30; i++) {
      lessons.add({
        id: `quiet-${i}`,
        text: `在這裡少說話 ${i}`,
        person: null,
        scope: null,
        talk: -1,
        created_at: "2026-11-02T00:00:00.000Z",
        expires_at: null,
        source: "daily",
      });
    }
    expect(lessons.talkShift(TEXT, [])).toBeCloseTo(-0.15);
    expect(lessons.applicable(TEXT, ["p-amy"]).map((l) => l.text)).not.toContain(
      "Owen 講話時不要插嘴",
    );
    expect(run?.lessons).toHaveLength(2);
    expect(run?.goals).toHaveLength(1);
    expect(shortId(docs[0]?.id ?? "")).toMatch(/^#/);
  });

  it("refuses insights across privacy scopes and never shows DMs", async () => {
    const reply = JSON.stringify({
      summary: "嗯",
      insights: [{ from: ["n1", "n5"], content: "混在一起" }],
    });
    const { curator, reflector } = setup(reply);
    const run = await reflector.reflect("daily", null);
    expect(run?.insights).toBe(0);
    expect(curator.insights).toEqual([]);
  });

  it("runs once a day in a quiet moment, and lighter after a long session", () => {
    const { reflector } = setup("{}");
    const now = Date.parse("2026-11-02T21:30:00.000Z"); // 05:30 local
    reflector.activity(now - 5 * 60_000);
    expect(reflector.due(now, "ok")).toBeNull(); // somebody talked 5 minutes ago
    expect(reflector.due(now + 20 * 60_000, "ok")).toEqual({ kind: "daily" });
    expect(reflector.due(now + 20 * 60_000, "exhausted")).toBeNull();
    // Before the daily hour only light reflections.
    const evening = Date.parse("2026-11-02T18:00:00.000Z"); // 02:00 local
    vi.setSystemTime(evening);
    reflector.folded(TEXT, 90);
    expect(reflector.due(evening, "ok")).toBeNull();
    expect(reflector.due(evening + 11 * 60_000, "degraded")).toBeNull();
    expect(reflector.due(evening + 11 * 60_000, "ok")).toEqual({ kind: "light", context: TEXT });
  });

  it("gives up without applying anything on an unusable reply", async () => {
    const { reflector, lessons, curator } = setup("今天好累,不想寫 JSON");
    const run = await reflector.reflect("daily", null);
    expect(run?.error).toContain("unusable");
    expect(lessons.all()).toEqual([]);
    expect(curator.insights).toEqual([]);
  });

  it("a daily reflection that failed is tried again later, three times a day at most", async () => {
    const start = Date.parse("2026-11-02T22:00:00.000Z"); // 06:00 local
    vi.setSystemTime(start);
    const { reflector, provider } = setup("今天好累,不想寫 JSON");
    expect(reflector.due(start, "ok")).toEqual({ kind: "daily" });
    expect((await reflector.reflect("daily", null))?.error).toContain("unusable");
    // Not at once: the provider may be down.
    expect(reflector.due(start + 60_000, "ok")).toBeNull();
    const second = start + 31 * 60_000;
    vi.setSystemTime(second);
    expect(reflector.due(second, "ok")).toEqual({ kind: "daily" });
    await reflector.reflect("daily", null);
    const third = second + 31 * 60_000;
    vi.setSystemTime(third);
    expect(reflector.due(third, "ok")).toEqual({ kind: "daily" });
    await reflector.reflect("daily", null);
    // Three tries: the day is left alone.
    const later = third + 3 * 60 * 60_000;
    vi.setSystemTime(later);
    expect(reflector.due(later, "ok")).toBeNull();
    expect(provider.requests().length).toBeGreaterThanOrEqual(3);
  });

  it("a daily reflection that worked is not run again that day", async () => {
    const start = Date.parse("2026-11-02T22:00:00.000Z");
    vi.setSystemTime(start);
    const { reflector } = setup(JSON.stringify({ summary: "今天還不錯" }));
    expect((await reflector.reflect("daily", null))?.error).toBeNull();
    expect(reflector.due(start + 2 * 60 * 60_000, "ok")).toBeNull();
  });

  it("a daily reflection cut off (she was stopped) is still owed", async () => {
    const start = Date.parse("2026-11-02T22:00:00.000Z");
    vi.setSystemTime(start);
    // The call ends in an error while she is being stopped.
    const { reflector } = setup("講到一半");
    const controller = new AbortController();
    controller.abort();
    expect(await reflector.reflect("daily", null, controller.signal)).toBeNull();
    const later = start + 31 * 60_000;
    vi.setSystemTime(later);
    expect(reflector.due(later, "ok")).toEqual({ kind: "daily" });
  });
});

describe("feedback signals", () => {
  it("rules for emoji and phrases", () => {
    expect(emojiTone("👍")).toBe("positive");
    expect(emojiTone("👎")).toBe("negative");
    expect(emojiTone("🪨")).toBeNull();
    expect(phraseTone("小鯨閉嘴啦")).toBe("negative");
    expect(phraseTone("你好可愛")).toBe("positive");
    expect(phraseTone("今天天氣不錯")).toBeNull();
  });

  it("are recorded per person and context from the bus", async () => {
    const r = await rig({ provider: new MockProvider("p").reply("{}"), modules: ["reflect"] });
    r.publish({
      type: "action_completed",
      data: {
        action: "a1",
        turn: null,
        ok: true,
        error: null,
        message: { context: TEXT, id: "her-1" },
      },
    });
    r.publish(
      customEvent("platform.reaction", {
        message: { context: { ...TEXT }, id: "her-1" },
        account: { ...OWEN },
        display_name: "Owen",
        emoji: "❤️",
        added: true,
        at: toTimestamp(Date.now()),
      }),
    );
    // A reaction on someone else's message is not about her.
    r.publish(
      customEvent("platform.reaction", {
        message: { context: { ...TEXT }, id: "not-hers" },
        account: { ...OWEN },
        display_name: "Owen",
        emoji: "👎",
        added: true,
        at: toTimestamp(Date.now()),
      }),
    );
    // She opens a conversation that nobody answers.
    r.publish({
      type: "agent_decision",
      data: { turn: "T1", context: TEXT, respond: true, score: 0, reasons: ["intent:chat.start"] },
    });
    r.publish({
      type: "agent_turn_completed",
      data: { turn: "T1", context: TEXT, text: "大家好" },
    });
    await r.say(TEXT, AMY, "Amy", "小鯨好吵");
    r.publish(
      customEvent("gate.decision", {
        capability: "voice.join",
        allowed: false,
        reason: "對方不希望她這樣做。",
        stage: "consent",
        principal: {
          kind: "self",
          requester: null,
          context: { ...TEXT },
          override: false,
          actor: null,
        },
      }),
    );
    await wait(20 * 60_000);
    const tallies = r.sup.services.require(ReflectionKey).feedback(1);
    const owen = tallies.find((t) => t.subject === "person:p-owen");
    expect(owen).toMatchObject({ reactions_pos: 1, reactions_neg: 0 });
    const amy = tallies.find((t) => t.subject === "person:p-amy");
    // Amy talked within the window, so the opening counts as answered; and she said "好吵".
    expect(amy).toMatchObject({ answered: 1, negative: 1 });
    const place = tallies.find((t) => t.subject === "discord:g1:c1");
    expect(place).toMatchObject({
      started: 1,
      answered: 1,
      denied: 1,
      negative: 1,
      reactions_pos: 1,
    });
    expect(r.sup.services.require(LessonsKey).all()).toEqual([]);
    // Persisted compactly in a day bucket.
    expect([...(await r.store.list("p", "feedback:day:")).keys()]).toEqual([
      "feedback:day:2026-11-02",
    ]);
  });

  it("count an ignored opening", async () => {
    const r = await rig({ provider: new MockProvider("p").reply("{}"), modules: ["reflect"] });
    r.publish({
      type: "agent_decision",
      data: {
        turn: "T2",
        context: TEXT,
        respond: true,
        score: 0,
        reasons: ["initiative:idle_channel"],
      },
    });
    r.publish({
      type: "agent_turn_completed",
      data: { turn: "T2", context: TEXT, text: "有人在嗎" },
    });
    await wait(12 * 60_000);
    const place = r.sup.services
      .require(ReflectionKey)
      .feedback(1)
      .find((t) => t.subject === "discord:g1:c1");
    expect(place).toMatchObject({ started: 1, ignored: 1, answered: 0 });
  });
});

describe("reflection writes only stable names", () => {
  it("shows people by handle and places by their full string, the same on every call", async () => {
    const reply = JSON.stringify({ summary: "嗯" });
    const a = setup(reply);
    await a.reflector.reflect("daily", null);
    const first = a.provider.requests()[0]?.messages[1]?.content as string;
    expect(first).toContain("人(名字就是稱呼):Owen");
    expect(first).not.toMatch(/(?<![A-Za-z0-9_])[up][0-9]{1,4}(?![A-Za-z0-9_])/);
    // Another process, same data: the same names (they are not numbered per call).
    const b = setup(reply);
    await b.reflector.reflect("daily", null);
    expect(b.provider.requests()[0]?.messages[1]?.content).toBe(first);
  });

  it("rewrites a code from the lesson's own person, refuses what it cannot resolve, keeps style lessons out of talkativeness", async () => {
    const reply = JSON.stringify({
      summary: "u3 今天很吵,u1 也是。",
      feelings: [
        { person: "u1", note: "還沒對上人" },
        { person: "Owen", note: "u2 提醒我的事讓我很感謝他" },
        { person: "Owen", note: "今天聊得很開心" },
      ],
      lessons: [
        { text: "u1 講話時不要插嘴", person: "Owen", place: null, talk: -0.5 },
        { text: "u9 一直嗆我", person: null, place: null, talk: null },
        { text: "別一直重複同一個梗", person: "Owen", place: null, talk: -1 },
        { text: "這裡可以更活潑一點", person: null, place: "discord:g1:c1", talk: 0.6 },
      ],
      goals: [
        { text: "跟 u1 約好一起玩", why: "u1 提議的", days: 3 },
        { text: "把拉麵店名字記起來", why: "想多聊", days: 3 },
      ],
    });
    const { self, lessons, reflector } = setup(reply);
    const run = await reflector.reflect("daily", null);
    expect(run?.error).toBeNull();
    // The summary kept for the panel has lost its code sentences.
    expect(ephemeralHandlesIn(run?.summary ?? "")).toEqual([]);
    // Feelings: the unknown person and the unresolvable sentence are skipped.
    expect([...self.feelings.values()]).toEqual(["今天聊得很開心"]);
    // Goals: the code is not written into the agenda.
    expect(self.agendaItems.map((a) => a.text)).toEqual(["把拉麵店名字記起來"]);
    // Lessons: "u1" in a lesson about Owen is Owen; "u9" cannot be resolved, so no lesson.
    const all = lessons.all();
    expect(all.map((l) => l.text).sort()).toEqual([
      "Owen 講話時不要插嘴",
      "別一直重複同一個梗",
      "這裡可以更活潑一點",
    ]);
    for (const l of all) expect(ephemeralHandlesIn(l.text)).toEqual([]);
    // Only the lessons that are about how much she talks carry a `talk`.
    const talk = new Map(all.map((l) => [l.text, l.talk]));
    expect(talk.get("別一直重複同一個梗")).toBeNull();
    expect(talk.get("這裡可以更活潑一點")).toBe(0.6);
    // ...and it is scoped to the place she named by its full string.
    expect(all.find((l) => l.text.includes("活潑"))?.scope).toBe("discord:g1:c1");
  });
});
