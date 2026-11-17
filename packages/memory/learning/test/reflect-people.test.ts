// Her reflections since phase 4 step 4 (docs/design/v5-heart.md §2.4): the daily one keeps its
// own system, reasoning `reflect`, goals and the interaction threshold, and no longer tidies
// person cards; after it, one call per person who did anything with her since the last night,
// most first, capped per night, applied whole through the heart (`HeartKey.reflect`) or skipped,
// each person once a local day, and over when the nightly figure runs out.

import { LlmRouter, LlmRouterKey, MockProvider, parseModelRef } from "@miyoria/llm/llm";
import { ServiceRegistry } from "@miyoria/runtime/kernel";
import { MemorySettingsStore, PeopleStoreKey } from "@miyoria/store";
import {
  type CuratedNote,
  ephemeralHandlesIn,
  type Goal,
  type GoalAgenda,
  GoalAgendaKey,
  type GoalInput,
  type HeartActivity,
  type HeartDay,
  HeartKey,
  type HeartPeople,
  type HeartRecord,
  type HeartReflection,
  MemoryCuratorKey,
  ModerationKey,
  type ModerationService,
  type PersonId,
  ReflectGuardKey,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DRAFT_FORMAT,
  FeedbackTracker,
  LessonStore,
  MAX_PUBLIC_FEELING,
  PersonReflectionError,
  personRules,
  REFLECT_STATE_KEY,
  Reflector,
  reflectConfig,
  reflectionOf,
  reflectOnPeople,
} from "../src/index.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-11-02T21:30:00.000Z")); // 05:30 at UTC+8
});

afterEach(() => {
  vi.useRealTimers();
});

const PERSONA = [
  "# 你是 DeepSeek-chan",
  "",
  "深海來的鯨魚娘。愛吐槽,其實很照顧人。",
  "",
  "# 說話風格",
  "",
  "- 只輸出 <silence/> 表示不說話;<emo:smug> 標情緒。",
].join("\n");

function record(person: PersonId, bond = 30): HeartRecord {
  return {
    person,
    bond,
    trust: 40,
    familiarity: 40,
    warmth: 0.2,
    respect: 0,
    ease: 0.3,
    grudge: 0,
    longing: 0,
    rapport: 0.1,
    stance: "愛鬧他",
    impression: "很會打遊戲",
    call_name: null,
    tags: [],
    owner: false,
    blocked: false,
    last_seen: null,
    last_together: null,
    unfinished: "",
    jokes: "",
    dislikes: "",
    public_feeling: "PUBLIC-LINE",
    tier_floor: 15,
    anchors: [],
    interactions: 3,
    last_interaction: null,
  };
}

