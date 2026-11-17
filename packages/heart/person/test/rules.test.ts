import { HeartChanged } from "@miyoria/store";
import { toTimestamp } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  ANCHORED_TIERS,
  applyBond,
  applyChange,
  applyDecay,
  bondGainCap,
  CARES_THRESHOLD,
  cares,
  type DayLedger,
  dailyCap,
  dayStart,
  decayDay,
  emptyLedger,
  familiarityGain,
  HEART_FIELDS,
  type HeartChangeRequest,
  type HeartPerson,
  HeartPersonConfigSchema,
  heartPersonConfig,
  ledgerFrom,
  localDay,
  newPerson,
  PROPOSAL_FIELDS,
  type ProposalField,
  proposalStep,
  repeatFactor,
  warmthBaseline,
} from "../src/index.js";

const rules = heartPersonConfig();
const DAY = 86_400_000;
/** 2026-11-17 10:00 in her time zone (UTC+8): mid-morning, far from either end of the day. */
const NOW = Date.UTC(2026, 10, 17, 2, 0, 0);
const TODAY = localDay(NOW, rules);

function person(overrides: Partial<HeartPerson> = {}): HeartPerson {
  return { ...newPerson("p1", toTimestamp(NOW - 30 * DAY)), ...overrides };
}

function propose(field: ProposalField, direction: "up" | "down"): HeartChangeRequest {
  return { type: "propose", field, direction, quote: "他記得我說過的話" };
}

/** Applies `requests` in order on one day, as the store would, returning the person and ledger. */
function run(
  start: HeartPerson,
  requests: readonly HeartChangeRequest[],
  ledger: DayLedger = emptyLedger(TODAY),
) {
  let p = start;
  let l = ledger;
  const deltas: number[] = [];
  for (const r of requests) {
    const applied = applyChange(p, r, l, rules, NOW);
    p = applied.person;
    l = applied.ledger;
    deltas.push(applied.change.delta);
  }
  return { person: p, ledger: l, deltas };
}

describe("config", () => {
  it("has a default for every number and keeps nested defaults", () => {
    const parsed = HeartPersonConfigSchema.parse({ caps: { trust: 3 } });
    expect(parsed.caps.trust).toBe(3);
    expect(parsed.caps.warmth).toBe(0.2);
    expect(parsed.repeat_damping).toBe(0.75);
    expect(parsed.step_share).toBe(0.25);
    expect(parsed.decay.bond_grace_days).toBe(7);
    expect(parsed.bond_gain_caps).toEqual([
      [0, 12],
      [100, 8],
      [300, 6],
      [600, 4],
    ]);
  });

  it("names the same fields as the contract", () => {
    expect([...HEART_FIELDS]).toEqual(HeartChanged.data.shape.field.options);
  });
});

describe("days", () => {
  it("are her local days", () => {
    // 15:59 UTC is 23:59 for her; 16:00 UTC is the next day.
    const before = Date.UTC(2026, 10, 17, 15, 59);
    expect(localDay(before, rules)).toBe(TODAY);
    expect(localDay(before + 60_000, rules)).toBe(TODAY + 1);
    expect(dayStart(TODAY + 1, rules)).toBe(before + 60_000);
  });
});

