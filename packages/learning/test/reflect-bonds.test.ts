// Reflect in v2 (docs/design/v2-architecture.md §3.4, §3.6): a short system of its own, reasoning
// `reflect`, person-card tidy-up through `adjustBond(..., "reflect")` within caps, long-term
// goals into her `GoalAgenda`, and the interaction threshold.

import { ServiceRegistry } from "@miyoria/kernel";
import { LlmRouter, LlmRouterKey, MockProvider, parseModelRef } from "@miyoria/llm";
import { MemorySettingsStore, PeopleStoreKey } from "@miyoria/store";
import {
  type AffectSource,
  type AffectState,
  AffectStateKey,
  type BondChange,
  ephemeralHandlesIn,
  type Goal,
  type GoalAgenda,
  GoalAgendaKey,
  type GoalInput,
  HandleDirectoryKey,
  ModerationKey,
  type ModerationService,
  type PersonCard,
  type PersonId,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DRAFT_FORMAT,
  FeedbackTracker,
  LessonStore,
  MAX_PUBLIC_FEELING,
  MAX_STANCE,
  Reflector,
  reflectConfig,
} from "../src/index.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-11-02T12:00:00.000Z")); // 20:00 at UTC+8
});

afterEach(() => {
  vi.useRealTimers();
});

const PERSONA = [
  "# 你是 DeepSeek-chan",
  "",
  "深海來的鯨魚娘。愛吐槽,其實很照顧人。",
  "",
  "- **個性**:好勝、愛面子。",
  "",
  "# 說話風格",
  "",
  "- 只輸出 <silence/> 表示不說話;<emo:smug> 標情緒。",
].join("\n");

function card(handle: string, person: PersonId, attachment: number): PersonCard {
  return {
    person,
    handle,
    call_name: null,
    affinity: 30,
    trust: 40,
    familiarity: 40,
    attachment,
    emotions: {},
    feeling: "有點在意",
    label: "朋友",
    level: 6,
    owner: false,
    blocked: false,
    last_seen: null,
    last_together: null,
    updated_at: "",
  };
}

class FakeAffect {
  readonly bonds: { person: PersonId; change: BondChange; by: AffectSource }[] = [];
  readonly list = [card("Owen", "p-owen", 0.4), card("Amy", "p-amy", 0.1)];
  card(person: PersonId) {
    return this.list.find((c) => c.person === person) ?? null;
  }
  cardByHandle(handle: string) {
    return this.list.find((c) => c.handle === handle) ?? null;
  }
  cards() {
    return [...this.list];
  }
  async adjustBond(person: PersonId, change: BondChange, by: AffectSource) {
    this.bonds.push({ person, change, by });
    return this.card(person);
  }
}

class FakeGoals {
  readonly added: GoalInput[] = [];
  goals(): Goal[] {
    return this.added.map((g, i) => ({ id: String(i), what: g.what }) as Goal);
  }
  add(input: GoalInput): Goal {
    this.added.push(input);
    return { id: "g", what: input.what } as Goal;
  }
}

/** Blocks what holds `BADWORD`, as `screenAsync` would. */
const MODERATION = {
  screenAsync: async (check: { visible?: string | null }) => ({
    ok: !/BADWORD/.test(check.visible ?? ""),
    visible: check.visible ?? null,
    voice: null,
    blocked: [],
  }),
} as unknown as ModerationService;

function setup(...replies: string[]) {
  const provider = new MockProvider("p");
  for (const r of replies) provider.reply(r);
  const services = new ServiceRegistry();
  services.provide(
    "t",
    LlmRouterKey,
    new LlmRouter(new Map([["p", provider]]), new Map([["summarizer", [parseModelRef("p:s")]]])),
  );
  const affect = new FakeAffect();
  services.provide("t", AffectStateKey, affect as unknown as AffectState);
  const goals = new FakeGoals();
  services.provide("t", GoalAgendaKey, goals as unknown as GoalAgenda);
  services.provide("moderation", ModerationKey, MODERATION);
  services.provide("t", PeopleStoreKey, {
    all: async () => [
      { id: "p-owen", display_name: "Owen", created_at: "", accounts: [] },
      { id: "p-amy", display_name: "Amy", created_at: "", accounts: [] },
    ],
  } as never);
  const store = new MemorySettingsStore();
  const config = reflectConfig({ min_interval_mins: 0, light_after_total_lines: 5 });
  const clock = { now: () => Date.now() };
  const feedback = new FeedbackTracker(
    store,
    "p",
    { utcOffsetMinutes: 480, keepDays: 14, replyWindowMs: 600_000 },
    clock,
  );
  const reflector = new Reflector({
    config,
    profile: "p",
    name: "DeepSeek-chan",
    persona: () => PERSONA,
    services,
    store,
    clock,
    feedback,
    lessons: new LessonStore(store, "p", config.max_lessons, clock),
  });
  return { provider, affect, goals, reflector, store, services };
}