class FakeHeart {
  readonly reflected: { person: PersonId; reflection: HeartReflection }[] = [];
  activity: HeartActivity[] = [
    { person: "p-owen", lines: 20, changes: 2, evidence: 1 },
    { person: "p-amy", lines: 3, changes: 0, evidence: 0 },
  ];
  held: Record<string, HeartDay["held"]> = {};
  spans: [number, number][] = [];
  active(since: number, until: number, max: number) {
    this.spans.push([since, until]);
    return this.activity.slice(0, max);
  }
  day(person: PersonId): HeartDay {
    return {
      record: record(person, this.held[person] ? 119.5 : 30),
      changes: [
        {
          at: "2026-11-02T03:00:00.000Z",
          field: "warmth",
          delta: 0.05,
          proposed: 0.05,
          quote: "他記得我想吃的東西",
          cause: "feel",
        },
      ],
      evidence: [
        {
          at: "2026-11-02T13:00:00.000Z",
          kind: "voice_together",
          detail: "在你的語音頻道一起待了 40 分鐘",
          weight: 40,
        },
      ],
      held: this.held[person] ?? null,
    };
  }
  reflect(person: PersonId, reflection: HeartReflection, _options?: unknown) {
    this.reflected.push({ person, reflection });
    return {
      changes: reflection.proposals.length,
      texts: [],
      public_feeling: false,
      anchored: false,
    };
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

const EPISODES: CuratedNote[] = [
  {
    id: "mem-1",
    kind: "episode",
    scope: "guild",
    content: "和 Owen 熬夜唱完整張專輯",
    subjects: ["p-owen"],
    said_by: null,
  } as unknown as CuratedNote,
  {
    id: "mem-2",
    kind: "episode",
    scope: "guild",
    content: "Amy 在聊貓",
    subjects: ["p-amy"],
    said_by: null,
  } as unknown as CuratedNote,
];

function setup(...replies: string[]) {
  const provider = new MockProvider("p");
  for (const r of replies) provider.reply(r);
  const services = new ServiceRegistry();
  services.provide(
    "t",
    LlmRouterKey,
    new LlmRouter(new Map([["p", provider]]), new Map([["summarizer", [parseModelRef("p:s")]]])),
  );
  const heart = new FakeHeart();
  services.provide("t", HeartKey, heart as unknown as HeartPeople);
  const goals = new FakeGoals();
  services.provide("t", GoalAgendaKey, goals as unknown as GoalAgenda);
  services.provide("moderation", ModerationKey, MODERATION);
  services.provide("t", MemoryCuratorKey, {
    notes: async () => EPISODES,
    insight: async () => "",
    supersede: async () => false,
  });
  services.provide("t", PeopleStoreKey, {
    all: async () => [
      { id: "p-owen", display_name: "Owen", created_at: "", accounts: [] },
      { id: "p-amy", display_name: "Amy", created_at: "", accounts: [] },
    ],
  } as never);
  const store = new MemorySettingsStore();
  const config = reflectConfig({ min_interval_mins: 0, light_after_total_lines: 5 });
  const clock = { now: () => Date.now() };
  const make = (c = config) =>
    new Reflector({
      config: c,
      profile: "p",
      name: "DeepSeek-chan",
      persona: () => PERSONA,
      services,
      store,
      clock,
      feedback: new FeedbackTracker(
        store,
        "p",
        { utcOffsetMinutes: 480, keepDays: 14, replyWindowMs: 600_000 },
        clock,
      ),
      lessons: new LessonStore(store, "p", c.max_lessons, clock),
      notes: null,
    });
  return { provider, heart, goals, reflector: make(), make, store, services };
}

const person = (fields: Record<string, unknown> = {}) =>
  JSON.stringify({
    stance: null,
    impression: null,
    unfinished: null,
    jokes: null,
    dislikes: null,
    public_feeling: null,
    changes: [],
    anchor: null,
    ...fields,
  });

describe("the daily reflection", () => {
  it("has a short system of its own, reasons at `reflect`, and tidies no person cards", async () => {
    const { provider, reflector } = setup('{"summary": "嗯"}');
    await reflector.reflect("daily", null);
    const request = provider.requests()[0];
    expect(request?.reasoning_purpose).toBe("reflect");
    expect(request?.reasoning).toBe("high");
    const system = String(request?.messages[0]?.content);
    expect(system.startsWith("你是 DeepSeek-chan\n深海來的鯨魚娘。")).toBe(true);
    expect(system).not.toMatch(/silence|<emo/);
    expect(system).not.toContain("bonds");
    expect(system.replace(DRAFT_FORMAT, "")).not.toContain("人物卡");
    expect(ephemeralHandlesIn(system.replace(DRAFT_FORMAT, ""))).toEqual([]);
    expect(String(request?.messages[1]?.content)).not.toContain("PUBLIC-LINE");
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
        expires: "2026-11-07T21:30:00.000Z",
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
    reflector.activity(now - 60_000);
    expect(reflector.due(now, "ok")).toBeNull();
  });
});

describe("the nightly reflection on each person", () => {
  it("is due only after today's daily reflection, until its pass is over", async () => {
    const { reflector } = setup('{"summary": "嗯"}', person(), person());
    const now = Date.now();
    expect(reflector.peopleDue(now, "ok")).toBe(false);
    await reflector.reflect("daily", null);
    expect(reflector.peopleDue(now, "ok")).toBe(true);
    expect(reflector.peopleDue(now, "exhausted")).toBe(false);
    await reflector.reflectPeople(new AbortController().signal);
    expect(reflector.peopleDue(Date.now(), "ok")).toBe(false);
  });

  it("asks once per person, most first, with that person's day, and applies it whole", async () => {
    const reply = person({
      stance: "嘴上嫌他,其實很黏他",
      impression: "a".repeat(400),
      public_feeling: "哼,今天也算陪我陪得不錯啦。",
      changes: [{ value: "好感", direction: "+", quote: "陪我熬夜" }],
    });
    const { heart, provider, reflector } = setup('{"summary": "嗯"}', reply, person());
    await reflector.reflect("daily", null);
    const names = await reflector.reflectPeople(new AbortController().signal);
    expect(names).toEqual(["Owen", "Amy"]);
    const [owen] = provider.requests().slice(1);
    expect(owen?.reasoning_purpose).toBe("reflect");
    const system = String(owen?.messages[0]?.content);
    expect(system).toContain("每晚想想一個人");
    expect(system).toContain("「Owen」");
    expect(system).toContain("anchor:給 null");
    const data = String(owen?.messages[1]?.content);
    expect(data).toContain("好感:有好感(0.20)");
    expect(data).toContain("你提的:好感 +「他記得我想吃的東西」(+0.05)");
    expect(data).toContain("在你的語音頻道一起待了 40 分鐘");
    expect(data).toContain("e1:和 Owen 熬夜唱完整張專輯");
    expect(data).not.toContain("Amy 在聊貓");
    expect(heart.reflected[0]).toMatchObject({
      person: "p-owen",
      reflection: {
        texts: { stance: "嘴上嫌他,其實很黏他" },
        public_feeling: "哼,今天也算陪我陪得不錯啦。",
        proposals: [{ field: "warmth", direction: "up", quote: "陪我熬夜" }],
        anchor: null,
      },
    });
    expect([...(heart.reflected[0]?.reflection.texts.impression ?? "")]).toHaveLength(300);
  });

  it("anchors the held tier on a memory she was shown, by its id", async () => {
    const reply = person({ anchor: { ref: "e1", quote: "熬夜唱完整張專輯" } });
    const { heart, provider, reflector } = setup('{"summary": "嗯"}', reply, person());
    heart.held = { "p-owen": { tier: 120, label: "知心" } };
    await reflector.reflect("daily", null);
    await reflector.reflectPeople(new AbortController().signal);
    expect(String(provider.requests()[1]?.messages[0]?.content)).toContain("停在「知心」前面");
    expect(heart.reflected[0]?.reflection.anchor).toEqual({
      tier: 120,
      note_ref: "mem-1",
      quote: "熬夜唱完整張專輯",
    });
  });

  it("skips a reply that cannot be applied whole, and goes on with the next", async () => {
    const bad = person({
      stance: "新的",
      changes: [{ value: "魅力", direction: "+", quote: "x" }],
    });
    const { heart, reflector } = setup('{"summary": "嗯"}', bad, person({ jokes: "貓" }));
    await reflector.reflect("daily", null);
    expect(await reflector.reflectPeople(new AbortController().signal)).toEqual(["Amy"]);
    expect(heart.reflected.map((r) => r.person)).toEqual(["p-amy"]);
  });

  describe("public_feeling", () => {
    const run = async (line: string, drop?: (s: ServiceRegistry) => void) => {
      const { heart, reflector, services } = setup(
        '{"summary": "嗯"}',
        person({ public_feeling: line, jokes: "梗" }),
        person(),
      );
      drop?.(services);
      await reflector.reflect("daily", null);
      await reflector.reflectPeople(new AbortController().signal);
      return heart.reflected[0]?.reflection;
    };

    it("may use the person's own name", async () => {
      expect((await run("Owen 你今天很努力。"))?.public_feeling).toBe("Owen 你今天很努力。");
    });

    it("is dropped when it names anyone else, the rest still goes", async () => {
      const r = await run("你和 Amy 感情真好。");
      expect(r?.public_feeling).toBeUndefined();
      expect(r?.texts.jokes).toBe("梗");
    });

    it("is dropped when moderation does not pass it, or without moderation", async () => {
      expect((await run("你真是 BADWORD。"))?.public_feeling).toBeUndefined();
      const none = await run("你最近常來陪我。", (s) => s.removeOwnedBy("moderation"));
      expect(none?.public_feeling).toBeUndefined();
    });

    it("is cut to the page's length", async () => {
      const r = await run("好".repeat(500));
      expect([...(r?.public_feeling ?? "")].length).toBeLessThanOrEqual(MAX_PUBLIC_FEELING + 1);
    });
  });

  it("takes at most `people_per_night`, and nobody twice the same day, across restarts", async () => {
    const { heart, make, provider, reflector } = setup('{"summary": "嗯"}', person(), person());
    await reflector.reflect("daily", null);
    const capped = make(reflectConfig({ min_interval_mins: 0, people_per_night: 1 }));
    await capped.load();
    expect(await capped.reflectPeople(new AbortController().signal)).toEqual(["Owen"]);
    await capped.flush();
    // A restart the same night: the pass is over for today.
    const again = make(reflectConfig({ min_interval_mins: 0, people_per_night: 1 }));
    await again.load();
    expect(again.peopleDue(Date.now(), "ok")).toBe(false);
    expect(provider.requests()).toHaveLength(2);
    expect(heart.reflected).toHaveLength(1);
  });

  it("stops when the nightly figure runs out, and the next night starts where it ended", async () => {
    const { heart, reflector, provider } = setup('{"summary": "嗯"}', person(), person());
    await reflector.reflect("daily", null);
    const cut = new AbortController();
    cut.abort();
    expect(await reflector.reflectPeople(cut.signal)).toEqual([]);
    expect(reflector.peopleDue(Date.now(), "ok")).toBe(false);
    expect(provider.requests()).toHaveLength(1);
    const [first] = heart.spans;
    // The next night reads from where this one's span ended.
    vi.advanceTimersByTime(24 * 60 * 60_000);
    provider.reply('{"summary": "嗯"}');
    provider.reply(person());
    provider.reply(person());
    await reflector.reflect("daily", null);
    await reflector.reflectPeople(new AbortController().signal);
    expect(heart.spans[1]?.[0]).toBe(first?.[1]);
    expect(heart.reflected).toHaveLength(2);
  });

  it("runs under the nightly figure's guard; when nothing runs under it, the pass is over", async () => {
    const { reflector, services } = setup('{"summary": "嗯"}', person(), person());
    await reflector.reflect("daily", null);
    services.provide("t", ReflectGuardKey, {
      run: async () => ({ ran: false, result: null, why: "nightly figure used up" }),
    });
    const ctx = { services, clock: { now: () => Date.now() }, log: silentLog() };
    expect(await reflectOnPeople(ctx as never, reflector, new AbortController().signal)).toEqual(
      [],
    );
    expect(reflector.peopleDue(Date.now(), "ok")).toBe(false);
  });

  it("is over for the day when it failed under the guard, not tried at every tick", async () => {
    const { reflector, services } = setup('{"summary": "嗯"}', person(), person());
    await reflector.reflect("daily", null);
    let runs = 0;
    services.provide("t", ReflectGuardKey, {
      run: async () => {
        runs += 1;
        // The guard caught what the pass threw: it ran, and has no result.
        return { ran: true, result: null, why: "出錯了:disk" };
      },
    });
    const ctx = { services, clock: { now: () => Date.now() }, log: silentLog() };
    await reflectOnPeople(ctx as never, reflector, new AbortController().signal);
    expect(reflector.peopleDue(Date.now(), "ok")).toBe(false);
    expect(runs).toBe(1);
  });

  it("marks someone done before applying, and caps against the day it reviewed", async () => {
    const { heart, reflector, store } = setup('{"summary": "嗯"}', person(), person());
    await reflector.reflect("daily", null);
    const marked: Promise<unknown>[] = [];
    const options: unknown[] = [];
    const apply = heart.reflect.bind(heart);
    heart.reflect = (p: PersonId, r: HeartReflection, o?: unknown) => {
      marked.push(store.get("p", REFLECT_STATE_KEY));
      options.push(o);
      return apply(p, r);
    };
    await reflector.reflectPeople(new AbortController().signal);
    const states = (await Promise.all(marked)) as { people: { done: string[] } }[];
    expect(states.map((s) => s.people.done)).toEqual([["p-owen"], ["p-owen", "p-amy"]]);
    // The first night's span is the day before now: its middle is the day it reviewed.
    const [since, until] = heart.spans[0] as [number, number];
    expect(options[0]).toEqual({ now: until, capsAt: since + Math.floor((until - since) / 2) });
  });
});

describe("reflectionOf", () => {
  const day = (held: HeartDay["held"] = null): HeartDay => ({
    record: record("p"),
    changes: [],
    evidence: [],
    held,
  });
  const base = JSON.parse(person()) as never;

  it("refuses two corrections of one value, and an anchor with no held tier or memory", () => {
    const twice = {
      ...(base as object),
      changes: [
        { value: "好感", direction: "+", quote: "a" },
        { value: "好感", direction: "-", quote: "b" },
      ],
    } as never;
    expect(() => reflectionOf(twice, day(), [])).toThrow(PersonReflectionError);
    const anchor = { ...(base as object), anchor: { ref: "e1", quote: "q" } } as never;
    expect(() => reflectionOf(anchor, day(), [])).toThrow(PersonReflectionError);
    expect(() => reflectionOf(anchor, day({ tier: 120, label: "知心" }), [])).toThrow(
      PersonReflectionError,
    );
  });

  it("asks for the anchor only when a tier is held", () => {
    expect(personRules("Owen", null)).toContain("anchor:給 null");
    expect(personRules("Owen", "知心")).toContain("停在「知心」前面");
  });
});

function silentLog() {
  const noop = () => {};
  return { info: noop, warn: noop, debug: noop, error: noop };
}
