// Embeddings of her documents' lines (docs/design/v5-brain.md, "embedding 和筆記"): the embedder of
// `[memory.embedding]` (`memory/src/embed.ts`, the one the memory records use), one vector per line
// in `notes_vectors`, and a search that reads meaning when it can and words when it cannot.
//
// - What is embedded: each line in use, by itself. A line is one statement of at most 200
//   characters, never edited in place, and what every reader shows is lines (a card picks lines, a
//   search returns its best lines), so a line's vector stays valid for as long as the line does.
// - When: a line that comes into use is queued (`NotesStore.onAdded`) and embedded in the
//   background, a few at a time; the write never waits for it. A line that goes out of use loses
//   its vector in the store's own transaction. What the queue missed (embeddings were off, the
//   embedder failed, Core stopped) the backfill finds: lines in use with no vector of the model in
//   use, newest first. A vector another model made counts as missing and is made again.
// - The query: embedded once per text (kept for the next asks of the same text), and waited for
//   only `waitMs` (`voice_wait_ms` in a voice turn); when it is not there in time the search goes
//   on with words alone, and the vector that arrives later is kept for the next ask.
// - With the embedder off (`provider = "none"`, or a local model that could not load), nothing is
//   queued, nothing is waited for, and every search is the keyword search it always was.

import { getLogger } from "@miyoria/runtime/kernel";
import { serviceKey } from "@miyoria/types";
import type { Embedder } from "../../memory/src/embed.js";
import type { QueryVector, Ranking } from "./rank.js";
import type { DocumentKind } from "./schema.js";
import type { NotesReader } from "./scope.js";
import type { CardOptions, LineHit, NotesStore, VectorCounts } from "./store.js";
import type { SearchHit } from "./types.js";

const log = getLogger("memory.notes");

/** Lines embedded per call of the embedder: small, so a query waits behind few of them. */
export const EMBED_BATCH = 8;
/** Query texts whose vectors are kept. */
const QUERY_CACHE = 64;

/** The id of what makes an embedder's vectors (`Embedder.embeddingModel`, else its name). */
export function modelOf(embedder: Embedder): string {
  return embedder.embeddingModel ?? embedder.name;
}

export interface NotesIndexOptions {
  notes: NotesStore;
  embedder: Embedder;
  /** Lines per call of the embedder. Default `EMBED_BATCH`. */
  batch?: number;
}

/** The vectors of her documents' lines: the queue, the backfill and the query vectors. */
export class NotesIndex {
  readonly notes: NotesStore;
  readonly embedder: Embedder;
  readonly #batch: number;
  readonly #queued = new Set<string>();
  readonly #queries = new Map<string, Promise<QueryVector | null>>();
  readonly #stop: () => void;
  #draining: Promise<void> | null = null;
  #closed = false;

  constructor(options: NotesIndexOptions) {
    this.notes = options.notes;
    this.embedder = options.embedder;
    this.#batch = Math.max(1, options.batch ?? EMBED_BATCH);
    this.#stop = this.notes.onAdded((lines) => this.queue(lines));
  }

  /** Whether vectors are made (the embedder may turn itself off after a failure to load). */
  get enabled(): boolean {
    return !this.#closed && this.embedder.enabled;
  }

  /** What makes the vectors: only vectors with this id are compared. */
  get model(): string {
    return modelOf(this.embedder);
  }

  /** Lines in use with and without a vector of the model in use. */
  counts(): VectorCounts {
    return this.notes.vectorCounts(this.model);
  }

