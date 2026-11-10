// Module `mood`: her global mood when the Affect module (`self`) does not run.
//
// With the `self` module her mood is its own: derived from her drives, her emotions and the time
// of day (`deriveMood` of `@miyoria/types`), served as `MoodSignalsKey` and published as
// `mood.changed` by the affect service. `self` starts first and this module then stays idle: it
// is what is left of the older mood, for `[modules.self] enabled = false`.
//
// Without it, valence / arousal / energy drift with an exponential decay toward a target (the
// profile baseline shaped by her daily rhythm), nudged by `social.relationship` (praise, insults,
// ...) and `mood.nudge` with `{"valence": .., "arousal": .., "energy": .., "reason": ..}` (all
// optional; for games and extensions). Her own `<emo:…>` tags (`agent.emotion`) are expression
// only: they never feed back (that loop is what pinned arousal at 1).
//
// Publishes `mood.changed` when the mood moved noticeably.

import {
  defineManifest,
  errorMessage,
  interval,
  type Module,
  type ModuleContext,
  SerialQueue,
} from "@miyoria/kernel";
import type { MoodBaseline } from "@miyoria/profile";
import { type SettingsStore, SettingsStoreKey } from "@miyoria/store";
import {
  type Affect,
  AffectStateKey,
  type Clock,
  customEvent,
  type Event,
  isJsonObject,
  type JsonValue,
  MOOD_CHANGED_TOPIC,
  type Mood,
  type MoodSignals,
  MoodSignalsKey,
  nightShape,
  type ProfileId,
  SelfStateKey,
  serviceKey,
  systemClock,
  toTimestamp,
} from "@miyoria/types";
import { z } from "zod";

// The time-of-day curve lives in `@miyoria/types` (the affect service derives the mood from it).
export { nightShape };

/** Settings key of the persisted mood. */
export const SETTINGS_KEY = "mood:last";
/** Bus topic published when the mood moved. */
export const TOPIC_CHANGED = MOOD_CHANGED_TOPIC;

/** `[modules.mood]` config section. */
export const MoodConfigSchema = z.object({
  /** Time for half of a deviation from the baseline to fade. */
  half_life_secs: z.number().default(1800),
  tick_secs: z.number().int().nonnegative().default(30),
  /** Publish `mood.changed` once any dimension moved this much. */
  publish_threshold: z.number().default(0.05),
  /** Her local time zone as a UTC offset. */
  utc_offset_minutes: z
    .number()
    .int()
    .default(8 * 60),
  /** How much energy drops at the deepest point of the night (0..1). */
  night_dip: z.number().default(0.4),
  /** Remember the last mood across restarts (needs `SettingsStoreKey`). */
  persist: z.boolean().default(true),
  /** Valence change per affinity point of a social event. */
  social_weight: z.number().default(0.03),
  /** Largest change of one dimension by a single event. */
  max_nudge: z.number().default(0.2),
  /** How much her emotions move the mood's target (0 = only baseline and rhythm). */
  emotion_weight: z.number().nonnegative().default(1),
});

export type MoodConfig = z.output<typeof MoodConfigSchema>;

