// The affect service (`AffectStateKey`): her feelings with one writer (docs/design/v2-architecture.md
// §3.1, §3.6).
//
// * Emotions have two inputs only: rule events (`applyEvent`, the table in `events.ts`) and
//   appraisals (`appraise`: the LLM says what happened meant, as an event with a strength; the
//   program turns it into a number). Nobody writes an absolute level.
// * Mood is not stored: `snapshot().mood` is derived from drives + emotions + the hour.
// * One `PersonCard` per person: her feeling, attachment and emotions toward them, plus the
//   social numbers. Reflect (or the panel) moves a bond only in small steps, within a daily cap.
// * The weighted behaviour biases her feelings imply are part of the snapshot.
// * This is where her mood is served from (`MoodSignalsKey`, `mood.changed`): the `mood` module
//   has nothing left to do while this runs (packages/social/src/mood.ts).

import {
  AFFECT_BOND_TOPIC,
  type AffectBondPayload,
  type AffectEvent,
  type AffectInput,
  type AffectSnapshot,
  type AffectSource,
  type AffectState,
  APPRAISAL_STRENGTH,
  type AppliedAppraisal,
  type AppraisalStrength,
  type Attitude,
  affinityLevel,
  type BondChange,
  type DriveName,
  deriveMood,
  type EmotionName,
  type EmotionReading,
  type Handle,
  isEphemeralHandle,
  type JsonValue,
  MOOD_CHANGED_TOPIC,
  type Mood,
  type MoodSignals,
  moodLine,
  type PersonCard,
  type PersonEmotionName,
  type PersonId,
  relationshipLabel,
  renderAffectMood,
  renderPeople,
  safeName,
  toTimestamp,
} from "@miyoria/types";
import { computeBiases } from "./biases.js";
import type { SelfConfig } from "./config.js";
import { INHIBITION_SHARE } from "./dynamics.js";
import { isEmotion, isPersonEmotion } from "./emotions.js";
import {
  type Effect,
  eventEffects,
  NO_CONTEXT,
  type RuleContext,
  socialEffects,
} from "./events.js";
import { cleanStance } from "./feelings.js";
import type { SelfService } from "./state.js";

/** At most this many appraisals count per call (the Appraise call outputs at most 3). */
export const MAX_APPRAISALS = 3;
/** At most this many promises count per call. */
export const MAX_PROMISES = 2;
const MAX_CAUSE = 80;
const DAY_MS = 86_400_000;
const MAX_UNKNOWN_HANDLE = 64;

export interface AffectDeps {
  self: SelfService;
  /** The profile's resting mood (`profile.manifest.mood`). */
  baseline: Mood;
  /** The handle directory's handle of a person, when it has one. */
  handleOf?: (person: PersonId) => Handle | null;
  /** The person behind a handle, when the directory knows it. */
  personOfHandle?: (handle: Handle) => PersonId | null;
  /** Publishes a bus topic (`affect.changed`, `affect.bond`). */
  publish?: (topic: string, payload: JsonValue) => void;
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
    const cards = this.cards();
    const levels: Partial<Record<EmotionName, number>> = {};
    const causes: Partial<Record<EmotionName, Handle>> = {};
    for (const r of felt) {
      levels[r.name] = r.intensity;
      const cause = r.person === null ? undefined : cards.find((c) => c.person === r.person);
      if (cause) causes[r.name] = cause.handle;
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
        cards,
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
    this.d.publish?.("affect.changed", JSON.parse(JSON.stringify(snap)) as JsonValue);
    return true;
  }

  /** `mood.changed`, for whoever follows the mood alone. The first reading is not a change. */
  #publishMood(mood: Mood): void {
    const last = this.#publishedMood;
    if (last !== null && !this.#moodMoved(last, mood)) return;
    this.#publishedMood = mood;
    if (last !== null) this.d.publish?.(MOOD_CHANGED_TOPIC, { ...mood, reason: "affect" });
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

  /** The person a handle names (the directory first, then the cards). */
  #resolve(handle: Handle | null): PersonId | null {
    if (handle === null) return null;
    if (isEphemeralHandle(handle)) return null;
    const viaDirectory = this.d.personOfHandle?.(handle);
    if (viaDirectory) return viaDirectory;
    return this.cardByHandle(handle)?.person ?? null;
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
    if (person !== null && r.applied > 0) this.#toward(person, ev.emotion, r.applied, r, now);
    self.changed("event");
    return {
      emotion: ev.emotion,
      toward: person,
      amount: r.applied,
      habituation: r.habituation,
      inhibited: r.inhibited,
    };
  }

