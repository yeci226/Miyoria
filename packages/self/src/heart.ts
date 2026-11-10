// How she feels about people beyond the social numbers: the attachment she has for each (在意,
// stored as `romance`; a crush grows from it),
// her active emotions toward them (想念, 嫉妒, 感激, 不爽) and her crush (暗戀). Pure; `now`
// (epoch ms) is passed in.
//
// * Attachment ("romance") no longer grows by itself from events: only the affect service moves
//   it, on Reflect's proposals, in small steps within a daily cap (`attach`). It fades slowly
//   (`half_life_days`) and drops without limit when they hurt her. (`romance()` keeps the old
//   per-day growth for callers that still want it.)
// * Her crush is whoever has the highest romance at or above `crush_threshold`; someone else
//   needs `crush_margin` more to take the place. It can be nobody.
// * Emotions toward someone fade with their own half-lives (her temperament).

import {
  type Crush,
  type Heart,
  isJsonObject,
  type JsonValue,
  PERSON_EMOTION_NAMES,
  type PersonEmotionName,
  type PersonId,
  toTimestamp,
} from "@miyoria/types";
import type { HeartConfig } from "./config.js";
import { fade, isPersonEmotion, stir, type Temperament } from "./emotions.js";

const DAY_MS = 86_400_000;
const FLOOR = 0.01;
const MAX_NAME = 64;

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0);

interface Rec {
  name: string | null;
  romance: number;
  emotions: Map<PersonEmotionName, number>;
  lastSeen: number | null;
  lastTogether: number | null;
  /** Local day of `gained` (romance gained today, for the daily limit). */
  day: number;
  gained: number;
}

function newRec(): Rec {
  return {
    name: null,
    romance: 0,
    emotions: new Map(),
    lastSeen: null,
    lastTogether: null,
    day: 0,
    gained: 0,
  };
}

const ts = (ms: number | null) => (ms === null ? null : toTimestamp(ms));

