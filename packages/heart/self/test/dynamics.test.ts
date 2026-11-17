// The dynamics of her emotions: habituation, mutual inhibition, the stir budget, decay toward
// the baseline, and 寂寞 as a function of the social drive.

import { describe, expect, it } from "vitest";
import { selfConfig } from "../src/config.js";
import { habituationFactor, INHIBITS, StirBudget } from "../src/dynamics.js";
import { EmotionEngine, temperament } from "../src/emotions.js";
import { IDLE, SelfEngine } from "../src/engine.js";
import { DAY, HOUR, MINUTE, T0 } from "./helpers.js";

const plain = () => temperament().temperament;
const engine = (budget = 0, t = plain()) => new EmotionEngine(t, 0.03, T0, { budget });

const hit = (
  e: EmotionEngine,
  name: Parameters<EmotionEngine["excite"]>[0]["name"],
  base: number,
  key: string,
  now: number,
) => e.excite({ name, base, key, cause: key, person: null }, now);

describe("habituation", () => {
  it("the same cause within two hours is worth 0.5ⁿ", () => {
    const e = engine();
    const a = hit(e, "pride", 0.1, "song", T0);
    const b = hit(e, "pride", 0.1, "song", T0 + 10 * MINUTE);
    const c = hit(e, "pride", 0.1, "song", T0 + 20 * MINUTE);
    expect(a.applied).toBeCloseTo(0.1, 6);
    expect(b.applied).toBeCloseTo(0.05, 6);
    expect(c.applied).toBeCloseTo(0.025, 6);
    expect([a.habituation, b.habituation, c.habituation]).toEqual([1, 0.5, 0.25]);
    expect(habituationFactor(3)).toBe(0.125);
  });

  it("a different cause is a fresh start, and the window runs out after two hours", () => {
    const e = engine();
    hit(e, "pride", 0.1, "song-1", T0);
    expect(hit(e, "pride", 0.1, "song-2", T0 + MINUTE).habituation).toBe(1);
    // Two hours after the first, only the later ones still count.
    expect(hit(e, "pride", 0.1, "song-1", T0 + 2 * HOUR + MINUTE).habituation).toBe(1);
  });

  it("the tenth song is far less than the first", () => {
    const e = engine();
    const amounts = Array.from(
      { length: 10 },
      (_, i) => hit(e, "pride", 0.1, "song", T0 + i * 5 * MINUTE).applied,
    );
    expect(amounts[9]).toBeLessThan((amounts[0] ?? 0) / 100);
  });

  it("survives a restart (the ledger is saved)", () => {
    const e = engine();
    hit(e, "pride", 0.1, "song", T0);
    const copy = engine();
    copy.restore(e.toJson(), T0 + MINUTE);
    expect(hit(copy, "pride", 0.1, "song", T0 + MINUTE).habituation).toBe(0.5);
  });
});

describe("mutual inhibition", () => {
  const table = [
    ["joy", "sorrow"],
    ["joy", "lonely"],
    ["pride", "guilt"],
    ["gratitude", "anger"],
  ] as const;

  it.each(table)("%s ⊣ %s: the opposite loses half of what was stirred", (up, down) => {
    const e = engine();
    e.feel(down, 0.6, "x", null, T0);
    const before = e.value(down, T0);
    const r = hit(e, up, 0.2, `${up}!`, T0);
    expect(r.inhibited[down]).toBeCloseTo(r.applied / 2, 6);
    expect(e.value(down, T0)).toBeCloseTo(before - r.applied / 2, 6);
  });

  it("gratitude ⊣ resentment: the caller is told to push resentment toward them down", () => {
    const e = engine();
    const r = hit(e, "gratitude", 0.2, "gift", T0);
    expect(r.inhibitedToward.resentment).toBeCloseTo(0.1, 6);
    expect(INHIBITS.companionship?.own).toContain("lonely");
  });

  it("never pushes an emotion below 0, and stirring an unrelated emotion changes nothing else", () => {
    const e = engine();
    e.feel("sorrow", 0.05, "x", null, T0);
    hit(e, "joy", 0.35, "big", T0);
    expect(e.value("sorrow", T0)).toBeGreaterThanOrEqual(0);
    const other = engine();
    other.feel("anger", 0.4, "x", null, T0);
    hit(other, "joy", 0.2, "j", T0);
    expect(other.value("anger", T0)).toBeCloseTo(0.4, 6);
  });
});

