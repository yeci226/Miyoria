import { describe, expect, it } from "vitest";
import {
  ANCHORED_TIER_MIN,
  BOND_LADDER,
  BOND_TIERS,
  bondBand,
  RELATIONSHIP_LABELS,
  relationshipLabel,
  ringOf,
  tierFloorOf,
  tierLabel,
  tierProgress,
  tierStanding,
  tiersEntered,
} from "../src/index.js";

describe("the bond ladder", () => {
  it("runs from 認識 at 0 to 永恆羈絆 at 1000, ascending", () => {
    expect(BOND_LADDER[0]).toEqual({ min: 0, label: "認識" });
    expect(BOND_LADDER.at(-1)).toEqual({ min: 1000, label: "永恆羈絆" });
    const mins = BOND_LADDER.map((t) => t.min);
    expect(mins).toEqual([...mins].sort((a, b) => a - b));
    expect(new Set(mins).size).toBe(mins.length);
    // Every tier from 知心 up is one of BOND_TIERS, and nothing else is.
    expect(BOND_LADDER.filter((t) => t.min >= ANCHORED_TIER_MIN)).toHaveLength(BOND_TIERS.length);
    for (const t of BOND_LADDER) expect(RELATIONSHIP_LABELS).toContain(t.label);
  });

  it("is where every tier name comes from: relationshipLabel is the ladder's", () => {
    for (let bond = -14; bond <= 1000; bond += 1) {
      expect(relationshipLabel({ affinity: bond })).toBe(tierProgress(bond).tier.label);
    }
    // Familiarity gates no tier any more: high tiers wait for their anchors instead.
    expect(relationshipLabel({ affinity: 80 })).toBe("摯友");
  });

  it("says how far into a tier a bond is and what comes next", () => {
    expect(tierProgress(30)).toEqual({
      tier: { min: 15, label: "朋友" },
      index: 1,
      next: { min: 45, label: "好朋友" },
      progress: 0.5,
      stage: 2,
    });
    expect(tierProgress(120).progress).toBe(0);
    expect(tierProgress(119.5).tier.label).toBe("摯友");
    const top = tierProgress(1000);
    expect(top.tier.label).toBe("永恆羈絆");
    expect(top.next).toBeNull();
    expect(top.progress).toBe(1);
  });

  it("reads a bond below 0 as the first tier with no progress", () => {
    const p = tierProgress(-40);
    expect(p.tier.label).toBe("認識");
    expect(p.progress).toBe(0);
    expect(p.next?.label).toBe("朋友");
    expect(tierProgress(Number.NaN).progress).toBe(0);
  });

  it("names the floor of a tier and the tiers a rise enters", () => {
    expect(tierFloorOf(-20)).toBe(0);
    expect(tierFloorOf(44.9)).toBe(15);
    expect(tierFloorOf(305)).toBe(300);
    expect(tiersEntered(100, 160).map((t) => t.min)).toEqual([120, 150]);
    expect(tiersEntered(120, 120)).toEqual([]);
    expect(tiersEntered(119, 120).map((t) => t.label)).toEqual(["知心"]);
    expect(tiersEntered(200, 100)).toEqual([]);
  });
});

describe("the ring", () => {
  it("draws one lap per 100, ten laps to 1000", () => {
    expect(ringOf(0)).toEqual({ lap: 0, fraction: 0, below: 0 });
    expect(ringOf(50)).toEqual({ lap: 0, fraction: 0.5, below: 0 });
    expect(ringOf(100)).toEqual({ lap: 1, fraction: 0, below: 0 });
    expect(ringOf(345).lap).toBe(3);
    expect(ringOf(345).fraction).toBeCloseTo(0.45);
    expect(ringOf(999).lap).toBe(9);
    expect(ringOf(1000)).toEqual({ lap: 9, fraction: 1, below: 0 });
    expect(ringOf(5000)).toEqual({ lap: 9, fraction: 1, below: 0 });
  });

  it("shows a bond below 0 apart from the laps", () => {
    expect(ringOf(-50)).toEqual({ lap: 0, fraction: 0, below: 0.5 });
    expect(ringOf(-100).below).toBe(1);
  });
});

describe("member bands", () => {
  it("keep the six old bands below 120", () => {
    expect([-60, -20, 0, 20, 50, 80].map(bondBand)).toEqual([
      "很差",
      "不太好",
      "普通",
      "不錯",
      "很好",
      "非常好",
    ]);
    expect(bondBand(-50)).toBe("很差");
    expect(bondBand(-15)).toBe("不太好");
    expect(bondBand(14.9)).toBe("普通");
  });

  it("go on to 1000 instead of stopping at 75", () => {
    expect([119, 120, 240, 450, 750, 999, 1000].map(bondBand)).toEqual([
      "非常好",
      "很親近",
      "心意相通",
      "像家人一樣",
      "無可取代",
      "無可取代",
      "永恆的羈絆",
    ]);
  });
});

describe("the stages of a tier (H10)", () => {
  const stage = (bond: number) => tierProgress(bond).stage;

  it("splits a low tier in equal thirds: 認識 0..15", () => {
    expect([0, 4.99, 5, 9.99, 10, 14.99].map(stage)).toEqual([1, 1, 2, 2, 3, 3]);
    expect(stage(15)).toBe(1);
  });

  it("splits a wide tier the same way: 心之所歸 870..1000", () => {
    const third = 130 / 3;
    expect([870, 870 + third - 0.01, 870 + third, 870 + 2 * third, 999.9].map(stage)).toEqual([
      1, 1, 2, 3, 3,
    ]);
  });

  it("gives the top none, nor 陌生人, 討厭 and 很討厭", () => {
    expect(stage(1000)).toBeNull();
    expect(tierStanding({ affinity: 1000 })).toEqual({
      tier: "永恆羈絆",
      stage: null,
      label: "永恆羈絆",
      next_label: null,
    });
    expect(tierStanding({ affinity: 0, met: false }).label).toBe("陌生人");
    expect(tierStanding({ affinity: -20 })).toMatchObject({ label: "討厭", stage: null });
    expect(tierStanding({ affinity: -80 })).toMatchObject({
      label: "很討厭",
      next_label: "認識 I",
    });
  });

  it("calls the tier at 450 宛若家人 (H10, it was 家人般)", () => {
    expect(tierProgress(450).tier).toEqual({ min: 450, label: "宛若家人" });
    expect(RELATIONSHIP_LABELS).not.toContain("家人般");
    expect(tierStanding({ affinity: 539 }).label).toBe("宛若家人 III");
  });

  it("writes the stage after the name with a space, in Roman numerals", () => {
    expect(tierLabel("知心", 1)).toBe("知心 I");
    expect(tierLabel("知心", 2)).toBe("知心 II");
    expect(tierLabel("知心", 3)).toBe("知心 III");
    expect(tierLabel("永恆羈絆", null)).toBe("永恆羈絆");
  });

  it("shows a bond held under an unanchored tier as III of the tier below", () => {
    expect(tierStanding({ affinity: 119.5 })).toEqual({
      tier: "摯友",
      stage: 3,
      label: "摯友 III",
      next_label: "知心 I",
    });
  });

  it("names the next step: the next stage, or the next tier's first after III", () => {
    expect(tierStanding({ affinity: 125 }).next_label).toBe("知心 II");
    expect(tierStanding({ affinity: 140 }).next_label).toBe("知己 I");
    expect(tierStanding({ affinity: 990 }).next_label).toBe("永恆羈絆");
  });
});
