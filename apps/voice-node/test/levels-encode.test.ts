// Pins the exact bytes `encodeLevel` puts on the wire, one literal per case. The Stage reads them
// as JSON, but the frames are built by hand (rounding, key order), so the text itself is pinned.
import { describe, expect, it } from "vitest";
import { encodeLevel } from "../src/levels/client.js";

describe("encodeLevel, exact frames", () => {
  it("without bands", () => {
    expect(encodeLevel({ t: 0, rms: 0 })).toBe('{"t":0,"rms":0}');
    expect(encodeLevel({ t: 20, rms: 0.123456 })).toBe('{"t":20,"rms":0.1235}');
    expect(encodeLevel({ t: 1234567, rms: 1 })).toBe('{"t":1234567,"rms":1}');
    expect(encodeLevel({ t: 10, rms: 0.5 })).toBe('{"t":10,"rms":0.5}');
  });

  it("rounds t to whole milliseconds and rms to 4 decimals", () => {
    expect(encodeLevel({ t: 9.6, rms: 1 })).toBe('{"t":10,"rms":1}');
    expect(encodeLevel({ t: 9.4, rms: 0.00004 })).toBe('{"t":9,"rms":0}');
    expect(encodeLevel({ t: 0.5, rms: 0.00005 })).toBe('{"t":1,"rms":0.0001}');
    expect(encodeLevel({ t: 3, rms: 0.33333333 })).toBe('{"t":3,"rms":0.3333}');
    expect(encodeLevel({ t: 3, rms: 0.99996 })).toBe('{"t":3,"rms":1}');
  });

  it("the extremes", () => {
    expect(encodeLevel({ t: 0, rms: 1e-9 })).toBe('{"t":0,"rms":0}');
    expect(encodeLevel({ t: 0, rms: 1.5 })).toBe('{"t":0,"rms":1.5}');
    expect(encodeLevel({ t: 0, rms: -0.25 })).toBe('{"t":0,"rms":-0.25}');
    expect(encodeLevel({ t: 3_600_000, rms: 0.0001 })).toBe('{"t":3600000,"rms":0.0001}');
  });

  it("with bands: 3 significant digits, lowest first", () => {
    expect(encodeLevel({ t: 0, rms: 0.1, bands: [0.012345, 0.5, 0] })).toBe('{"t":0,"rms":0.1,"bands":[0.0123,0.5,0]}');
    expect(encodeLevel({ t: 40, rms: 0.2, bands: [1] })).toBe('{"t":40,"rms":0.2,"bands":[1]}');
    expect(encodeLevel({ t: 40, rms: 0.2, bands: [0.123456, 0.987654, 0.00123456] })).toBe(
      '{"t":40,"rms":0.2,"bands":[0.123,0.988,0.00123]}',
    );
    expect(encodeLevel({ t: 40, rms: 0.2, bands: [123456, 0.999999] })).toBe('{"t":40,"rms":0.2,"bands":[123000,1]}');
  });

  it("small band values go to exponent form, as JSON allows", () => {
    expect(encodeLevel({ t: 0, rms: 0, bands: [1e-7, 0.000012345] })).toBe('{"t":0,"rms":0,"bands":[1e-7,0.0000123]}');
  });

  it("empty bands are left out", () => {
    expect(encodeLevel({ t: 0, rms: 0.1, bands: [] })).toBe('{"t":0,"rms":0.1}');
    expect(encodeLevel({ t: 0, rms: 0.1, bands: undefined })).toBe('{"t":0,"rms":0.1}');
  });

  it("a 16-band frame", () => {
    const bands = Array.from({ length: 16 }, (_, i) => (i + 1) / 17);
    expect(encodeLevel({ t: 100, rms: 0.4, bands })).toBe(
      '{"t":100,"rms":0.4,"bands":[0.0588,0.118,0.176,0.235,0.294,0.353,0.412,0.471,0.529,0.588,0.647,0.706,0.765,0.824,0.882,0.941]}',
    );
  });
});
