// The affect service through the module and the bus: its inputs and what it publishes.

import { exemptFromBusCheck, Supervisor } from "@miyoria/runtime/kernel";
import { MemorySettingsStore, SettingsStoreKey } from "@miyoria/store";
import {
  type AffectSnapshot,
  AffectStateKey,
  type Clock,
  Events,
  type HandleDirectory,
  HandleDirectoryKey,
  is,
  SelfStateKey,
  toTimestamp,
} from "@miyoria/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SelfModule } from "../src/index.js";
import { T0 } from "./helpers.js";

// One test sends malformed rule events on purpose (the module must ignore them).
exemptFromBusCheck(["affect.event"]);

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
  const sub = sup.bus.subscribe([Events.AffectChanged.type]);
  void (async () => {
    for await (const env of sub) {
      if (is(Events.AffectChanged, env)) changed.push(env.data as unknown as AffectSnapshot);
    }
  })();
  await sup.startAll();
  const publish = sup.bus.publisher("test");
  return {
    sup,
    clock,
    changed,
    publish,
    affect: sup.services.require(AffectStateKey),
    self: sup.services.require(SelfStateKey),
  };
}

const CTX = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" } as const;

describe("<emo:…> tags never write back", () => {
  it("`agent.emotion` changes neither her emotions nor her mood (the loop that pinned arousal)", async () => {
    const h = await boot();
    const before = h.affect.snapshot();
    for (let i = 0; i < 20; i++) {
      h.publish(Events.AgentEmotion, { turn: "t1", context: CTX, emotion: "smug" });
      h.publish(Events.AgentEmotion, { turn: "t1", context: CTX, emotion: "angry" });
    }
    // Wait until the bus has delivered them (a later event is handled after them).
    h.publish(Events.SelfNudge, { curiosity: 0.1 });
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
    h.publish(Events.AffectEvent, {
      kind: "topic_ignored",
      person: null,
      handle: null,
      context: null,
      detail: "沒人接話",
      key: "topic|1",
      at: toTimestamp(T0),
    });
    await vi.waitFor(() => expect(h.self.emotions(0).map((e) => e.name)).toContain("lonely"));
    expect(h.self.emotions(0).find((e) => e.name === "frustration")?.intensity).toBeCloseTo(0.1, 2);
  });

  it("a malformed or unknown event is ignored", async () => {
    const h = await boot();
    h.publish(Events.AffectEvent, { kind: "set_joy_to_one", amount: 1 } as never);
    h.publish(Events.AffectEvent, "nonsense" as never);
    h.publish(Events.SelfNudge, { curiosity: 0.1 });
    await vi.waitFor(() => expect(h.self.drives().curiosity).toBeGreaterThan(0.3));
    expect(h.self.emotions(0)).toEqual([]);
  });

  it("a voice playback cut off is an interruption (weak frustration, habituated)", async () => {
    const h = await boot();
    const ctx = { platform: "discord", scope: "g", channel: "v", kind: "voice" } as const;
    const cut = () =>
      h.publish(Events.VoicePlaybackEvent, {
        context: ctx,
        turn: null,
        state: "interrupted",
        text: "…",
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
    const ended = {
      resource: "broadcast" as const,
      request: { type: "stop_live" } as never,
      turn: null,
      at: toTimestamp(T0),
    };
    h.publish(Events.ActivityFailed, {
      type: "failed",
      task: "t1",
      ...ended,
      code: "timeout" as const,
      detail: "",
    });
    await vi.waitFor(() => expect(h.self.emotions(0).map((e) => e.name)).toContain("frustration"));
    h.publish(Events.ActivityDone, { type: "done", task: "t2", ...ended, detail: "", data: null });
    await vi.waitFor(() => expect(h.self.emotions(0).map((e) => e.name)).toContain("pride"));
  });
});

describe("affect.changed", () => {
  it("is published with the snapshot when her mood or strongest emotions move", async () => {
    const h = await boot();
    h.publish(Events.AffectEvent, {
      kind: "game_won",
      person: null,
      handle: null,
      context: null,
      detail: "",
      key: "w",
      at: toTimestamp(T0),
    });
    await vi.waitFor(() => expect(h.changed.length).toBeGreaterThan(0));
    const last = h.changed.at(-1);
    expect(last?.top.map((e) => e.name)).toEqual(expect.arrayContaining(["joy"]));
    expect(last?.mood_line).toMatch(/^心情/);
    expect(last?.biases.talkativeness).toBeGreaterThan(0);
  });
});
