import { defineManifest, type Module, type ModuleContext, Supervisor } from "@miyoria/kernel";
import { MemorySettingsStore, SettingsStoreKey } from "@miyoria/store";
import {
  type AffectState,
  AffectStateKey,
  customEvent,
  type Event,
  type Mood,
  MoodSignalsKey,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  eventNudge,
  MoodConfigSchema,
  MoodEngine,
  MoodModule,
  MoodState,
  MoodStateKey,
  moodConfig,
  nightShape,
  SETTINGS_KEY,
} from "../src/index.js";

const baseline = () => ({ valence: 0.1, arousal: 0.5, energy: 0.7 });

/** Local (UTC+8) time on a fixed day (epoch ms). */
const local = (h: number, m: number) => Date.UTC(2026, 10, 1, h - 8, m, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const close = (a: number, b: number) => Math.abs(a - b) < 1e-3;

const fmt = (m: Mood) => JSON.stringify(m);

describe("mood", () => {
  it("energy_is_lower_late_at_night", () => {
    const e = new MoodEngine(baseline(), moodConfig(), local(12, 0));
    const noon = e.target(local(12, 0));
    const four = e.target(local(4, 0));
    const midnight = e.target(local(0, 0));
    expect(close(noon.energy, 0.7), fmt(noon)).toBe(true);
    expect(close(four.energy, 0.7 * 0.6), fmt(four)).toBe(true);
    expect(four.energy < midnight.energy && midnight.energy < noon.energy).toBe(true);
    expect(close(four.valence, 0.1)).toBe(true);
    expect(close(nightShape(4.5), 0.95)).toBe(true);
  });

  it("decays_to_baseline_with_half_life", () => {
    const t0 = local(12, 0);
    const e = new MoodEngine(baseline(), moodConfig({ half_life_secs: 600 }), t0);
    e.nudge(t0, 0.2, 0, 0);
    expect(close(e.current().valence, 0.3)).toBe(true);
    e.advance(t0 + 10 * MINUTE);
    expect(close(e.current().valence, 0.2), fmt(e.current())).toBe(true);
    e.advance(t0 + 5 * HOUR);
    expect(close(e.current().valence, 0.1)).toBe(true);
  });

  it("nudges_are_limited_and_clamped", () => {
    const t0 = local(12, 0);
    const e = new MoodEngine(baseline(), moodConfig(), t0);
    e.nudge(t0, 5, -5, Number.NaN);
    expect(close(e.current().valence, 0.3), "max_nudge").toBe(true);
    expect(close(e.current().arousal, 0.3)).toBe(true);
    expect(close(e.current().energy, 0.7)).toBe(true);
    for (let i = 0; i < 10; i++) e.nudge(t0, -0.2, -0.2, -0.2);
    expect(close(e.current().valence, -1)).toBe(true);
    expect(close(e.current().arousal, 0)).toBe(true);
    expect(close(e.current().energy, 0)).toBe(true);
  });

  it("events_nudge_and_publish_past_threshold", () => {
    const t0 = local(12, 0);
    const state = new MoodState(baseline(), moodConfig(), t0);
    const praise = customEvent("social.relationship", { kind: "gift", affinity: 3 });
    const r1 = state.handle(praise, t0);
    expect(r1).not.toBeNull();
    expect((r1?.mood.valence ?? 0) > 0.15 && r1?.reason === "social: gift").toBe(true);

    const insult = customEvent("social.relationship", { kind: "insult", affinity: -3 });
    const r2 = state.handle(insult, t0);
    expect(r2).not.toBeNull();
    const m2 = r2?.mood as Mood;
    expect(m2.valence < 0.15 && m2.arousal > 0.55, fmt(m2)).toBe(true);

    const small = customEvent("agent.emotion", { emotion: "smug" });
    expect(state.handle(small, t0), "below threshold").toBeNull();
    const admin = customEvent("social.relationship", { kind: null, affinity: 20 });
    expect(eventNudge(admin, moodConfig())).toBeNull();
    const game = customEvent("mood.nudge", { energy: -0.1, reason: "game: died" });
    const r3 = state.handle(game, t0);
    expect(r3?.reason).toBe("game: died");
    expect((r3?.mood.energy ?? 1) < 0.7).toBe(true);
    // Hours later it is back at the baseline.
    const later = state.at(t0 + 6 * HOUR);
    expect(close(later.valence, 0.1) && close(later.energy, 0.7), fmt(later)).toBe(true);
  });

  it("persists_and_restores", () => {
    const t0 = local(12, 0);
    const state = new MoodState(baseline(), moodConfig(), t0);
    state.engine.nudge(t0, -0.2, 0, 0);
    const saved = state.toJson(t0);
    const fresh = new MoodState(baseline(), moodConfig(), t0);
    fresh.restoreJson(saved, t0 + 30 * MINUTE);
    const m = fresh.at(t0 + 30 * MINUTE);
    expect(close(m.valence, 0), `half decayed: ${fmt(m)}`).toBe(true);
  });

  // ---- TS-specific -----------------------------------------------------------------------

  it("config defaults match legacy", () => {
    expect(MoodConfigSchema.parse({})).toEqual({
      half_life_secs: 1800,
      tick_secs: 30,
      publish_threshold: 0.05,
      utc_offset_minutes: 480,
      night_dip: 0.4,
      persist: true,
      social_weight: 0.03,
      max_nudge: 0.2,
      emotion_weight: 1,
    });
  });

  it("saved JSON shape and non-custom events", () => {
    const t0 = local(12, 0);
    const state = new MoodState(baseline(), moodConfig(), t0);
    const json = state.toJson(t0) as Record<string, unknown>;
    expect(Object.keys(json).sort()).toEqual(["arousal", "at", "energy", "valence"]);
    expect(Date.parse(json.at as string)).toBe(t0);
    const ready: Event = {
      type: "platform_ready",
      data: { platform: "discord", self_account: { platform: "discord", id: "1" } },
    };
    expect(state.handle(ready, t0)).toBeNull();
  });

  it("module persistence", async () => {
    const sup = new Supervisor();
    const settings = new MemorySettingsStore();
    await settings.set("p", SETTINGS_KEY, {
      valence: -0.5,
      arousal: 0.5,
      energy: 0.7,
      at: new Date().toISOString(),
    });
    sup.services.provide("kernel", SettingsStoreKey, settings);
    await sup.register(new MoodModule("p", baseline()), null, true);
    await sup.startAll();
    expect(sup.services.require(MoodSignalsKey).mood().valence < -0.4).toBe(true);
    expect(sup.services.has(MoodStateKey)).toBe(true);
    await sup.stopAll();
    const saved = (await settings.get("p", SETTINGS_KEY)) as Record<string, number>;
    expect((saved.valence ?? 0) < -0.4).toBe(true);
  });
});

describe("the mood module beside the Affect module", () => {
  class Affect implements Module {
    readonly manifest = defineManifest("self", "stands in for the Affect module");
    async start(ctx: ModuleContext): Promise<void> {
      ctx.provide(AffectStateKey, {} as AffectState);
      ctx.provide(MoodSignalsKey, { mood: () => ({ valence: 0.5, arousal: 0.5, energy: 0.5 }) });
    }
  }

  it("starts after it and has nothing left to do: one owner, nothing stored", async () => {
    const sup = new Supervisor();
    const store = new MemorySettingsStore();
    sup.services.provide("app", SettingsStoreKey, store);
    // In the order of the catalog: the mood module comes first.
    await sup.register(new MoodModule("p", baseline()), null, true);
    await sup.register(new Affect(), null, true);
    await sup.startAll();
    expect(sup.services.ownerOf(MoodSignalsKey)).toBe("self");
    expect(sup.services.has(MoodStateKey)).toBe(false);
    expect(sup.list().find((m) => m.id === "mood")?.state).toBe("running");
    await sup.stopAll();
    expect(await store.get("p", SETTINGS_KEY)).toBeNull();
  });

  it("without it, the older mood runs as before", async () => {
    const sup = new Supervisor();
    await sup.register(new MoodModule("p", baseline()), null, true);
    await sup.startAll();
    expect(sup.services.ownerOf(MoodSignalsKey)).toBe("mood");
    await sup.stopAll();
  });
});
