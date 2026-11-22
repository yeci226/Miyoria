// When the nightly tidy of her notes runs (`src/tidy.ts`): once a local day after the night's
// reflections, in a quiet moment, under the nightly figure's guard as a job of its own name, and
// what it keeps so the documents rotate. The tidy itself is tested in `notes/test/tidy.test.ts`.

import type { ChatRequest, ChatResponse, Completer } from "@miyoria/llm/llm";
import { LlmRouter, LlmRouterKey, MockProvider, parseModelRef } from "@miyoria/llm/llm";
import { ServiceRegistry } from "@miyoria/runtime/kernel";
import { MemorySettingsStore } from "@miyoria/store";
import { type ReflectGuard, ReflectGuardKey } from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { placeSubject } from "../../notes/src/store.js";
import { MINUTE, type Rig, rig, SPACE } from "../../notes/test/helpers.js";
import {
  FeedbackTracker,
  LessonStore,
  NightlyTidy,
  Reflector,
  reflectConfig,
  TIDY_GOAL,
  TIDY_STATE_KEY,
  TidyConfigSchema,
} from "../src/index.js";

let open: Rig | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-11-02T21:30:00.000Z")); // 05:30 at UTC+8
});

afterEach(() => {
  open?.store.close();
  open = null;
  vi.useRealTimers();
});

const silent = { info: () => undefined, warn: () => undefined };
const clock = { now: () => Date.now() };

function nightly(store: MemorySettingsStore, enabled = true) {
  return new NightlyTidy({
    config: TidyConfigSchema.parse({ enabled, min_group_lines: 3 }),
    purpose: "summarizer",
    utcOffsetMinutes: 480,
    profile: "p",
    store,
    clock,
    log: silent,
  });
}

