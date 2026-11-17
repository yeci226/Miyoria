// The bond ring's PNG for Discord: drawn through resvg like the card, kept per spec.

import { describe, expect, it } from "vitest";
import { RingImages, ringKey } from "../src/ring-image.js";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe("the ring's PNG", () => {
  it("is a PNG, drawn once for the same ring, again for another", async () => {
    const images = new RingImages();
    const spec = { lap: 3, fraction: 0.4, full: false, below: 0 };
    const png = await images.png(spec);
    expect([...png.slice(0, 8)]).toEqual(SIGNATURE);
    expect(await images.png({ ...spec })).toBe(png);
    const other = await images.png({ ...spec, fraction: 0.45 });
    expect(other).not.toBe(png);
  });

  it("draws the number only when it is given", async () => {
    const images = new RingImages();
    const spec = { lap: 7, fraction: 0.4, full: false, below: 0 };
    const plain = await images.png(spec);
    const numbered = await images.png({ ...spec, value: 742.3 });
    // Its own picture, not the plain one kept: whether the digits show in the pixels depends on
    // the machine having a font (a CI runner has none), so the pixels are not compared.
    expect(numbered).not.toBe(plain);
    expect(ringKey({ ...spec, value: 742.3 })).not.toBe(ringKey(spec));
    expect(ringKey(spec)).not.toContain("742");
  });

  it("draws a full ring and one below zero", async () => {
    const images = new RingImages();
    for (const spec of [
      { lap: 9, fraction: 1, full: true, below: 0 },
      { lap: 0, fraction: 0, full: false, below: 0.25 },
    ]) {
      expect([...(await images.png(spec)).slice(0, 8)]).toEqual(SIGNATURE);
    }
  });
});