  /** The part of a stir that is about one person (their own emotions toward them). */
  #toward(
    person: PersonId,
    emotion: EmotionName | PersonEmotionName,
    amount: number,
    r: { inhibitedToward: Partial<Record<PersonEmotionName, number>> },
    now: number,
  ): void {
    const hearts = this.#self.engine.hearts;
    if (isPersonEmotion(emotion)) hearts.feel(person, emotion, amount, now);
    for (const [name, down] of Object.entries(r.inhibitedToward) as [PersonEmotionName, number][]) {
      hearts.feel(person, name, -down, now);
    }
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
          if (person !== null && f.toward !== undefined) {
            const towardAmount = (f.towardAmount ?? r.applied) * (r.applied > 0 ? 1 : 0);
            if (towardAmount > 0) this.#toward(person, f.toward, towardAmount, r, now);
          }
          break;
        }
        case "toward": {
          if (person === null) break;
          const factor = f.amount > 0 ? e.emotions.habituate(`${key}|toward|${f.emotion}`, now) : 1;
          const v = e.hearts.feel(person, f.emotion, f.amount * factor, now);
          out.push({ emotion: f.emotion, amount: f.amount * factor });
          // Resentment toward someone is also (a part of) her anger.
          if (f.emotion === "resentment" && f.amount > 0) {
            e.emotions.atLeast("anger", v * 0.8, why || "不爽", person, now);
          }
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

  /** The handle shown for someone: the directory's, else the one stored, else their name. */
  #handleFor(
    person: PersonId,
    stored: string | null,
    att: Attitude | null,
    heartName: string | null,
  ): Handle {
    const viaDirectory = this.d.handleOf?.(person);
    if (viaDirectory && !isEphemeralHandle(viaDirectory)) return viaDirectory;
    if (stored && !isEphemeralHandle(stored)) return stored;
    const name = att?.display_name ?? heartName;
    if (name && name.trim() !== "") {
      const handle = safeName(name).slice(0, MAX_UNKNOWN_HANDLE);
      if (!isEphemeralHandle(handle)) return handle;
    }
    return "(無名)";
  }

  /** Whether anything is known about `person`. */
  #known(person: PersonId): boolean {
    const self = this.#self;
    return (
      self.feelingsBook.record(person) !== null ||
      self.engine.hearts.has(person) ||
      self.attitudeOf(person) !== null
    );
  }

  card(person: PersonId): PersonCard | null {
    const self = this.#self;
    const now = self.now();
    return this.#card(person, now);
  }

  #card(person: PersonId, now: number): PersonCard | null {
    const self = this.#self;
    if (!this.#known(person)) return null;
    const rec = self.feelingsBook.record(person);
    const att = self.attitudeOf(person);
    const heart = self.engine.hearts.heart(person, now);
    const snap = rec?.extras.snapshot ?? null;
    const affinity = att?.affinity ?? snap?.affinity ?? 0;
    const familiarity = att?.familiarity ?? snap?.familiarity ?? 0;
    const feeling = self.feelingsBook.get(person);
    return {
      person,
      handle: this.#handleFor(person, rec?.extras.handle ?? null, att, heart?.name ?? null),
      call_name: att?.call_name ?? rec?.extras.call_name ?? null,
      affinity,
      trust: att?.trust ?? snap?.trust ?? 0,
      familiarity,
      attachment: heart?.romance ?? 0,
      emotions: heart?.emotions ?? {},
      feeling: feeling?.text ?? "",
      public_feeling: rec?.extras.public_feeling ?? null,
      label: relationshipLabel({ affinity, familiarity }),
      level: affinityLevel(affinity),
      stance: rec?.extras.stance ?? null,
      stance_level: rec?.extras.stance_level ?? null,
      owner: att?.owner ?? snap?.owner ?? false,
      blocked: att?.blocked ?? snap?.blocked ?? false,
      last_seen: heart?.last_seen ?? null,
      last_together: heart?.last_together ?? null,
      updated_at: feeling?.updated_at ?? toTimestamp(now),
    };
  }

  cardByHandle(handle: Handle): PersonCard | null {
    return this.cards().find((c) => c.handle === handle) ?? null;
  }

  /** Every card, highest attachment first. */
  cards(): PersonCard[] {
    const self = this.#self;
    const now = self.now();
    const people = new Set<PersonId>([
      ...self.feelingsBook.records().map((r) => r.person),
      ...self.engine.hearts.people(),
    ]);
    const out: PersonCard[] = [];
    for (const person of people) {
      const card = this.#card(person, now);
      if (card) out.push(card);
    }
    return out.sort(
      (a, b) =>
        b.attachment - a.attachment || b.affinity - a.affinity || (a.person < b.person ? -1 : 1),
    );
  }

  async adjustBond(
    person: PersonId,
    change: BondChange,
    by: AffectSource,
  ): Promise<PersonCard | null> {
    const self = this.#self;
    const now = self.now();
    if (!this.#known(person)) return null;
    const cfg = this.#config.bond;
    const day = Math.floor((now + this.#config.utc_offset_minutes * 60_000) / DAY_MS);
    // Attachment moves only when Reflect (or the panel) says so; Appraise may nudge the rest.
    const attachmentAllowed = by === "reflect" || by === "panel";
    const free = by === "panel";
    const step = (v: number | undefined, max: number, spent: number, cap: number) => {
      if (v === undefined || !Number.isFinite(v) || v === 0) return 0;
      const room = free ? Number.POSITIVE_INFINITY : Math.max(cap - spent, 0);
      const size = Math.min(Math.abs(v), free ? Math.abs(v) : max, room);
      return Math.sign(v) * size;
    };
    const done = { attachment: 0, affinity: 0, trust: 0, familiarity: 0 };
    await self.feelingsBook.patch(
      person,
      (x) => {
        if (x.ledger.day !== day) {
          x.ledger = { day, attachment: 0, affinity: 0, trust: 0, familiarity: 0 };
        }
        const l = x.ledger;
        if (attachmentAllowed) {
          done.attachment = step(
            change.attachment,
            cfg.attachment_step,
            l.attachment,
            cfg.attachment_daily,
          );
        }
        done.affinity = step(change.affinity, cfg.affinity_step, l.affinity, cfg.affinity_daily);
        done.trust = step(change.trust, cfg.trust_step, l.trust, cfg.trust_daily);
        done.familiarity = step(
          change.familiarity,
          cfg.familiarity_step,
          l.familiarity,
          cfg.familiarity_daily,
        );
        l.attachment += Math.abs(done.attachment);
        l.affinity += Math.abs(done.affinity);
        l.trust += Math.abs(done.trust);
        l.familiarity += Math.abs(done.familiarity);
        // Only Reflect writes the line; anyone who may change a card may clear it.
        if (change.public_feeling === null) x.public_feeling = null;
        else if (change.public_feeling !== undefined && by === "reflect") {
          x.public_feeling = change.public_feeling;
        }
        // Only Reflect writes her stance, at the level the card has once this change lands.
        if (change.stance !== undefined && by === "reflect") {
          const line = cleanStance(change.stance);
          if (line !== "") {
            x.stance = line;
            const base = self.attitudeOf(person)?.affinity ?? x.snapshot?.affinity ?? 0;
            x.stance_level = affinityLevel(clampTo(base + done.affinity, -100, 100));
          }
        }
        if (x.snapshot) {
          x.snapshot.affinity = clampTo(x.snapshot.affinity + done.affinity, -100, 100);
          x.snapshot.trust = clampTo(x.snapshot.trust + done.trust, 0, 100);
          x.snapshot.familiarity = clampTo(x.snapshot.familiarity + done.familiarity, 0, 100);
        }
      },
      now,
    );
    if (done.attachment !== 0) self.engine.hearts.attach(person, done.attachment, now);
    if (done.affinity !== 0 || done.trust !== 0 || done.familiarity !== 0) {
      const payload: AffectBondPayload = {
        person,
        affinity: done.affinity,
        trust: done.trust,
        familiarity: done.familiarity,
        why: change.why,
      };
      this.d.publish?.(AFFECT_BOND_TOPIC, payload as unknown as JsonValue);
    }
    // Her feeling uses names: sentences with a `u1`-style code are dropped by the book.
    if (change.feeling !== undefined) await self.setFeeling(person, change.feeling, by);
    self.changed("bond");
    return this.card(person);
  }

  /**
   * Keeps the stored numbers of every card as the social module has them now (so a card is
   * whole when the social module is not running). Returns how many cards changed.
   */
  async syncSnapshots(): Promise<number> {
    const self = this.#self;
    const now = self.now();
    let changed = 0;
    for (const rec of self.feelingsBook.records()) {
      const att = self.attitudeOf(rec.person);
      if (!att) continue;
      const next = {
        affinity: att.affinity,
        trust: att.trust,
        familiarity: att.familiarity,
        owner: att.owner ?? false,
        blocked: att.blocked,
        interactions: att.interactions ?? rec.extras.snapshot?.interactions ?? 0,
        last_interaction: att.last_interaction ?? rec.extras.snapshot?.last_interaction ?? null,
      };
      const same = JSON.stringify(rec.extras.snapshot) === JSON.stringify(next);
      if (same && rec.extras.call_name === att.call_name) continue;
      const did = await self.feelingsBook.patch(
        rec.person,
        (x) => {
          x.snapshot = next;
          x.call_name = att.call_name;
        },
        now,
      );
      if (did) changed++;
    }
    return changed;
  }

  // ---- text for prompts ---------------------------------------------------------------

  renderMood(): string {
    return renderAffectMood(this.snapshot());
  }

  renderPeople(people: readonly PersonId[]): string[] {
    const seen = new Set<PersonId>();
    const cards: PersonCard[] = [];
    for (const person of people) {
      if (seen.has(person)) continue;
      seen.add(person);
      const card = this.card(person);
      if (card && !card.blocked) cards.push(card);
    }
    return renderPeople(cards);
  }
}

const clampTo = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
