// How the lines of her documents are ranked against a search once they and the query have vectors
// (`vectors.ts`): the combination the memory records use (`memory/src/score.ts`), so words and
// meaning weigh the same in both stores.
//
// - Candidates: the lines sharing a word with the query, and the `candidate_limit` lines nearest
//   to it by cosine (the "nearest neighbours" of the records' vector search).
// - Signals, each 0..1: `text` the share of the query's words the line holds; `vector` the cosine
//   spread over the candidates (`spreadCosine`, from `min_vector` up to the best one); `recency` of
//   the line's last change (`recency_tau_days`); `importance` the line's confidence; `subject` 1
//   when the document is about someone present. The score is `signalScore` with `weights`.
// - A line that shares no word with the query has to be at least `min_vector` close to it, as a
//   recalled record must (being one of the nearest neighbours of an unrelated query is no match).
//
// Without a query vector nothing here runs: the store's keyword search is what it always was.

import type { Timestamp } from "@miyoria/types";
import { type MemoryConfig, memoryConfig, type Weights } from "../../memory/src/config.js";
import { cosine } from "../../memory/src/embed.js";
import { recency, signalScore, spreadCosine } from "../../memory/src/score.js";
import type { NotesLineRow } from "./schema.js";

/** A query's vector and the model that made it (only vectors of that model are compared). */
export interface QueryVector {
  values: readonly number[];
  model: string;
}

/** What a hybrid ranking reads of `[modules.memory]`. */
export interface Ranking {
  min_vector: number;
  weights: Weights;
  recency_tau_days: number;
  /** Lines nearest to the query by cosine that are candidates without a shared word. */
  candidate_limit: number;
  /** `searchLines`: lines scoring below it are left out; `null`: none are. */
  min_score: number | null;
}

/** The ranking of `config`; `min_score` only where a caller wants recall's cut (the eval). */
export function rankingOf(config: MemoryConfig, minScore: number | null = null): Ranking {
  return {
    min_vector: config.min_vector,
    weights: { ...config.weights },
    recency_tau_days: config.recency_tau_days,
    candidate_limit: config.candidate_limit,
    min_score: minScore,
  };
}

/** The ranking of the default `[modules.memory]`. */
export const DEFAULT_RANKING: Ranking = rankingOf(memoryConfig());

/** What ranking reads of a line: a stored row, or a `NoteLine`. */
export type RankRow = Pick<
  NotesLineRow,
  "id" | "document_id" | "text" | "confidence" | "updated_at"
>;

/** A line scored against a query. */
export interface RankedLine<T extends RankRow = NotesLineRow> {
  row: T;
  /** Query words it holds. */
  hits: number;
  /** 0..1: the share of the query's words it holds. */
  text: number;
  /** The raw cosine; `null`: it has no vector of the query's model. */
  cosine: number | null;
  /** 0..1: the cosine spread over the candidates. */
  vector: number;
  score: number;
}

export interface RankInput<T extends RankRow> {
  /** The query's words (`tokenize`). */
  words: readonly string[];
  /** The words of a row's text (`tokenize`). */
  wordsOf: (row: T) => ReadonlySet<string>;
  vector: QueryVector;
  /** The stored vectors of `vector.model`, by line id. */
  vectors: ReadonlyMap<string, ArrayLike<number>>;
  /** Whether the document of a line is about someone present. */
  aboutPresent: (row: T) => boolean;
  ranking: Ranking;
  now: Timestamp;
}

/**
 * The candidates among `rows` (see the file comment), scored; the ones that are no match left out.
 * Not sorted.
 */
export function rankLines<T extends RankRow>(
  rows: readonly T[],
  input: RankInput<T>,
): RankedLine<T>[] {
  const { words, ranking } = input;
  const cosines = new Map<string, number>();
  for (const row of rows) {
    const v = input.vectors.get(row.id);
    if (v !== undefined) cosines.set(row.id, cosine(input.vector.values, v));
  }
  const nearest = new Set(
    [...cosines.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(0, ranking.candidate_limit))
      .map(([id]) => id),
  );
  const candidates = rows.flatMap((row) => {
    const have = input.wordsOf(row);
    const hits = words.filter((w) => have.has(w)).length;
    if (hits === 0 && !nearest.has(row.id)) return [];
    return [{ row, hits, cosine: cosines.get(row.id) ?? null }];
  });
  const spread = spreadCosine(
    candidates.map((c) => [c.cosine, nearest.has(c.row.id)] as const),
    ranking.min_vector,
  );
  const out: RankedLine<T>[] = [];
  for (const c of candidates) {
    const text = words.length === 0 ? 0 : c.hits / words.length;
    if (text <= 0 && (c.cosine ?? 0) < ranking.min_vector) continue;
    const vector = c.cosine === null ? 0 : spread(c.cosine);
    const score = signalScore(
      {
        vector,
        text,
        recency: recency(c.row.updated_at, input.now, ranking.recency_tau_days),
        importance: Math.min(1, Math.max(0, c.row.confidence)),
        subject: input.aboutPresent(c.row) ? 1 : 0,
      },
      ranking.weights,
    );
    out.push({ row: c.row, hits: c.hits, text, cosine: c.cosine, vector, score });
  }
  return out;
}
