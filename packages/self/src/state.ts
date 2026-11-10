// The `SelfStateKey` service: the engine advanced to "now" on every call, plus her mood and the
// feelings records. Every change calls `changed` so the module saves it.

import type {
  Affect,
  AgendaInput,
  AgendaItem,
  Attitude,
  Clock,
  ContextKey,
  Crush,
  Drives,
  EffectiveTalkativeness,
  EmotionName,
  EmotionReading,
  EmotionSample,
  Feeling,
  Heart,
  Mood,
  PersonEmotionName,
  PersonId,
  SelfSnapshot,
  SelfState,
  ShownEmotion,
  Talkativeness,
  TalkativenessInput,
} from "@miyoria/types";
import { EMOTION_LABELS, PERSON_EMOTION_LABELS, toTimestamp } from "@miyoria/types";
import type { SelfConfig } from "./config.js";
import { type Audience, shownEmotion } from "./display.js";
import type { Circumstances, SelfEngine } from "./engine.js";
import type { FeelingsBook } from "./feelings.js";

export interface SelfServiceDeps {
  engine: SelfEngine;
  feelings: FeelingsBook;
  clock: Clock;
  config: SelfConfig;
  /** What she is doing right now (playing, live, energy, her crush with her). */
  circumstances: () => Circumstances;
  mood: () => Mood | null;
  /** The social numbers of someone, when the social module runs. */
  attitudeOf?: (person: PersonId) => Attitude | null;
  /** Who she is with right now (for what she shows); `undefined` = nobody in particular. */
  audience?: () => Audience | undefined;
  /** Called after every change of the persisted state. */
  changed: (reason: string) => void;
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0);

export class SelfService implements SelfState {
  readonly #history: EmotionSample[] = [];
  #sampledAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly d: SelfServiceDeps) {}

  /** The engine (the affect service of the same module works on it). */
  get engine(): SelfEngine {
    return this.d.engine;
  }

  get feelingsBook(): FeelingsBook {
    return this.d.feelings;
  }

  get config(): SelfConfig {
    return this.d.config;
  }

  get clock(): Clock {
    return this.d.clock;
  }

  /** The social numbers of someone, when the social module runs. */
  attitudeOf(person: PersonId): Attitude | null {
    return this.d.attitudeOf?.(person) ?? null;
  }

  /** Records that something changed (the module saves it). */
  changed(reason: string): void {
    this.d.changed(reason);
  }

  /** Advances the engine to now and returns now. */
  now(): number {
    const now = this.d.clock.now();
    const e = this.d.engine;
    e.advance(now, { ...this.d.circumstances(), care: (p) => this.care(p) });
    // An agenda item for someone ran out before she did it: a promise she did not keep.
    for (const item of e.takeExpired()) {
      if (item.person === null) continue;
      const name = e.hearts.heart(item.person, now)?.name ?? "別人";
      e.emotions.feel("guilt", 0.35, `答應${name}的事沒做到`, item.person, now);
      this.d.changed("event");
    }
    return now;
  }

  snapshot(): SelfSnapshot {
    const now = this.now();
    const e = this.d.engine;
    const emotions = e.emotions.readings(now, this.d.config.emotions.floor);
    return {
      at: toTimestamp(now),
      mood: this.d.mood(),
      boredom: e.boredom(),
      drives: e.drives(),
      policy: e.policy(now),
      agenda: e.allAgenda(now),
      emotions,
      shown: this.#shown(emotions),
      hearts: e.hearts.hearts(now),
      crush: e.hearts.crush(now),
    };
  }

  // ---- emotions -----------------------------------------------------------------------

  emotions(min?: number): EmotionReading[] {
    const now = this.now();
    return this.d.engine.emotions.readings(now, min ?? this.d.config.emotions.notice);
  }

  feel(emotion: EmotionName, amount: number, cause: string, person: PersonId | null = null): void {
    if (!Number.isFinite(amount) || amount === 0) return;
    const now = this.now();
    this.d.engine.emotions.feel(emotion, amount, cause || EMOTION_LABELS[emotion], person, now);
    this.d.changed("event");
  }

  feelToward(person: PersonId, emotion: PersonEmotionName, amount: number, cause: string): void {
    if (!Number.isFinite(amount) || amount === 0) return;
    const now = this.now();
    const e = this.d.engine;
    // The same cause again within two hours counts less (toward someone as for her own).
    const factor =
      amount > 0 ? e.emotions.habituate(`toward|${person}|${emotion}|${cause}`, now) : 1;
    const v = e.hearts.feel(person, emotion, amount * factor, now);
    // The matching feeling of her own (不爽 toward someone is anger).
    const own: EmotionName = emotion === "resentment" ? "anger" : emotion;
    const why = cause || PERSON_EMOTION_LABELS[emotion];
    if (amount > 0) e.emotions.atLeast(own, own === "anger" ? v * 0.8 : v, why, person, now);
    this.d.changed("event");
  }

  shown(): ShownEmotion | null {
    return this.#shown(this.emotions());
  }

