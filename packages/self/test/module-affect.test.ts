// The affect service through the module and the bus: its inputs and what it publishes.

import { Supervisor } from "@miyoria/kernel";
import { MemorySettingsStore, SettingsStoreKey } from "@miyoria/store";
import {
  AFFECT_CHANGED_TOPIC,
  AFFECT_EVENT_TOPIC,
  type AffectSnapshot,
  AffectStateKey,
  type Clock,
  customEvent,
  type Event,
  type HandleDirectory,
  HandleDirectoryKey,
  SelfStateKey,
  toTimestamp,
} from "@miyoria/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SelfModule } from "../src/index.js";
import { T0 } from "./helpers.js";

class ManualClock implements Clock {
  constructor(public at = T0) {}
  now(): number {
    return this.at;
  }
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

async function boot(display: "open" | "tsundere" = "open") {
  const sup = new Supervisor();
  cleanup.push(() => sup.stopAll());
  const clock = new ManualClock();
  sup.services.provide("app", SettingsStoreKey, new MemorySettingsStore());
  const directory: HandleDirectory = {
    ofAccount: () => "Owen",
    ofPerson: (p) => (p === "p1" ? "Owen" : null),
    resolve: (h) =>
      h === "Owen"
        ? {
            handle: "Owen",
            person: "p1",
            account: null,
            display_name: "Owen",
            created_at: toTimestamp(T0),
          }
        : null,
    list: () => [],
  };
  sup.services.provide("app", HandleDirectoryKey, directory);
  await sup.register(
    new SelfModule("p", {
      clock,
      temperament: { display },
      baseline: { valence: 0, arousal: 0.5, energy: 0.8 },
    }),
    null,
    true,
  );
  const changed: AffectSnapshot[] = [];
  const sub = sup.bus.subscribe([AFFECT_CHANGED_TOPIC]);
  void (async () => {
    for await (const env of sub) {
      if (env.event.type === "custom")
        changed.push(env.event.data.payload as unknown as AffectSnapshot);
    }
  })();
  await sup.startAll();
  const publish = (event: Event) => sup.bus.publish("test", event);
  return {
    sup,
    clock,
    changed,
    publish,
    affect: sup.services.require(AffectStateKey),
    self: sup.services.require(SelfStateKey),
  };
}

describe("<emo:…> tags never write back", () => {
  it("`agent.emotion` changes neither her emotions nor her mood (the loop that pinned arousal)", async () => {
    const h = await boot();
    const before = h.affect.snapshot();
    for (let i = 0; i < 20; i++) {
      h.publish(customEvent("agent.emotion", { emotion: "smug", context: null }));
      h.publish(customEvent("agent.emotion", { emotion: "angry", context: null }));
    }
    // Wait until the bus has delivered them (a later event is handled after them).
    h.publish(customEvent("self.nudge", { curiosity: 0.1 }));
    await vi.waitFor(() => expect(h.self.drives().curiosity).toBeGreaterThan(0.3));
    const after = h.affect.snapshot();
    expect(after.mood).toEqual(before.mood);
    expect(after.top).toEqual(before.top);
    expect(h.self.emotions(0)).toEqual([]);
  });
});

describe("rule events on the bus", () => {
  it("`affect.event` (from the Arbiter and others) is mapped by the table", async () => {
    const h = await boot();
    h.publish(
      customEvent(AFFECT_EVENT_TOPIC, {
        kind: "topic_ignored",
        person: null,
        handle: null,
        context: null,
        detail: "沒人接話",
        key: "topic|1",
        at: toTimestamp(T0),
      }),
    );
    await vi.waitFor(() => expect(h.self.emotions(0).map((e) => e.name)).toContain("lonely"));
    expect(h.self.emotions(0).find((e) => e.name === "frustration")?.intensity).toBeCloseTo(0.1, 2);
  });

  it("a malformed or unknown event is ignored", async () => {
    const h = await boot();
    h.publish(customEvent(AFFECT_EVENT_TOPIC, { kind: "set_joy_to_one", amount: 1 }));
    h.publish(customEvent(AFFECT_EVENT_TOPIC, "nonsense"));
    h.publish(customEvent("self.nudge", { curiosity: 0.1 }));
    await vi.waitFor(() => expect(h.self.drives().curiosity).toBeGreaterThan(0.3));
    expect(h.self.emotions(0)).toEqual([]);
  });

  it("a voice playback cut off is an interruption (weak frustration, habituated)", async () => {
    const h = await boot();
    const ctx = { platform: "discord", scope: "g", channel: "v", kind: "voice" } as const;
    const cut = () =>
      h.publish({
        type: "voice_playback",
        data: { context: ctx, turn: null, state: "interrupted", text: "…" },
      });
    cut();
    await vi.waitFor(() => expect(h.self.emotions(0).map((e) => e.name)).toContain("frustration"));
    const first = h.self.emotions(0).find((e) => e.name === "frustration")?.intensity ?? 0;
    expect(first).toBeCloseTo(0.1, 2);
    cut();
    await vi.waitFor(() =>
      expect(
        h.self.emotions(0).find((e) => e.name === "frustration")?.intensity ?? 0,
      ).toBeGreaterThan(first),
    );
    expect(h.self.emotions(0).find((e) => e.name === "frustration")?.intensity).toBeLessThan(
      first * 1.6,
    );
  });

  it("an activity that failed is a weak frustration, one that is done a weak pride", async () => {
    const h = await boot();
    h.publish(customEvent("activity.failed", { type: "failed", task: "t1" }));
    await vi.waitFor(() => expect(h.self.emotions(0).map((e) => e.name)).toContain("frustration"));
    h.publish(customEvent("activity.done", { type: "done", task: "t2" }));
    await vi.waitFor(() => expect(h.self.emotions(0).map((e) => e.name)).toContain("pride"));
  });

  it("a social appraisal arrives as appraisals (a strength, never her reading as a level)", async () => {
    const h = await boot();
    h.publish(
      customEvent("social.appraisal", {
        context: { platform: "discord", scope: "g", channel: "c", kind: "channel" },
        her: { joy: 0.95, shy: 0.2, pride: 0.5, sorrow: 0.4 },
        people: [],
      }),
    );
    await vi.waitFor(() => expect(h.self.emotions(0).length).toBeGreaterThan(0));
    const by = Object.fromEntries(h.self.emotions(0).map((e) => [e.name, e.intensity]));
    // The top three readings, as strong / medium / medium steps: 0.35, 0.2, 0.2 (not 0.95).
    expect(by.joy).toBeCloseTo(0.35, 2);
    expect(by.pride).toBeCloseTo(0.2, 2);
    expect(by.sorrow ?? 0).toBeCloseTo(0.2, 2);
    expect(by.shy ?? 0).toBe(0);
  });
});

describe("affect.changed", () => {
  it("is published with the snapshot when her mood or strongest emotions move", async () => {
    const h = await boot();
    h.publish(
      customEvent(AFFECT_EVENT_TOPIC, {
        kind: "game_won",
        person: null,
        handle: null,
        context: null,
        detail: "",
        key: "w",
        at: toTimestamp(T0),
      }),
    );
    await vi.waitFor(() => expect(h.changed.length).toBeGreaterThan(0));
    const last = h.changed.at(-1);
    expect(last?.top.map((e) => e.name)).toEqual(expect.arrayContaining(["joy"]));
    expect(last?.mood_line).toMatch(/^心情/);
    expect(last?.biases.talkativeness).toBeGreaterThan(0);
  });
});