  /** Queues `lines` to be embedded; returns at once. */
  queue(lines: readonly string[]): void {
    if (!this.enabled) return;
    for (const id of lines) this.#queued.add(id);
    if (this.#draining === null && this.#queued.size > 0) {
      // Not in the writer's call stack: its transaction may still be open.
      this.#draining = new Promise<void>((resolve) => setImmediate(resolve))
        .then(() => this.#drain())
        .finally(() => {
          this.#draining = null;
          if (this.#queued.size > 0 && this.enabled) this.queue([]);
        });
    }
  }

  /** Resolves once the queue is empty (tests, the CLI). */
  async idle(): Promise<void> {
    while (this.#draining !== null) await this.#draining;
  }

  async #drain(): Promise<void> {
    while (this.#queued.size > 0 && this.enabled) {
      const ids = [...this.#queued].slice(0, this.#batch);
      for (const id of ids) this.#queued.delete(id);
      try {
        await this.#embed(this.notes.missingVectors(this.model, ids.length, ids));
      } catch (error) {
        // The backfill finds these lines, and the rest of the queue, again.
        log.warn({ error: String((error as Error)?.message ?? error) }, "notes embedding failed");
        this.#queued.clear();
        return;
      }
    }
  }

  /** Embeds `lines` and keeps the vectors; returns how many were kept. */
  async #embed(lines: ReadonlyArray<{ id: string; text: string }>, signal?: AbortSignal) {
    if (lines.length === 0) return 0;
    const model = this.model;
    const vectors = await this.embedder.embed(
      lines.map((l) => l.text),
      signal,
    );
    if (vectors.length !== lines.length) {
      throw new Error(`the embedder gave ${vectors.length} vectors for ${lines.length} lines`);
    }
    let kept = 0;
    lines.forEach((line, i) => {
      const v = vectors[i];
      if (v !== undefined && v.length > 0 && this.notes.putVector(line.id, model, v)) kept++;
    });
    return kept;
  }

  /**
   * Gives vectors to up to `limit` lines in use that have none of the model in use, newest first,
   * `batch` at a time. Returns how many got one. What it did is kept batch by batch, so a stop in
   * the middle loses at most the batch in flight. An embedder that fails ends the call (logged;
   * the next call tries again).
   */
  async backfill(limit: number, signal?: AbortSignal): Promise<number> {
    let done = 0;
    while (done < limit && this.enabled) {
      signal?.throwIfAborted();
      const lines = this.notes.missingVectors(this.model, Math.min(this.#batch, limit - done));
      if (lines.length === 0) break;
      let kept: number;
      try {
        kept = await this.#embed(lines, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        log.warn({ error: String((error as Error)?.message ?? error) }, "notes backfill failed");
        break;
      }
      done += kept;
      // Lines that came back without a vector would be asked for again forever.
      if (kept < lines.length) break;
    }
    return done;
  }

  /**
   * The vector of a search for `text`, or `null` when there is none within `waitMs` (or the
   * embedder is off, or it failed, or `signal` aborted first). The embedding is not stopped by
   * the wait: it finishes and is kept for the next ask of the same text.
   */
  async query(
    text: string,
    options: { waitMs: number; signal?: AbortSignal },
  ): Promise<QueryVector | null> {
    const asked = text.trim();
    if (!this.enabled || asked === "" || options.signal?.aborted) return null;
    let made = this.#queries.get(asked);
    if (made === undefined) {
      const model = this.model;
      const embedder = this.embedder;
      made = (embedder.embedQuery ? embedder.embedQuery([asked]) : embedder.embed([asked])).then(
        (vectors): QueryVector | null => {
          const v = vectors[0];
          return v !== undefined && v.length > 0 ? { values: v, model } : null;
        },
        (error: unknown): null => {
          log.warn({ error: String((error as Error)?.message ?? error) }, "query embedding failed");
          return null;
        },
      );
      this.#queries.set(asked, made);
      // A failed one is asked again next time (`made` never rejects).
      void made.then((v) => {
        if (v === null) this.#queries.delete(asked);
      });
      while (this.#queries.size > QUERY_CACHE) {
        const oldest = this.#queries.keys().next().value;
        if (oldest === undefined) break;
        this.#queries.delete(oldest);
      }
    }
    return waitFor(made, options.waitMs, options.signal);
  }

  /** Stops queueing; what is in flight finishes. */
  close(): void {
    this.#closed = true;
    this.#queued.clear();
    this.#stop();
  }
}

/** `promise`'s value, or `null` once `ms` passed or `signal` aborted. */
async function waitFor<T>(
  promise: Promise<T>,
  ms: number,
  signal?: AbortSignal,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(0, ms));
    if (signal) {
      onAbort = () => resolve(null);
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** How long a search waits for its query's vector (`[modules.memory]`). */
export interface VectorWait {
  /** Milliseconds; `notes_vector_wait_ms`. */
  text: number;
  /** In a voice turn; `notes_vector_voice_wait_ms`. */
  voice: number;
}

export interface SearchOptions {
  kind?: DocumentKind;
  limit?: number;
  /** `lines`: only the lines of these documents (subjects). */
  subjects?: readonly string[];
  /** A voice turn: the query's vector is waited for `voice` ms. */
  voice?: boolean;
  signal?: AbortSignal;
}

export interface NotesSearchOptions {
  notes: NotesStore;
  /** `null`: embeddings are off, every search is by words. */
  index: NotesIndex | null;
  ranking: () => Ranking;
  wait: () => VectorWait;
}

/**
 * Searches of her documents that read meaning when a query vector is there in time and words
 * otherwise (the file comment). Without an index each call is the store's keyword call, unchanged.
 */
export class NotesSearch {
  readonly notes: NotesStore;
  readonly index: NotesIndex | null;
  readonly #ranking: () => Ranking;
  readonly #wait: () => VectorWait;

  constructor(options: NotesSearchOptions) {
    this.notes = options.notes;
    this.index = options.index;
    this.#ranking = options.ranking;
    this.#wait = options.wait;
  }

  get ranking(): Ranking {
    return this.#ranking();
  }

  /** The vector of `text` within the wait of a text or a voice turn; `null`: words alone. */
  async vector(
    text: string,
    options: { voice?: boolean; signal?: AbortSignal } = {},
  ): Promise<QueryVector | null> {
    const index = this.index;
    if (index === null || !index.enabled) return null;
    const wait = this.#wait();
    return index.query(text, {
      waitMs: options.voice ? wait.voice : wait.text,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  /** `NotesStore.search`, with the query's vector when there is one in time. */
  async documents(
    query: string,
    reader: NotesReader,
    options: SearchOptions = {},
  ): Promise<SearchHit[]> {
    const vector = await this.vector(query, options);
    return this.notes.search(query, reader, {
      ...(options.kind === undefined ? {} : { kind: options.kind }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(vector === null ? {} : { vector, ranking: this.#ranking() }),
    });
  }

  /** `NotesStore.searchLines`, with the query's vector when there is one in time. */
  async lines(query: string, reader: NotesReader, options: SearchOptions = {}): Promise<LineHit[]> {
    const vector = await this.vector(query, options);
    return this.linesWith(vector, query, reader, options);
  }

  /** `lines` with a query vector already in hand (`vector`), so several searches share one wait. */
  linesWith(
    vector: QueryVector | null,
    query: string,
    reader: NotesReader,
    options: Omit<SearchOptions, "voice" | "signal"> = {},
  ): LineHit[] {
    return this.notes.searchLines(query, reader, {
      ...(options.kind === undefined ? {} : { kind: options.kind }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.subjects === undefined ? {} : { subjects: options.subjects }),
      ranking: this.#ranking(),
      ...(vector === null ? {} : { vector }),
    });
  }

  /** What `CardOptions` adds for `vector` (nothing when it is `null`). */
  cardOptions(vector: QueryVector | null): Pick<CardOptions, "vector" | "ranking"> {
    return vector === null ? {} : { vector, ranking: this.#ranking() };
  }
}

/** The search over her documents (module `memory` provides it when the notes are there). */
export const NotesSearchKey = serviceKey<NotesSearch>("NotesSearch");
