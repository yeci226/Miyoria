// What a member sees: words, the ring and the tier, and no raw value.

import { toTimestamp } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { type HeartPerson, newPerson, publicBond } from "../src/index.js";

const NOW = Date.UTC(2026, 10, 17, 2, 0, 0);

function person(overrides: Partial<HeartPerson> = {}): HeartPerson {
  return { ...newPerson("p1", toTimestamp(NOW)), ...overrides };
}

/** Every numeric field of `value` by its path. */
function numbers(value: unknown, path = ""): string[] {
  if (typeof value === "number") return [path];
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([k, v]) => numbers(v, path === "" ? k : `${path}.${k}`));
}

describe("publicBond", () => {
  it("has no number but the ring and the tier progress, and no raw value", () => {
    const view = publicBond(
      person({
        bond: 263.7,
        trust: 72.4,
        familiarity: 41.3,
        warmth: 0.33,
        grudge: 0.2,
        public_feeling: "跟你玩遊戲很開心",
        call_name: "小美",
      }),
    );
    // The stage (1..3) is a coarse band of the tier, like the progress (H10).
    expect(numbers(view).sort()).toEqual(["ring.fraction", "ring.lap", "stage", "tier_progress"]);
    expect(Object.keys(view)).not.toContain("bond");
    expect(JSON.stringify(view)).not.toMatch(/263|72\.4|41\.3|0\.33/);
    expect(view).toEqual({
      tier: "莫逆之交",
      // (263.7 - 240) * 3 < 60 * 2: the second third.
      stage: 2,
      tier_label: "莫逆之交 II",
      next_tier: "心有靈犀",
      next_label: "莫逆之交 III",
      // (263.7 - 240) / (300 - 240) = 0.395, shown as 0.35.
      tier_progress: 0.35,
      // Lap 2 (200..300), 63.7% full, shown as 0.6.
      ring: { lap: 2, fraction: 0.6, full: false, below: false },
      closeness: "心意相通",
      trust: "很信任",
      familiarity: "熟",
      public_feeling: "跟你玩遊戲很開心",
      call_name: "小美",
    });
  });

  it("is the same ring as the panel's at the ends of the scale", () => {
    expect(publicBond(person({ bond: 0 }))).toMatchObject({
      tier: "認識",
      next_tier: "朋友",
      tier_progress: 0,
      ring: { lap: 0, fraction: 0, full: false, below: false },
      closeness: "普通",
      trust: "還不信任",
      familiarity: "陌生",
    });
    expect(publicBond(person({ bond: 1000 }))).toMatchObject({
      tier: "永恆羈絆",
      next_tier: null,
      tier_progress: 1,
      ring: { lap: 9, fraction: 1, full: true, below: false },
      closeness: "永恆的羈絆",
    });
    expect(publicBond(person({ bond: 999.9 })).ring).toEqual({
      lap: 9,
      fraction: 0.95,
      full: false,
      below: false,
    });
  });

  it("names someone she dislikes without saying how much", () => {
    expect(publicBond(person({ bond: -60 }))).toMatchObject({
      tier: "很討厭",
      next_tier: "認識",
      tier_progress: 0,
      ring: { lap: 0, fraction: 0, full: false, below: true },
      closeness: "很差",
    });
    expect(publicBond(person({ bond: -20 })).tier).toBe("討厭");
    expect(publicBond(person({ bond: -5 })).tier).toBe("認識");
  });
});