describe("proposal steps", () => {
  it("make a bad direction three times a good one", () => {
    for (const field of PROPOSAL_FIELDS) {
      const good = field === "grudge" ? "down" : "up";
      const bad = field === "grudge" ? "up" : "down";
      const g = Math.abs(proposalStep(field, good, rules));
      const b = Math.abs(proposalStep(field, bad, rules));
      expect(b).toBeCloseTo(3 * g);
      expect(Math.sign(proposalStep(field, "up", rules))).toBe(1);
      expect(Math.sign(proposalStep(field, "down", rules))).toBe(-1);
    }
  });

  it("size the bond by the day's cap at the bond it starts from (H3)", () => {
    expect([0, 99, 100, 299, 300, 599, 600, 1000].map((b) => bondGainCap(b, rules))).toEqual([
      12, 12, 8, 8, 6, 6, 4, 4,
    ]);
    expect([50, 150, 450, 650].map((b) => proposalStep("bond", "up", rules, b))).toEqual([
      3, 2, 1.5, 1,
    ]);
    expect(proposalStep("bond", "down", rules, 650)).toBe(-3);
    expect(proposalStep("trust", "up", rules)).toBe(0.5);
    expect(proposalStep("warmth", "up", rules)).toBeCloseTo(0.05);
    expect(dailyCap("bond", "down", rules, 50)).toBe(36);
    expect(dailyCap("grudge", "up", rules)).toBeCloseTo(0.6);
  });

  it("damp the n-th of a day by 0.75^(n-1)", () => {
    expect([1, 2, 3, 4].map((n) => repeatFactor(n, rules))).toEqual([1, 0.75, 0.5625, 0.421875]);
  });

  it("converge on each daily cap over 8 to 15 proposals and never pass it", () => {
    const cases: [ProposalField, "up" | "down", number][] = [
      ["bond", "up", 0],
      ["bond", "up", 150],
      ["bond", "up", 400],
      ["bond", "up", 700],
      ["bond", "down", 400],
      ["trust", "up", 0],
      ["warmth", "up", 0],
      ["respect", "down", 0],
      ["ease", "up", 0],
      ["grudge", "down", 0],
      ["grudge", "up", 0],
      ["rapport", "up", 0],
    ];
    for (const [field, direction, bond] of cases) {
      // Room to move: a tier floor that needs no anchors, a grudge that can still fall.
      const grudge = field === "grudge" && direction === "down" ? 0.9 : 0;
      const start = person({ bond, tier_floor: 1000, grudge });
      const cap = dailyCap(field, direction, rules, bond);
      const total = (n: number) =>
        run(
          start,
          Array.from({ length: n }, () => propose(field, direction)),
        ).deltas.reduce((a, b) => a + Math.abs(b), 0);
      expect(total(1)).toBeCloseTo(0.25 * cap);
      expect(total(3)).toBeLessThan(0.6 * cap);
      expect(total(8)).toBeGreaterThan(0.89 * cap);
      expect(total(15)).toBeGreaterThan(0.98 * cap);
      expect(total(40)).toBeLessThanOrEqual(cap + 1e-9);
    }
  });
});

describe("applyChange", () => {
  it("records the step asked for and what the cap left", () => {
    const start = person({ bond: 10 });
    const ledger = { ...emptyLedger(TODAY) };
    ledger.fields = {
      ...ledger.fields,
      bond: { up: 11, down: 0, proposed_up: 3, proposed_down: 0 },
    };
    const applied = applyChange(start, propose("bond", "up"), ledger, rules, NOW);
    // The 4th proposal asks 3 * 0.75^3 = 1.27; only 1 is left of the cap.
    expect(applied.change).toEqual({
      person: "p1",
      field: "bond",
      delta: 1,
      value_after: 11,
      proposed: 3,
      reason_quote: "他記得我說過的話",
      cause: "feel",
    });
    const capped = applyChange(
      { ...start, bond: 10 },
      propose("bond", "up"),
      {
        ...ledger,
        fields: { ...ledger.fields, bond: { up: 12, down: 0, proposed_up: 0, proposed_down: 0 } },
      },
      rules,
      NOW,
    );
    expect(capped.change.delta).toBe(0);
    expect(capped.change.proposed).toBe(3);
    // A proposal the cap took all of still counts for the damping.
    expect(capped.ledger.fields.bond.proposed_up).toBe(1);
  });

  it("damps rises and falls separately", () => {
    const { deltas } = run(person({ bond: 50 }), [
      propose("bond", "up"),
      propose("bond", "up"),
      propose("bond", "down"),
    ]);
    expect(deltas).toEqual([3, 2.25, -9]);
  });

  it("caps reflection and evidence but not the owner, decay or the migration", () => {
    const ledger = emptyLedger(TODAY);
    const big = (cause: "reflect" | "evidence" | "admin" | "decay" | "migrate") =>
      applyChange(
        person({ bond: 10 }),
        { type: "adjust", field: "bond", delta: 50, cause, quote: "" },
        ledger,
        rules,
        NOW,
      ).change;
    expect(big("reflect").delta).toBe(12);
    expect(big("reflect").proposed).toBe(50);
    expect(big("evidence").delta).toBe(12);
    expect(big("admin").delta).toBe(50);
    expect(big("decay").delta).toBe(50);
    expect(big("decay").proposed).toBeNull();
    expect(big("migrate").delta).toBe(50);
  });

  it("keeps every number in its range", () => {
    const { person: p } = run(person({ warmth: 0.95, grudge: 0.05 }), [
      { type: "adjust", field: "warmth", delta: 5, cause: "admin", quote: "" },
      { type: "adjust", field: "grudge", delta: -5, cause: "admin", quote: "" },
      { type: "adjust", field: "bond", delta: -500, cause: "admin", quote: "" },
    ]);
    expect([p.warmth, p.grudge, p.bond]).toEqual([1, 0, -100]);
  });

  it("holds the owner's trust and bond floor", () => {
    const owner = person({ tags: ["owner"], bond: 40, trust: 100 });
    const { person: p } = run(owner, [
      propose("trust", "down"),
      { type: "adjust", field: "bond", delta: -100, cause: "admin", quote: "" },
    ]);
    expect(p.trust).toBe(100);
    expect(p.bond).toBe(30);
  });

  it("builds the same ledger from the day's events", () => {
    const { ledger } = run(person({ bond: 50 }), [
      propose("bond", "up"),
      propose("warmth", "down"),
      { type: "adjust", field: "bond", delta: 2, cause: "reflect", quote: "" },
      { type: "adjust", field: "bond", delta: -1, cause: "decay", quote: "" },
    ]);
    const changes = [
      {
        at: toTimestamp(NOW),
        change: {
          person: "p1",
          field: "bond" as const,
          delta: 3,
          value_after: 53,
          proposed: 3,
          reason_quote: "",
          cause: "feel" as const,
        },
      },
      {
        at: toTimestamp(NOW),
        change: {
          person: "p1",
          field: "warmth" as const,
          delta: -0.15,
          value_after: -0.15,
          proposed: -0.15,
          reason_quote: "",
          cause: "feel" as const,
        },
      },
      {
        at: toTimestamp(NOW),
        change: {
          person: "p1",
          field: "bond" as const,
          delta: 2,
          value_after: 55,
          proposed: 2,
          reason_quote: "",
          cause: "reflect" as const,
        },
      },
      {
        at: toTimestamp(NOW),
        change: {
          person: "p1",
          field: "bond" as const,
          delta: -1,
          value_after: 54,
          proposed: null,
          reason_quote: "",
          cause: "decay" as const,
        },
      },
      // Yesterday's does not count today.
      {
        at: toTimestamp(NOW - DAY),
        change: {
          person: "p1",
          field: "bond" as const,
          delta: 3,
          value_after: 50,
          proposed: 3,
          reason_quote: "",
          cause: "feel" as const,
        },
      },
    ];
    const rebuilt = ledgerFrom(TODAY, changes, rules);
    expect(rebuilt.fields.bond).toEqual(ledger.fields.bond);
    expect(rebuilt.fields.warmth.down).toBeCloseTo(ledger.fields.warmth.down);
    expect(rebuilt.fields.bond).toEqual({ up: 5, down: 0, proposed_up: 1, proposed_down: 0 });
  });
});

