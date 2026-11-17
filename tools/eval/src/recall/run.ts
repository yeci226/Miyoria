// The recall harness: a set's memories in a fresh in-memory database, every query asked the way
// a turn asks (`MemoryContributor.contribute`: `visibleScopes`, `turnOf`, `MemoryEngine.recall`
// over `PROMPT_KINDS`), and what came back scored by `metrics.ts`. With `target: "notes"` the
// same set is asked of her notes instead (`notes.ts`).
//
// Memories are written through the table layer (`MemoryTables.upsert`), not `MemoryEngine.store`:
// the engine's write path merges similar records, refuses facts without evidence and
// present-tense notes, and makes its own ids, so a set would not be stored as written.
//
// Not covered: the handle directory (people named in a line are found only through `people`),
// and the down-weighting of a gag recalled many times in a row (each query gets a new engine, so
// the result does not depend on the order of the queries).

import {
  type Embedder,
  type MemoryConfigSchema,
  MemoryEngine,
  memoryConfig,
  memoryTables,
  PROMPT_KINDS,
  tokenString,
  turnOf,
  visibleScopes,
} from "@miyoria/memory/memory";
import { type MemoryRecord, SqliteStore } from "@miyoria/store";
import type { z } from "zod";
import { DEFAULT_KS, type RecallMetrics, type Returned, scoreRecall } from "./metrics.js";
import { runNotesRecall } from "./notes.js";
import type { RecallSet } from "./set.js";

/** The profile the harness stores under (one database is one character). */
const PROFILE = "recall-eval";
/** Memories embedded per call when they are stored. */
const EMBED_BATCH = 16;

export type RecallConfigOverrides = z.input<typeof MemoryConfigSchema>;

/** What is searched: the memory records (`memory_records`), or her notes (`notes.ts`). */
export type RecallTarget = "records" | "notes";
export const RECALL_TARGETS: readonly RecallTarget[] = ["records", "notes"];

export interface RecallOptions {
  /** Default `records`. */
  target?: RecallTarget;
  /** Makes the vectors of memories and queries; absent: full text, recency and importance only. */
  embedder?: Embedder;
  /** The k of recall@k (1, 3, 5, 8). */
  ks?: readonly number[];
  /** `[modules.memory]` overrides: `weights`, `min_score`, `min_vector`, ... */
  config?: RecallConfigOverrides;
  signal?: AbortSignal;
}

export interface RecallResult extends RecallMetrics {
  set: string;
  target: RecallTarget;
  memories: number;
  /** The embedder's model (or name), `null` when the run had none. */
  embedder: string | null;
  /** Calls to the embedder that failed; the engine goes on without a vector for that query. */
  embedding_failures: number;
  /** Memories asked for per query: `recall_limit`, or the largest k when that is more. */
  limit: number;
  /** The settings of the run that thresholds are swept over. */
  config: {
    min_score: number;
    min_vector: number;
    recall_limit: number;
    weights: Record<string, number>;
  };
  /**
   * The notes only: what the prompt's memory block would show (`[modules.memory.notes_recall]`
   * rule 3 too: weak hits are none), scored the same way. The top-level numbers are `recall`'s.
   */
  block?: Pick<
    RecallMetrics,
    "recall_at" | "mrr" | "nothing_returned_rate" | "nothing_mean_returned"
  >;
}

const iso = (at: string): string => new Date(at).toISOString();

/**
 * Keeps every vector an embedder made, by text, so a sweep embeds the set once. Counts the calls
 * that failed: the engine logs a failed query embedding and ranks without it.
 */
export class CachedEmbedder implements Embedder {
  readonly name: string;
  readonly enabled: boolean;
  readonly embeddingModel?: string;
  failures = 0;
  readonly #inner: Embedder;
  readonly #passages = new Map<string, number[]>();
  readonly #queries = new Map<string, number[]>();

  constructor(inner: Embedder) {
    this.#inner = inner;
    this.name = inner.name;
    this.enabled = inner.enabled;
    if (inner.embeddingModel !== undefined) this.embeddingModel = inner.embeddingModel;
  }

  embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    return this.#cached(this.#passages, (t) => this.#inner.embed(t, signal), texts);
  }

  embedQuery(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    const embedQuery = this.#inner.embedQuery?.bind(this.#inner);
    if (!embedQuery) return this.embed(texts, signal);
    return this.#cached(this.#queries, (t) => embedQuery(t, signal), texts);
  }

  async #cached(
    cache: Map<string, number[]>,
    make: (texts: string[]) => Promise<number[][]>,
    texts: readonly string[],
  ): Promise<number[][]> {
    const missing = [...new Set(texts.filter((t) => !cache.has(t)))];
    if (missing.length > 0) {
      let vectors: number[][];
      try {
        vectors = await make(missing);
      } catch (error) {
        this.failures += 1;
        throw error;
      }
      if (vectors.length !== missing.length) {
        this.failures += 1;
        throw new Error(`embedder returned ${vectors.length} vectors for ${missing.length} texts`);
      }
      missing.forEach((text, i) => {
        cache.set(text, vectors[i] as number[]);
      });
    }
    return texts.map((t) => [...(cache.get(t) as number[])]);
  }
}

