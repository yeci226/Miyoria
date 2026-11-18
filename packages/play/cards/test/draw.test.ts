// The draw: the rarity distribution over a seeded run, a card's rarity is its rarest part's, the
// pity, drop-only parts, and the expression decided by the relationship, never by the rarity.

import { RELATIONSHIP_LABELS } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  cardsConfig,
  drawCard,
  drawRules,
  EXPRESSIONS,
  expressionsFor,
  nextSince,
  type Part,
  pityApplies,
  pityView,
  portraitPose,
  RARITIES,
  type Rarity,
  rarityChances,
  rarityRank,
  SEED_PARTS,
  seededRandom,
  wishedOn,
} from "../src/index.js";

const rules = drawRules(cardsConfig());
const RUNS = 100_000;

function count<T extends string>(items: readonly T[]): Map<T, number> {
  const out = new Map<T, number>();
  for (const item of items) out.set(item, (out.get(item) ?? 0) + 1);
  return out;
}

describe("the rarity", () => {
  it("follows the public weights over a seeded run", () => {
    const random = seededRandom(20261117);
    const rarities: Rarity[] = [];
    for (let i = 0; i < RUNS; i++) {
      rarities.push(
        drawCard({ catalogue: SEED_PARTS, rules, since: 0, tier: "朋友", random }).rarity,
      );
    }
    const seen = count(rarities);
    const expected: Record<Rarity, number> = { N: 0.7, R: 0.22, SR: 0.07, SSR: 0.01 };
    for (const r of RARITIES) {
      // Four standard deviations of a binomial share.
      const p = expected[r];
      const tolerance = 4 * Math.sqrt((p * (1 - p)) / RUNS);
      expect(Math.abs((seen.get(r) ?? 0) / RUNS - p)).toBeLessThan(tolerance);
    }
  });

  it("is the rarity of the card's rarest part, and every slot is filled", () => {
    const random = seededRandom(7);
    for (let i = 0; i < 5_000; i++) {
      const card = drawCard({ catalogue: SEED_PARTS, rules, since: 0, tier: "認識", random });
      const rarest = Math.max(...card.parts.map((p) => rarityRank(p.rarity)));
      expect(rarest).toBe(rarityRank(card.rarity));
      expect(card.parts.map((p) => p.slot)).toEqual([
        "hand",
        "accessory",
        "outfit",
        "pose",
        "background",
      ]);
      expect(card.foil).toBe(card.rarity === "SSR");
    }
  });

  it("never gives a drop-only or disabled part", () => {
    const catalogue = SEED_PARTS.map((p) =>
      p.id === "background.aurora" ? { ...p, enabled: false } : p,
    );
    const random = seededRandom(99);
    for (let i = 0; i < 20_000; i++) {
      const card = drawCard({ catalogue, rules, since: 0, tier: "朋友", random });
      for (const p of card.parts) {
        expect(p.id).not.toBe("background.fireworks");
        expect(p.id).not.toBe("background.aurora");
      }
    }
    // Twenty thousand draws: a slow machine needs more than the default five seconds.
  }, 30_000);

  it("leaves out a rarity no part can give; the others share its weight", () => {
    const noSsr: Part[] = SEED_PARTS.filter((p) => p.rarity !== "SSR");
    const chances = rarityChances(noSsr, rules.weights);
    expect(chances.map(([r]) => r)).toEqual(["N", "R", "SR"]);
    expect(chances.reduce((sum, [, p]) => sum + p, 0)).toBeCloseTo(1);
    expect(chances[0]?.[1]).toBeCloseTo(70 / 99);
  });

  it("is the same for the same seed", () => {
    const a = drawCard({
      catalogue: SEED_PARTS,
      rules,
      since: 0,
      tier: "朋友",
      random: seededRandom(5),
    });
    const b = drawCard({
      catalogue: SEED_PARTS,
      rules,
      since: 0,
      tier: "朋友",
      random: seededRandom(5),
    });
    expect(a).toEqual(b);
  });

  it("refuses a catalogue with nothing to draw", () => {
    const off = SEED_PARTS.map((p) => ({ ...p, enabled: false }));
    expect(() =>
      drawCard({ catalogue: off, rules, since: 0, tier: "朋友", random: seededRandom(1) }),
    ).toThrow(/nothing to draw/);
  });
});

