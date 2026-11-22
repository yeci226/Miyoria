// The exchange's shared chart and map arithmetic (`src/market.ts`): the moving averages, the
// up/down colours and the tiles' diverging colour under both conventions, and the squarified
// treemap (areas by weight, sectors grouped, a stable order).

import { describe, expect, it } from "vitest";
import {
  changeText,
  approxTextWidth,
  capShares,
  layoutMap,
  MARKET_GREEN,
  MARKET_RED,
  maDirection,
  moveColors,
  movingAverage,
  TILE_FULL_AT,
  TILE_NEUTRAL,
  tileColor,
  tileRoom,
} from "../src/market.js";

describe("moving averages", () => {
  it("averages the last n closes, nothing until there are n", () => {
    const ma = movingAverage([1, 2, 3, 4, 5, 6], 3);
    expect(ma).toEqual([null, null, 2, 3, 4, 5]);
    expect(movingAverage([10, 20], 5)).toEqual([null, null]);
    expect(movingAverage([], 5)).toEqual([]);
  });

  it("matches a plain average at every bar over a long series", () => {
    const closes = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 3) * 7 + i * 0.1);
    for (const n of [5, 20, 60]) {
      const ma = movingAverage(closes, n);
      for (let i = n - 1; i < closes.length; i++) {
        const plain = closes.slice(i - n + 1, i + 1).reduce((t, x) => t + x, 0) / n;
        expect(ma[i]).toBeCloseTo(plain, 9);
      }
    }
  });

  it("says which way an average is going at its end", () => {
    expect(maDirection([null, 1, 2])).toBe(1);
    expect(maDirection([3, 2])).toBe(-1);
    expect(maDirection([2, 2])).toBe(0);
    expect(maDirection([null, 2])).toBeNull();
  });
});

describe("the up and down colours", () => {
  it("is red up in tw and green up in us, on lines and on tiles", () => {
    expect(moveColors("tw")).toEqual({ up: MARKET_RED, down: MARKET_GREEN });
    expect(moveColors("us")).toEqual({ up: MARKET_GREEN, down: MARKET_RED });
    // A tile's full colour: up in tw is the down colour in us.
    expect(tileColor(TILE_FULL_AT, "tw")).toBe(tileColor(-TILE_FULL_AT, "us"));
    expect(tileColor(-TILE_FULL_AT, "tw")).toBe(tileColor(TILE_FULL_AT, "us"));
    expect(tileColor(TILE_FULL_AT, "tw")).not.toBe(tileColor(-TILE_FULL_AT, "tw"));
    // Red in tw: the red channel leads for up.
    const red = Number.parseInt(tileColor(0.05, "tw").slice(1, 3), 16);
    const green = Number.parseInt(tileColor(0.05, "tw").slice(3, 5), 16);
    expect(red).toBeGreaterThan(green);
  });

  it("is neutral for no move or none known, deeper as the move grows, full past the end", () => {
    expect(tileColor(0, "tw")).toBe(TILE_NEUTRAL);
    expect(tileColor(null, "tw")).toBe(TILE_NEUTRAL);
    expect(tileColor(Number.NaN, "us")).toBe(TILE_NEUTRAL);
    expect(tileColor(0.01, "tw")).not.toBe(tileColor(0.02, "tw"));
    expect(tileColor(0.05, "tw")).toBe(tileColor(TILE_FULL_AT, "tw"));
  });

  it("never leaves the move to colour alone", () => {
    expect(changeText(0.0174)).toBe("▲ +1.7%");
    expect(changeText(-0.008)).toBe("▼ −0.8%");
    expect(changeText(0)).toBe("0.0%");
    expect(changeText(null)).toBe("—");
  });
});

