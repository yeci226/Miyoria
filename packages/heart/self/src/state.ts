// The `SelfStateKey` service: the engine advanced to "now" on every call, plus her mood. Every
// change calls `changed` so the module saves it. How she feels about each person is the heart's
// (`HeartKey`, docs/design/v5-heart.md §2.10): 在意, the one she cares about most and how much she
// misses someone are read from it, never kept here.

import type {
  Affect,
  AgendaInput,
  AgendaItem,
  Clock,
  ContextKey,
  Drives,
  EffectiveTalkativeness,
  EmotionName,
  EmotionReading,
  EmotionSample,
  HeartPeople,
  Mood,
  PersonId,
  SelfSnapshot,
  SelfState,
  ShownEmotion,
  Talkativeness,
  TalkativenessInput,
} from "@miyoria/types";
import { CARES_THRESHOLD, EMOTION_LABELS, toTimestamp } from "@miyoria/types";
import type { SelfConfig } from "./config.js";
import { type Audience, shownEmotion } from "./display.js";
import type { Circumstances, SelfEngine } from "./engine.js";

export interface SelfServiceDeps {
  engine: SelfEngine;
  clock: Clock;
  config: SelfConfig;
  /** What she is doing right now (playing, live, energy, the one she cares about with her). */
  circumstances: () => Circumstances;
  mood: () => Mood | null;
  /** The heart (`HeartKey`): 在意, the one she cares about most, how much she misses someone. */
  heart: () => HeartPeople | null;
  /** Someone's name as people see it (for the cause of an emotion); `null`: unknown. */
  nameOf?: (person: PersonId) => string | null;
  /** Who she is with right now (for what she shows); `undefined` = nobody in particular. */
  audience?: () => Audience | undefined;
  /** Called after every change of the persisted state. */
  changed: (reason: string) => void;
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0);

export class SelfService implements SelfState {
  readonly #history: EmotionSample[] = [];
  #sampledAt = Number.NEGATIVE_INFINITY;
  /** When she last saw each person say or do anything (this run): a return is news once. */
  readonly #lastSeen = new Map<PersonId, number>();

  constructor(private readonly d: SelfServiceDeps) {}

  /** The engine (the affect service of the same module works on it). */
  get engine(): SelfEngine {
    return this.d.engine;
  }

  get config(): SelfConfig {
    return this.d.config;
  }

  get clock(): Clock {
    return this.d.clock;
  }

  /** Records that something changed (the module saves it). */
  changed(reason: string): void {
    this.d.changed(reason);
  }

  /** Advances the engine to now and returns now. */
  now(): number {
    const now = this.d.clock.now();
    const e = this.d.engine;
    e.advance(now, this.d.circumstances());
    // An agenda item for someone ran out before she did it: a promise she did not keep.
    for (const item of e.takeExpired()) {
      if (item.person === null) continue;
      const name = this.d.nameOf?.(item.person) ?? "別人";
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

  /**
   * How much she cares about someone, 0..1; 0 when she does not (yet): the heart's one definition
   * (`HeartPeople.cares`, counted from `CARES_THRESHOLD` on, owner decision H5). 0 without it.
   */
  care(person: PersonId): number {
    const cares = this.d.heart()?.cares(person) ?? 0;
    return cares >= CARES_THRESHOLD ? clamp01(cares) : 0;
  }

  /** The one she cares about most, above the threshold (H5); `null` for nobody. */
  mostCared(): { person: PersonId; cares: number } | null {
    return this.d.heart()?.mostCared() ?? null;
  }

  /**
   * They said or did something. Returns how much she had been missing them (their longing on the
   * heart's row, which the heart's daily pass eases once they are back) when this is the first
   * she sees of them for `missing_after_hours`; 0 otherwise, so a return is news once.
   */
  seen(person: PersonId): number {
    const now = this.d.clock.now();
    const last = this.#lastSeen.get(person) ?? Number.NEGATIVE_INFINITY;
    this.#lastSeen.set(person, now);
    if (now - last < this.d.config.emotions.missing_after_hours * 3_600_000) return 0;
    const longing = this.d.heart()?.view(person)?.longing ?? 0;
    return clamp01(longing);
  }

  /**
   * Who the old crush rules are about (praise makes her shy, jealousy, longing eased by them):
   * the one she cares about most (H5).
   */
  crushPerson(): PersonId | null {
    return this.mostCared()?.person ?? null;
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
}
