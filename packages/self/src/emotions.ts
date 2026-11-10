// Her emotions (七情): discrete, coexisting, each 0..1 with its own half-life. Pure; `now`
// (epoch ms) is passed in.
//
// * Stirring saturates: `v + (1 - v) * min(amount * gain, 1)`, so a strong emotion grows
//   slower and never passes 1; calming subtracts. `gain`, the half-life and the baseline are
//   her temperament (code defaults, overridden per profile by `[temperament]`).
// * Every emotion fades exponentially toward its baseline (0 unless the temperament says
//   otherwise); below `floor` and without a baseline it is forgotten.
// * `excite` is the one way to stir: habituation (same cause again within 2 h is worth 0.5ⁿ),
//   mutual inhibition (the opposite is pushed down by half of the stir) and the stir budget
//   (all emotions together, per 10 minutes) are in `dynamics.ts`.
// * `hold` keeps an emotion at least at the level a standing need implies (an unmet drive).
// * `affect` turns them into mood offsets (valence / arousal / energy) for the `mood` module.

import {
  type Affect,
  EMOTION_NAMES,
  type EmotionName,
  type EmotionReading,
  isJsonObject,
  type JsonValue,
  PERSON_EMOTION_NAMES,
  type PersonEmotionName,
  type PersonId,
  toTimestamp,
} from "@miyoria/types";

import {
  Habituation,
  habituationFactor,
  INHIBITION_SHARE,
  INHIBITS,
  StirBudget,
} from "./dynamics.js";

const MINUTE_MS = 60_000;
const MAX_CAUSE = 80;

/** How one emotion rises and fades for her. */
export interface Temper {
  /** Multiplier of every stir (1 = ordinary). */
  gain: number;
  halfLifeMins: number;
  /** Where it settles without events (0..1, default 0). */
  baseline?: number;
}

export type DisplayRules = "open" | "tsundere";

/** Her temperament: her display rules and how each emotion behaves. */
export interface Temperament {
  display: DisplayRules;
  emotions: Record<EmotionName, Temper>;
  /** Emotions toward one person. */
  toward: Record<PersonEmotionName, Temper>;
}

/** The profile's `[temperament]` table (see `@miyoria/profile` `TemperamentSchema`). */
export interface TemperamentInput {
  display?: DisplayRules;
  emotions?: Record<
    string,
    {
      gain?: number | undefined;
      half_life_mins?: number | undefined;
      baseline?: number | undefined;
    }
  >;
}

/** Ordinary half-lives (minutes): surprise is gone in moments, missing lasts. */
export const BASE_HALF_LIFE_MINS: Readonly<Record<EmotionName, number>> = {
  joy: 30,
  anger: 15,
  sorrow: 120,
  fear: 20,
  surprise: 3,
  disgust: 30,
  shy: 10,
  pride: 30,
  jealousy: 90,
  lonely: 240,
  missing: 360,
  gratitude: 180,
  guilt: 180,
  frustration: 45,
};

/**
 * Where emotions settle by display rules: a tsundere's pride sits a little above nothing (never
 * enough to show: below the `notice` level), the rest settle at 0. The profile's `[temperament]`
 * can set `baseline` per emotion.
 */
export const BASE_BASELINES: Readonly<Record<DisplayRules, Partial<Record<EmotionName, number>>>> =
  {
    open: {},
    tsundere: { pride: 0.12 },
  };

/** Ordinary half-lives of emotions toward someone (minutes). */
export const BASE_TOWARD_HALF_LIFE_MINS: Readonly<Record<PersonEmotionName, number>> = {
  missing: 1440,
  jealousy: 180,
  gratitude: 1440,
  resentment: 480,
};

/**
 * Valence / arousal / energy per unit of each emotion (a full-strength emotion moves the mood
 * this much); summed, then bounded by `affect`.
 */
const AFFECT: Readonly<Record<EmotionName, readonly [number, number, number]>> = {
  joy: [0.5, 0.2, 0.1],
  anger: [-0.4, 0.5, 0],
  sorrow: [-0.5, -0.2, -0.15],
  fear: [-0.3, 0.4, 0],
  surprise: [0, 0.4, 0],
  disgust: [-0.3, 0.2, 0],
  shy: [0.1, 0.3, 0],
  pride: [0.4, 0.3, 0.05],
  jealousy: [-0.35, 0.3, 0],
  lonely: [-0.35, -0.2, -0.1],
  missing: [-0.2, -0.1, -0.05],
  gratitude: [0.35, 0.05, 0],
  guilt: [-0.3, 0.1, -0.05],
  frustration: [-0.3, 0.35, 0],
};
const MAX_VALENCE = 0.7;
const MAX_AROUSAL = 0.4;
const MAX_ENERGY = 0.3;

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0);
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

