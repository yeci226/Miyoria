import { describe, expect, it } from "vitest";
import { qrMatrix, qrSvgPath } from "../src/qr.js";
import raw from "./qr-vectors.json?raw";

// Reference codes made with uqr (byte mode, level M, no border, automatic mask).
interface Vector {
  text: string;
  version: number;
  mask: number;
  rows: string[];
}
const vectors = JSON.parse(raw) as Vector[];

const toStrings = (m: boolean[][]) => m.map((row) => row.map((b) => (b ? "1" : "0")).join(""));

describe("qrMatrix", () => {
  it("has vectors for every version", () => {
    expect([...new Set(vectors.map((v) => v.version))].sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  for (const v of vectors) {
    it(`matches the reference for version ${v.version}: ${v.text.slice(0, 40)}`, () => {
      const m = qrMatrix(v.text);
      expect(m).not.toBeNull();
      expect(m?.length).toBe(17 + 4 * v.version);
      for (const row of m ?? []) expect(row.length).toBe(m?.length);
      expect(toStrings(m ?? [])).toEqual(v.rows);
    });
  }

  it("picks the smallest version that fits", () => {
    expect(qrMatrix("a".repeat(14))?.length).toBe(21);
    expect(qrMatrix("a".repeat(15))?.length).toBe(25);
    expect(qrMatrix("a".repeat(213))?.length).toBe(57);
  });

  it("returns null beyond version 10", () => {
    expect(qrMatrix("a".repeat(214))).toBeNull();
    expect(qrMatrix("例".repeat(72))).toBeNull();
  });
});

describe("qrSvgPath", () => {
  /** Dark modules drawn by the path, assuming its `M x y h n v1 h-n z` runs. */
  function painted(d: string): Set<string> {
    const cells = new Set<string>();
    for (const [, x, y, n, back] of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-(\d+)z/g)) {
      expect(back).toBe(n);
      for (let i = 0; i < Number(n); i++) {
        const key = `${Number(x) + i},${y}`;
        expect(cells.has(key)).toBe(false);
        cells.add(key);
      }
    }
    expect(d.replace(/M\d+ \d+h\d+v1h-\d+z/g, "")).toBe("");
    return cells;
  }

  it("includes the border in the size and draws exactly the dark modules", () => {
    const m = qrMatrix("https://example.com/karaoke/room/AB23CD");
    expect(m).not.toBeNull();
    if (!m) return;
    const { size, d } = qrSvgPath(m);
    expect(size).toBe(m.length + 8);
    const expected = new Set<string>();
    m.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (dark) expected.add(`${x + 4},${y + 4}`);
      });
    });
    expect(painted(d)).toEqual(expected);
  });

  it("takes another border", () => {
    const m = [
      [true, true, false],
      [false, false, false],
      [false, true, true],
    ];
    expect(qrSvgPath(m, 1)).toEqual({ size: 5, d: "M1 1h2v1h-2zM2 3h2v1h-2z" });
    expect(qrSvgPath(m, 0).size).toBe(3);
  });
});
