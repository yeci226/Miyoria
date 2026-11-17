// The bond's scale, the ring and the member's words for it, with no imports: the narrow entry
// `@miyoria/types/bond` that the card's drawing (`@miyoria/card-face`, in the panel's browser
// bundle) reads, so it takes nothing else of `@miyoria/types` with it. `affect.ts` re-exports all
// of it; the ladder of tier names stays there.

/** Lowest and highest bond (and `affinityLevel()`): past 100 is bond (羈絆) stacking. */
export const AFFINITY_MIN = -100;
export const AFFINITY_MAX = 1000;

/** `affinity` kept inside -100..1000 (a non-finite value is 0). */
export function clampAffinity(affinity: number): number {
  if (!Number.isFinite(affinity)) return 0;
  return Math.min(Math.max(affinity, AFFINITY_MIN), AFFINITY_MAX);
}

/** Bond per lap of the ring (H1): one lap per 100, ten laps to 1000. */
export const RING_LAP = 100;
export const RING_LAPS = 10;

/** Where a bond is on the ring (H1). */
export interface RingPosition {
  /** The lap being drawn, 0..9: lap 0 is the outermost ring. */
  lap: number;
  /** 0..1 of that lap. At 1000 it is lap 9, full. */
  fraction: number;
  /** For a bond below 0, how far below (0..1 of the way to -100); 0 otherwise. */
  below: number;
}

/** The ring position of `bond`: `floor(bond / 100)` laps done, capped at the tenth. */
export function ringOf(bond: number): RingPosition {
  const b = clampAffinity(bond);
  if (b < 0) return { lap: 0, fraction: 0, below: Math.min(-b / -AFFINITY_MIN, 1) };
  const lap = Math.min(Math.floor(b / RING_LAP), RING_LAPS - 1);
  const fraction = Math.min((b - lap * RING_LAP) / RING_LAP, 1);
  return { lap, fraction, below: 0 };
}

/**
 * The words a member sees for their bond, never the number (§17.1, H2), from the bottom of the
 * scale to 1000: `[lowest bond, words]`, highest first. Below 120 they are the six bands the
 * member page has always shown.
 */
export const BOND_BANDS: readonly (readonly [number, string])[] = [
  [1000, "永恆的羈絆"],
  [750, "無可取代"],
  [450, "像家人一樣"],
  [240, "心意相通"],
  [120, "很親近"],
  [75, "非常好"],
  [45, "很好"],
  [15, "不錯"],
];

/** Every word `bondBand` can return, lowest first (the card's meter has a step for each). */
export const BOND_BAND_WORDS: readonly string[] = [
  "很差",
  "不太好",
  "普通",
  ...[...BOND_BANDS].reverse().map(([, words]) => words),
];

/** The member-facing words for `bond` (`BOND_BANDS`; at or below -15 and below 15 as before). */
export function bondBand(bond: number): string {
  const b = clampAffinity(bond);
  if (b <= -50) return "很差";
  if (b <= -15) return "不太好";
  for (const [min, words] of BOND_BANDS) if (b >= min) return words;
  return "普通";
}
