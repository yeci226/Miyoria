// Which model made a stored vector (`memory_records.embedding_model`, migration 2): a vector of
// another model is missing for every read, search never compares it, and the backfill makes it
// again with the model in use.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type MemoryRecord, SqliteStore } from "@miyoria/store";
import { newId, type ProfileId, toTimestamp } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { type Embedder, MemoryEngine, memoryConfig } from "../src/index.js";
import { embeddingValues } from "../src/stored.js";
import { type MemoryTables, memoryTables } from "../src/tables.js";
import { closeAll, openAreas, profile, t0 } from "./helpers.js";

const P = "p" as ProfileId;

function record(embedding: number[] | null, content = "x"): MemoryRecord {
  const now = toTimestamp(Date.UTC(2026, 9, 1));
  return {
    id: newId(),
    profile: P,
    kind: "fact",
    scope: { type: "global" },
    subjects: [],
    content,
    tokens: content,
    embedding,
    importance: 0.5,
    confidence: 1,
    created_at: now,
    updated_at: now,
    last_accessed: null,
    access_count: 0,
    source_context: null,
    source: null,
    origin: "experienced",
    source_events: [],
    due: null,
    done: false,
    superseded_by: null,
  };
}

async function nearest(tables: MemoryTables, embedding: number[]): Promise<string[]> {
  const hits = await tables.search({
    profile: P,
    scopes: [{ type: "global" }],
    kinds: null,
    tokens: [],
    embedding,
    limit: 5,
  });
  return hits.filter((h) => h.vector_score !== null).map((h) => h.record.id);
}

function withFile<T>(fn: (path: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "miyoria-embedding-model-"));
  return fn(join(dir, "memory.db")).finally(() =>
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 }),
  );
}

afterEach(closeAll);

describe("the embedding model of a stored vector", () => {
  it("is recorded, and a vector of another model is missing for reads and search", async () => {
    const store = await SqliteStore.open(":memory:", { plugins: [memoryTables] });
    try {
      const tables = store.plugin(memoryTables).useEmbeddingModel("model-a");
      const a = record([1, 0]);
      await tables.upsert(a);
      expect(await nearest(tables, [1, 0])).toEqual([a.id]);
      expect(embeddingValues((await tables.get(a.id)) as MemoryRecord)).not.toBeNull();
      expect(await tables.missingEmbeddings(P, 10)).toEqual([]);

      // Another model of the same size: never compared, read back without a vector, and listed
      // for the backfill.
      tables.useEmbeddingModel("model-b");
      expect(await nearest(tables, [1, 0])).toEqual([]);
      expect((await tables.get(a.id))?.embedding).toBeNull();
      expect((await tables.missingEmbeddings(P, 10)).map((r) => r.id)).toEqual([a.id]);

      // Embedded again: recorded with model b, found again, nothing missing.
      await tables.upsert({ ...((await tables.get(a.id)) as MemoryRecord), embedding: [0.9, 0.1] });
      expect(await nearest(tables, [1, 0])).toEqual([a.id]);
      expect(await tables.missingEmbeddings(P, 10)).toEqual([]);
      // And now missing for model a.
      tables.useEmbeddingModel("model-a");
      expect(await nearest(tables, [1, 0])).toEqual([]);
    } finally {
      await store.close();
    }
  });

  it("is kept by a writer that does not know it when the vector is unchanged", async () => {
    const store = await SqliteStore.open(":memory:", { plugins: [memoryTables] });
    try {
      const tables = store.plugin(memoryTables).useEmbeddingModel("model-a");
      const a = record([1, 0]);
      await tables.upsert(a);
      // Unknown model (no embedder): every vector counts, and rewriting a record (here its
      // importance) keeps the label its vector had.
      tables.useEmbeddingModel(null);
      const read = (await tables.get(a.id)) as MemoryRecord;
      expect(embeddingValues(read)).not.toBeNull();
      await tables.upsert({ ...read, importance: 0.9 });
      // A new vector written without a model is unlabelled: missing once a model is in use.
      const b = record([0, 1]);
      await tables.upsert(b);
      tables.useEmbeddingModel("model-a");
      expect(await nearest(tables, [1, 0])).toEqual([a.id]);
      expect((await tables.missingEmbeddings(P, 10)).map((r) => r.id)).toEqual([b.id]);
    } finally {
      await store.close();
    }
  });

  it("invalidates the decoded vectors when only the label changes", () =>
    withFile(async (path) => {
      const store = await SqliteStore.open(path, { plugins: [memoryTables] });
      try {
        const tables = store.plugin(memoryTables).useEmbeddingModel("model-a");
        const a = record([1, 0]);
        await tables.upsert(a);
        expect(await nearest(tables, [1, 0])).toEqual([a.id]);
        const raw = new DatabaseSync(path);
        raw.prepare("UPDATE memory_records SET embedding_model = 'model-b' WHERE id = ?").run(a.id);
        raw.close();
        expect(await nearest(tables, [1, 0])).toEqual([]);
      } finally {
        await store.close();
      }
    }));
});

/** Gives every text the same vector; says which model it is. */
class Fixed implements Embedder {
  readonly name = "fixed";
  readonly enabled = true;
  calls = 0;

  constructor(
    readonly embeddingModel: string,
    readonly vector: number[],
  ) {}

  async embed(texts: readonly string[]): Promise<number[][]> {
    this.calls += texts.length;
    return texts.map(() => [...this.vector]);
  }
}

describe("a change of embedding model", () => {
  it("treats the old vectors as missing in recall and lets the backfill embed them again", async () => {
    const areas = await openAreas("sqlite");
    const config = memoryConfig({ min_vector: 0.5 });
    const old = new MemoryEngine(profile(), config, areas.memories, {
      embedder: new Fixed("model-a", [1, 0]),
    });
    const stored = await old.store(
      {
        kind: "self_note",
        scope: { type: "global" },
        subjects: [],
        content: "她喜歡下雨天",
        importance: 0.5,
        confidence: 0.8,
        source_context: null,
        source: null,
        origin: "experienced",
        source_events: [],
        due: null,
      },
      t0(),
    );
    expect(stored.type).toBe("inserted");
    const scopes = [{ type: "global" as const }];
    // No shared word: only the vector can bring it up.
    const ask = (engine: MemoryEngine) =>
      engine
        .search(scopes, "天氣", ["self_note"], 5, t0())
        .then((r) => r.map((x) => x.vector_score));
    expect(await ask(old)).toEqual([1]);

    // The same size, another model: the old vector is not compared.
    const embedder = new Fixed("model-b", [1, 0]);
    const next = new MemoryEngine(profile(), config, areas.memories, { embedder });
    expect(await ask(next)).toEqual([]);
    expect(await next.backfillEmbeddings(10)).toBe(1);
    expect(embedder.calls).toBe(2);
    expect(await ask(next)).toEqual([1]);
    expect(await next.backfillEmbeddings(10)).toBe(0);
  });
});
