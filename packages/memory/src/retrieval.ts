// The retrieval interface the main line calls (docs/design/v3-architecture.md §11): derived
// memory, found by one hybrid pass over the scopes that may be shown, never by a model and
// never by following links between memories.

import type {
  MemoryRetrieval,
  RetrievalQuery,
  RetrievedKind,
  RetrievedMemory,
  Timestamp,
} from "@miyoria/types";
import { lineOf, PROMPT_KINDS } from "./contributor.js";
import type { MemoryEngine } from "./engine.js";
import { visibleScopes } from "./scope.js";
import { effectiveConfidence } from "./score.js";

export class MemoryRetriever implements MemoryRetrieval {
  readonly #engine: MemoryEngine;

  constructor(engine: MemoryEngine) {
    this.#engine = engine;
  }

  async retrieve(query: RetrievalQuery, signal?: AbortSignal): Promise<RetrievedMemory[]> {
    const engine = this.#engine;
    const scopes = visibleScopes(query.context, query.accounts ?? [], query.present);
    const recalled = await engine.recall(
      scopes,
      query.present,
      query.text,
      PROMPT_KINDS,
      query.limit ?? engine.config.recall_limit,
      query.now,
      signal,
    );
    return recalled.map(({ record, score }) => ({
      id: record.id,
      kind: record.kind as RetrievedKind,
      origin: record.origin ?? (record.source !== null ? "told" : "unknown"),
      content: record.content,
      said_by: record.source?.name ?? null,
      source_events: [...(record.source_events ?? [])],
      created_at: record.created_at,
      score,
      confidence: effectiveConfidence(engine.config, record, query.now),
    }));
  }

  format(memories: readonly RetrievedMemory[], now: Timestamp): string {
    return memories.map((m) => lineOf(m, now)).join("\n");
  }
}
