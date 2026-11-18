// The public odds table: every column sums to 100, and it says what the draw does (a seeded run of
// the draw lands on its numbers).

import { describe, expect, it } from "vitest";
import {
  cardsConfig,
  drawCard,
  drawRules,
  oddsTable,
  SEED_PARTS,
  seededRandom,
  shownPercents,
} from "../src/index.js";

const rules = drawRules(cardsConfig());
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const shownSum = (xs: readonly string[]) => sum(xs.map((s) => Math.round(Number(s) * 100)));

describe("the odds table", () => {
  const table = oddsTable(SEED_PARTS, rules);

  it("prints the rarities, summing to 100", () => {
    expect(table.rarities.map((r) => [r.rarity, r.shown])).toEqual([
      ["N", "70.00"],
      ["R", "22.00"],
      ["SR", "7.00"],
      ["SSR", "1.00"],
    ]);
    expect(sum(table.rarities.map((r) => r.percent))).toBeCloseTo(100, 9);
  });

  it("names each part's series, and nothing for a part without one", () => {
    const parts = table.slots.flatMap((s) => s.parts);
    expect(parts.find((p) => p.id === "accessory.glasses")).toMatchObject({
      series: "glasses",
      series_name: "眼鏡系列",
    });
    expect(parts.find((p) => p.id === "accessory.none")).toMatchObject({
      series: null,
      series_name: null,
    });
  });

  it("prints the pity's rarities, summing to 100", () => {
    expect(table.pity?.after).toBe(20);
    expect(table.pity?.rarities.map((r) => [r.rarity, r.shown])).toEqual([
      ["SR", "87.50"],
      ["SSR", "12.50"],
    ]);
  });

  it("sums each slot to 100, exactly and as printed", () => {
    expect(table.slots.map((s) => s.slot)).toEqual([
      "hand",
      "accessory",
      "outfit",
      "pose",
      "background",
    ]);
    for (const slot of table.slots) {
      const exact = [...slot.parts.map((p) => p.percent), slot.empty?.percent ?? 0];
      expect(sum(exact)).toBeCloseTo(100, 9);
      const shown = [...slot.parts.map((p) => p.shown), ...(slot.empty ? [slot.empty.shown] : [])];
      expect(shownSum(shown)).toBe(10_000);
    }
  });

  it("lists no drop-only part and no disabled one", () => {
    const ids = table.slots.flatMap((s) => s.parts.map((p) => p.id));
    expect(ids).not.toContain("background.fireworks");
    // 短裙 is off (migration 9): nobody draws it, so the table does not print it.
    expect(ids).not.toContain("outfit.short_skirt");
    expect(ids).toHaveLength(SEED_PARTS.filter((p) => p.enabled && !p.drop_only).length);
    expect(table.slots.find((s) => s.slot === "outfit")?.parts.map((p) => p.id)).toEqual([
      "outfit.usual",
      "outfit.long_skirt",
      "outfit.shoes",
      "outfit.top",
    ]);
  });

  it("agrees with a seeded run of the draw", () => {
    const runs = 200_000;
    const random = seededRandom(1117);
    const seen = new Map<string, number>();
    for (let i = 0; i < runs; i++) {
      const card = drawCard({ catalogue: SEED_PARTS, rules, since: 0, tier: "朋友", random });
      for (const p of card.parts) seen.set(p.id, (seen.get(p.id) ?? 0) + 1);
    }
    expect(seen.get("outfit.short_skirt") ?? 0).toBe(0);
    for (const slot of table.slots) {
      for (const part of slot.parts) {
        const p = part.percent / 100;
        const tolerance = 4.5 * Math.sqrt((p * (1 - p)) / runs);
        expect(Math.abs((seen.get(part.id) ?? 0) / runs - p), part.id).toBeLessThan(tolerance);
      }
    }
    // Two hundred thousand draws: a slow machine needs more than the default five seconds.
  }, 30_000);

  it("follows the weights of the config", () => {
    const flat = oddsTable(SEED_PARTS, { ...rules, weights: { N: 1, R: 1, SR: 1, SSR: 1 } });
    expect(flat.rarities.map((r) => r.shown)).toEqual(["25.00", "25.00", "25.00", "25.00"]);
    const noSsr = oddsTable(
      SEED_PARTS.filter((p) => p.rarity !== "SSR"),
      rules,
    );
    expect(noSsr.rarities.map((r) => r.rarity)).toEqual(["N", "R", "SR"]);
    expect(noSsr.pity?.rarities.map((r) => r.shown)).toEqual(["100.00"]);
  });
});

describe("shownPercents", () => {
  it("rounds so the column sums to exactly 100.00", () => {
    const thirds = shownPercents([100 / 3, 100 / 3, 100 / 3]);
    expect(thirds).toEqual(["33.34", "33.33", "33.33"]);
    expect(shownSum(shownPercents([12.345, 45.678, 41.977]))).toBe(10_000);
  });
});