describe("anchors (H4)", () => {
  it("are needed from 知心 up", () => {
    expect(ANCHORED_TIERS[0]).toBe(120);
    expect(ANCHORED_TIERS.at(-1)).toBe(1000);
  });

  it("hold a rise half a point below a tier without one", () => {
    const p = person({ bond: 115, tier_floor: 75 });
    const r = applyBond(p, 10, rules);
    expect(r).toEqual({ bond: 119.5, tier_floor: 75, held: 120 });
    // Further rises stay held, and do not lower a bond already close.
    expect(applyBond({ ...p, bond: 119.5 }, 6, rules).bond).toBe(119.5);
    expect(applyBond({ ...p, bond: 119.8 }, 6, rules).bond).toBe(119.8);
  });

  it("let a rise through with an anchor, and raise tier_floor only when the tier is entered", () => {
    const anchored = person({
      bond: 115,
      tier_floor: 75,
      anchors: [
        {
          tier: 120,
          note_ref: "01LINE",
          quote: "一起唱完那首歌",
          at: toTimestamp(NOW),
          by: "reflect",
        },
      ],
    });
    expect(applyBond(anchored, 10, rules)).toEqual({ bond: 125, tier_floor: 120, held: null });
    // Without the next tier's anchor, the rise past 150 stops below it.
    expect(applyBond({ ...anchored, bond: 148 }, 6, rules)).toEqual({
      bond: 149.5,
      tier_floor: 120,
      held: 150,
    });
  });

  it("do not hold a tier entered before, nor the owner's or the migration's change", () => {
    const back = person({ bond: 110, tier_floor: 120 });
    expect(applyBond(back, 15, rules).bond).toBe(125);
    const p = person({ bond: 100, tier_floor: 75 });
    expect(applyBond(p, 400, rules, { anchors: false })).toEqual({
      bond: 500,
      tier_floor: 450,
      held: null,
    });
    const admin = applyChange(
      p,
      { type: "adjust", field: "bond", delta: 400, cause: "admin", quote: "" },
      emptyLedger(TODAY),
      rules,
      NOW,
    );
    expect(admin.person.bond).toBe(500);
    expect(admin.person.tier_floor).toBe(450);
  });

  it("apply to her proposals", () => {
    const { person: p, deltas } = run(person({ bond: 117, tier_floor: 75 }), [
      { type: "adjust", field: "bond", delta: 1, cause: "admin", quote: "" },
      propose("bond", "up"),
    ]);
    expect(p.bond).toBe(119.5);
    expect(deltas[1]).toBeCloseTo(1.5);
    expect(p.tier_floor).toBe(75);
  });

  it("leave tier_floor where it was when the bond falls", () => {
    const p = person({ bond: 130, tier_floor: 120 });
    expect(applyBond(p, -50, rules)).toEqual({ bond: 80, tier_floor: 120, held: null });
  });
});

