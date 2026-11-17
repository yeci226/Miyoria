// Feedback signals about her, kept compactly per person and per context in day buckets:
// reactions on her messages, replies to her, conversations she started that were answered or
// ignored, explicit phrases about her (cheap rules here, plus what a fold noticed), and her
// autonomous actions that were refused. Reflection reads them; nothing here calls a model.

import { errorMessage, getLogger, SerialQueue } from "@miyoria/runtime/kernel";
import type { SettingsStore } from "@miyoria/store";
import {
  type AccountRef,
  type Clock,
  type ContextKey,
  contextKeyString,
  type FeedbackTally,
  type IncomingMessage,
  isJsonObject,
  type JsonValue,
  type PersonId,
  type ProfileId,
  safeName,
  systemClock,
} from "@miyoria/types";

const log = getLogger("learning.feedback");

/** Settings key prefix of the day buckets (`feedback:day:<YYYY-MM-DD>`). */
export const FEEDBACK_PREFIX = "feedback:day:";
const MAX_EXAMPLES = 4;
const MAX_SUBJECTS = 200;
const MAX_OWN_MESSAGES = 300;

const NEGATIVE =
  /閉嘴|好吵|很吵|吵死|太吵|煩死|好煩|很煩|你很煩|安靜一點|安靜點|不要吵|別吵|不要插嘴|別插嘴|走開|滾開|shut\s*up|annoying|stop talking|be quiet/iu;
const POSITIVE =
  /好可愛|真可愛|可愛|謝謝|感謝|好棒|好厲害|很厲害|喜歡你|愛你|笑死|好好笑|讚啦|thank|love you|cute|good job|nice one/iu;

const POSITIVE_EMOJI = new Set([
  "👍",
  "❤️",
  "❤",
  "♥️",
  "💕",
  "💖",
  "😂",
  "🤣",
  "😆",
  "😍",
  "🥰",
  "👏",
  "🎉",
  "💯",
  "✨",
  "😊",
  "😄",
  "😁",
  "🙏",
  "🔥",
  "😻",
  "🫶",
]);
const NEGATIVE_EMOJI = new Set(["👎", "😡", "🤬", "😠", "🙄", "💢", "😒", "🤮", "😤", "😑", "🖕"]);

/** `positive`, `negative` or `null` (neutral / unknown) for a reaction emoji. */
export function emojiTone(emoji: string): "positive" | "negative" | null {
  const e = emoji.trim();
  if (POSITIVE_EMOJI.has(e)) return "positive";
  if (NEGATIVE_EMOJI.has(e)) return "negative";
  const name = e.toLowerCase();
  if (/heart|love|lol|laugh|clap|thumbsup|\+1|pog|kawaii|cute/.test(name)) return "positive";
  if (/thumbsdown|angry|rage|-1|annoy/.test(name)) return "negative";
  return null;
}

/** Explicit tone of a line addressed to her, by cheap rules (`null` = none). */
export function phraseTone(text: string): "positive" | "negative" | null {
  if (NEGATIVE.test(text)) return "negative";
  if (POSITIVE.test(text)) return "positive";
  return null;
}

type Counter = Exclude<keyof FeedbackTally, "subject" | "label" | "examples">;

function emptyTally(subject: string, label: string): FeedbackTally {
  return {
    subject,
    label,
    reactions_pos: 0,
    reactions_neg: 0,
    replies: 0,
    started: 0,
    answered: 0,
    ignored: 0,
    positive: 0,
    negative: 0,
    denied: 0,
    examples: [],
  };
}

interface Started {
  context: ContextKey;
  at: number;
}

export interface Who {
  account: AccountRef | null;
  person: PersonId | null;
  name: string | null;
}

export class FeedbackTracker {
  /** Day → subject → tally. */
  readonly #days = new Map<string, Map<string, FeedbackTally>>();
  readonly #dirty = new Set<string>();
  readonly #writes = new SerialQueue();
  /** Her message ids → context (to recognize reactions to her). */
  readonly #own = new Map<string, ContextKey>();
  /** Conversations she started, waiting for an answer. */
  readonly #started = new Map<string, Started>();
  /** Her last words per context (replies within the window count). */
  readonly #lastSelf = new Map<string, number>();

  constructor(
    private readonly store: SettingsStore | null,
    private readonly profile: ProfileId,
    private readonly options: {
      utcOffsetMinutes: number;
      keepDays: number;
      replyWindowMs: number;
    },
    private readonly clock: Clock = systemClock,
  ) {}