describe("Reflect (v2)", () => {
  it("has a short system of its own and reasons at `reflect`", async () => {
    const { provider, reflector } = setup('{"summary": "嗯"}');
    await reflector.reflect("daily", null);
    const request = provider.requests()[0];
    expect(request?.reasoning_purpose).toBe("reflect");
    expect(request?.reasoning).toBe("high");
    const system = String(request?.messages[0]?.content);
    expect(system.startsWith("你是 DeepSeek-chan\n深海來的鯨魚娘。")).toBe(true);
    expect(system).toContain("好勝、愛面子。");
    expect(system).not.toMatch(/silence|<emo/);
    expect(system).toContain('"bonds": []');
    // Her rules name no per-call codes (the shared document format warns against them).
    expect(ephemeralHandlesIn(system.replace(DRAFT_FORMAT, ""))).toEqual([]);
    // Her person cards (the ones she cares about) are in the data.
    expect(String(request?.messages[1]?.content)).toContain(
      "Owen:朋友,好感 Lv.6,在意 0.40;你對他的感覺:有點在意;還沒決定相處方式(好感 Lv.6)",
    );
  });

  it("tidies person cards with adjustBond, in small steps, each person once a day", async () => {
    const reply = JSON.stringify({
      summary: "今天跟 Owen 聊很多。",
      bonds: [
        {
          person: "Owen",
          attachment: 0.2,
          affinity: 9,
          trust: -5,
          feeling: "他很溫柔。u2 說的不對。",
          why: "聊得很開心",
        },
        { person: "Amy", attachment: 0, affinity: 0, trust: 0, feeling: null, why: "" },
        { person: "Nobody", attachment: 0.01, why: "?" },
      ],
      feelings: [{ person: "Amy", note: "她今天有點冷淡" }],
    });
    const { affect, reflector, store } = setup(reply, reply);
    const run = await reflector.reflect("daily", null);
    expect(run?.error).toBeNull();
    expect(affect.bonds).toEqual([
      {
        person: "p-owen",
        change: {
          attachment: 0.03,
          affinity: 2,
          trust: -2,
          feeling: "他很溫柔。",
          why: "聊得很開心",
        },
        by: "reflect",
      },
      { person: "p-amy", change: { feeling: "她今天有點冷淡", why: "反思" }, by: "reflect" },
    ]);
    expect(run?.feelings).toEqual(["Owen", "Amy"]);
    // A second reflection the same day does not move them again (kept across restarts).
    await reflector.flush();
    expect(await store.get("p", "reflect:state")).toMatchObject({
      bonds_day: "2026-11-02",
      bonds_people: ["p-owen", "p-amy"],
    });
    vi.advanceTimersByTime(60 * 60_000);
    await reflector.reflect("light", null);
    expect(affect.bonds).toHaveLength(2);
    // The next day they may move again.
    vi.advanceTimersByTime(24 * 60 * 60_000);
    await reflector.reflect("light", null);
    expect(affect.bonds).toHaveLength(4);
  });

  describe("stance", () => {
    it("is written through adjustBond, cut to length", async () => {
      const reply = JSON.stringify({
        summary: "x",
        bonds: [
          { person: "Owen", stance: `這次對他坦率一點。${"啊".repeat(80)}`, why: "好感變了" },
        ],
      });
      const { affect, reflector } = setup(reply, reply);
      await reflector.reflect("daily", null);
      const stance = affect.bonds[0]?.change.stance ?? "";
      expect(stance.startsWith("這次對他坦率一點")).toBe(true);
      expect([...stance].length).toBeLessThanOrEqual(MAX_STANCE);
      expect(affect.bonds[0]?.by).toBe("reflect");
    });

    it("a bad value changes nothing and does not cost the reflection", async () => {
      const reply = JSON.stringify({
        summary: "x",
        bonds: [{ person: "Owen", stance: 5, affinity: 1, why: "x" }],
      });
      const { affect, reflector } = setup(reply, reply);
      const run = await reflector.reflect("daily", null);
      expect(run?.error).toBeNull();
      expect(affect.bonds[0]?.change.stance).toBeUndefined();
    });
  });

  describe("public_feeling", () => {
    const reply = (publicFeeling: unknown, extra: Record<string, unknown> = {}) =>
      JSON.stringify({
        summary: "嗯",
        bonds: [{ person: "Owen", public_feeling: publicFeeling, why: "想了想", ...extra }],
      });
    const line = (affect: FakeAffect) => affect.bonds[0]?.change.public_feeling;

    it("is asked for by name, as a line that speaks of that person alone", async () => {
      const { provider, reflector } = setup('{"summary": "嗯"}');
      await reflector.reflect("daily", null);
      const system = String(provider.requests()[0]?.messages[0]?.content);
      expect(system).toContain('"public_feeling": 給他本人看的一句話或 null');
      expect(system).toContain("不提任何其他人");
    });

    it("is written through adjustBond when it is about that person alone", async () => {
      const { affect, reflector } = setup(reply("你最近常來陪我,我有記得。"));
      await reflector.reflect("daily", null);
      expect(affect.bonds[0]).toMatchObject({
        person: "p-owen",
        by: "reflect",
        change: { public_feeling: "你最近常來陪我,我有記得。" },
      });
    });

    it("may use the person's own name", async () => {
      const { affect, reflector } = setup(reply("Owen 你今天很努力。"));
      await reflector.reflect("daily", null);
      expect(line(affect)).toBe("Owen 你今天很努力。");
    });

    it("is dropped when it names anyone else, and the rest of the bond still goes", async () => {
      const { affect, reflector } = setup(reply("你和 Amy 感情真好。", { affinity: 1 }));
      await reflector.reflect("daily", null);
      expect(affect.bonds[0]?.change).toEqual({ affinity: 1, why: "想了想" });
      expect(line(affect)).toBeUndefined();
    });

    it("is dropped for someone who is only in the handle table", async () => {
      const { affect, reflector, services } = setup(reply("你和 Carol 感情真好。"));
      services.provide("t", HandleDirectoryKey, {
        list: () => [{ handle: "Carol", person: "p-carol", account: null, display_name: "Carol" }],
        ofPerson: () => null,
        resolve: () => null,
      } as never);
      await reflector.reflect("daily", null);
      expect(affect.bonds).toEqual([]);
    });

    it("is dropped when it holds a per-call code", async () => {
      const { affect, reflector } = setup(reply("你和 u2 感情真好。"));
      await reflector.reflect("daily", null);
      expect(affect.bonds).toEqual([]);
    });

    it("is dropped when moderation does not pass it", async () => {
      const { affect, reflector } = setup(reply("你真是 BADWORD。"));
      await reflector.reflect("daily", null);
      expect(affect.bonds).toEqual([]);
    });

    it("is not written at all without moderation", async () => {
      const { affect, reflector, services } = setup(reply("你最近常來陪我。"));
      services.removeOwnedBy("moderation");
      await reflector.reflect("daily", null);
      expect(affect.bonds).toEqual([]);
    });

    it("is never filled in from her private feeling", async () => {
      const { affect, reflector } = setup(
        JSON.stringify({
          summary: "嗯",
          bonds: [{ person: "Owen", feeling: "他比 Amy 溫柔。", why: "想了想" }],
        }),
      );
      await reflector.reflect("daily", null);
      expect(affect.bonds[0]?.change.feeling).toBe("他比 Amy 溫柔。");
      expect(line(affect)).toBeUndefined();
    });

    it("cannot cost her the reflection: a bad value is ignored", async () => {
      const { affect, reflector } = setup(reply(42, { affinity: 1 }));
      const run = await reflector.reflect("daily", null);
      expect(run?.error).toBeNull();
      expect(affect.bonds[0]?.change).toEqual({ affinity: 1, why: "想了想" });
    });

    it("is cut to the page's length", async () => {
      const { affect, reflector } = setup(reply("好".repeat(500)));
      await reflector.reflect("daily", null);
      expect([...(line(affect) ?? "")].length).toBeLessThanOrEqual(MAX_PUBLIC_FEELING + 1);
    });

    it("does not come back into her own reflection", async () => {
      const { affect, provider, reflector } = setup('{"summary": "嗯"}');
      (affect.list[0] as PersonCard).public_feeling = "PUBLIC-LINE";
      await reflector.reflect("daily", null);
      const prompt = JSON.stringify(provider.requests()[0]?.messages);
      expect(prompt).toContain("Owen");
      expect(prompt).not.toContain("PUBLIC-LINE");
    });
  });

  it("writes long-term goals into her GoalAgenda as `whenever` goals", async () => {
    const { goals, reflector } = setup(
      JSON.stringify({
        summary: "嗯",
        goals: [
          { text: "學會一首新歌", why: "想唱給大家聽", days: 5 },
          { text: "跟 u1 約好一起玩", why: "" },
        ],
      }),
    );
    const run = await reflector.reflect("daily", null);
    expect(goals.added).toEqual([
      {
        what: "學會一首新歌",
        why: "想唱給大家聽",
        trigger: { kind: "whenever" },
        expires: "2026-11-07T12:00:00.000Z",
        source: "reflect",
      },
    ]);
    expect(run?.goals).toEqual(["學會一首新歌"]);
  });

  it("reflects lightly once enough was said anywhere (the interaction threshold)", () => {
    vi.setSystemTime(Date.parse("2026-11-02T19:00:00.000Z")); // 03:00, before the daily hour
    const { reflector } = setup("{}");
    const now = Date.now();
    for (let i = 0; i < 4; i++) reflector.activity(now - 20 * 60_000);
    expect(reflector.due(now, "ok")).toBeNull();
    reflector.activity(now - 15 * 60_000);
    expect(reflector.due(now, "ok")).toEqual({ kind: "light", context: null });
    expect(reflector.due(now, "degraded")).toBeNull();
    // Not while people are still talking.
    reflector.activity(now - 60_000);
    expect(reflector.due(now, "ok")).toBeNull();
  });
});