function parseMs(v: JsonValue | undefined): number | null {
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

export class HeartBook {
  #people = new Map<PersonId, Rec>();
  #crush: { person: PersonId; since: number } | null = null;
  #at: number;

  constructor(
    private readonly config: HeartConfig,
    private readonly temper: Temperament,
    private readonly utcOffsetMinutes: number,
    /** Away this long, 想念 toward someone holds instead of fading. */
    private readonly awayMs: number,
    now: number,
  ) {
    this.#at = now;
  }

  #day(now: number): number {
    return Math.floor((now + this.utcOffsetMinutes * 60_000) / DAY_MS);
  }

  #rec(person: PersonId): Rec {
    let r = this.#people.get(person);
    if (!r) {
      r = newRec();
      this.#people.set(person, r);
    }
    return r;
  }

  /** Fades romance and emotions up to `now`, forgets what is gone, updates the crush. */
  advance(now: number): void {
    const dt = now - this.#at;
    if (dt > 0) {
      for (const [person, r] of this.#people) {
        r.romance = fade(r.romance, dt, this.config.half_life_days * 24 * 60);
        if (r.romance < FLOOR) r.romance = 0;
        const away = r.lastSeen !== null && now - r.lastSeen >= this.awayMs;
        for (const [name, v] of r.emotions) {
          // Missing someone does not fade while they are still away.
          if (name === "missing" && away) continue;
          const left = fade(v, dt, this.temper.toward[name].halfLifeMins);
          if (left < FLOOR) r.emotions.delete(name);
          else r.emotions.set(name, left);
        }
        // Someone seen once and felt nothing about is kept only for a while (their absence
        // matters only if she cares, which needs romance or affinity anyway).
        if (r.romance === 0 && r.emotions.size === 0 && r.lastSeen !== null) {
          if (now - r.lastSeen > 30 * DAY_MS) this.#people.delete(person);
        }
      }
      this.#at = now;
    }
    this.#pickCrush(now);
  }

  #pickCrush(now: number): void {
    const c = this.config;
    let best: [PersonId, number] | null = null;
    for (const [p, r] of this.#people) {
      if (r.romance >= c.crush_threshold && (best === null || r.romance > best[1])) {
        best = [p, r.romance];
      }
    }
    const current = this.#crush;
    const held = current ? (this.#people.get(current.person)?.romance ?? 0) : 0;
    if (current && held >= c.crush_threshold) {
      // Hysteresis: the current one stays unless someone clearly passed them.
      if (best && best[0] !== current.person && best[1] >= held + c.crush_margin) {
        this.#crush = { person: best[0], since: now };
      }
      return;
    }
    this.#crush = best ? { person: best[0], since: now } : null;
  }

  /** They said or did something (`together`: with her, or to her). */
  seen(person: PersonId, name: string | null, together: boolean, now: number): void {
    this.advance(now);
    const r = this.#rec(person);
    if (name !== null && name.trim() !== "") r.name = [...name.trim()].slice(0, MAX_NAME).join("");
    r.lastSeen = now;
    if (together) r.lastTogether = now;
  }

  /**
   * Adds romance: positive changes are limited to `daily_gain` per local day, negative ones are
   * not. Returns the change actually made.
   */
  romance(person: PersonId, amount: number, now: number): number {
    if (!Number.isFinite(amount) || amount === 0) return 0;
    this.advance(now);
    const r = this.#rec(person);
    const before = r.romance;
    if (amount > 0) {
      const day = this.#day(now);
      if (r.day !== day) {
        r.day = day;
        r.gained = 0;
      }
      const room = Math.max(this.config.daily_gain - r.gained, 0);
      const add = Math.min(amount, room);
      r.romance = clamp01(r.romance + add * (1 - r.romance * 0.5));
      r.gained += r.romance - before;
    } else {
      r.romance = clamp01(r.romance + amount);
    }
    this.#pickCrush(now);
    return r.romance - before;
  }

  /**
   * Moves attachment by `delta` directly (no per-day growth: the bond ledger of the service
   * caps what Reflect may change). Returns the change made.
   */
  attach(person: PersonId, delta: number, now: number): number {
    if (!Number.isFinite(delta) || delta === 0) return 0;
    this.advance(now);
    const r = this.#rec(person);
    const before = r.romance;
    r.romance = clamp01(r.romance + delta);
    this.#pickCrush(now);
    return r.romance - before;
  }

  /** Gives someone no record yet an attachment (the migration). Returns whether it did. */
  seed(person: PersonId, attachment: number, name: string | null, now: number): boolean {
    if (this.#people.has(person)) return false;
    const r = this.#rec(person);
    r.romance = clamp01(attachment);
    if (name !== null && name.trim() !== "") r.name = [...name.trim()].slice(0, MAX_NAME).join("");
    this.#pickCrush(now);
    return true;
  }

  has(person: PersonId): boolean {
    return this.#people.has(person);
  }

  /** Stirs or calms an emotion toward `person`; returns the new intensity. */
  feel(person: PersonId, emotion: PersonEmotionName, amount: number, now: number): number {
    this.advance(now);
    const r = this.#rec(person);
    const v = stir(r.emotions.get(emotion) ?? 0, amount, this.temper.toward[emotion].gain);
    if (v < FLOOR) r.emotions.delete(emotion);
    else r.emotions.set(emotion, v);
    return v;
  }

  /**
   * Moves an emotion toward `person` up toward `target` (never down), `rate` being the share of
   * the gap per unit before her temperament: a feeling that builds while a situation lasts.
   */
  long(
    person: PersonId,
    emotion: PersonEmotionName,
    target: number,
    rate: number,
    now: number,
  ): number {
    this.advance(now);
    const r = this.#rec(person);
    const v = r.emotions.get(emotion) ?? 0;
    const goal = clamp01(target);
    if (goal <= v) return v;
    const next =
      v + (goal - v) * (1 - Math.exp(-Math.max(rate, 0) * this.temper.toward[emotion].gain));
    r.emotions.set(emotion, next);
    return next;
  }

  emotion(person: PersonId, emotion: PersonEmotionName, now: number): number {
    const r = this.#people.get(person);
    const v = r?.emotions.get(emotion);
    if (v === undefined) return 0;
    const away =
      r?.lastSeen !== null && r?.lastSeen !== undefined && now - r.lastSeen >= this.awayMs;
    if (emotion === "missing" && away) return v;
    return fade(v, now - this.#at, this.temper.toward[emotion].halfLifeMins);
  }

  /** Raw romance (0 for strangers). */
  romanceOf(person: PersonId): number {
    return this.#people.get(person)?.romance ?? 0;
  }

  lastSeen(person: PersonId): number | null {
    return this.#people.get(person)?.lastSeen ?? null;
  }

  lastTogether(person: PersonId): number | null {
    return this.#people.get(person)?.lastTogether ?? null;
  }

  people(): PersonId[] {
    return [...this.#people.keys()];
  }

  crush(now: number): Crush | null {
    this.advance(now);
    const c = this.#crush;
    if (!c) return null;
    const r = this.#people.get(c.person);
    return {
      person: c.person,
      name: r?.name ?? null,
      romance: r?.romance ?? 0,
      since: toTimestamp(c.since),
    };
  }

  heart(person: PersonId, now: number): Heart | null {
    const r = this.#people.get(person);
    if (!r) return null;
    const emotions: Heart["emotions"] = {};
    for (const name of PERSON_EMOTION_NAMES) {
      const v = this.emotion(person, name, now);
      if (v >= FLOOR) emotions[name] = v;
    }
    return {
      person,
      name: r.name,
      romance: r.romance,
      emotions,
      last_seen: ts(r.lastSeen),
      last_together: ts(r.lastTogether),
    };
  }

  /** People with romance or active emotions, highest romance first. */
  hearts(now: number): Heart[] {
    const out: Heart[] = [];
    for (const person of this.#people.keys()) {
      const h = this.heart(person, now);
      if (h && (h.romance >= FLOOR || Object.keys(h.emotions).length > 0)) out.push(h);
    }
    return out.sort((a, b) => b.romance - a.romance || (a.person < b.person ? -1 : 1));
  }

  /** Keeps the `max_people` people she feels most about. */
  #prune(): void {
    const max = Math.max(this.config.max_people, 1);
    if (this.#people.size <= max) return;
    const weight = (p: PersonId, r: Rec) =>
      (this.#crush?.person === p ? 10 : 0) +
      r.romance +
      [...r.emotions.values()].reduce((a, b) => a + b, 0) +
      (r.lastSeen ?? 0) / 1e15;
    const keep = [...this.#people.entries()]
      .sort((a, b) => weight(b[0], b[1]) - weight(a[0], a[1]))
      .slice(0, max);
    this.#people = new Map(keep);
  }

  toJson(): JsonValue {
    this.#prune();
    const people: Record<string, JsonValue> = {};
    for (const [p, r] of this.#people) {
      people[p] = {
        name: r.name,
        romance: r.romance,
        emotions: Object.fromEntries(r.emotions),
        last_seen: ts(r.lastSeen),
        last_together: ts(r.lastTogether),
        day: r.day,
        gained: r.gained,
      };
    }
    const crush = this.#crush
      ? { person: this.#crush.person, since: toTimestamp(this.#crush.since) }
      : null;
    return { at: toTimestamp(this.#at), people, crush };
  }

  restore(value: JsonValue | undefined, now: number): void {
    this.#people.clear();
    this.#crush = null;
    this.#at = now;
    if (value === undefined || !isJsonObject(value)) return;
    const at = parseMs(value.at);
    this.#at = at === null ? now : Math.min(at, now);
    if (isJsonObject(value.people)) {
      for (const [p, raw] of Object.entries(value.people)) {
        if (!isJsonObject(raw)) continue;
        const r = newRec();
        r.name = typeof raw.name === "string" ? raw.name : null;
        r.romance = typeof raw.romance === "number" ? clamp01(raw.romance) : 0;
        if (isJsonObject(raw.emotions)) {
          for (const [name, v] of Object.entries(raw.emotions)) {
            if (isPersonEmotion(name) && typeof v === "number") r.emotions.set(name, clamp01(v));
          }
        }
        r.lastSeen = parseMs(raw.last_seen);
        r.lastTogether = parseMs(raw.last_together);
        r.day = typeof raw.day === "number" ? raw.day : 0;
        r.gained = typeof raw.gained === "number" ? raw.gained : 0;
        this.#people.set(p, r);
      }
    }
    const crush = value.crush;
    if (isJsonObject(crush) && typeof crush.person === "string") {
      this.#crush = { person: crush.person, since: parseMs(crush.since) ?? now };
    }
    this.advance(now);
  }
}