/** The defaults (`MoodConfig::default()`), optionally overridden. */
export function moodConfig(overrides: Partial<MoodConfig> = {}): MoodConfig {
  return { ...MoodConfigSchema.parse({}), ...overrides };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

function clampMood(m: Mood): Mood {
  const fix = (v: number, lo: number, hi: number) =>
    Number.isFinite(v) ? clamp(v, lo, hi) : Math.max(lo, 0);
  return {
    valence: fix(m.valence, -1, 1),
    arousal: fix(m.arousal, 0, 1),
    energy: fix(m.energy, 0, 1),
  };
}

/** Mood offsets her emotions push toward (`SelfState.affect`); `null` = none. */
export type AffectSource = () => Affect | null;

/** The mood derived from drives, emotions and the hour (`null`: the affect service is not running). */
export type DerivedMood = () => Mood | null;

/** Pure mood dynamics; `now` (epoch ms) is passed in. */
export class MoodEngine {
  #baseline: Mood;
  #current: Mood;
  #at: number;
  readonly #config: MoodConfig;
  readonly #affect: AffectSource;

  constructor(
    baseline: MoodBaseline,
    config: MoodConfig,
    now: number,
    affect: AffectSource = () => null,
  ) {
    this.#baseline = clampMood({
      valence: baseline.valence,
      arousal: baseline.arousal,
      energy: baseline.energy,
    });
    this.#config = config;
    this.#affect = affect;
    this.#at = now;
    this.#current = this.#baseline;
    this.#current = this.target(now);
  }

  baseline(): Mood {
    return { ...this.#baseline };
  }

  current(): Mood {
    return { ...this.#current };
  }

  clone(): MoodEngine {
    const copy = new MoodEngine(this.#baseline, this.#config, this.#at, this.#affect);
    copy.#current = this.#current;
    return copy;
  }

  #localHour(now: number): number {
    const minutes = this.#config.utc_offset_minutes;
    const offset = Math.abs(minutes) < 24 * 60 ? minutes : 0;
    const local = Math.floor((now + offset * 60_000) / 60_000);
    const minuteOfDay = ((local % 1440) + 1440) % 1440;
    return minuteOfDay / 60;
  }

  /** Where the mood drifts to at `now` (baseline shaped by the time of day, plus emotions). */
  target(now: number): Mood {
    const dip = clamp(this.#config.night_dip, 0, 1) * nightShape(this.#localHour(now));
    const a = this.#affect();
    const w = a === null ? 0 : Math.max(this.#config.emotion_weight, 0);
    const off = (v: number | undefined) => (v !== undefined && Number.isFinite(v) ? v * w : 0);
    return clampMood({
      valence: this.#baseline.valence + off(a?.valence),
      arousal: this.#baseline.arousal * (1 - 0.5 * dip) + off(a?.arousal),
      energy: this.#baseline.energy * (1 - dip) + off(a?.energy),
    });
  }

  /** Her emotions are moving the target (so social events need no direct nudge). */
  followsEmotions(): boolean {
    return this.#affect() !== null;
  }

  /** The mood at `now` without changing the engine. */
  peek(now: number): Mood {
    const copy = this.clone();
    copy.advance(now);
    return copy.current();
  }

  /** Decays toward the target up to `now`. */
  advance(now: number): void {
    const dt = Math.trunc(now - this.#at);
    if (dt <= 0) return;
    const secs = dt / 1000;
    const halfLife = Math.max(this.#config.half_life_secs, 1);
    const alpha = 1 - 0.5 ** (secs / halfLife);
    const target = this.target(now);
    const step = (cur: number, tgt: number) => cur + (tgt - cur) * alpha;
    this.#current = clampMood({
      valence: step(this.#current.valence, target.valence),
      arousal: step(this.#current.arousal, target.arousal),
      energy: step(this.#current.energy, target.energy),
    });
    this.#at = now;
  }

  /** Adds a change (each dimension limited to `max_nudge`) at `now`. */
  nudge(now: number, valence: number, arousal: number, energy: number): void {
    this.advance(now);
    const max = Math.abs(this.#config.max_nudge);
    const lim = (v: number) => (Number.isFinite(v) ? clamp(v, -max, max) : 0);
    this.#current = clampMood({
      valence: this.#current.valence + lim(valence),
      arousal: this.#current.arousal + lim(arousal),
      energy: this.#current.energy + lim(energy),
    });
  }

  /** Restores a saved mood from `at` and decays it to `now`. */
  restore(mood: Mood, at: number, now: number): void {
    this.#current = clampMood(mood);
    this.#at = Math.min(at, now);
    this.advance(now);
  }
}

function num(v: JsonValue, key: string): number {
  if (!isJsonObject(v)) return 0;
  const x = v[key];
  return typeof x === "number" ? x : 0;
}

function str(v: JsonValue, key: string): string | null {
  if (!isJsonObject(v)) return null;
  const x = v[key];
  return typeof x === "string" ? x : null;
}

/** A nudge with a short reason. */
export interface MoodNudge {
  valence: number;
  arousal: number;
  energy: number;
  reason: string;
}

/** The nudge an event causes, if any. */
export function eventNudge(event: Event, config: MoodConfig): MoodNudge | null {
  if (event.type !== "custom") return null;
  const { topic, payload } = event.data;
  switch (topic) {
    case "social.relationship": {
      const kind = str(payload, "kind");
      if (kind === null) return null;
      const affinity = num(payload, "affinity");
      if (Math.abs(affinity) < 1e-6) return null;
      // A dirty joke riles her only from someone it actually cost (see `flirtWeight`).
      const hostile =
        kind === "insult" || kind === "harassment" || (kind === "flirt_too_far" && affinity < -1);
      return {
        valence: affinity * config.social_weight,
        arousal: Math.abs(affinity) * 0.01 + (hostile ? 0.05 : 0),
        energy: 0,
        reason: `social: ${kind}`,
      };
    }
    case "mood.nudge":
      return {
        valence: num(payload, "valence"),
        arousal: num(payload, "arousal"),
        energy: num(payload, "energy"),
        reason: str(payload, "reason") ?? "nudge",
      };
    default:
      return null;
  }
}

/** Shared mood state. Provided as `MoodStateKey` and `MoodSignalsKey`. */
export class MoodState implements MoodSignals {
  readonly engine: MoodEngine;
  /** The derived mood (the affect service), when it runs: then nothing is stored here. */
  readonly #derived: DerivedMood;
  #lastPublished: Mood;
  readonly #threshold: number;
  readonly #config: MoodConfig;
  readonly #clock: Clock;

  constructor(
    baseline: MoodBaseline,
    config: MoodConfig,
    now: number,
    clock: Clock = systemClock,
    affect: AffectSource = () => null,
    derived: DerivedMood = () => null,
  ) {
    this.#derived = derived;
    this.engine = new MoodEngine(baseline, config, now, affect);
    this.#lastPublished = this.engine.current();
    this.#threshold = Math.abs(config.publish_threshold);
    this.#config = config;
    this.#clock = clock;
  }

  at(now: number): Mood {
    return this.#derived() ?? this.engine.peek(now);
  }

  /** Applies an event. Returns the new mood when it should be published. */
  handle(event: Event, now: number): { mood: Mood; reason: string } | null {
    // A derived mood is nobody's to nudge: events reach it through her drives and emotions.
    if (this.#derived() !== null) return null;
    // Her emotions already react to what people do (and the mood follows them).
    if (
      event.type === "custom" &&
      event.data.topic === "social.relationship" &&
      this.engine.followsEmotions()
    ) {
      return null;
    }
    const n = eventNudge(event, this.#config);
    if (n === null) return null;
    this.engine.nudge(now, n.valence, n.arousal, n.energy);
    const mood = this.#changed(now);
    return mood === null ? null : { mood, reason: n.reason };
  }

  /** Advances the decay. Returns the new mood when it should be published. */
  tick(now: number): Mood | null {
    this.engine.advance(now);
    return this.#changed(now);
  }

  #changed(now: number): Mood | null {
    const current = this.at(now);
    const last = this.#lastPublished;
    const moved = Math.max(
      Math.abs(current.valence - last.valence),
      Math.abs(current.arousal - last.arousal),
      Math.abs(current.energy - last.energy),
    );
    if (moved < this.#threshold) return null;
    this.#lastPublished = current;
    return current;
  }

  /** Restores `{"valence", "arousal", "energy", "at"}` as saved by `toJson`. */
  restoreJson(value: JsonValue, now: number): void {
    const rawAt = str(value, "at");
    let at = now;
    if (rawAt !== null) {
      const ms = Date.parse(rawAt);
      if (!Number.isNaN(ms)) at = ms;
    }
    const mood: Mood = {
      valence: num(value, "valence"),
      arousal: num(value, "arousal"),
      energy: num(value, "energy"),
    };
    this.engine.restore(mood, at, now);
    this.#lastPublished = this.engine.current();
  }

  toJson(now: number): JsonValue {
    const m = this.at(now);
    return { valence: m.valence, arousal: m.arousal, energy: m.energy, at: toTimestamp(now) };
  }

  mood(): Mood {
    return this.at(this.#clock.now());
  }
}

/** The service key of the shared mood state (Rust `Arc<MoodState>`). */
export const MoodStateKey = serviceKey<MoodState>("MoodState");

interface Running {
  state: MoodState;
  store: SettingsStore | undefined;
  ctx: ModuleContext;
  saves: SerialQueue;
}

/**
 * Module `mood`. Requires nothing; stays idle when the Affect module runs (it starts after it).
 * Otherwise uses `SettingsStoreKey`, `PromptContributorsKey` and `SelfStateKey` (her emotions move
 * the target, should `self` start later) when present.
 */
export class MoodModule implements Module {
  static readonly ID = "mood";
  readonly manifest = defineManifest(MoodModule.ID, "Mood", {
    description: "Her mood when the Affect module is off: decays to the persona baseline",
    optional: ["self"],
    configSchema: MoodConfigSchema,
  });
  readonly #profile: ProfileId;
  readonly #baseline: MoodBaseline;
  #running: Running | null = null;

  /** `baseline` is `Profile.manifest.mood`. */
  constructor(profile: ProfileId, baseline: MoodBaseline) {
    this.#profile = profile;
    this.#baseline = { ...baseline };
  }

  async #save(ctx: ModuleContext, store: SettingsStore, state: MoodState): Promise<void> {
    try {
      await store.set(this.#profile, SETTINGS_KEY, state.toJson(ctx.clock.now()));
    } catch (error) {
      ctx.log.warn({ err: errorMessage(error) }, "cannot persist mood");
    }
  }

  async start(ctx: ModuleContext): Promise<void> {
    if (ctx.services.get(AffectStateKey)) {
      ctx.log.debug("the Affect module owns her mood: nothing to do here");
      return;
    }
    const config = ctx.config(MoodConfigSchema);
    const now = ctx.clock.now();
    // The `self` module may start later or restart: looked up on every use.
    const affect = () => ctx.services.get(SelfStateKey)?.affect?.() ?? null;
    // With the affect service the mood is derived from her drives and emotions, not stored.
    const derived = () => ctx.services.get(AffectStateKey)?.snapshot().mood ?? null;
    const state = new MoodState(this.#baseline, config, now, ctx.clock, affect, derived);
    const store = config.persist ? ctx.services.get(SettingsStoreKey) : undefined;
    if (store) {
      try {
        const saved = await store.get(this.#profile, SETTINGS_KEY);
        if (saved !== null) state.restoreJson(saved, now);
      } catch (error) {
        ctx.log.warn({ err: errorMessage(error) }, "cannot load saved mood");
      }
    }
    ctx.provide(MoodSignalsKey, state);
    ctx.provide(MoodStateKey, state);
    const saves = new SerialQueue();
    this.#running = { state, store, ctx, saves };

    const changed = async (mood: Mood, reason: string) => {
      ctx.log.debug({ mood, reason }, "mood changed");
      ctx.publish(
        customEvent(TOPIC_CHANGED, {
          valence: mood.valence,
          arousal: mood.arousal,
          energy: mood.energy,
          reason,
        }),
      );
      if (store) await saves.run(() => this.#save(ctx, store, state));
    };

    // `agent.emotion` is not listened to: her own tags are expression, never a cause.
    const sub = ctx.subscribe(["social.relationship", "mood.nudge"]);
    ctx.spawn("mood", async () => {
      for await (const env of sub) {
        const result = state.handle(env.event, ctx.clock.now());
        if (result) await changed(result.mood, result.reason);
      }
    });
    ctx.spawn("tick", async (signal) => {
      for await (const _ of interval(Math.max(config.tick_secs, 1) * 1000, signal)) {
        const mood = state.tick(ctx.clock.now());
        if (mood) await changed(mood, "decay");
      }
    });
  }

  async stop(): Promise<void> {
    const running = this.#running;
    this.#running = null;
    if (!running) return;
    const store = running.store;
    if (store) await running.saves.run(() => this.#save(running.ctx, store, running.state));
  }
}