describe("decayDay (H9)", () => {
  const at = (days: number) => toTimestamp(NOW - days * DAY);

  it("leaves the bond alone for seven days without contact, then takes 1 a day", () => {
    const fresh = person({
      bond: 60,
      tier_floor: 45,
      last_interaction: at(7),
      last_seen: at(7),
      warmth: warmthBaseline(60),
    });
    expect(decayDay(fresh, NOW, rules).changes.find((c) => c.field === "bond")).toBeUndefined();
    const idle = { ...fresh, last_interaction: at(8), last_seen: at(8) };
    const pass = decayDay(idle, NOW, rules);
    expect(pass.day).toBe(TODAY);
    expect(pass.changes).toContainEqual({
      type: "adjust",
      field: "bond",
      delta: -1,
      cause: "decay",
      quote: "",
    });
  });

  it("never takes the bond below the highest tier reached, nor below 0", () => {
    const near = person({ bond: 45.4, tier_floor: 45, last_interaction: at(30) });
    const bond = decayDay(near, NOW, rules).changes.find((c) => c.field === "bond");
    expect(bond?.type === "adjust" && bond.delta).toBeCloseTo(-0.4);
    const atFloor = person({ bond: 45, tier_floor: 45, last_interaction: at(30) });
    expect(decayDay(atFloor, NOW, rules).changes.find((c) => c.field === "bond")).toBeUndefined();
    const low = person({ bond: 0.5, last_interaction: at(30) });
    const fall = decayDay(low, NOW, rules).changes.find((c) => c.field === "bond");
    expect(fall?.type === "adjust" && fall.delta).toBeCloseTo(-0.5);
    const negative = person({ bond: -20, last_interaction: at(30), warmth: warmthBaseline(-20) });
    expect(decayDay(negative, NOW, rules).changes.find((c) => c.field === "bond")).toBeUndefined();
  });

  it("runs once per local day and catches up the days it missed", () => {
    const p = person({
      bond: 80,
      tier_floor: 75,
      last_interaction: at(20),
      last_seen: at(20),
      decayed_on: TODAY - 3,
      warmth: warmthBaseline(80),
    });
    const pass = decayDay(p, NOW, rules);
    const bond = pass.changes.find((c) => c.field === "bond");
    expect(bond?.type === "adjust" && bond.delta).toBe(-3);
    const { person: after, changes } = applyDecay(p, pass, emptyLedger(TODAY), rules, NOW);
    expect(after.decayed_on).toBe(TODAY);
    expect(after.bond).toBe(77);
    expect(changes.every((c) => c.cause === "decay")).toBe(true);
    // Later the same day: nothing more.
    expect(decayDay(after, NOW + 3 * 3_600_000, rules).changes).toEqual([]);
    // A pass that changes nothing still records its day.
    const quiet = person({ last_interaction: at(0), last_seen: at(0) });
    const none = decayDay(quiet, NOW, rules);
    expect(none.changes).toEqual([]);
    expect(applyDecay(quiet, none, emptyLedger(TODAY), rules, NOW).person.decayed_on).toBe(TODAY);
  });

  it("does not depend on the hour it runs at", () => {
    const p = person({ bond: 80, tier_floor: 75, last_interaction: at(10), last_seen: at(10) });
    const morning = decayDay(p, dayStart(TODAY, rules) + 60_000, rules);
    const night = decayDay(p, dayStart(TODAY + 1, rules) - 60_000, rules);
    expect(morning).toEqual(night);
  });

  it("relaxes warmth toward the baseline of the bond", () => {
    expect(warmthBaseline(0)).toBe(0);
    expect(warmthBaseline(120)).toBeCloseTo(0.4);
    expect(warmthBaseline(1000)).toBeCloseTo(0.8);
    expect(warmthBaseline(-100)).toBeCloseTo(-0.6);
    const warm = person({
      bond: 120,
      tier_floor: 120,
      warmth: 1,
      last_interaction: at(0),
      last_seen: at(0),
    });
    const change = decayDay(warm, NOW, rules).changes.find((c) => c.field === "warmth");
    // A half-life of three days: a day closes 1 - 0.5^(1/3) of the gap.
    expect(change?.type === "adjust" && change.delta).toBeCloseTo(
      -(1 - 0.4) * (1 - 0.5 ** (1 / 3)),
    );
  });

  it("raises longing while they are away and lowers it once they are back", () => {
    const friend = { bond: 130, tier_floor: 120, warmth: warmthBaseline(130) };
    const away = person({ ...friend, longing: 0.1, last_interaction: at(5), last_seen: at(5) });
    const up = decayDay(away, NOW, rules).changes.find((c) => c.field === "longing");
    expect(up?.type === "adjust" && up.delta).toBeGreaterThan(0);
    const back = person({ ...friend, longing: 0.6, last_interaction: at(0), last_seen: at(0) });
    const down = decayDay(back, NOW, rules).changes.find((c) => c.field === "longing");
    expect(down?.type === "adjust" && down.delta).toBeCloseTo(-0.3);
    // She does not long for someone she does not care about.
    const stranger = person({ last_interaction: at(30), last_seen: at(30) });
    expect(
      decayDay(stranger, NOW, rules).changes.find((c) => c.field === "longing"),
    ).toBeUndefined();
  });

  it("lets a grudge fade only down to its floor", () => {
    const hurt = person({ grudge: 0.5, last_interaction: at(0), last_seen: at(0) });
    const fade = decayDay({ ...hurt, decayed_on: TODAY - 60 }, NOW, rules).changes.find(
      (c) => c.field === "grudge",
    );
    expect(fade?.type === "adjust" && hurt.grudge + fade.delta).toBeCloseTo(0.1);
    const small = person({ grudge: 0.05, last_interaction: at(0), last_seen: at(0) });
    expect(decayDay(small, NOW, rules).changes.find((c) => c.field === "grudge")).toBeUndefined();
    // Only a proposal clears the rest.
    const cleared = run(small, [propose("grudge", "down")]).person;
    expect(cleared.grudge).toBe(0);
  });

  it("blurs familiarity slowly and never to nothing", () => {
    const known = person({ familiarity: 40, last_interaction: at(20), last_seen: at(20) });
    const blur = decayDay(known, NOW, rules).changes.find((c) => c.field === "familiarity");
    expect(blur?.type === "adjust" && blur.delta).toBeCloseTo(-0.2);
    const long = decayDay({ ...known, familiarity: 5.1, decayed_on: TODAY - 60 }, NOW, rules);
    const f = long.changes.find((c) => c.field === "familiarity");
    expect(f?.type === "adjust" && 5.1 + f.delta).toBeCloseTo(5);
  });
});

