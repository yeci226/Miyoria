import { Supervisor } from "@miyoria/runtime/kernel";
import {
  MemorySettingsStore,
  type SettingsStore,
  SettingsStoreKey,
  SqliteStore,
  StoreKey,
} from "@miyoria/store";
import {
  type AnyEventDefinition,
  type Clock,
  type EventPayload,
  Events,
  eventEnvelope,
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
import { heartTables } from "../../person/src/store.js";
import { selfConfig } from "../src/config.js";
import { SelfEngine } from "../src/engine.js";
import { eventDelta, SelfModule, STATE_KEY } from "../src/index.js";

/** An event as the bus delivers it. */
const ev = <D extends AnyEventDefinition>(def: D, data: EventPayload<D>) =>
  eventEnvelope("test", def, data, ...([] as never));

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

async function boot(
  store: SettingsStore = new MemorySettingsStore(),
  clock = new ManualClock(),
  sqlite: SqliteStore | null = null,
) {
  const sup = new Supervisor();
  cleanup.push(() => sup.stopAll());
  const contributors = new PromptContributors();
  const baseline: Mood = { valence: 0.1, arousal: 0.4, energy: 0.8 };
  const world = new FakeWorld();
  sup.services.provide("app", SettingsStoreKey, store);
  if (sqlite !== null) sup.services.provide("app", StoreKey, sqlite);
  sup.services.provide("app", PromptContributorsKey, contributors);
  sup.services.provide("app", WorldStateKey, world);
  await sup.register(new SelfModule("p", { clock, baseline }), null, true);
  await sup.startAll();
  const self = sup.services.require(SelfStateKey);
  return { sup, store, clock, contributors, self, world };
}

describe("self module", () => {
  it("serves the snapshot with her mood and persists policy and agenda changes", async () => {
    const sqlite = await SqliteStore.open(":memory:", { plugins: [heartTables] });
    cleanup.push(() => sqlite.close());
    const h = await boot(sqlite.settings, new ManualClock(), sqlite);
    const snap = h.self.snapshot();
    // The mood is derived (baseline, the hour, her emotions and drives), not stored.
    expect(snap.mood?.valence).toBeCloseTo(0.1, 2);
    expect(snap.mood?.arousal).toBeCloseTo(0.4, 2);
    expect(snap.mood?.energy).toBeCloseTo(0.8, 2);
    expect(snap.drives.social).toBeCloseTo(0.3);
    h.self.setTalkativeness("discord:g1:c1", { level: 0.8, forMs: 60_000, why: "熱鬧" });
    const item = h.self.addAgenda({ text: "等 Owen 上線" });
    await vi.waitFor(() => {
      const saved = sqlite.plugin(heartTables).self.get() as { agenda: { id: string }[] } | null;
      expect(saved?.agenda.map((a) => a.id)).toEqual([item.id]);
    });
    expect(h.self.talkativeness(ctx)?.level).toBe(0.8);
    h.clock.at += 60_000;
    expect(h.self.talkativeness(ctx)).toBeNull();
    expect(h.self.completeAgenda(item.id)?.status).toBe("done");
    expect(h.self.agenda()).toEqual([]);
  });

  it("keeps her state in heart_self, never in self:state, and restores it after a restart", async () => {
    const sqlite = await SqliteStore.open(":memory:", { plugins: [heartTables] });
    cleanup.push(() => sqlite.close());
    const first = await boot(sqlite.settings, new ManualClock(), sqlite);
    first.self.setInitiative(0.9, "想主動");
    await first.sup.stopAll();
    const kept = sqlite.plugin(heartTables).self.get() as { policy?: { initiative?: number } };
    expect(kept.policy?.initiative).toBe(0.9);
    expect(await sqlite.settings.get("p", STATE_KEY)).toBeNull();
    const second = await boot(sqlite.settings, new ManualClock(T0 + 3_600_000), sqlite);
    expect(second.self.initiative()).toBe(0.9);
  });

  it("reads the old self:state once while heart_self is empty", async () => {
    const sqlite = await SqliteStore.open(":memory:", { plugins: [heartTables] });
    cleanup.push(() => sqlite.close());
    const old = new SelfEngine(selfConfig(), T0);
    old.setInitiative(0.7, "以前的");
    await sqlite.settings.set("p", STATE_KEY, old.toJson());
    const h = await boot(sqlite.settings, new ManualClock(), sqlite);
    expect(h.self.initiative()).toBe(0.7);
  });

  it("is satisfied by what happens on the bus", async () => {
    const h = await boot();
    const before = h.self.drives();
    h.sup.bus.publish("test", Events.AgentTurnCompleted, { turn: "t", context: ctx, text: "哈囉" });
    h.sup.bus.publish("test", Events.SelfNudge, { play: 0.4, reason: "看到別人在玩" });
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
  const message = (author: string, direct: boolean) => ({
    id: { context: ctx, id: "m" },
    author: { account: { platform: "discord", id: author }, display_name: author, is_bot: false },
    text: "hi",
    mentions_self: direct,
    reply_to_self: false,
    attachments: [],
    ts: toTimestamp(T0),
  });

  it("maps events to satisfaction", () => {
    expect(
      eventDelta(ev(Events.PlatformMessageCreated, message("a", true)), config, self)?.delta,
    ).toEqual({
      attention: -0.04,
      boredom: -0.02,
    });
    expect(
      eventDelta(ev(Events.PlatformMessageCreated, message("a", false)), config, self)?.delta,
    ).toEqual({ boredom: -0.01 });
    expect(
      eventDelta(ev(Events.PlatformMessageCreated, message("me", true)), config, self),
    ).toBeNull();
    expect(
      eventDelta(
        ev(Events.AgentTurnCompleted, { turn: "t", context: ctx, text: " " }),
        config,
        self,
      ),
    ).toBeNull();
    expect(eventDelta(ev(Events.WorldSalient, {} as never), config, self)?.delta).toEqual({
      boredom: -0.05,
      curiosity: -0.02,
    });
    // Nudges are limited to ±0.5 per drive.
    expect(
      eventDelta(ev(Events.SelfNudge, { social: 3, bogus: 1 } as never), config, self)?.delta,
    ).toEqual({ social: 0.5 });
  });
});

describe("prompt", () => {
  it("contributes no prompt sections: the agent renders her state from the services", async () => {
    const h = await boot();
    expect(h.contributors.all()).toEqual([]);
  });
});
