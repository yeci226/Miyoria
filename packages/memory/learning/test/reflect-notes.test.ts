// The daily reflection on the notes: her documents are written as lines (author `reflect`), and a
// daily run makes one more call that rewrites her self document.

import { LlmRouter, LlmRouterKey, MockProvider, parseModelRef } from "@miyoria/llm/llm";
import { ServiceRegistry } from "@miyoria/runtime/kernel";
import { MemorySettingsStore, PeopleStoreKey } from "@miyoria/store";
import { KnowledgeKey, MemoryCuratorKey } from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotesKnowledge } from "../../notes/src/knowledge.js";
import { fakeResolver, OWEN, type Rig, rig } from "../../notes/test/helpers.js";
import {
  FeedbackTracker,
  KnowledgeStore,
  knowledgeConfig,
  LessonStore,
  Reflector,
  reflectConfig,
} from "../src/index.js";
import { selfRules } from "../src/reflect.js";

let open: Rig | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-11-02T12:00:00.000Z"));
});

afterEach(() => {
  open?.store.close();
  open = null;
  vi.useRealTimers();
});

const REFLECTION = JSON.stringify({
  summary: "今天學了怎麼少插話。",
  insights: [],
  outdated: [],
  documents: [
    {
      type: "create",
      subject: "self",
      kind: "自我模型",
      title: "我",
      content: { 想做的事: "學畫畫" },
    },
    {
      type: "create",
      subject: "topic:拉麵",
      kind: "主題",
      title: "拉麵",
      content: { 筆記: "週五吃" },
    },
  ],
  feelings: [],
  lessons: [],
  goals: [],
});

async function setup(...replies: string[]) {
  open = await rig();
  const provider = new MockProvider("p");
  for (const r of replies) provider.reply(r);
  const services = new ServiceRegistry();
  services.provide(
    "t",
    LlmRouterKey,
    new LlmRouter(new Map([["p", provider]]), new Map([["summarizer", [parseModelRef("p:s")]]])),
  );
  services.provide("t", MemoryCuratorKey, {
    notes: async () => [],
    insight: async () => "x",
    supersede: async () => true,
  });
  const settings = new MemorySettingsStore();
  const legacy = new KnowledgeStore(settings, "p", knowledgeConfig(), { now: () => Date.now() });
  const knowledge = new NotesKnowledge({ notes: open.notes, resolver: fakeResolver() });
  services.provide("t", KnowledgeKey, knowledge.base());
  services.provide("t", PeopleStoreKey, {
    all: async () => [{ id: OWEN, display_name: "Owen", created_at: "", accounts: [] }],
  } as never);
  const config = reflectConfig();
  const clock = { now: () => Date.now() };
  const reflector = new Reflector({
    config,
    profile: "p",
    name: "鯨魚",
    persona: () => "你是鯨魚娘。",
    services,
    store: settings,
    clock,
    feedback: new FeedbackTracker(
      settings,
      "p",
      { utcOffsetMinutes: 480, keepDays: 14, replyWindowMs: 600_000 },
      clock,
    ),
    lessons: new LessonStore(settings, "p", config.max_lessons, clock),
    notes: open.notes,
  });
  return { provider, reflector, notes: open.notes, legacy };
}

describe("daily reflection on the notes", () => {
  it("writes her documents as notes lines and rewrites her self document", async () => {
    const { provider, reflector, notes, legacy } = await setup(
      REFLECTION,
      "想做的事:學畫畫\n學到的:別一直插話\n最近:今天學了怎麼少插話",
    );
    const run = await reflector.reflect("daily", null);
    expect(run?.error).toBeNull();
    expect(run?.documents).toHaveLength(2);
    expect(notes.lines("topic:拉麵", "owner").map((l) => [l.text, l.author])).toEqual([
      ["筆記: 週五吃", "reflect"],
    ]);
    // The legacy store is not written any more.
    expect(legacy.docs()).toEqual([]);

    expect(provider.requests()).toHaveLength(2);
    const asked = provider.requests()[1];
    expect(asked?.messages[0]?.content).toContain(selfRules(12, 200));
    expect(asked?.messages[1]?.content).toContain("學畫畫");
    expect(asked?.messages[1]?.content).toContain("今天學了怎麼少插話");
    const self = notes.lines("self", "owner");
    expect(self.map((l) => [l.section, l.text]).sort()).toEqual([
      ["learned", "別一直插話"],
      ["recent", "今天學了怎麼少插話"],
      ["wants", "學畫畫"],
    ]);
    expect(self.every((l) => l.author === "reflect")).toBe(true);
    expect(run?.tokens).toBeGreaterThan(0);
  });

  it("keeps the self document and the run when the rewrite fails", async () => {
    const { reflector, notes } = await setup(REFLECTION);
    const run = await reflector.reflect("daily", null);
    expect(run?.error).toBeNull();
    expect(run?.documents).toHaveLength(2);
    expect(notes.lines("self", "owner").map((l) => l.text)).toEqual(["學畫畫"]);
  });

  it("does not rewrite after a light reflection", async () => {
    const { provider, reflector } = await setup(REFLECTION, "想做的事:不該寫");
    await reflector.reflect("light", null);
    expect(provider.requests()).toHaveLength(1);
  });
});