/** Runs every query of `set` against its memories and scores what came back. */
export async function runRecall(
  set: RecallSet,
  options: RecallOptions = {},
): Promise<RecallResult> {
  if (options.target === "notes") return runNotesRecall(set, options);
  const config = memoryConfig(options.config ?? {});
  const ks = [...(options.ks ?? DEFAULT_KS)];
  const limit = Math.max(config.recall_limit, ...ks);
  const embedder =
    options.embedder === undefined || !options.embedder.enabled
      ? null
      : options.embedder instanceof CachedEmbedder
        ? options.embedder
        : new CachedEmbedder(options.embedder);
  const failuresBefore = embedder?.failures ?? 0;
  const engineOptions = embedder === null ? {} : { embedder };

  const store = await SqliteStore.open(":memory:", { plugins: [memoryTables] });
  try {
    const tables = store.plugin(memoryTables);
    // The first engine tells the tables which model makes the vectors, before any is stored.
    const newEngine = () => new MemoryEngine(PROFILE, config, tables, engineOptions);
    newEngine();

    const vectors = new Map<string, number[]>();
    if (embedder !== null) {
      for (let i = 0; i < set.memories.length; i += EMBED_BATCH) {
        const batch = set.memories.slice(i, i + EMBED_BATCH);
        const made = await embedder.embed(
          batch.map((m) => m.content),
          options.signal,
        );
        batch.forEach((m, n) => {
          vectors.set(m.id, made[n] as number[]);
        });
      }
    }
    for (const memory of set.memories) {
      const at = iso(memory.at);
      const record: MemoryRecord = {
        id: memory.id,
        profile: PROFILE,
        kind: memory.kind,
        scope: memory.scope,
        subjects: [...new Set(memory.subjects)].sort(),
        content: memory.content,
        tokens: tokenString(memory.content),
        embedding: vectors.get(memory.id) ?? null,
        importance: memory.importance,
        confidence: memory.confidence,
        created_at: at,
        updated_at: at,
        last_accessed: null,
        access_count: 0,
        source_context: null,
        source: null,
        origin: "experienced",
        source_events: [],
        due: null,
        done: false,
        superseded_by: memory.superseded_by,
      };
      await tables.upsert(record);
    }

    const returned = new Map<string, Returned[]>();
    for (const query of set.queries) {
      const scopes = visibleScopes(query.place.context, query.place.accounts, query.people);
      const recalled = await newEngine().recall(
        scopes,
        query.people,
        query.text,
        PROMPT_KINDS,
        limit,
        iso(query.at),
        options.signal,
        turnOf(query.context, query.talking_with ?? query.people),
      );
      returned.set(
        query.id,
        recalled.map(({ record, score }) => ({ id: record.id, score })),
      );
    }

    return {
      set: set.name,
      target: "records",
      memories: set.memories.length,
      embedder: embedder === null ? null : (embedder.embeddingModel ?? embedder.name),
      embedding_failures: embedder === null ? 0 : embedder.failures - failuresBefore,
      limit,
      config: {
        min_score: config.min_score,
        min_vector: config.min_vector,
        recall_limit: config.recall_limit,
        weights: { ...config.weights },
      },
      ...scoreRecall(set, returned, ks),
    };
  } finally {
    await store.close();
  }
}

/** One setting of a sweep. */
export interface SweepVariant {
  name: string;
  config: RecallConfigOverrides;
}

export interface SweepRow {
  name: string;
  recall_at: Record<string, number> | null;
  mrr: number | null;
  nothing_returned_rate: number | null;
  nothing_mean_returned: number | null;
  leaks: number;
  /** The notes: lines the prompt's block would show for the "nothing to recall" queries. */
  block_nothing_mean_returned?: number | null;
}

/**
 * The same set under several configs (each variant's overrides on top of `options.config`), one
 * row per variant. Texts are embedded once for the whole sweep.
 */
export async function sweepRecall(
  set: RecallSet,
  variants: readonly SweepVariant[],
  options: RecallOptions = {},
): Promise<SweepRow[]> {
  const embedder =
    options.embedder === undefined ? undefined : new CachedEmbedder(options.embedder);
  const rows: SweepRow[] = [];
  for (const variant of variants) {
    const base = options.config ?? {};
    const result = await runRecall(set, {
      ...options,
      ...(embedder ? { embedder } : {}),
      config: {
        ...base,
        ...variant.config,
        weights: { ...base.weights, ...variant.config.weights },
      },
    });
    rows.push({
      name: variant.name,
      recall_at: result.recall_at,
      mrr: result.mrr,
      nothing_returned_rate: result.nothing_returned_rate,
      nothing_mean_returned: result.nothing_mean_returned,
      leaks: result.leaks,
      ...(result.block ? { block_nothing_mean_returned: result.block.nothing_mean_returned } : {}),
    });
  }
  return rows;
}