  #shown(felt: readonly EmotionReading[]): ShownEmotion | null {
    const e = this.d.engine.emotions;
    return shownEmotion(
      felt,
      e.temperament.display,
      this.d.config.emotions.notice,
      this.d.audience?.(),
    );
  }

  /** Never advances through `circumstances` (which reads the mood, which reads this). */
  affect(): Affect {
    return this.d.engine.emotions.affect(this.d.clock.now());
  }

  heart(person: PersonId): Heart | null {
    return this.d.engine.hearts.heart(person, this.now());
  }

  hearts(): Heart[] {
    return this.d.engine.hearts.hearts(this.now());
  }

  crush(): Crush | null {
    return this.d.engine.hearts.crush(this.now());
  }

  history(): EmotionSample[] {
    return this.#history.map((s) => ({
      ...s,
      emotions: { ...s.emotions },
      drives: { ...s.drives },
    }));
  }

  /** Adds a history sample when one is due (the module's tick). */
  sample(): void {
    const now = this.now();
    const cfg = this.d.config.emotions;
    if (now - this.#sampledAt < cfg.history_every_mins * 60_000) return;
    this.#sampledAt = now;
    const emotions: EmotionSample["emotions"] = {};
    for (const r of this.d.engine.emotions.readings(now, cfg.floor)) {
      emotions[r.name] = Math.round(r.intensity * 1000) / 1000;
    }
    this.#history.push({
      at: toTimestamp(now),
      emotions,
      drives: this.d.engine.drives(),
      mood: this.d.mood(),
    });
    const keep = Math.max(cfg.history_keep, 1);
    if (this.#history.length > keep) this.#history.splice(0, this.#history.length - keep);
  }

  // ---- people (for the rules; not part of `SelfState`) -------------------------------

  /** How much she cares about someone, 0..1: from affinity and romance. */
  care(person: PersonId): number {
    const a = this.d.attitudeOf?.(person) ?? null;
    if (a?.blocked) return 0;
    const min = this.d.config.emotions.care_affinity;
    let care = 0;
    if (a !== null && a.affinity >= min)
      care = 0.4 + (0.6 * (a.affinity - min)) / Math.max(100 - min, 1);
    const romance = this.d.engine.hearts.romanceOf(person);
    if (romance >= 0.15) care = Math.max(care, romance + 0.2);
    return clamp01(care);
  }

  /**
   * They said or did something. Returns how much she had been missing them (想念 toward them,
   * before it eased).
   */
  seen(person: PersonId, name: string | null, together: boolean): number {
    const now = this.now();
    const h = this.d.engine.hearts;
    const missed = h.emotion(person, "missing", now);
    h.seen(person, name, together, now);
    // They are back: missing them eases (what is left fades at its own pace).
    if (missed > 0) h.feel(person, "missing", -missed * 0.7, now);
    this.d.changed("event");
    return missed;
  }

  /** Changes her romance for someone (see `HeartBook.romance`); returns the change made. */
  romance(person: PersonId, amount: number): number {
    const now = this.now();
    const change = this.d.engine.hearts.romance(person, amount, now);
    if (change !== 0) this.d.changed("event");
    return change;
  }

  /** Her crush's person id, without advancing (cheap, for event routing). */
  crushPerson(): PersonId | null {
    return this.d.engine.hearts.crush(this.d.clock.now())?.person ?? null;
  }

  drives(): Drives {
    this.now();
    return this.d.engine.drives();
  }

  boredom(): number {
    this.now();
    return this.d.engine.boredom();
  }

  adjust(delta: Partial<Drives> & { boredom?: number }, reason: string): void {
    this.now();
    this.d.engine.adjust(delta);
    this.d.changed(reason);
  }

  talkativeness(context: ContextKey | null): EffectiveTalkativeness | null {
    return this.d.engine.talkativeness(context, this.now());
  }

  setTalkativeness(scope: string, input: TalkativenessInput): Talkativeness {
    const t = this.d.engine.setTalkativeness(scope, input, this.now());
    this.d.changed("talkativeness");
    return t;
  }

  clearTalkativeness(scope: string): boolean {
    this.now();
    const removed = this.d.engine.clearTalkativeness(scope);
    if (removed) this.d.changed("talkativeness");
    return removed;
  }

  initiative(): number {
    this.now();
    return this.d.engine.initiative();
  }

  setInitiative(level: number, why: string): void {
    this.now();
    this.d.engine.setInitiative(level, why);
    this.d.changed("initiative");
  }

  agenda(): AgendaItem[] {
    return this.d.engine.agenda(this.now());
  }

  addAgenda(input: AgendaInput): AgendaItem {
    const item = this.d.engine.addAgenda(input, this.now());
    this.d.changed("agenda");
    return item;
  }

  completeAgenda(id: string): AgendaItem | null {
    const now = this.now();
    const item = this.d.engine.completeAgenda(id, now);
    if (item) {
      // Doing what she meant to do for someone: a little proud of herself.
      if (item.person !== null) {
        this.d.engine.emotions.feel("pride", 0.15, "說到做到", item.person, now);
      }
      this.d.changed("agenda");
    }
    return item;
  }

  dropAgenda(id: string): AgendaItem | null {
    const item = this.d.engine.dropAgenda(id, this.now());
    if (item) this.d.changed("agenda");
    return item;
  }

  blockAgenda(id: string, block: { capability: string; reason: string }): AgendaItem | null {
    const item = this.d.engine.blockAgenda(id, block, this.now());
    if (item) this.d.changed("agenda");
    return item;
  }

  unblockAgenda(id: string): AgendaItem | null {
    const item = this.d.engine.unblockAgenda(id, this.now());
    if (item) this.d.changed("agenda");
    return item;
  }

  feeling(person: PersonId): Feeling | null {
    return this.d.feelings.get(person);
  }

  feelings(): Feeling[] {
    return this.d.feelings.all();
  }

  setFeeling(person: PersonId, text: string, by: string): Promise<Feeling | null> {
    return this.d.feelings.set(person, text, by, this.d.clock.now());
  }
}
