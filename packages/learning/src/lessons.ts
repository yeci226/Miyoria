// Lessons she writes when she reflects ("阿明不喜歡被打斷"), scoped to a person and / or a
// place. Turns see them as data; attention shifts her talkativeness by them; her mind loop
// reads them. One settings record per lesson (`reflect:lesson:<id>`).

import { errorMessage, getLogger, SerialQueue } from "@miyoria/kernel";
import type { SettingsStore } from "@miyoria/store";
import {
  type Clock,
  type ContextKey,
  isJsonObject,
  type Lesson,
  type Lessons,
  type PersonId,
  type ProfileId,
  repairHandleText,
  systemClock,
  talkativenessScopes,
  timestampMs,
} from "@miyoria/types";

const log = getLogger("learning.lessons");

export const LESSON_PREFIX = "reflect:lesson:";
/**
 * One unit of a lesson's `talk` shifts talkativeness by this much, and all lessons together by
 * at most `MAX_SHIFT`: lessons nudge her, they never silence her (thirty "be quieter" lessons
 * once added up to the old cap of 0.4 and kept her near mute everywhere).
 */
const TALK_STEP = 0.1;
const MAX_SHIFT = 0.15;

/**
 * Whether a lesson is about how much she talks ("安靜一點", "可以更活躍"), as opposed to how she
 * talks (tone, jokes, wording, topics). Only the first kind may shift her talkativeness: when
 * every complaint about style also turned her down, a handful of bad evenings kept her near mute.
 */
const VOLUME =
  /安靜|閉嘴|話(?:太)?多|少說|少講|多說|多講|說話|講話|話少|吵|沉默|活潑|活躍|主動|開話題|插話|頻率|quiet|chatty|talk less|talk more|speak up/i;

export function isTalkLesson(text: string): boolean {
  return VOLUME.test(text);
}

export class LessonStore implements Lessons {
  readonly #items = new Map<string, Lesson>();
  readonly #writes = new SerialQueue();

  constructor(
    private readonly store: SettingsStore | null,
    private readonly profile: ProfileId,
    private readonly keep: number,
    private readonly clock: Clock = systemClock,
  ) {}

  async load(): Promise<void> {
    if (!this.store) return;
    for (const value of (await this.store.list(this.profile, LESSON_PREFIX)).values()) {
      if (!isJsonObject(value) || typeof value.id !== "string" || typeof value.text !== "string") {
        continue;
      }
      this.#items.set(value.id, value as unknown as Lesson);
    }
  }

  flush(): Promise<void> {
    return this.#writes.run(async () => {});
  }

  #live(now: number): Lesson[] {
    const out: Lesson[] = [];
    for (const l of this.#items.values()) {
      if (l.expires_at !== null && timestampMs(l.expires_at) <= now) {
        this.remove(l.id);
        continue;
      }
      out.push(l);
    }
    return out.sort((a, b) => (a.id < b.id ? 1 : -1));
  }

  all(): Lesson[] {
    return this.#live(this.clock.now()).map((l) => structuredClone(l));
  }

  applicable(context: ContextKey | null, people: readonly PersonId[]): Lesson[] {
    const scopes = context === null ? null : talkativenessScopes(context);
    return this.#live(this.clock.now()).filter((l) => {
      if (l.person !== null && !people.includes(l.person)) return false;
      if (l.scope === null) return true;
      return scopes?.includes(l.scope) === true;
    });
  }

  talkShift(context: ContextKey | null, people: readonly PersonId[]): number {
    // A style lesson never turns into a talkativeness offset, whatever `talk` it was saved with
    // (older lessons carry one); the owner's own lessons (`panel`) are taken as set.
    const sum = this.applicable(context, people).reduce(
      (n, l) => n + (l.source === "panel" || isTalkLesson(l.text) ? (l.talk ?? 0) : 0),
      0,
    );
    return Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, sum * TALK_STEP));
  }

  /**
   * Adds a lesson. A text with a per-call code (`u7`) is rewritten without it, or refused when
   * nothing is left; `false` = not added.
   */
  add(lesson: Lesson): boolean {
    const text = repairHandleText(lesson.text);
    if (text === null) {
      log.warn({ id: lesson.id }, "refused a lesson that only says a per-call code");
      return false;
    }
    lesson = { ...lesson, text };
    // The same lesson again replaces the old one.
    for (const l of this.#items.values()) {
      if (l.text === lesson.text && l.person === lesson.person && l.scope === lesson.scope) {
        this.remove(l.id);
      }
    }
    this.#items.set(lesson.id, structuredClone(lesson));
    this.#save(lesson.id);
    const all = [...this.#items.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const old of all.slice(0, Math.max(all.length - this.keep, 0))) this.remove(old.id);
    return true;
  }

  remove(id: string): boolean {
    if (!this.#items.delete(id)) return false;
    this.#save(id);
    return true;
  }

  #save(id: string): void {
    const store = this.store;
    if (!store) return;
    const value = this.#items.get(id);
    void this.#writes
      .run(async () => {
        try {
          await store.set(
            this.profile,
            `${LESSON_PREFIX}${id}`,
            value ? JSON.parse(JSON.stringify(value)) : null,
          );
        } catch (error) {
          log.warn({ err: errorMessage(error) }, "cannot persist a lesson");
        }
      })
      .catch(() => undefined);
  }
}
