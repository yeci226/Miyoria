// One definition of 在意 (docs/design/v5-heart.md H5, §2.9, §2.10): how much she cares is the
// heart's (from `CARES_THRESHOLD` on), and the old crush's behaviours hang on the one she cares
// about most. There is no other source any more.

import { CARES_THRESHOLD, type HeartPeople, type PersonId } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { IDLE } from "../src/engine.js";
import { ev, HOUR, level, rig } from "./helpers.js";

function heart(cares: Record<string, number>): HeartPeople {
  const fake: Pick<HeartPeople, "cares" | "mostCared"> = {
    cares: (p) => cares[p] ?? 0,
    mostCared: () => {
      const best = Object.entries(cares)
        .filter(([, c]) => c >= CARES_THRESHOLD)
        .sort((a, b) => b[1] - a[1])[0];
      return best === undefined ? null : { person: best[0] as PersonId, cares: best[1] };
    },
  };
  return fake as HeartPeople;
}

describe("在意 from the heart", () => {
  it("cares from the threshold on, and not below it, whatever the old affinity", () => {
    const r = rig({ heart: heart({ p1: 0.62, p2: 0.2 }) });
    expect(r.self.care("p1")).toBeCloseTo(0.62);
    expect(r.self.care("p2")).toBe(0);
    expect(r.self.care("p3")).toBe(0);
  });

  it("hangs the crush's rules on the one she cares about most", () => {
    const r = rig({ heart: heart({ p1: 0.45, p2: 0.7 }) });
    expect(r.self.crushPerson()).toBe("p2");
    expect(rig({ heart: heart({ p1: 0.1 }) }).self.crushPerson()).toBeNull();
  });

  it("praise from the one she cares about most flusters her; from someone else less", () => {
    const most = rig({ heart: heart({ p1: 0.7 }) });
    most.affect.applyEvent(ev("praised", most.clock.at, { person: "p1", key: "praise|p1" }));
    const other = rig({ heart: heart({ p1: 0.7 }) });
    other.affect.applyEvent(ev("praised", other.clock.at, { person: "p2", key: "praise|p2" }));
    expect(level(most, "shy")).toBeGreaterThan(level(other, "shy"));
  });
});

describe("longing in the engine", () => {
  it("grows toward the 在意 of the one she cares about most while they are away", () => {
    const r = rig();
    const start = r.engine.drives().longing;
    r.engine.advance(r.clock.at + 6 * HOUR, { ...IDLE, cared: { person: "p1", cares: 0.9 } });
    const grown = r.engine.drives().longing;
    expect(grown).toBeGreaterThan(start);
    // Nobody she cares about: it fades, the old crush not asked.
    r.engine.advance(r.clock.at + 30 * HOUR, { ...IDLE, cared: null });
    expect(r.engine.drives().longing).toBeLessThan(grown);
  });
});