  #day(now: number): string {
    return new Date(now + this.options.utcOffsetMinutes * 60_000).toISOString().slice(0, 10);
  }

  async load(): Promise<void> {
    if (!this.store) return;
    const records = await this.store.list(this.profile, FEEDBACK_PREFIX);
    for (const [key, value] of records) {
      if (!isJsonObject(value) || !isJsonObject(value.subjects)) continue;
      const map = new Map<string, FeedbackTally>();
      for (const [subject, t] of Object.entries(value.subjects)) {
        if (isJsonObject(t)) map.set(subject, { ...emptyTally(subject, ""), ...(t as object) });
      }
      this.#days.set(key.slice(FEEDBACK_PREFIX.length), map);
    }
  }

  #bump(subject: string, label: string, counter: Counter, example: string | null): void {
    const now = this.clock.now();
    const day = this.#day(now);
    let map = this.#days.get(day);
    if (!map) {
      map = new Map();
      this.#days.set(day, map);
      this.#prune(now);
    }
    let t = map.get(subject);
    if (!t) {
      if (map.size >= MAX_SUBJECTS) return;
      t = emptyTally(subject, label);
      map.set(subject, t);
    }
    if (label !== "" && t.label === "") t.label = label;
    t[counter] += 1;
    if (example !== null && example.trim() !== "") {
      t.examples = [...t.examples, example.trim()].slice(-MAX_EXAMPLES);
    }
    this.#dirty.add(day);
  }

  /** Counts a signal for the person (if known) and the context (if any). */
  record(who: Who | null, context: ContextKey | null, counter: Counter, example: string | null) {
    if (who?.person)
      this.#bump(`person:${who.person}`, safeName(who.name ?? who.person), counter, example);
    if (context) this.#bump(contextKeyString(context), contextKeyString(context), counter, example);
  }

  #prune(now: number): void {
    const keep = new Set<string>();
    for (let i = 0; i < Math.max(this.options.keepDays, 1); i++) {
      keep.add(this.#day(now - i * 86_400_000));
    }
    for (const day of [...this.#days.keys()]) {
      if (keep.has(day)) continue;
      this.#days.delete(day);
      this.#dirty.add(day);
    }
  }

  // ---- signals ------------------------------------------------------------------------------

  /** She sent a message (id from `action.completed`). */
  ownMessage(id: string, context: ContextKey): void {
    this.#own.set(id, context);
    if (this.#own.size > MAX_OWN_MESSAGES) {
      const oldest = this.#own.keys().next().value;
      if (oldest !== undefined) this.#own.delete(oldest);
    }
  }

  /** She said something in `context`; `started` = she opened the conversation herself. */
  spoke(context: ContextKey, started: boolean): void {
    const now = this.clock.now();
    const key = contextKeyString(context);
    this.#lastSelf.set(key, now);
    if (started) {
      this.#started.set(key, { context, at: now });
      this.record(null, context, "started", null);
    }
  }

  reaction(messageId: string, who: Who, emoji: string, added: boolean): void {
    if (!added) return;
    const context = this.#own.get(messageId);
    if (!context) return;
    const tone = emojiTone(emoji);
    if (tone === null) return;
    this.record(who, context, tone === "positive" ? "reactions_pos" : "reactions_neg", emoji);
  }

  /** Someone else wrote in a context. `addressed` = to her (mention, reply, DM, her name). */
  message(msg: IncomingMessage, who: Who, addressed: boolean): void {
    const now = this.clock.now();
    const context = msg.id.context;
    const key = contextKeyString(context);
    const started = this.#started.get(key);
    if (started && now - started.at <= this.options.replyWindowMs) {
      this.#started.delete(key);
      this.record(who, context, "answered", null);
    }
    const last = this.#lastSelf.get(key);
    const toHer =
      msg.reply_to_self ||
      (addressed && last !== undefined && now - last <= this.options.replyWindowMs);
    if (toHer) this.record(who, context, "replies", null);
    if (addressed) {
      const tone = phraseTone(msg.text);
      if (tone !== null) {
        this.record(who, context, tone, msg.text.replace(/\s+/g, " ").slice(0, 80));
      }
    }
  }

  /** An explicit reaction a fold noticed. */
  noticed(who: Who, context: ContextKey | null, tone: "positive" | "negative", quote: string) {
    this.record(who, context, tone, quote.slice(0, 80));
  }

  /** One of her autonomous actions was refused. */
  denied(context: ContextKey | null, capability: string, reason: string): void {
    this.record(null, context, "denied", `${capability}: ${reason}`.slice(0, 80));
    if (context === null)
      this.#bump("self", "她自己", "denied", `${capability}: ${reason}`.slice(0, 80));
  }

  /** Conversations she started that nobody answered within the window count as ignored. */
  sweep(): void {
    const now = this.clock.now();
    for (const [key, s] of [...this.#started]) {
      if (now - s.at <= this.options.replyWindowMs) continue;
      this.#started.delete(key);
      this.record(null, s.context, "ignored", null);
    }
  }

  // ---- reads --------------------------------------------------------------------------------

  /** Tallies over the last `days` days, merged per subject, busiest first. */
  tallies(days = 1): FeedbackTally[] {
    const now = this.clock.now();
    const merged = new Map<string, FeedbackTally>();
    for (let i = 0; i < Math.max(days, 1); i++) {
      const map = this.#days.get(this.#day(now - i * 86_400_000));
      if (!map) continue;
      for (const t of map.values()) {
        const m = merged.get(t.subject) ?? emptyTally(t.subject, t.label);
        for (const k of Object.keys(t) as (keyof FeedbackTally)[]) {
          if (typeof t[k] === "number") (m[k] as number) += t[k] as number;
        }
        m.examples = [...m.examples, ...t.examples].slice(-MAX_EXAMPLES);
        if (m.label === "") m.label = t.label;
        merged.set(t.subject, m);
      }
    }
    const weight = (t: FeedbackTally) =>
      t.reactions_pos +
      t.reactions_neg +
      t.replies +
      t.started +
      t.positive +
      t.negative +
      t.denied;
    return [...merged.values()].sort((a, b) => weight(b) - weight(a));
  }

  /** Writes changed day buckets. */
  persist(): Promise<void> {
    const store = this.store;
    if (!store || this.#dirty.size === 0) return Promise.resolve();
    const days = [...this.#dirty];
    this.#dirty.clear();
    return this.#writes
      .run(async () => {
        for (const day of days) {
          const map = this.#days.get(day);
          const value: JsonValue | null = map
            ? ({
                subjects: Object.fromEntries([...map].map(([k, t]) => [k, { ...t }])),
              } as unknown as JsonValue)
            : null;
          try {
            await store.set(this.profile, `${FEEDBACK_PREFIX}${day}`, value);
          } catch (error) {
            log.warn({ err: errorMessage(error) }, "cannot persist feedback");
          }
        }
      })
      .catch(() => undefined);
  }
}