describe("the treemap", () => {
  const tiles = [
    { code: "A", sector: "S1", weight: 40 },
    { code: "B", sector: "S1", weight: 20 },
    { code: "C", sector: "S2", weight: 25 },
    { code: "D", sector: "S2", weight: 10 },
    { code: "E", sector: "S3", weight: 5 },
  ];

  it("gives each tile an area by its weight, and fills the box", () => {
    const { tiles: placed, sectors } = layoutMap(tiles, 400, 300, { header: 0, gap: 0 });
    expect(placed).toHaveLength(5);
    const total = tiles.reduce((t, x) => t + x.weight, 0);
    for (const p of placed) {
      const share = (p.w * p.h) / (400 * 300);
      expect(share).toBeCloseTo(p.tile.weight / total, 6);
    }
    const area = sectors.reduce((t, s) => t + s.w * s.h, 0);
    expect(area).toBeCloseTo(400 * 300, 3);
    // Every tile is inside its sector.
    for (const p of placed) {
      const s = sectors.find((x) => x.name === p.tile.sector);
      expect(s).toBeDefined();
      if (!s) continue;
      expect(p.x).toBeGreaterThanOrEqual(s.x - 1e-6);
      expect(p.y).toBeGreaterThanOrEqual(s.y - 1e-6);
      expect(p.x + p.w).toBeLessThanOrEqual(s.x + s.w + 1e-6);
      expect(p.y + p.h).toBeLessThanOrEqual(s.y + s.h + 1e-6);
    }
  });

  it("keeps a sector's label strip and gaps inside the box", () => {
    const { tiles: placed, sectors } = layoutMap(tiles, 400, 300, { header: 14, gap: 2 });
    for (const s of sectors) {
      const inside = placed.filter((p) => p.tile.sector === s.name);
      for (const p of inside) expect(p.y).toBeGreaterThanOrEqual(s.y + 14 - 1e-6);
    }
    for (const p of placed) {
      expect(p.x + p.w).toBeLessThanOrEqual(400 + 1e-6);
      expect(p.y + p.h).toBeLessThanOrEqual(300 + 1e-6);
    }
  });

  it("puts the same tiles in the same places whatever order they come in", () => {
    const a = layoutMap(tiles, 320, 200);
    const b = layoutMap([...tiles].reverse(), 320, 200);
    const where = (l: typeof a) =>
      Object.fromEntries(l.tiles.map((p) => [p.tile.code, [p.x, p.y, p.w, p.h].map((n) => n.toFixed(3))]));
    expect(where(a)).toEqual(where(b));
    // Bigger first: the biggest sector starts at the top left.
    expect(a.sectors[0]?.name).toBe("S1");
    expect(a.sectors[0]?.x).toBe(0);
  });

  it("leaves out tiles with no weight, and draws nothing for nothing", () => {
    expect(layoutMap([{ code: "Z", sector: "S", weight: 0 }], 100, 100).tiles).toEqual([]);
    expect(layoutMap([], 100, 100)).toEqual({ sectors: [], tiles: [] });
  });

  it("says how much a tile has room for", () => {
    expect(tileRoom(80, 40)).toBe(2);
    expect(tileRoom(35, 20)).toBe(1);
    expect(tileRoom(20, 12)).toBe(0);
  });
});

describe("capShares", () => {
  const share = (ts: { weight: number }[], i: number) =>
    (ts[i]?.weight ?? 0) / ts.reduce((s, t) => s + t.weight, 0);

  it("cuts a tile over the cap to it and keeps the others in proportion, the total unchanged", () => {
    const tiles = [300, 30, 23, 20, 11, 10, 12, 10, 9, 6, 3, 3, 6, 4, 4, 2].map((weight, i) => ({ code: `T${i}`, weight }));
    const out = capShares(tiles, 0.35);
    expect(share(out, 0)).toBeCloseTo(0.35, 10);
    expect(out.reduce((s, t) => s + t.weight, 0)).toBeCloseTo(453, 6);
    expect((out[1]?.weight ?? 0) / (out[2]?.weight ?? 1)).toBeCloseTo(30 / 23, 10);
  });

  it("repeats until none is over, gives equal shares when the cap cannot hold, and 1 is off", () => {
    const two = capShares([{ weight: 50 }, { weight: 45 }, { weight: 5 }, { weight: 1 }], 0.35);
    expect(two.every((_, i) => share(two, i) <= 0.35 + 1e-9)).toBe(true);
    expect(capShares([{ weight: 9 }, { weight: 1 }], 0.35).map((t) => t.weight)).toEqual([5, 5]);
    expect(capShares([{ weight: 9 }, { weight: 1 }], 1).map((t) => t.weight)).toEqual([9, 1]);
  });

  it("measures CJK wider than Latin for the panel's tile labels", () => {
    expect(approxTextWidth("台積電", 12)).toBe(36);
    expect(approxTextWidth("2330", 10)).toBeCloseTo(24.8, 5);
  });
});
