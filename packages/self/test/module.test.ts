import { Supervisor } from "@miyoria/kernel";
import { MemorySettingsStore, SettingsStoreKey } from "@miyoria/store";
import {
  type Clock,
  customEvent,
  type Event,
  type JsonValue,
  type Mood,
  PromptContributors,
  PromptContributorsKey,
  SelfStateKey,
  toTimestamp,
  type WorldSnapshot,
  type WorldState,
  WorldStateKey,
} from "@miyoria/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { selfConfig } from "../src/config.js";
import { eventDelta, SelfModule, STATE_KEY } from "../src/index.js";

const T0 = Date.parse("2026-11-02T12:00:00.000Z");
const ctx = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" } as const;

class ManualClock implements Clock {
  constructor(public at = T0) {}
  now(): number {
    return this.at;
  }
}

class FakeWorld implements WorldState {
  her: WorldSnapshot["her"] = {
    voice: null,
    voice_name: null,
    golive: null,
    streaming: false,
    scene: null,
    game: null,
  };
  snapshot(): WorldSnapshot {
    return {
      at: toTimestamp(T0),
      time: { local: "", weekday: 1, weekend: false, part_of_day: "", utc_offset_minutes: 480 },
      her: this.her,
      people: [],
      voice_channels: [],
      channels: [],
    };
  }
  person() {
    return null;
  }
  personById() {
    return null;
  }
  summary() {
    return "";
  }
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

async function boot(store = new MemorySettingsStore(), clock = new ManualClock()) {
  const sup = new Supervisor();
  cleanup.push(() => sup.stopAll());
  const contributors = new PromptContributors();
  const baseline: Mood = { valence: 0.1, arousal: 0.4, energy: 0.8 };
  const world = new FakeWorld();
  sup.services.provide("app", SettingsStoreKey, store);
  sup.services.provide("app", PromptContributorsKey, contributors);
  sup.services.provide("app", WorldStateKey, world);
  await sup.register(new SelfModule("p", { clock, baseline }), null, true);
  await sup.startAll();
  const self = sup.services.require(SelfStateKey);
  return { sup, store, clock, contributors, self, world };
}

describe("self module", () => {
  it("serves the snapshot with her mood and persists policy and agenda changes", async () => {
    const h = await boot();
    const snap = h.self.snapshot();
    // The mood is derived (baseline, the hour, her emotions and drives), not stored.
    expect(snap.mood?.valence).toBeCloseTo(0.1, 2);
    expect(snap.mood?.arousal).toBeCloseTo(0.4, 2);
    expect(snap.mood?.energy).toBeCloseTo(0.8, 2);
    expect(snap.drives.social).toBeCloseTo(0.3);
    h.self.setTalkativeness("discord:g1:c1", { level: 0.8, forMs: 60_000, why: "熱鬧" });
    const item = h.self.addAgenda({ text: "等 Owen 上線" });
    await vi.waitFor(async () => {
      const saved = (await h.store.get("p", STATE_KEY)) as { agenda: { id: string }[] } | null;
      expect(saved?.agenda.map((a) => a.id)).toEqual([item.id]);
    });
    expect(h.self.talkativeness(ctx)?.level).toBe(0.8);
    h.clock.at += 60_000;
    expect(h.self.talkativeness(ctx)).toBeNull();
    expect(h.self.completeAgenda(item.id)?.status).toBe("done");
    expect(h.self.agenda()).toEqual([]);
  });

  it("restores state and feelings after a restart", async () => {
    const store = new MemorySettingsStore();
    const first = await boot(store);
    first.self.setInitiative(0.9, "想主動");
    await first.self.setFeeling("person-1", "  Owen 最近常陪我聊天,有點在意他  ", "self");
    await first.self.setFeeling("person-2", "", "self");
    await first.sup.stopAll();
    expect(await store.get("p", "self:feeling:person-1")).toMatchObject({
      text: "Owen 最近常陪我聊天,有點在意他",
      by: "self",
    });

    const second = await boot(store, new ManualClock(T0 + 3_600_000));
    expect(second.self.initiative()).toBe(0.9);
    expect(second.self.feeling("person-1")?.text).toBe("Owen 最近常陪我聊天,有點在意他");
    expect(second.self.feelings().map((f) => f.person)).toEqual(["person-1"]);
    // Empty text deletes.
    expect(await second.self.setFeeling("person-1", " ", "panel")).toBeNull();
    // The person's card stays (only the feeling text goes).
    expect(await store.get("p", "self:feeling:person-1")).toMatchObject({ text: "" });
    expect(second.self.feeling("person-1")).toBeNull();
  });

  it("is satisfied by what happens on the bus", async () => {
    const h = await boot();
    const before = h.self.drives();
    h.sup.bus.publish("test", {
      type: "agent_turn_completed",
      data: { turn: "t", context: ctx, text: "哈囉" },
    });
    h.sup.bus.publish("test", customEvent("self.nudge", { play: 0.4, reason: "看到別人在玩" }));
    await vi.waitFor(() => {
      const d = h.self.drives();
      expect(d.social).toBeCloseTo(before.social - 0.06);
      expect(d.play).toBeCloseTo(before.play + 0.4);
    });
    expect(h.self.boredom()).toBeCloseTo(0.1);
  });

  it("drifts with what she is doing", async () => {
    const h = await boot();
    h.self.adjust({ play: 0.6 }, "test");
    h.world.her = { ...h.world.her, game: "Minecraft" };
    h.clock.at += 3_600_000;
    // 0.9 rises a little, playing takes 0.5 per hour.
    expect(h.self.drives().play).toBeLessThan(0.5);
    // Rest moves toward 1 - energy = 0.2.
    expect(h.self.drives().rest).toBeLessThan(0.3);
  });
});

describe("eventDelta", () => {
  const config = selfConfig();
  const self = (id: string) => id === "me";
  const message = (author: string, direct: boolean): Event => ({
    type: "platform_message_created",
    data: {
      id: { context: ctx, id: "m" },
      author: { account: { platform: "discord", id: author }, display_name: author, is_bot: false },
      text: "hi",
      mentions_self: direct,
      reply_to_self: false,
      attachments: [],
      ts: toTimestamp(T0),
    },
  });

  it("maps events to satisfaction", () => {
    expect(eventDelta(message("a", true), config, self)?.delta).toEqual({
      attention: -0.04,
      boredom: -0.02,
    });
    expect(eventDelta(message("a", false), config, self)?.delta).toEqual({ boredom: -0.01 });
    expect(eventDelta(message("me", true), config, self)).toBeNull();
    expect(
      eventDelta(
        { type: "agent_turn_completed", data: { turn: "t", context: ctx, text: " " } },
        config,
        self,
      ),
    ).toBeNull();
    expect(eventDelta(customEvent("world.salient", {}), config, self)?.delta).toEqual({
      boredom: -0.05,
      curiosity: -0.02,
    });
    // Nudges are limited to ±0.5 per drive.
    expect(
      eventDelta(customEvent("self.nudge", { social: 3, bogus: 1 } as JsonValue), config, self)
        ?.delta,
    ).toEqual({ social: 0.5 });
  });
});

describe("prompt", () => {
  it("contributes no prompt sections: the agent renders her state from the services", async () => {
    const h = await boot();
    expect(h.contributors.all()).toEqual([]);
  });

  it("still loads an old `prompt = false`", async () => {
    const sup = new Supervisor();
    cleanup.push(() => sup.stopAll());
    await sup.register(new SelfModule("p"), { prompt: false }, true);
    await sup.startAll();
    // Works without a store or world (the mood is derived, so it is always there).
    expect(sup.services.require(SelfStateKey).snapshot().mood).not.toBeNull();
  });
});
