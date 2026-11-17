// The affect service (`AffectStateKey`): her feelings with one writer (docs/design/v2-architecture.md
// §3.1, §3.6).
//
// * Emotions have two inputs only: rule events (`applyEvent`, the table in `events.ts`) and
//   appraisals (`appraise`: the LLM says what happened meant, as an event with a strength; the
//   program turns it into a number). Nobody writes an absolute level.
// * Mood is not stored: `snapshot().mood` is derived from drives + emotions + the hour.
// * How she feels about each person is the heart's (`heart_person`, docs/design/v5-heart.md §2.10):
//   the people she cares about and how much she misses them are read from it for the biases.
// * The weighted behaviour biases her feelings imply are part of the snapshot.
// * This is where her mood is served from (`MoodSignalsKey`, `mood.changed`).

import {
  type AffectEvent,
  type AffectInput,
  type AffectSnapshot,
  type AffectState,
  APPRAISAL_STRENGTH,
  type AppliedAppraisal,
  type AppraisalStrength,
  type DriveName,
  deriveMood,
  type EmotionName,
  type EmotionReading,
  Events,
  type Handle,
  type HeartPeople,
  isEphemeralHandle,
  type Mood,
  type MoodSignals,
  moodLine,
  type PersonEmotionName,
  type PersonId,
  type Publish,
  renderAffectMood,
  safeName,
  toTimestamp,
} from "@miyoria/types";
import { computeBiases } from "./biases.js";
import type { SelfConfig } from "./config.js";
import { INHIBITION_SHARE } from "./dynamics.js";
import { isEmotion } from "./emotions.js";
import {
  type Effect,
  eventEffects,
  NO_CONTEXT,
  type RuleContext,
  socialEffects,
} from "./events.js";
import type { SelfService } from "./state.js";

/** At most this many appraisals count per call (the Appraise call outputs at most 3). */
export const MAX_APPRAISALS = 3;
/** At most this many promises count per call. */
export const MAX_PROMISES = 2;
const MAX_CAUSE = 80;
const MAX_UNKNOWN_HANDLE = 64;
/** The people she cares about the biases look at. */
const CARED_FOR_BIASES = 5;

export interface AffectDeps {
  self: SelfService;
  /** The profile's resting mood (`profile.manifest.mood`). */
  baseline: Mood;
  /** The handle directory's handle of a person, when it has one. */
  handleOf?: (person: PersonId) => Handle | null;
  /** The person behind a handle, when the directory knows it. */
  personOfHandle?: (handle: Handle) => PersonId | null;
  /** Publishes on the bus (`affect.changed`, `mood.changed`). */
  publish?: Publish;
  /** The heart (`HeartKey`): whom she cares about and misses, for the biases. */
  heart?: () => HeartPeople | null;
  /** Someone's name as people see it, for a handle the directory has none of. */
  nameOf?: (person: PersonId) => string | null;
}

/** What one rule event did (for tests and the journal). */
export interface AppliedEffect {
  emotion: EmotionName | PersonEmotionName | "companionship" | DriveName;
  /** The stir applied (negative: calmed / eased). */
  amount: number;
}

function cleanCause(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  // A per-call code in a cause would be saved with the emotion: say "someone" instead.
  const named = flat.replace(/(?<![A-Za-z0-9_])[upg][0-9]{1,4}(?![A-Za-z0-9_])/g, "某人");
  const chars = [...named];
  return chars.length > MAX_CAUSE ? `${chars.slice(0, MAX_CAUSE).join("")}…` : named;
}

const normalize = (text: string) => text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");

export class AffectService implements AffectState, MoodSignals {
  #published: AffectSnapshot | null = null;
  #publishedMood: Mood | null = null;

  constructor(private readonly d: AffectDeps) {}

