import { describe, expect, it } from "vitest";
import { initialState, parseMessage, reduce } from "../src/feed.js";
import { BarField, barDistance, barTargets, levelValue, MAX_BANDS } from "../src/wave.js";
import { OVERLAY_LEVEL_BANDS_MAX } from "@miyoria/contracts/overlay";

describe("levels feed", () => {
  it("parses levels, clamps rms and drops odd bands", () => {
    expect(parseMessage('{"type":"levels","rms":0.12,"bands":[0.1,0.2]}')).toEqual({
      type: "levels",
      rms: 0.12,
      bands: [0.1, 0.2],
    });
    expect(parseMessage('{"type":"levels","rms":3}')).toEqual({ type: "levels", rms: 1, bands: null });
    expect(parseMessage('{"type":"levels","rms":0.1,"bands":["x"]}')).toMatchObject({ bands: null });
    expect(parseMessage('{"type":"levels"}')).toBeNull();
    // As many bands as the contract allows, and not one more.
    const bands = (n: number) => JSON.stringify(Array.from({ length: n }, () => 0.5));
    expect(MAX_BANDS).toBe(OVERLAY_LEVEL_BANDS_MAX);
    const frame = (n: number) => `{"type":"levels","rms":0.1,"bands":${bands(n)}}`;
    expect(parseMessage(frame(MAX_BANDS))).toMatchObject({
      bands: Array.from({ length: MAX_BANDS }, () => 0.5),
    });
    expect(parseMessage(frame(MAX_BANDS + 1))).toMatchObject({ bands: null });
  });

  it("never changes the reduced state", () => {
    const s = initialState();
    expect(reduce(s, { type: "levels", rms: 0.5, bands: null })).toBe(s);
  });
});

describe("voice bars", () => {
  it("maps levels on a dB scale: silence 0, loud speech near 1", () => {
    expect(levelValue(0)).toBe(0);
    expect(levelValue(10 ** (-60 / 20))).toBe(0);
    expect(levelValue(10 ** (-12 / 20))).toBeCloseTo(1);
    const quiet = levelValue(10 ** (-40 / 20));
    const loud = levelValue(10 ** (-20 / 20));
    expect(quiet).toBeGreaterThan(0);
    expect(loud).toBeGreaterThan(quiet * 3);
  });

  it("mirrors the bars around the middle", () => {
    expect(barDistance(12, 26)).toBe(0);
    expect(barDistance(13, 26)).toBe(0);
    expect(barDistance(0, 26)).toBe(1);
    expect(barDistance(25, 26)).toBe(1);
    expect(barDistance(5, 26)).toBeCloseTo(barDistance(20, 26));
  });

  it("puts the low bands in the middle and the high bands at the ends", () => {
    const out = new Float32Array(26);
    const peaks = Float32Array.from([1, 1, 1, 1, 1, 1]);
    barTargets(1, [1, 0, 0, 0, 0, 0], out, peaks);
    const middle = out[12] ?? 0;
    const end = out[0] ?? 0;
    expect(middle).toBeGreaterThan(end * 2);
    barTargets(1, [0, 0, 0, 0, 0, 1], out, peaks);
    expect(out[0] ?? 0).toBeGreaterThan((out[12] ?? 0) * 0.9);
  });

  it("shapes the bars from as many bands as the contract allows", () => {
    const f = new BarField(8);
    // Only the lowest band is loud: the middle bars stand above the ends.
    f.push(0.2, Array.from({ length: MAX_BANDS }, (_, k) => (k === 0 ? 0.2 : 0.001)), 0);
    f.advance(100, 100);
    expect(f.values[3] ?? 0).toBeGreaterThan((f.values[0] ?? 0) * 1.5);
  });

  it("rises quickly, falls slowly and goes still when the feed stops", () => {
    const f = new BarField(8);
    let now = 0;
    const step = (ms: number) => {
      now += ms;
      f.advance(ms, now);
    };
    expect(f.silent()).toBe(true);
    f.push(0.2, [0.2, 0.15, 0.1, 0.08, 0.05, 0.03], now);
    step(16);
    const first = f.values[3] ?? 0;
    expect(first).toBeGreaterThan(0);
    for (let i = 0; i < 6; i++) {
      f.push(0.2, [0.2, 0.15, 0.1, 0.08, 0.05, 0.03], now);
      step(16);
    }
    const loud = f.values[3] ?? 0;
    expect(loud).toBeGreaterThan(first);
    expect(f.silent()).toBe(false);
    // The feed stops: after the stale window the bars sink slower than they rose.
    step(250);
    step(100);
    expect(f.values[3] ?? 0).toBeGreaterThan(0.1 * loud);
    for (let i = 0; i < 40; i++) step(100);
    expect(f.silent()).toBe(true);
  });
});