export function isEmotion(name: string): name is EmotionName {
  return (EMOTION_NAMES as readonly string[]).includes(name);
}

export function isPersonEmotion(name: string): name is PersonEmotionName {
  return (PERSON_EMOTION_NAMES as readonly string[]).includes(name);
}

/** Her temperament from the profile's table; `unknown` lists names that are not emotions. */
export function temperament(input: TemperamentInput = {}): {
  temperament: Temperament;
  unknown: string[];
} {
  const display = input.display ?? "open";
  const emotions = Object.fromEntries(
    EMOTION_NAMES.map((n) => [
      n,
      { gain: 1, halfLifeMins: BASE_HALF_LIFE_MINS[n], baseline: BASE_BASELINES[display][n] ?? 0 },
    ]),
  ) as Record<EmotionName, Temper>;
  const toward = Object.fromEntries(
    PERSON_EMOTION_NAMES.map((n) => [n, { gain: 1, halfLifeMins: BASE_TOWARD_HALF_LIFE_MINS[n] }]),
  ) as Record<PersonEmotionName, Temper>;
  const unknown: string[] = [];
  for (const [name, t] of Object.entries(input.emotions ?? {})) {
    const targets: Temper[] = [];
    if (isEmotion(name)) targets.push(emotions[name]);
    // The same name toward someone (想念, 嫉妒, 感激) rises like hers, at its own pace.
    if (isPersonEmotion(name)) targets.push(toward[name]);
    if (targets.length === 0) {
      unknown.push(name);
      continue;
    }
    for (const target of targets) {
      if (t.gain !== undefined && Number.isFinite(t.gain)) target.gain = Math.max(t.gain, 0);
      if (t.half_life_mins !== undefined && t.half_life_mins > 0) {
        target.halfLifeMins = t.half_life_mins;
      }
      if (
        t.baseline !== undefined &&
        Number.isFinite(t.baseline) &&
        target.baseline !== undefined
      ) {
        target.baseline = clamp01(t.baseline);
      }
    }
  }
  return { temperament: { display, emotions, toward }, unknown };
}

/** `v` stirred by `amount` (> 0, scaled by `gain`) or calmed (< 0). */
export function stir(v: number, amount: number, gain: number): number {
  if (!Number.isFinite(amount) || amount === 0) return clamp01(v);
  if (amount < 0) return clamp01(v + amount);
  return clamp01(v + (1 - v) * clamp01(amount * gain));
}

/** `v` after `ms` with a half-life of `halfLifeMins`. */
export function fade(v: number, ms: number, halfLifeMins: number): number {
  if (ms <= 0) return v;
  return v * 0.5 ** (ms / (Math.max(halfLifeMins, 0.01) * MINUTE_MS));
}

function cut(text: string, max: number): string {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}

interface Slot {
  v: number;
  /** When it was last stirred. */
  at: number;
  cause: string;
  person: PersonId | null;
}

/** What a standing need holds an emotion at (see `hold`). */
interface Held {
  v: number;
  cause: string;
  person: PersonId | null;
}

/** One stir: what, how much (before temperament, habituation and the budget) and why. */
export interface Excitation {
  name: EmotionName;
  /** > 0, the event's own strength (a `APPRAISAL_STRENGTH` or a rule's strength). */
  base: number;
  /** Counts as the same cause (for habituation) when equal. */
  key: string;
  cause: string;
  person: PersonId | null;
}

/** What `excite` did. */
export interface Excited {
  /** The emotion's intensity afterwards. */
  value: number;
  /** The stir applied (after gain, habituation and the budget). */
  applied: number;
  /** `0.5ⁿ` (1 = first time). */
  habituation: number;
  /** Her own emotions it pushed down. */
  inhibited: Partial<Record<EmotionName, number>>;
  /** Emotions toward the person it should push down (the caller owns those). */
  inhibitedToward: Partial<Record<PersonEmotionName, number>>;
}

export interface EmotionOptions {
  /** Most stir allowed in any 10 minutes, all emotions together (0: unlimited). */
  budget?: number;
}

export class EmotionEngine {
  #slots = new Map<EmotionName, Slot>();
  #held = new Map<EmotionName, Held>();
  #at: number;
  readonly #habit = new Habituation();
  readonly #budget: StirBudget;

  constructor(
    private readonly temper: Temperament,
    private readonly floor: number,
    now: number,
    options: EmotionOptions = {},
  ) {
    this.#at = now;
    this.#budget = new StirBudget(options.budget ?? 0);
  }

