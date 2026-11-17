// Her thought journal: every thought with its triggers, the changes she made, her intents and
// what became of them (gate decisions, what she said). One settings record per thought
// (`mind:thought:<id>`, ULIDs sort by time) of the active profile, and a copy in memory for the
// panel. At most `keep + batch - 1` raw thoughts: once that many piled up, the oldest beyond
// `keep` are condensed into one digest (`mind:digest:<id>`, the newest `digestsKeep` kept), so
// the settings never grow unbounded.

import { errorMessage, getLogger, SerialQueue } from "@miyoria/runtime/kernel";
import type { SettingsStore } from "@miyoria/store";
import {
  isJsonObject,
  type JsonValue,
  newId,
  type ProfileId,
  type Thought,
  type ThoughtDigest,
  type TurnId,
} from "@miyoria/types";

import { DETAIL_KEEP } from "./record.js";

const log = getLogger("mind.journal");

/** Settings key prefix of journal entries. */
export const THOUGHT_PREFIX = "mind:thought:";

export function thoughtKey(id: string): string {
  return `${THOUGHT_PREFIX}${id}`;
}

/** Settings key prefix of journal digests. */
export const DIGEST_PREFIX = "mind:digest:";

export function digestKey(id: string): string {
  return `${DIGEST_PREFIX}${id}`;
}

/** Condenses old thoughts (the summarizer, or `ruleDigest`). */
export type Condense = (thoughts: Thought[]) => Promise<ThoughtDigest>;

export interface DigestOptions {
  /** Condense once `keep + batch` raw thoughts piled up (1 = as soon as one is beyond `keep`). */
  batch: number;
  digestsKeep: number;
  condense: Condense;
}

function shortText(text: string, max: number): string {
  const c = [...text.replace(/\s+/g, " ").trim()];
  return c.length > max ? `${c.slice(0, max).join("")}…` : c.join("");
}

/** Intents of `thoughts` by `capability:status`. */
export function intentCounts(thoughts: readonly Thought[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of thoughts) {
    for (const i of t.intents) {
      const key = `${i.capability}:${i.status}`;
      out[key] = (out[key] ?? 0) + 1;
    }
  }
  return out;
}

/** A digest without a model: counts and a few of her own lines. */
export function ruleDigest(thoughts: readonly Thought[]): ThoughtDigest {
  const said = thoughts.filter((t) => t.thought.trim() !== "");
  const picks = [said[0], said[Math.floor(said.length / 2)], said.at(-1)]
    .filter((t, i, a): t is Thought => t !== undefined && a.indexOf(t) === i)
    .map((t) => `「${shortText(t.thought, 60)}」`);
  const failed = thoughts.length - said.length;
  return {
    id: newId(),
    from: thoughts[0]?.at ?? "",
    to: thoughts.at(-1)?.at ?? "",
    count: thoughts.length,
    summary:
      `${thoughts.length} 個想法${failed > 0 ? `(${failed} 個失敗)` : ""}。` +
      (picks.length > 0 ? `例如:${picks.join("、")}` : ""),
    intents: intentCounts(thoughts),
    by: "rule",
  };
}

function parseDigest(value: JsonValue): ThoughtDigest | null {
  if (!isJsonObject(value) || typeof value.id !== "string" || typeof value.summary !== "string") {
    return null;
  }
  return value as unknown as ThoughtDigest;
}

function parseThought(value: JsonValue): Thought | null {
  if (!isJsonObject(value)) return null;
  if (typeof value.id !== "string" || typeof value.at !== "string") return null;
  if (typeof value.thought !== "string" || !Array.isArray(value.intents)) return null;
  return value as unknown as Thought;
}

/** Drops the input snapshot and the reasoning; `true` when there was any. */
export function stripDetail(thought: Thought): boolean {
  if (!thought.input && !thought.reasoning) return false;
  thought.input = null;
  thought.reasoning = null;
  return true;
}

function toJson(thought: Thought): JsonValue {
  return JSON.parse(JSON.stringify(thought)) as JsonValue;
}

function toDigestJson(digest: ThoughtDigest): JsonValue {
  return JSON.parse(JSON.stringify(digest)) as JsonValue;
}

export class Journal {
  readonly #items: Thought[] = [];
  readonly #digests: ThoughtDigest[] = [];
  readonly #writes = new SerialQueue();
  readonly #condensing = new SerialQueue();

  constructor(
    private readonly store: SettingsStore | null,
    private readonly profile: ProfileId,
    private readonly keep: number,
    /** Called with a copy after every add and update (publishes `mind.thought`). */
    private readonly changed: (thought: Thought) => void = () => {},
    /** Without it, thoughts beyond `keep` are dropped. */
    private readonly digest: DigestOptions | null = null,
    /** The newest thoughts that keep their input snapshot and reasoning. */
    private readonly detailKeep = DETAIL_KEEP,
  ) {}