  get #self(): SelfService {
    return this.d.self;
  }

  get #config(): SelfConfig {
    return this.#self.config;
  }

  // ---- snapshot -----------------------------------------------------------------------

  snapshot(): AffectSnapshot {
    const self = this.#self;
    const now = self.now();
    const e = self.engine;
    const cfg = this.#config;
    const felt = e.emotions.readings(now, cfg.emotions.floor);
    const top = felt
      .filter((r) => r.intensity >= cfg.emotions.notice)
      .slice(0, Math.max(cfg.emotions.prompt_max, 1));
    const mood = this.#mood(now);
    const heart = this.d.heart?.() ?? null;
    const people = (heart?.caredAbout(CARED_FOR_BIASES) ?? []).map((c) => ({
      handle: this.#handleFor(c.person),
      longing: heart?.view(c.person)?.longing ?? 0,
    }));
    const levels: Partial<Record<EmotionName, number>> = {};
    const causes: Partial<Record<EmotionName, Handle>> = {};
    for (const r of felt) {
      levels[r.name] = r.intensity;
      if (r.person !== null && (heart?.cares(r.person) ?? 0) > 0) {
        causes[r.name] = this.#handleFor(r.person);
      }
    }
    const drives = e.drives();
    return {
      at: toTimestamp(now),
      drives,
      boredom: e.boredom(),
      top,
      mood,
      mood_line: moodLine(mood),
      shown: self.shown(),
      biases: computeBiases({
        emotions: levels,
        causes,
        drives,
        boredom: e.boredom(),
        valence: mood.valence,
        people,
      }),
    };
  }

  /** The derived mood now, without advancing anything (safe to call from `SelfService`). */
  mood(): Mood {
    return this.#mood(this.#self.clock.now());
  }

  /** The mood from drives, emotions and the hour (never advances: no loop with `now()`). */
  #mood(now: number): Mood {
    const e = this.#self.engine;
    const cfg = this.#config;
    return deriveMood({
      baseline: this.d.baseline,
      emotions: e.emotions.affect(now),
      drives: e.drives(),
      boredom: e.boredom(),
      nowMs: now,
      utcOffsetMinutes: cfg.utc_offset_minutes,
      nightDip: cfg.mood.night_dip,
      emotionWeight: cfg.mood.emotion_weight,
    });
  }

  emotions(min?: number): EmotionReading[] {
    return this.#self.emotions(min);
  }

  /**
   * Publishes `affect.changed` when the mood, her strongest emotions or the biases moved
   * noticeably since the last time. Returns whether it published.
   */
  publishIfChanged(): boolean {
    const snap = this.snapshot();
    this.#publishMood(snap.mood);
    const last = this.#published;
    if (last && !this.#moved(last, snap)) return false;
    this.#published = snap;
    this.d.publish?.(Events.AffectChanged, JSON.parse(JSON.stringify(snap)) as AffectSnapshot);
    return true;
  }

  /** `mood.changed`, for whoever follows the mood alone. The first reading is not a change. */
  #publishMood(mood: Mood): void {
    const last = this.#publishedMood;
    if (last !== null && !this.#moodMoved(last, mood)) return;
    this.#publishedMood = mood;
    if (last !== null) this.d.publish?.(Events.MoodChanged, { ...mood, reason: "affect" });
  }

  #moodMoved(a: Mood, b: Mood): boolean {
    const t = this.#config.mood.publish_threshold;
    return (
      Math.abs(a.valence - b.valence) >= t ||
      Math.abs(a.arousal - b.arousal) >= t ||
      Math.abs(a.energy - b.energy) >= t
    );
  }

  #moved(a: AffectSnapshot, b: AffectSnapshot): boolean {
    const t = this.#config.mood.publish_threshold;
    if (this.#moodMoved(a.mood, b.mood)) return true;
    const names = (s: AffectSnapshot) => s.top.map((r) => r.name).join(",");
    if (names(a) !== names(b)) return true;
    if (a.top.some((r, i) => Math.abs(r.intensity - (b.top[i]?.intensity ?? 0)) >= 2 * t)) {
      return true;
    }
    return (
      Math.abs(a.biases.talkativeness - b.biases.talkativeness) >= 2 * t ||
      Math.abs(a.biases.initiative - b.biases.initiative) >= 2 * t
    );
  }

  // ---- emotions in -------------------------------------------------------------------

  /** The person a handle names (the directory's). */
  #resolve(handle: Handle | null): PersonId | null {
    if (handle === null) return null;
    if (isEphemeralHandle(handle)) return null;
    return this.d.personOfHandle?.(handle) ?? null;
  }

  appraise(input: AffectInput): AppliedAppraisal[] {
    const out: AppliedAppraisal[] = [];
    for (const ev of input.events.slice(0, MAX_APPRAISALS)) {
      const applied = this.appraiseFor(this.#resolve(ev.toward), ev);
      if (applied) out.push(applied);
    }
    for (const promise of (input.promises ?? []).slice(0, MAX_PROMISES)) {
      const person = this.#resolve(promise.toward);
      if (person === null) continue;
      this.applySocial(promise.kept ? "promise_kept" : "promise_broken", person, 1, promise.cause);
    }
    return out;
  }

  /**
   * One appraisal about `person` (already resolved). Strength becomes a number here
   * (`APPRAISAL_STRENGTH`, her temperament's gain, habituation, the budget); returns `null`
   * for an emotion or strength that does not exist.
   */
  appraiseFor(
    person: PersonId | null,
    ev: { emotion: EmotionName; strength: AppraisalStrength; cause: string },
  ): AppliedAppraisal | null {
    if (!isEmotion(ev.emotion) || !Object.hasOwn(APPRAISAL_STRENGTH, ev.strength)) return null;
    const self = this.#self;
    const now = self.now();
    const cause = cleanCause(ev.cause);
    const key = `appraise|${ev.emotion}|${person ?? ""}|${normalize(cause)}`;
    const r = self.engine.emotions.excite(
      {
        name: ev.emotion,
        base: APPRAISAL_STRENGTH[ev.strength],
        key,
        cause: cause === "" ? ev.emotion : cause,
        person,
      },
      now,
    );
    self.changed("event");
    return {
      emotion: ev.emotion,
      toward: person,
      amount: r.applied,
      habituation: r.habituation,
      inhibited: r.inhibited,
    };
  }

  /**
   * A rule event (the table in `events.ts`): what it means to her, as stirs and calms that go
   * through the same dynamics as appraisals. `hint.missed`: how much she had missed them
   * (for `cared_arrived`, before it eased).
   */
  applyEvent(ev: AffectEvent, hint: { missed?: number } = {}): AppliedEffect[] {
    const self = this.#self;
    const now = self.now();
    const person = ev.person ?? this.#resolve(ev.handle);
    const ctx: RuleContext = {
      ...NO_CONTEXT,
      care: person === null ? 0 : self.care(person),
      crush: person !== null && self.crushPerson() === person,
      tsundere: self.engine.emotions.temperament.display === "tsundere",
      missed: hint.missed ?? 0,
    };
    const applied = this.#run(
      eventEffects(ev.kind, ctx),
      `${ev.kind}|${ev.key}`,
      ev.detail,
      person,
      now,
    );
    if (applied.length > 0) self.changed("event");
    return applied;
  }

  /**
   * What someone did toward her (`social.event`: thanks, gifts, insults ...). Praise is the
   * `praised` rule event. Returns `null` for kinds with no rule.
   */
  applySocial(
    kind: string,
    person: PersonId | null,
    scale: number,
    cause: string,
    extra: Pick<RuleContext, "hunger"> = {},
  ): AppliedEffect[] | null {
    const self = this.#self;
    const now = self.now();
    const ctx: RuleContext = {
      ...NO_CONTEXT,
      care: person === null ? 0 : self.care(person),
      crush: person !== null && self.crushPerson() === person,
      tsundere: self.engine.emotions.temperament.display === "tsundere",
      scale,
      ...extra,
    };
    const effects = socialEffects(kind, ctx);
    if (effects === null) return null;
    const applied = this.#run(effects, `social|${kind}|${person ?? ""}`, cause, person, now);
    if (applied.length > 0) self.changed("event");
    return applied;
  }

  /** Runs effects; `key` makes repeats of one cause habituate. */
  #run(
    effects: readonly Effect[],
    key: string,
    cause: string,
    person: PersonId | null,
    now: number,
  ): AppliedEffect[] {
    const self = this.#self;
    const e = self.engine;
    const why = cleanCause(cause);
    const out: AppliedEffect[] = [];
    for (const f of effects) {
      switch (f.type) {
        case "emotion": {
          if (f.amount < 0) {
            e.emotions.calm(f.emotion, -f.amount, now);
            out.push({ emotion: f.emotion, amount: f.amount });
            break;
          }
          const r = e.emotions.excite(
            {
              name: f.emotion,
              base: f.amount,
              key: `${key}|${f.emotion}`,
              cause: why || f.emotion,
              person,
            },
            now,
          );
          if (r.applied > 0) out.push({ emotion: f.emotion, amount: r.applied });
          break;
        }
        case "toward": {
          // How she feels about the person is the heart's (her `feel`, her nightly reflection):
          // only resentment shows in her own emotions now, as (a part of) her anger.
          if (person === null || f.emotion !== "resentment" || f.amount <= 0) break;
          const factor = e.emotions.habituate(`${key}|toward|${f.emotion}`, now);
          e.emotions.atLeast("anger", f.amount * factor * 0.8, why || "不爽", person, now);
          out.push({ emotion: f.emotion, amount: f.amount * factor });
          break;
        }
        case "companionship": {
          // Being with someone eases loneliness by half of it, and some of the wish for company.
          e.emotions.calm("lonely", f.amount * INHIBITION_SHARE, now);
          e.adjust({ social: -f.amount });
          out.push({ emotion: "companionship", amount: f.amount });
          break;
        }
        case "drive": {
          e.adjust({ [f.drive]: f.amount });
          out.push({ emotion: f.drive, amount: f.amount });
          break;
        }
      }
    }
    return out;
  }

  satisfy(drive: DriveName, amount: number, reason: string): void {
    this.#self.adjust({ [drive]: amount }, reason === "" ? "satisfy" : reason);
  }

  // ---- people -------------------------------------------------------------------------

  /** The handle shown for someone: the directory's, else their name. */
  #handleFor(person: PersonId): Handle {
    const viaDirectory = this.d.handleOf?.(person);
    if (viaDirectory && !isEphemeralHandle(viaDirectory)) return viaDirectory;
    const name = this.d.nameOf?.(person) ?? null;
    if (name && name.trim() !== "") {
      const handle = safeName(name).slice(0, MAX_UNKNOWN_HANDLE);
      if (!isEphemeralHandle(handle)) return handle;
    }
    return "(無名)";
  }

  // ---- text for prompts ---------------------------------------------------------------

  renderMood(): string {
    return renderAffectMood(this.snapshot());
  }
}