  get temperament(): Temperament {
    return this.temper;
  }

  #baseline(name: EmotionName): number {
    return clamp01(this.temper.emotions[name].baseline ?? 0);
  }

  /** `v` faded toward the baseline of `name` over `ms`. */
  #fade(name: EmotionName, v: number, ms: number): number {
    const base = this.#baseline(name);
    return base + fade(v - base, ms, this.temper.emotions[name].halfLifeMins);
  }

  /** Fades every emotion up to `now`. */
  advance(now: number): void {
    const dt = now - this.#at;
    if (dt <= 0) return;
    for (const [name, slot] of this.#slots) {
      slot.v = this.#fade(name, slot.v, dt);
      if (slot.v < this.floor && this.#baseline(name) < this.floor) this.#slots.delete(name);
    }
    this.#at = now;
  }

  /** The slot's own intensity at `now` (baseline when it has no slot). */
  #own(name: EmotionName, now: number): number {
    const slot = this.#slots.get(name);
    if (!slot) return this.#baseline(name);
    return this.#fade(name, slot.v, now - this.#at);
  }

  /**
   * Stirs `name` by `e.base`: times her gain, times `0.5ⁿ` when the same cause counted `n`
   * times in the last two hours, limited by what is left of the ten-minute budget; saturating
   * (never past 1). Pushes the opposites down by half of what it stirred.
   */
  excite(e: Excitation, now: number): Excited {
    this.advance(now);
    const none: Excited = {
      value: this.value(e.name, now),
      applied: 0,
      habituation: 1,
      inhibited: {},
      inhibitedToward: {},
    };
    if (!Number.isFinite(e.base) || e.base <= 0) return none;
    const prior = this.#habit.count(e.key, now);
    const habituation = habituationFactor(prior);
    this.#habit.record(e.key, now);
    const wanted = e.base * this.temper.emotions[e.name].gain * habituation;
    const applied = Math.min(wanted, this.#budget.room(now), 1);
    if (applied < 1e-4) return { ...none, habituation };
    this.#budget.take(now, applied);
    const slot = this.#slots.get(e.name);
    const before = slot?.v ?? this.#baseline(e.name);
    const v = clamp01(before + (1 - before) * applied);
    this.#slots.set(e.name, { v, at: now, cause: cut(e.cause, MAX_CAUSE), person: e.person });
    const inhibited: Excited["inhibited"] = {};
    const inhibitedToward: Excited["inhibitedToward"] = {};
    const rule = INHIBITS[e.name];
    if (rule) {
      const down = applied * INHIBITION_SHARE;
      for (const other of rule.own) {
        const cur = this.#slots.get(other);
        if (!cur) continue;
        const taken = Math.min(cur.v, down);
        if (taken <= 0) continue;
        this.#lower(other, cur, taken);
        inhibited[other] = taken;
      }
      for (const other of rule.toward) inhibitedToward[other] = down;
    }
    return { value: this.value(e.name, now), applied, habituation, inhibited, inhibitedToward };
  }

  /**
   * Counts `key` as a cause that happened now and returns its `0.5ⁿ` factor (for effects the
   * engine does not stir itself, like emotions toward a person).
   */
  habituate(key: string, now: number): number {
    const factor = habituationFactor(this.#habit.count(key, now));
    this.#habit.record(key, now);
    return factor;
  }

  /** Pushes `name` down by `amount` directly (inhibition, calming). */
  #lower(name: EmotionName, slot: Slot, amount: number): void {
    slot.v = clamp01(slot.v - amount);
    if (slot.v < this.floor && this.#baseline(name) < this.floor) this.#slots.delete(name);
  }

  /** Calms `name` by `amount` (> 0) at `now`; returns the new intensity. */
  calm(name: EmotionName, amount: number, now: number): number {
    this.advance(now);
    const slot = this.#slots.get(name);
    if (slot && Number.isFinite(amount) && amount > 0) this.#lower(name, slot, amount);
    return this.value(name, now);
  }

  /**
   * Something stirs (`amount` > 0) or calms (`amount` < 0) `name`, for callers with only a
   * number (`SelfState.feel`). It goes through `excite`, so it is habituated, inhibited and
   * budgeted like everything else. Returns the new intensity.
   */
  feel(
    name: EmotionName,
    amount: number,
    cause: string,
    person: PersonId | null,
    now: number,
    key?: string,
  ): number {
    if (!Number.isFinite(amount) || amount === 0) {
      this.advance(now);
      return this.value(name, now);
    }
    if (amount < 0) return this.calm(name, -amount, now);
    return this.excite(
      { name, base: amount, key: key ?? `${name}|${person ?? ""}|${cause}`, cause, person },
      now,
    ).value;
  }

  /**
   * Keeps `name` at least at `v` while a standing need lasts (an unmet drive): the emotion
   * reads at least this, and fades at its own pace only after `hold(name, 0, …)`.
   */
  hold(name: EmotionName, v: number, cause: string, person: PersonId | null, now: number): void {
    this.advance(now);
    const level = clamp01(v);
    if (level < this.floor) this.#held.delete(name);
    else this.#held.set(name, { v: level, cause: cut(cause, MAX_CAUSE), person });
  }

  /**
   * Raises `name` to at least `v` (no temperament: `v` already is the level she feels);
   * never lowers it.
   */
  atLeast(name: EmotionName, v: number, cause: string, person: PersonId | null, now: number): void {
    this.advance(now);
    const level = clamp01(v);
    if (level < this.floor) return;
    const slot = this.#slots.get(name);
    if (slot && slot.v >= level) return;
    if (slot && slot.cause !== "" && slot.person === person) slot.v = level;
    else this.#slots.set(name, { v: level, at: now, cause: cut(cause, MAX_CAUSE), person });
  }

  /** One emotion's intensity at `now` (without changing the engine). */
  value(name: EmotionName, now: number): number {
    return Math.max(this.#own(name, now), this.#held.get(name)?.v ?? 0);
  }

  /** Stir used in the last ten minutes (of the budget). */
  stirUsed(now: number): number {
    return this.#budget.used(now);
  }

  /** Emotions at or above `min` at `now`, strongest first (without changing the engine). */
  readings(now: number, min: number): EmotionReading[] {
    const out: EmotionReading[] = [];
    const threshold = Math.max(min, this.floor);
    for (const name of EMOTION_NAMES) {
      const v = this.value(name, now);
      if (v < threshold) continue;
      const slot = this.#slots.get(name);
      const held = this.#held.get(name);
      const fromHold = held !== undefined && held.v >= this.#own(name, now);
      out.push({
        name,
        intensity: v,
        cause: (fromHold ? held?.cause : slot?.cause) ?? "",
        at: toTimestamp(slot?.at ?? now),
        person: (fromHold ? held?.person : slot?.person) ?? null,
      });
    }
    return out.sort((a, b) => b.intensity - a.intensity || (a.name < b.name ? -1 : 1));
  }

  /** Mood offsets of the emotions at `now` (bounded). */
  affect(now: number): Affect {
    let valence = 0;
    let arousal = 0;
    let energy = 0;
    for (const name of EMOTION_NAMES) {
      const v = this.value(name, now);
      if (v <= 0) continue;
      const [dv, da, de] = AFFECT[name];
      valence += dv * v;
      arousal += da * v;
      energy += de * v;
    }
    return {
      valence: clamp(valence, -MAX_VALENCE, MAX_VALENCE),
      arousal: clamp(arousal, -MAX_AROUSAL, MAX_AROUSAL),
      energy: clamp(energy, -MAX_ENERGY, MAX_ENERGY),
    };
  }

  toJson(): JsonValue {
    const out: Record<string, JsonValue> = {};
    for (const [name, s] of this.#slots) {
      out[name] = { v: s.v, at: toTimestamp(s.at), cause: s.cause, person: s.person };
    }
    return {
      at: toTimestamp(this.#at),
      emotions: out,
      habituation: this.#habit.toJson(this.#at),
      budget: this.#budget.toJson(this.#at),
    };
  }

  /** Restores a `toJson` value (lenient: unknown or malformed emotions are skipped). */
  restore(value: JsonValue | undefined, now: number): void {
    this.#slots.clear();
    this.#held.clear();
    this.#at = now;
    if (value === undefined || !isJsonObject(value) || !isJsonObject(value.emotions)) return;
    const at = typeof value.at === "string" ? Date.parse(value.at) : Number.NaN;
    this.#at = Number.isNaN(at) ? now : Math.min(at, now);
    for (const [name, raw] of Object.entries(value.emotions)) {
      if (!isEmotion(name) || !isJsonObject(raw) || typeof raw.v !== "number") continue;
      const stirred = typeof raw.at === "string" ? Date.parse(raw.at) : Number.NaN;
      this.#slots.set(name, {
        v: clamp01(raw.v),
        at: Number.isNaN(stirred) ? this.#at : stirred,
        cause: typeof raw.cause === "string" ? cut(raw.cause, MAX_CAUSE) : "",
        person: typeof raw.person === "string" ? raw.person : null,
      });
    }
    this.#habit.restore(value.habituation, this.#at);
    this.#budget.restore(value.budget, this.#at);
    this.advance(now);
  }
}
