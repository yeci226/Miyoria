// Messages someone asked her not to remember (`agent.message.excluded`, "不要記住這個").
//
// The agent hides the message from her prompts and tells the bus; this is what the rest of her
// memory keeps so the text cannot come back through consolidation, evidence, "just now" or a
// person's profile. Neither the event nor this list keeps the text: a message is known by the
// ids it has in each place (the EventLog event, the chat-log line) and by a hash of "who said
// what, in which context", which is how a chat-log line is recognised when the log holds no event
// for it. Bounded, and persisted in the settings store so a restart does not forget.

import { createHash } from "node:crypto";
import { type ContextKey, contextKeyString, isJsonObject, type LogEvent } from "@miyoria/types";

/** Settings key of the list. */
export const EXCLUDED_KEY = "memory_excluded";
/** Messages kept; past this the oldest are forgotten (the agent keeps its own bounded copy too). */
export const MAX_EXCLUDED = 500;

/** One excluded message, as stored. */
export interface ExcludedEntry {
  /** `contextKeyString` of the place she knew it in. */
  c: string;
  /** Attention key of its observation: `msg:<platform>:<message id>`. */
  key: string;
  /** EventLog event ids and `msg:<line id>` of chat lines: the ids evidence points at. */
  refs: string[];
  /** Hashes of `lineHash(author name, text)`. */
  hashes: string[];
  /** When it was asked, ms. */
  at: number;
}

/** Hash of one line of chat (who said what), the same from an event and from the chat log. */
export function lineHash(summary: string): string {
  return createHash("sha256").update(summary.normalize("NFC").trim()).digest("hex").slice(0, 16);
}

/** The attention key a chat message has on its observation. */
export function messageKey(platform: string, id: string): string {
  return `msg:${platform}:${id}`;
}

export class ExclusionList {
  #entries: ExcludedEntry[] = [];
  readonly #keys = new Set<string>();
  readonly #refs = new Set<string>();
  readonly #hashes = new Set<string>();

  get size(): number {
    return this.#entries.length;
  }

  /** Replaces the list with what was stored (anything unreadable is dropped). */
  load(value: unknown): void {
    this.#entries = [];
    if (Array.isArray(value)) {
      for (const raw of value) {
        if (typeof raw !== "object" || raw === null) continue;
        const e = raw as Partial<ExcludedEntry>;
        if (typeof e.c !== "string" || typeof e.key !== "string") continue;
        this.#entries.push({
          c: e.c,
          key: e.key,
          refs: Array.isArray(e.refs) ? e.refs.filter((r) => typeof r === "string") : [],
          hashes: Array.isArray(e.hashes) ? e.hashes.filter((r) => typeof r === "string") : [],
          at: typeof e.at === "number" ? e.at : 0,
        });
      }
    }
    this.#rebuild();
  }

  /** What is written to the settings store. */
  toJSON(): ExcludedEntry[] {
    return this.#entries.map((e) => ({ ...e, refs: [...e.refs], hashes: [...e.hashes] }));
  }

  add(entry: ExcludedEntry): void {
    const same = this.#entries.find((e) => e.c === entry.c && e.key === entry.key);
    if (same) {
      same.refs = [...new Set([...same.refs, ...entry.refs])];
      same.hashes = [...new Set([...same.hashes, ...entry.hashes])];
    } else {
      this.#entries.push({ ...entry, refs: [...entry.refs], hashes: [...entry.hashes] });
      while (this.#entries.length > MAX_EXCLUDED) this.#entries.shift();
    }
    this.#rebuild();
  }

  #rebuild(): void {
    this.#keys.clear();
    this.#refs.clear();
    this.#hashes.clear();
    for (const e of this.#entries) {
      this.#keys.add(e.key);
      for (const r of e.refs) this.#refs.add(r);
      for (const h of e.hashes) this.#hashes.add(`${e.c}\n${h}`);
    }
  }

  /** An evidence id (EventLog event or `msg:<line id>`) of an excluded message. */
  hasRef(ref: string): boolean {
    return this.#refs.has(ref);
  }

  /** The platform message `id` is excluded. */
  hasMessage(platform: string, id: string): boolean {
    return this.#keys.has(messageKey(platform, id));
  }

  /** A chat line by who said what in `context`. */
  hasLine(context: ContextKey, name: string, text: string): boolean {
    if (this.#hashes.size === 0) return false;
    return this.#hashes.has(`${contextKeyString(context)}\n${lineHash(`${name}:${text}`)}`);
  }

  /** An EventLog event of an excluded message (by id, or by the message it was made from). */
  hasEvent(event: LogEvent): boolean {
    if (this.#entries.length === 0) return false;
    if (this.#refs.has(event.id)) return true;
    const body = event.body;
    if (!isJsonObject(body) || !isJsonObject(body.observation)) return false;
    const key = body.observation.attention_key;
    return typeof key === "string" && this.#keys.has(key);
  }
}