describe("the stir budget", () => {
  it("all emotions together may be stirred only so much in 10 minutes", () => {
    const e = engine(0.5);
    expect(hit(e, "joy", 0.3, "a", T0).applied).toBeCloseTo(0.3, 6);
    expect(hit(e, "pride", 0.3, "b", T0 + MINUTE).applied).toBeCloseTo(0.2, 6);
    expect(hit(e, "anger", 0.3, "c", T0 + 2 * MINUTE).applied).toBe(0);
    expect(e.stirUsed(T0 + 2 * MINUTE)).toBeCloseTo(0.5, 6);
    // The window moves on: the first stir leaves it after ten minutes.
    expect(hit(e, "anger", 0.3, "d", T0 + 10 * MINUTE + MINUTE).applied).toBeCloseTo(0.3, 6);
  });

  it("does not limit calming, and 0 means unlimited", () => {
    const e = engine(0.1);
    e.feel("sorrow", 0.1, "x", null, T0);
    expect(e.calm("sorrow", 0.05, T0)).toBeCloseTo(0.05, 6);
    expect(new StirBudget(0).room(T0)).toBe(Number.POSITIVE_INFINITY);
  });

  it("saturates: a strong emotion grows slower and never passes 1", () => {
    const e = engine();
    for (let i = 0; i < 30; i++) hit(e, "anger", 0.35, `k${i}`, T0);
    expect(e.value("anger", T0)).toBeLessThanOrEqual(1);
    expect(e.value("anger", T0)).toBeGreaterThan(0.95);
  });
});

describe("temperament: gain, half-life and baseline", () => {
  it("her gain scales every stir", () => {
    const t = temperament({ emotions: { shy: { gain: 2 } } }).temperament;
    expect(hit(engine(0, t), "shy", 0.1, "x", T0).applied).toBeCloseTo(0.2, 6);
  });

  it("decays to nothing by its half-life, or to its baseline when it has one", () => {
    const open = engine(0, temperament({ display: "open" }).temperament);
    hit(open, "pride", 0.35, "x", T0);
    expect(open.value("pride", T0 + 30 * MINUTE)).toBeCloseTo(0.175, 3);
    expect(open.value("pride", T0 + 6 * HOUR)).toBeLessThan(0.001);
    open.advance(T0 + 6 * HOUR);
    expect(open.readings(T0 + 6 * HOUR, 0)).toEqual([]);

    // A tsundere's pride settles a little above nothing, never above what shows (0.2).
    const tsun = engine(0, temperament({ display: "tsundere" }).temperament);
    expect(tsun.value("pride", T0)).toBeCloseTo(0.12, 6);
    hit(tsun, "pride", 0.35, "x", T0);
    const late = tsun.value("pride", T0 + 12 * HOUR);
    expect(late).toBeGreaterThan(0.12);
    expect(late).toBeLessThan(0.121);
    expect(engine(0, temperament({ display: "tsundere" }).temperament).readings(T0, 0.2)).toEqual(
      [],
    );
  });

  it("the profile can set a baseline", () => {
    const t = temperament({ emotions: { joy: { baseline: 0.25 } } }).temperament;
    const e = engine(0, t);
    expect(e.value("joy", T0 + DAY)).toBeCloseTo(0.25, 6);
  });
});

describe("寂寞 comes from the social drive", () => {
  it("rises with the gap, is not computed separately, and is gone once the need is met", () => {
    const e = new SelfEngine(selfConfig(), T0, plain());
    e.adjust({ social: 1, attention: 1 });
    for (let h = 1; h <= 8; h++) e.advance(T0 + h * HOUR, IDLE);
    const lonely = e.emotions.value("lonely", T0 + 8 * HOUR);
    expect(lonely).toBeGreaterThan(0.5);
    // Never above what a long wait weighs (0.8): that alone cannot saturate her.
    expect(lonely).toBeLessThanOrEqual(0.8);
    e.adjust({ social: -1, attention: -1 });
    e.advance(T0 + 9 * HOUR, IDLE);
    expect(e.emotions.value("lonely", T0 + 9 * HOUR)).toBeLessThan(0.05);
  });

  it("an unmet social drive does not need the mind's drip to stay lonely, and the mind's absence does not lift it", () => {
    const e = new SelfEngine(selfConfig(), T0, plain());
    e.adjust({ social: 1 });
    e.advance(T0 + 6 * HOUR, IDLE);
    const at6 = e.emotions.value("lonely", T0 + 6 * HOUR);
    e.advance(T0 + 12 * HOUR, IDLE);
    expect(e.emotions.value("lonely", T0 + 12 * HOUR)).toBeGreaterThanOrEqual(at6 - 1e-6);
  });
});
