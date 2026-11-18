// The dex (圖鑑, docs/design/cards.md §7.2, v5-play.md §2): what a person has collected is parts,
// not cards. A series is complete when they have every part of it a bought card can give (enabled,
// not blank, not drop-only); completing it earns its title, once, kept even if the series later
// grows. One page per person, theirs alone by default, never ranked against anyone.

import { type Part, SERIES } from "./catalogue.js";

/** The parts of a series that count toward completing it. */
export function seriesParts(catalogue: readonly Part[], series: string): Part[] {
  return catalogue.filter((p) => p.series === series && p.enabled && !p.blank && !p.drop_only);
}

/** How far a person is with one series. */
export interface SeriesProgress {
  id: string;
  name: string;
  title: string;
  /** Parts of it they have. */
  owned: number;
  /** Parts it has. */
  total: number;
  complete: boolean;
}

/** Every series of the catalogue (one with no parts left out) and how far `owned` is with it. */
export function seriesProgress(
  catalogue: readonly Part[],
  owned: ReadonlySet<string>,
): SeriesProgress[] {
  const out: SeriesProgress[] = [];
  for (const s of SERIES) {
    const parts = seriesParts(catalogue, s.id);
    if (parts.length === 0) continue;
    const have = parts.filter((p) => owned.has(p.id)).length;
    out.push({
      id: s.id,
      name: s.name,
      title: s.title,
      owned: have,
      total: parts.length,
      complete: have === parts.length,
    });
  }
  return out;
}

/** The series `owned` completes that `before` did not. */
export function completedBy(
  catalogue: readonly Part[],
  before: ReadonlySet<string>,
  owned: ReadonlySet<string>,
): SeriesProgress[] {
  const was = new Set(
    seriesProgress(catalogue, before)
      .filter((s) => s.complete)
      .map((s) => s.id),
  );
  return seriesProgress(catalogue, owned).filter((s) => s.complete && !was.has(s.id));
}

/** At most this many parts on a wishlist (v5-play.md §6.3). */
export const MAX_WISHES = 3;

export type WishlistProblem = "too_many" | "duplicate" | "unknown_part";

/**
 * Whether a part can be wished for: one a card can give now and the dex collects (not blank, not
 * disabled). A drop-only part can: the design lets anyone wish for any part, and wishing changes
 * no odds (v5-play.md §6.3); she only says so when a drop brings it.
 */
export function isWishable(part: Pick<Part, "blank" | "enabled">): boolean {
  return !part.blank && part.enabled;
}

/**
 * Why `ids` cannot be a wishlist, or `null` when it can: at most `MAX_WISHES`, each once, each a
 * part of the catalogue that is wishable (`isWishable`). Wishing changes no odds.
 */
export function wishlistProblem(
  catalogue: readonly Part[],
  ids: readonly string[],
): WishlistProblem | null {
  if (ids.length > MAX_WISHES) return "too_many";
  if (new Set(ids).size !== ids.length) return "duplicate";
  const known = new Set(catalogue.filter(isWishable).map((p) => p.id));
  if (ids.some((id) => !known.has(id))) return "unknown_part";
  return null;
}