describe("the pity", () => {
  it("guarantees SR or better after 20 cards in a row without", () => {
    const random = seededRandom(3);
    for (let i = 0; i < 2_000; i++) {
      const card = drawCard({ catalogue: SEED_PARTS, rules, since: 20, tier: "朋友", random });
      expect(["SR", "SSR"]).toContain(card.rarity);
      expect(card.pity_hit).toBe(true);
    }
    expect(pityApplies(SEED_PARTS, rules, 19)).toBe(false);
    // A random source that always says "the most common": N without the pity.
    const card = drawCard({
      catalogue: SEED_PARTS,
      rules,
      since: 19,
      tier: "朋友",
      random: () => 0,
    });
    expect(card).toMatchObject({ rarity: "N", pity_hit: false });
  });

  it("splits the guaranteed card between SR and SSR by their weights", () => {
    const random = seededRandom(11);
    const rarities: Rarity[] = [];
    for (let i = 0; i < 40_000; i++) {
      rarities.push(
        drawCard({ catalogue: SEED_PARTS, rules, since: 25, tier: "朋友", random }).rarity,
      );
    }
    expect((count(rarities).get("SSR") ?? 0) / 40_000).toBeCloseTo(1 / 8, 1);
  });

  it("counts cards since the last SR or better", () => {
    expect(nextSince(0, "N")).toBe(1);
    expect(nextSince(19, "R")).toBe(20);
    expect(nextSince(20, "SR")).toBe(0);
    expect(nextSince(4, "SSR")).toBe(0);
    expect(pityView(17, 20)).toEqual({ since: 17, pity: 20, until: 3 });
    expect(pityView(20, 20).until).toBe(0);
  });
});

describe("the expression", () => {
  it("comes from the relationship's group, whatever the rarity", () => {
    const random = seededRandom(42);
    for (const tier of RELATIONSHIP_LABELS) {
      const allowed = new Set(expressionsFor(tier).map((e) => e.id));
      for (let i = 0; i < 300; i++) {
        // Under the pity too: a rarer card buys no other face.
        const card = drawCard({
          catalogue: SEED_PARTS,
          rules,
          since: i % 2 === 0 ? 0 : 20,
          tier,
          random,
        });
        expect(allowed.has(card.expression.id)).toBe(true);
      }
    }
  });

  it("shows 黑臉 only to someone she dislikes, and 愛心眼 never to them", () => {
    for (const tier of RELATIONSHIP_LABELS) {
      const ids = expressionsFor(tier).map((e) => e.id);
      const negative = tier === "討厭" || tier === "很討厭";
      expect(ids.includes(EXPRESSIONS.black_face.id)).toBe(negative);
      if (negative) expect(ids).not.toContain(EXPRESSIONS.heart_eyes.id);
    }
    expect(expressionsFor("not a tier")).toEqual(expressionsFor("陌生人"));
  });
});

describe("the wishlist", () => {
  it("is matched after the draw, in the wishlist's order", () => {
    const card = drawCard({
      catalogue: SEED_PARTS,
      rules,
      since: 0,
      tier: "朋友",
      random: () => 0,
    });
    const ids = card.parts.map((p) => p.id);
    expect(wishedOn(card, ["pose.sway", ids[3] as string, ids[1] as string])).toEqual([
      ids[3],
      ids[1],
    ]);
  });
});

describe("the fallback portrait", () => {
  it("has one of the ten fixed pictures for every expression", () => {
    const poses = [
      "calm",
      "smile",
      "blush",
      "heart",
      "squint",
      "finger",
      "hand",
      "smug",
      "sweat",
      "cold",
    ];
    for (const e of Object.values(EXPRESSIONS)) expect(poses).toContain(portraitPose(e.id));
    expect(portraitPose("black_face")).toBe("cold");
    expect(portraitPose("unknown")).toBe("calm");
  });
});