describe("cares (在意)", () => {
  it("is one number from the bond's tier, warmth and longing", () => {
    expect(cares({ bond: -10, warmth: 1, longing: 1 })).toBe(0);
    expect(cares({ bond: 0, warmth: 0, longing: 0 })).toBe(0);
    expect(cares({ bond: 1000, warmth: 1, longing: 1 })).toBe(1);
    expect(cares({ bond: 200, warmth: 0.3, longing: 0.5 })).toBeGreaterThan(
      cares({ bond: 200, warmth: 0.3, longing: 0 }),
    );
  });

  it("is always at least the threshold for the owner", () => {
    expect(cares({ bond: 30, warmth: 0, longing: 0, tags: ["owner"] })).toBe(CARES_THRESHOLD);
    expect(cares({ bond: -50, warmth: -1, longing: 0, tags: ["owner"] })).toBe(CARES_THRESHOLD);
    expect(cares({ bond: 30, warmth: 0, longing: 0, tags: [] })).toBeLessThan(CARES_THRESHOLD);
    expect(cares({ bond: 1000, warmth: 1, longing: 1, tags: ["owner"] })).toBe(1);
  });

  it("starts at 好朋友 with the warmth the bond makes normal", () => {
    expect(cares({ bond: 45, warmth: warmthBaseline(45), longing: 0 })).toBeGreaterThanOrEqual(
      CARES_THRESHOLD,
    );
    expect(cares({ bond: 44, warmth: warmthBaseline(44), longing: 0 })).toBeLessThan(
      CARES_THRESHOLD,
    );
  });
});

describe("familiarity", () => {
  it("grows by lines, slowing toward 100", () => {
    expect(familiarityGain(0, 2, rules)).toBeCloseTo(0.3);
    expect(familiarityGain(50, 2, rules)).toBeCloseTo(0.15);
    expect(familiarityGain(100, 4, rules)).toBe(0);
  });
});
