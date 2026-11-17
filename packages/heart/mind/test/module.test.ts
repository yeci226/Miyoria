// What is left of her mind loop (phase 4 step 5, docs/design/v5-heart.md §2.6): the journal records
// her reflections and her `feel` in a line each, and a goal whose trigger fires becomes an item of
// her inbox on the new runner (a fired `mind.reminder`), never a Plan call. Nothing here calls a
// model to think, and `MindKey` no longer takes suggestions.

import { Supervisor } from "@miyoria/runtime/kernel";
import { MemorySettingsStore, SettingsStoreKey } from "@miyoria/store";
import {
  type Clock,
  Events,
  GoalAgendaKey,
  MindKey,
  type ReflectionRun,
  toTimestamp,
} from "@miyoria/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { goalReminder, MindModule } from "../src/index.js";

const T0 = Date.parse("2026-11-02T12:00:00.000Z");
const MIN = 60_000;

class ManualClock implements Clock {
  constructor(public at = T0) {}
  now(): number {
    return this.at;
  }
}

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});

async function boot(clock = new ManualClock()) {
  const sup = new Supervisor();
  cleanup.push(() => sup.stopAll());
  sup.services.provide("app", SettingsStoreKey, new MemorySettingsStore());
  await sup.register(new MindModule("p", { clock, name: "米優" }), null, true);
  await sup.startAll();
  const sub = sup.bus.subscribe([Events.MindReminder.type]);
  return { sup, clock, mind: sup.services.require(MindKey), sub };
}

describe("her journal", () => {
  it("keeps a line for a feel and for a reflection, and takes no suggestions", async () => {
    const h = await boot();
    expect("suggest" in h.mind).toBe(false);
    h.mind.note?.({
      kind: "feel",
      text: "開心(中)。小明:好感 +「他記得」",
      changes: ["小明 好感 +"],
    });
    const run: ReflectionRun = {
      id: "r1",
      at: toTimestamp(T0),
      kind: "daily",
      context: null,
      summary: "今天大家都很好。",
      insights: 0,
      superseded: 0,
      lessons: ["別太吵"],
      goals: [],
      documents: [],
      feelings: [],
      error: null,
      tokens: null,
      ms: 0,
    };
    h.sup.bus.publish("reflect", Events.ReflectRun, run);
    await vi.waitFor(() => expect(h.mind.thoughts(10)).toHaveLength(2));
    const [reflected, felt] = h.mind.thoughts(10);
    expect(reflected?.thought).toBe("今天大家都很好。");
    expect(reflected?.changes).toEqual(["學到:別太吵"]);
    expect(felt?.triggers[0]?.kind).toBe("turn");
    expect(h.mind.stats().last_at).not.toBeNull();
  });

  it("marks a feel from a DM as one", async () => {
    const h = await boot();
    const dm = { platform: "discord", scope: null, channel: "d1", kind: "dm" } as const;
    h.mind.note?.({ kind: "feel", text: "開心 中", context: dm });
    await vi.waitFor(() => expect(h.mind.thoughts(10)).toHaveLength(1));
    expect(h.mind.thoughts(1)[0]?.triggers[0]).toMatchObject({
      detail: "她在私訊裡的感受",
      context: dm,
    });
  });
});

describe("her goals", () => {
  it("a goal whose time came is an item of her inbox, once per refire window", async () => {
    const h = await boot();
    const goals = h.sup.services.require(GoalAgendaKey);
    const goal = goals.add({
      what: "問小明考試怎樣",
      why: "他說今天考試",
      trigger: { kind: "at", time: toTimestamp(T0 + 5 * MIN) },
      expires: toTimestamp(T0 + 24 * 60 * MIN),
      source: "reflect",
    });
    h.clock.at = T0 + 6 * MIN;
    const loop = h.mind as unknown as { checkGoals(now: number): unknown[] };
    expect(loop.checkGoals(h.clock.at)).toHaveLength(1);
    expect(loop.checkGoals(h.clock.at + MIN)).toHaveLength(0);
    const fired = h.sub.tryRecv();
    expect(fired?.data).toMatchObject({
      state: "fired",
      reminder: { id: `goal:${goal.id}`, fired: 1 },
    });
    expect(goalReminder(goal, 2, T0, 480).what).toContain("問小明考試怎樣");
  });
});
