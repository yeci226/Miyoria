// How sure a search of her notes has to be before its lines are read back (`recall`, block 6 of a
// prompt). The eval's "nothing to recall" questions (v5-brain.md, B1) all brought something back:
// the ranking always has a best line, and a hybrid score spread over the candidates makes the best
// of unrelated lines look as good as the best of related ones. Three rules, in this order:
//
// 1. A floor (`min_score`): a line scoring below it is not returned at all.
// 2. Meaning alone needs more (`vector_alone_margin`): a line that shares no word with the query
//    must be at least `min_vector + vector_alone_margin` close to it by cosine; one that shares a
//    word only has to pass the floor. Without vectors every hit shares a word, and this rule does
//    nothing.
// 3. Separation (`gap_rank`, `min_gap`): when the best line is not clearly ahead of the line at
//    rank `gap_rank` (or of the floor, when fewer came back), nothing stands out and the hits are
//    weak. The prompt's block treats weak as nothing found; the `recall` tool returns them, marked.

import { NotesRecallConfigSchema } from "../../memory/src/config.js";
import type { LineHit } from "./store.js";

/** `[modules.memory.notes_recall]`. */
export interface Precision {
  min_score: number;
  vector_alone_margin: number;
  gap_rank: number;
  min_gap: number;
}

/** The defaults of `[modules.memory.notes_recall]`. */
export const DEFAULT_PRECISION: Precision = NotesRecallConfigSchema.parse({});

/** Rules 1 and 2: the hits that may be returned at all, in their order. */
export function keptHits<T extends Pick<LineHit, "score" | "text" | "cosine">>(
  hits: readonly T[],
  precision: Precision,
  minVector: number,
): T[] {
  const alone = minVector + precision.vector_alone_margin;
  return hits.filter(
    (h) => h.score >= precision.min_score && (h.text > 0 || (h.cosine ?? 0) >= alone),
  );
}

/**
 * Rule 3: whether the best of `hits` (any order) stands out from the one at rank `gap_rank`, or
 * from the floor when fewer came back. `false` for no hits.
 */
export function separated(hits: readonly Pick<LineHit, "score">[], precision: Precision): boolean {
  if (hits.length === 0) return false;
  const scores = hits.map((h) => h.score).sort((a, b) => b - a);
  const best = scores[0] as number;
  const rank = Math.max(2, Math.floor(precision.gap_rank));
  const against = scores[rank - 1] ?? precision.min_score;
  return best - against >= precision.min_gap;
}

/** All three rules: the hits kept, and whether they are weak (rule 3). */
export function precise<T extends Pick<LineHit, "score" | "text" | "cosine">>(
  hits: readonly T[],
  precision: Precision,
  minVector: number,
): { hits: T[]; weak: boolean } {
  const kept = keptHits(hits, precision, minVector);
  return { hits: kept, weak: kept.length > 0 && !separated(kept, precision) };
}