  async load(): Promise<void> {
    if (!this.store) return;
    const records = await this.store.list(this.profile, THOUGHT_PREFIX);
    this.#items.length = 0;
    for (const value of records.values()) {
      const thought = parseThought(value);
      if (thought) this.#items.push(thought);
    }
    this.#items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const old of this.#items.slice(0, Math.max(this.#items.length - this.detailKeep, 0))) {
      if (stripDetail(old)) void this.#persist(old.id, []);
    }
    this.#digests.length = 0;
    for (const value of (await this.store.list(this.profile, DIGEST_PREFIX)).values()) {
      const d = parseDigest(value);
      if (d) this.#digests.push(d);
    }
    this.#digests.sort((a, b) => (a.id < b.id ? -1 : 1));
    // A smaller `keep` than before: the extra are condensed (or dropped) right away.
    const over = this.#overflow(true);
    if (over.length > 0) void this.#retire(over);
  }

  /** Digests, newest first. */
  digests(limit = 20): ThoughtDigest[] {
    return this.#digests
      .slice(-Math.max(limit, 0))
      .reverse()
      .map((d) => structuredClone(d));
  }

  /** Waits for digests being made and writes. */
  settle(): Promise<void> {
    return this.#condensing.run(async () => {}).then(() => this.flush());
  }

  /** Takes the thoughts to retire: none until `keep + batch` piled up (`force`: any beyond). */
  #overflow(force = false): Thought[] {
    const batch = this.digest?.batch ?? 1;
    const extra = this.#items.length - this.keep;
    if (extra <= 0 || (!force && this.#items.length < this.keep + batch)) return [];
    return this.#items.splice(0, extra);
  }

  /** Condenses retired thoughts into a digest (or just drops them), then deletes them. */
  #retire(old: Thought[]): Promise<void> {
    const ids = old.map((t) => t.id);
    const digest = this.digest;
    if (!digest) return this.#persist(null, ids);
    return this.#condensing
      .run(async () => {
        let made: ThoughtDigest;
        try {
          made = await digest.condense(old.map((t) => structuredClone(t)));
        } catch (error) {
          log.debug({ err: errorMessage(error) }, "condensing her thoughts failed; a plain digest");
          made = ruleDigest(old);
        }
        this.#digests.push(made);
        const dropped = this.#digests.splice(
          0,
          Math.max(this.#digests.length - digest.digestsKeep, 0),
        );
        const store = this.store;
        if (store) {
          await this.#writes.run(async () => {
            try {
              await store.set(this.profile, digestKey(made.id), toDigestJson(made));
              for (const d of dropped) await store.set(this.profile, digestKey(d.id), null);
            } catch (error) {
              log.warn({ err: errorMessage(error) }, "cannot persist a journal digest");
            }
          });
        }
        await this.#persist(null, ids);
      })
      .catch(() => undefined);
  }

  /** Newest first. */
  list(limit = 50): Thought[] {
    return this.#items
      .slice(-Math.max(limit, 0))
      .reverse()
      .map((t) => structuredClone(t));
  }

  /** The thought `id`, if the journal still has it raw. */
  get(id: string): Thought | null {
    const t = this.#items.find((x) => x.id === id);
    return t ? structuredClone(t) : null;
  }

  /** The most recent `n`, oldest first. */
  recent(n: number): Thought[] {
    return this.#items.slice(-Math.max(n, 0)).map((t) => structuredClone(t));
  }

  get size(): number {
    return this.#items.length;
  }

  add(thought: Thought): Promise<void> {
    this.#items.push(structuredClone(thought));
    const retired = this.#overflow();
    this.changed(structuredClone(thought));
    if (retired.length > 0) void this.#retire(retired);
    // Only the newest thoughts keep what they saw and the model's reasoning.
    const aged = this.#items[this.#items.length - 1 - this.detailKeep];
    if (aged && stripDetail(aged)) void this.#persist(aged.id, []);
    return this.#persist(thought.id, []);
  }

  /** Applies `f` to the thought with an intent of turn `turn`; `false` when there is none. */
  updateByTurn(turn: TurnId, f: (thought: Thought, intent: Thought["intents"][number]) => void) {
    for (let i = this.#items.length - 1; i >= 0; i--) {
      const thought = this.#items[i] as Thought;
      const intent = thought.intents.find((x) => x.turn === turn);
      if (!intent) continue;
      f(thought, intent);
      this.changed(structuredClone(thought));
      void this.#persist(thought.id, []);
      return true;
    }
    return false;
  }

  /** Applies `f` to the thought `id`. */
  update(id: string, f: (thought: Thought) => void): boolean {
    const thought = this.#items.find((t) => t.id === id);
    if (!thought) return false;
    f(thought);
    this.changed(structuredClone(thought));
    void this.#persist(id, []);
    return true;
  }

  /** Waits for pending writes. */
  flush(): Promise<void> {
    return this.#writes.run(async () => {});
  }

  #persist(id: string | null, dropped: string[]): Promise<void> {
    const store = this.store;
    if (!store) return Promise.resolve();
    return this.#writes
      .run(async () => {
        const current = id === null ? undefined : this.#items.find((t) => t.id === id);
        try {
          if (current) await store.set(this.profile, thoughtKey(current.id), toJson(current));
          for (const old of dropped) await store.set(this.profile, thoughtKey(old), null);
        } catch (error) {
          log.warn({ err: errorMessage(error) }, "cannot persist her thought journal");
        }
      })
      .catch(() => undefined);
  }
}