/** A model that writes every line back unchanged, counting its calls. */
function echo() {
  const asked: ChatRequest[] = [];
  const router: Completer = {
    async complete(_purpose: string, request: ChatRequest): Promise<ChatResponse> {
      asked.push(request);
      const body = String(request.messages[1]?.content ?? "");
      const lines = [...body.matchAll(/^- (L\d+) (.*)\([^(]*\)$/gm)].map((m) => ({
        section: "規矩",
        text: m[2] ?? "",
        from: [m[1] ?? ""],
      }));
      return {
        text: JSON.stringify({ lines }),
        reasoning: "",
        tool_calls: [],
        finish_reason: "stop",
        usage: { prompt_tokens: 100, completion_tokens: 40, cached_prompt_tokens: null },
      };
    },
  };
  return { router, asked };
}

async function placeWithRules() {
  open = await rig({ now: () => Date.now(), tick: () => undefined });
  for (const n of ["一", "二", "三", "四"]) {
    vi.advanceTimersByTime(MINUTE);
    open.notes.add(
      placeSubject("p1"),
      {
        section: "規矩",
        text: `規矩${n}`,
        provenance: "observed",
        scope: { type: "space", space: SPACE },
      },
      { author: "segment" },
    );
  }
  return open.notes;
}

describe("the nightly tidy's schedule", () => {
  it("is due once a local day, only when on and the night's reflections are over", async () => {
    const store = new MemorySettingsStore();
    const off = nightly(store, false);
    expect(off.due(Date.now(), true)).toBe(false);
    const tidy = nightly(store);
    expect(tidy.due(Date.now(), false)).toBe(false);
    expect(tidy.due(Date.now(), true)).toBe(true);
    await tidy.run(new ServiceRegistry(), null, undefined, new AbortController().signal);
    expect(tidy.due(Date.now(), true)).toBe(false);
    // The day it ran is kept: a restart does not run it twice.
    const again = nightly(store);
    await again.load();
    expect(again.due(Date.now(), true)).toBe(false);
    vi.advanceTimersByTime(24 * 60 * MINUTE);
    expect(again.due(Date.now(), true)).toBe(true);
  });

  it("runs under the nightly guard as a job named for it, and keeps when it tidied what", async () => {
    const notes = await placeWithRules();
    const store = new MemorySettingsStore();
    const services = new ServiceRegistry();
    const asked: Array<{ goal: string | undefined; summary: string | null }> = [];
    const guard: ReflectGuard = {
      run: async (run, signal, options) => {
        const result = await run(signal ?? new AbortController().signal);
        asked.push({ goal: options?.goal, summary: options?.summarise?.(result) ?? null });
        return { ran: true, result, why: null };
      },
    };
    services.provide("t", ReflectGuardKey, guard);
    const { router, asked: calls } = echo();
    const tidy = nightly(store);
    const report = await tidy.run(services, notes, router, new AbortController().signal);
    expect(report).toMatchObject({ documents: 1, groups: 1, tidied: 0, dropped: 0 });
    expect(calls).toHaveLength(1);
    expect(asked).toEqual([{ goal: TIDY_GOAL, summary: expect.stringContaining("看了 1 份") }]);
    const kept = (await store.get("p", TIDY_STATE_KEY)) as {
      day: string;
      documents: Record<string, number>;
    };
    expect(kept.day).toBe("2026-11-03");
    const doc = notes.document(placeSubject("p1"));
    expect(Object.keys(kept.documents)).toEqual([doc?.id]);
    // Tomorrow the document, unchanged, is not taken again.
    vi.advanceTimersByTime(24 * 60 * MINUTE);
    const next = nightly(store);
    await next.load();
    const second = await next.run(services, notes, router, new AbortController().signal);
    expect(second?.documents).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("does nothing, and is over for the day, when the guard lets nothing run", async () => {
    const notes = await placeWithRules();
    const services = new ServiceRegistry();
    services.provide("t", ReflectGuardKey, {
      run: async () => ({ ran: false, result: null, why: "今晚反思能花的額度用完了" }),
    });
    const { router, asked } = echo();
    const tidy = nightly(new MemorySettingsStore());
    expect(await tidy.run(services, notes, router, new AbortController().signal)).toBeNull();
    expect(asked).toHaveLength(0);
    expect(tidy.due(Date.now(), true)).toBe(false);
  });
});

describe("Reflector.nightOver", () => {
  function reflector(peoplePerNight: number) {
    const provider = new MockProvider("p");
    provider.reply('{"summary": "嗯"}');
    const services = new ServiceRegistry();
    services.provide(
      "t",
      LlmRouterKey,
      new LlmRouter(new Map([["p", provider]]), new Map([["summarizer", [parseModelRef("p:s")]]])),
    );
    const store = new MemorySettingsStore();
    const config = reflectConfig({ min_interval_mins: 0, people_per_night: peoplePerNight });
    return new Reflector({
      config,
      profile: "p",
      name: "她",
      persona: () => "",
      services,
      store,
      clock,
      feedback: new FeedbackTracker(
        store,
        "p",
        { utcOffsetMinutes: 480, keepDays: 14, replyWindowMs: 600_000 },
        clock,
      ),
      lessons: new LessonStore(store, "p", config.max_lessons, clock),
      notes: null,
    });
  }

  it("is true after today's daily reflection and pass on people, in a quiet moment", async () => {
    const r = reflector(0);
    expect(r.nightOver(Date.now(), "ok")).toBe(false);
    await r.reflect("daily", null);
    expect(r.nightOver(Date.now(), "ok")).toBe(true);
    expect(r.nightOver(Date.now(), "exhausted")).toBe(false);
    r.activity(Date.now());
    expect(r.nightOver(Date.now(), "ok")).toBe(false);
    vi.advanceTimersByTime(20 * MINUTE);
    expect(r.nightOver(Date.now(), "ok")).toBe(true);
  });

  it("waits for the pass on people when it is on", async () => {
    const r = reflector(30);
    await r.reflect("daily", null);
    expect(r.nightOver(Date.now(), "ok")).toBe(false);
    r.peopleFinished(Date.now());
    expect(r.nightOver(Date.now(), "ok")).toBe(true);
  });
});
