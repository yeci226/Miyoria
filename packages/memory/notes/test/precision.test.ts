// The three precision rules of a notes search (`precision.ts`).

import { describe, expect, it } from "vitest";
import { DEFAULT_PRECISION, keptHits, type Precision, precise, separated } from "../src/index.js";

const P: Precision = { min_score: 0.3, vector_alone_margin: 0.1, gap_rank: 5, min_gap: 0.05 };
const MIN_VECTOR = 0.5;
const hit = (score: number, text: number, cosine: number | null = null) => ({
  score,
  text,
  cosine,
});

describe("precision", () => {
  it("has the config's defaults", () => {
    expect(DEFAULT_PRECISION).toMatchObject(P);
  });

  it("returns nothing below the floor", () => {
    expect(keptHits([hit(0.29, 1), hit(0.31, 1)], P, MIN_VECTOR).map((h) => h.score)).toEqual([
      0.31,
    ]);
    expect(precise([hit(0.2, 1), hit(0.1, 0.5)], P, MIN_VECTOR)).toEqual({
      hits: [],
      weak: false,
    });
  });

  it("asks a line close only in meaning for more than one that shares a word", () => {
    // 0.55 passes `min_vector` (0.5) but not `min_vector + margin` (0.6) without a shared word.
    expect(keptHits([hit(0.5, 0, 0.55)], P, MIN_VECTOR)).toEqual([]);
    expect(keptHits([hit(0.5, 0, 0.61)], P, MIN_VECTOR)).toHaveLength(1);
    // With a shared word the same cosine is enough, and so is none at all.
    expect(keptHits([hit(0.5, 0.2, 0.55)], P, MIN_VECTOR)).toHaveLength(1);
    expect(keptHits([hit(0.5, 0.2, null)], P, MIN_VECTOR)).toHaveLength(1);
  });

  it("calls hits weak when the best is not clearly ahead of the fifth", () => {
    const flat = [0.5, 0.49, 0.48, 0.48, 0.47, 0.4].map((s) => hit(s, 0.5));
    expect(separated(flat, P)).toBe(false);
    expect(precise(flat, P, MIN_VECTOR).weak).toBe(true);
    const clear = [0.7, 0.5, 0.48, 0.48, 0.47].map((s) => hit(s, 0.5));
    expect(separated(clear, P)).toBe(true);
    expect(precise(clear, P, MIN_VECTOR)).toMatchObject({ weak: false });
  });

  it("compares with the floor when fewer than the rank came back", () => {
    expect(separated([hit(0.32, 1)], P)).toBe(false);
    expect(separated([hit(0.4, 1), hit(0.33, 1)], P)).toBe(true);
    expect(separated([], P)).toBe(false);
  });
});
