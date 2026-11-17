// Scoring of what came back: recall@k, MRR, the "nothing to recall" queries and scope leaks.
//
// Nothing here calls the memory engine. `visibleAt` decides from the set alone whether a memory
// may be seen where a query happens, so a leak is counted even when the engine's own filter is
// the thing that is wrong.

import type { RecallMemory, RecallQuery, RecallScope, RecallSet } from "./set.js";

export const DEFAULT_KS: readonly number[] = [1, 3, 5, 8];

/** One memory that came back for a query. */
export interface Returned {
  id: string;
  score: number;
}

/** What one query got (ids only, never content). */
export interface QueryResult {
  id: string;
  relevant: string[];
  /** Ranked, best first. */
  returned: Returned[];
  /** Share of `relevant` in the top k, by k; `null` for a "nothing to recall" query. */
  recall_at: Record<string, number> | null;
  /** 1 / rank of the first relevant memory, 0 when none came back; `null` as above. */
  reciprocal_rank: number | null;
  /** Returned memories the query's place cannot see, superseded ones and ids not in the set. */
  leaks: string[];
}

export interface RecallMetrics {
  ks: number[];
  queries: number;
  /** Queries that expect something. */
  with_relevant: number;
  /** Queries that expect nothing. */
  nothing: number;
  /** Mean recall@k over the queries that expect something, by k; `null` when there are none. */
  recall_at: Record<string, number> | null;
  mrr: number | null;
  /** Share of the "nothing to recall" queries that got nothing; `null` when there are none. */
  nothing_returned_rate: number | null;
  /** Mean number of memories those queries got. */
  nothing_mean_returned: number | null;
  /** Returned memories that should not have been visible, over every query. Must be 0. */
  leaks: number;
  per_query: QueryResult[];
}

type Context = RecallQuery["place"]["context"];

function sameContext(a: Context, b: Context): boolean {
  return (
    a.platform === b.platform && a.scope === b.scope && a.channel === b.channel && a.kind === b.kind
  );
}

/**
 * Whether a memory in `scope` may be seen in a turn at `place` with `people` present: `global`
 * anywhere, `guild` in that guild, `channel` in exactly that context, `dm` only in a private
 * place with that account in it, `person` where the person is.
 */
export function visibleAt(
  scope: RecallScope,
  place: RecallQuery["place"],
  people: readonly string[],
): boolean {
  const here = place.context;
  switch (scope.type) {
    case "global":
      return true;
    case "guild":
      return here.scope !== null && here.platform === scope.platform && here.scope === scope.guild;
    case "channel":
      return sameContext(scope.context, here);
    case "dm":
      return (
        (here.kind === "dm" || here.scope === null) &&
        place.accounts.some(
          (a) => a.platform === scope.account.platform && a.id === scope.account.id,
        )
      );
    case "person":
      return people.includes(scope.person);
  }
}

/** The returned ids that must not have come back for `query`. */
export function leaksOf(
  query: RecallQuery,
  returned: readonly Returned[],
  memories: ReadonlyMap<string, RecallMemory>,
): string[] {
  return returned
    .filter(({ id }) => {
      const memory = memories.get(id);
      if (memory === undefined || memory.superseded_by !== null) return true;
      return !visibleAt(memory.scope, query.place, query.people);
    })
    .map((r) => r.id);
}

const mean = (xs: readonly number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

/** Scores `returned` (query id to its ranked memories; a missing query got nothing). */
export function scoreRecall(
  set: RecallSet,
  returned: ReadonlyMap<string, readonly Returned[]>,
  ks: readonly number[] = DEFAULT_KS,
): RecallMetrics {
  const memories = new Map(set.memories.map((m) => [m.id, m]));
  const per_query: QueryResult[] = set.queries.map((query) => {
    const got = [...(returned.get(query.id) ?? [])];
    const relevant = new Set(query.relevant);
    const base = {
      id: query.id,
      relevant: [...query.relevant],
      returned: got.map(({ id, score }) => ({ id, score })),
      leaks: leaksOf(query, got, memories),
    };
    if (relevant.size === 0) return { ...base, recall_at: null, reciprocal_rank: null };
    const recall_at: Record<string, number> = {};
    for (const k of ks) {
      const found = got.slice(0, k).filter((r) => relevant.has(r.id)).length;
      recall_at[String(k)] = found / relevant.size;
    }
    const first = got.findIndex((r) => relevant.has(r.id));
    return { ...base, recall_at, reciprocal_rank: first === -1 ? 0 : 1 / (first + 1) };
  });

  const expecting = per_query.filter((q) => q.recall_at !== null);
  const nothing = per_query.filter((q) => q.recall_at === null);
  let recall_at: Record<string, number> | null = null;
  if (expecting.length > 0) {
    recall_at = {};
    for (const k of ks) {
      recall_at[String(k)] = mean(expecting.map((q) => q.recall_at?.[String(k)] ?? 0)) ?? 0;
    }
  }
  return {
    ks: [...ks],
    queries: per_query.length,
    with_relevant: expecting.length,
    nothing: nothing.length,
    recall_at,
    mrr: mean(expecting.map((q) => q.reciprocal_rank ?? 0)),
    nothing_returned_rate: mean(nothing.map((q) => (q.returned.length === 0 ? 1 : 0))),
    nothing_mean_returned: mean(nothing.map((q) => q.returned.length)),
    leaks: per_query.reduce((n, q) => n + q.leaks.length, 0),
    per_query,
  };
}
