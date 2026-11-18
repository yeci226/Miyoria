// The stream's voice of a karaoke round (step 5): µ-law, whose voice (the picker: opt-outs, the
// hold, a brief swap, nobody), and the mix on the room's fixed delay (placement by device latency,
// late audio dropped, contiguous pieces, a crossfade in a gap between lines).

import { describe, expect, it } from "vitest";
import {
  AIR_LEAD_MS,
  AirPicker,
  type AirPiece,
  type AirSinger,
  lyricGaps,
  MULAW_TABLE,
  mulawDecode,
  mulawEncodeSample,
  RoomAir,
} from "../src/air.js";
import { fromBase64 } from "../src/score/index.js";

const RATE = 16_000;

describe("µ-law", () => {
  it("decodes what it encodes within a step of the curve", () => {
    for (const v of [0, 1, -1, 100, -100, 1_000, -5_000, 12_345, -30_000, 32_767, -32_768]) {
      const back = MULAW_TABLE[mulawEncodeSample(v)] as number;
      expect(Math.abs(back - v)).toBeLessThanOrEqual(Math.max(8, Math.abs(v) / 16));
    }
    expect(mulawDecode(new Uint8Array([0xff, 0x7f]))).toEqual(new Int16Array([0, 0]));
  });
});

const singer = (key: string, total: number, order: number, eligible = true): AirSinger => ({
  key,
  total,
  order,
  eligible,
});

describe("AirPicker", () => {
  it("alone: the singer while they allow it, nobody otherwise", () => {
    const p = new AirPicker(4_000, true);
    expect(p.pick(0, null, [singer("a", 0, 1)])).toEqual({ target: "a", gap: false });
    expect(p.pick(1, "a", [singer("a", 50, 1, false)])).toEqual({ target: null, gap: false });
  });

  it("before any score: the first who allows it, in joining order; nobody when all opted out", () => {
    const p = new AirPicker(4_000, false);
    const wish = p.pick(0, null, [singer("a", 0, 1, false), singer("b", 0, 2), singer("c", 0, 3)]);
    expect(wish.target).toBe("b");
    expect(p.pick(0, null, [singer("a", 0, 1, false), singer("b", 0, 2, false)]).target).toBeNull();
  });

  it("puts a new leader on only after they held first place for the hold time", () => {
    const p = new AirPicker(4_000, false);
    const at = (t: number, a: number, b: number) =>
      p.pick(t, "a", [singer("a", a, 1), singer("b", b, 2)]);
    expect(at(0, 60, 70).target).toBe("a");
    expect(at(2_000, 60, 71).target).toBe("a");
    expect(at(3_999, 60, 72).target).toBe("a");
    expect(at(4_000, 60, 72)).toEqual({ target: "b", gap: true });
  });

  it("does not switch on a brief swap, and a tie keeps the voice on", () => {
    const p = new AirPicker(4_000, false);
    const at = (t: number, a: number, b: number) =>
      p.pick(t, "a", [singer("a", a, 1), singer("b", b, 2)]);
    expect(at(0, 60, 70).target).toBe("a");
    expect(at(3_000, 72, 70).target).toBe("a"); // back in front: the count starts again
    expect(at(4_500, 60, 70).target).toBe("a");
    expect(at(8_000, 60, 70).target).toBe("a");
    expect(at(8_500, 60, 70).target).toBe("b");
    const q = new AirPicker(4_000, false);
    for (let t = 0; t <= 10_000; t += 1_000) {
      expect(q.pick(t, "a", [singer("a", 70, 1), singer("b", 70, 2)]).target).toBe("a");
    }
  });

  it("skips a leader who opted out for the best singer who allows it", () => {
    const p = new AirPicker(1_000, false);
    const s = (t: number) =>
      p.pick(t, "c", [singer("a", 90, 1, false), singer("b", 80, 2), singer("c", 50, 3)]);
    expect(s(0).target).toBe("c");
    expect(s(1_000).target).toBe("b");
  });

  it("takes a voice off at once when it may no longer go out", () => {
    const p = new AirPicker(10_000, false);
    const wish = p.pick(0, "a", [singer("a", 90, 1, false), singer("b", 40, 2)]);
    expect(wish).toEqual({ target: "b", gap: false });
  });
});

/** A µ-law chunk of `n` samples of one level. */
const tone = (n: number, level: number) => new Uint8Array(n).fill(mulawEncodeSample(level));

function rig(options: { solo?: boolean; gaps?: number[]; delayMs?: number } = {}) {
  const pieces: AirPiece[] = [];
  const startAt = 1_000_000;
  const delayMs = options.delayMs ?? 2_000;
  const air = new RoomAir({
    startAt,
    delayMs,
    holdMs: 1_000,
    fadeMs: 200,
    solo: options.solo ?? true,
    durationMs: 60_000,
    gaps: options.gaps ?? [],
    send: (p) => pieces.push(p),
  });
  return { air, pieces, startAt, delayMs };
}

/** The pieces as one sample array from song sample 0 (checks that they are contiguous). */
function joined(pieces: AirPiece[]): Int16Array {
  const out: number[] = [];
  for (const p of pieces) {
    expect(Math.round((p.at_ms * RATE) / 1000)).toBe(out.length);
    for (const b of fromBase64(p.audio) ?? []) out.push(MULAW_TABLE[b] as number);
  }
  return Int16Array.from(out);
}

describe("RoomAir", () => {
  it("places a singer's audio by their latency and sends it ahead of the stream, without gaps", () => {
    const { air, pieces, startAt, delayMs } = rig();
    // 0.5 s of the voice sung at song time 1.0 s, stamped 1.2 s on a device with 200 ms latency.
    air.put("a", 1_200, 200, tone(8_000, 8_000), startAt + 1_700);
    for (let t = 0; t <= 3_000; t += 250) {
      air.tick(startAt + delayMs - AIR_LEAD_MS + t, [
        { key: "a", eligible: true, total: 0, order: 1 },
      ]);
    }
    const all = joined(pieces);
    expect(all.length).toBe(3 * RATE);
    expect(Math.abs(all[RATE - 10] as number)).toBeLessThan(100);
    expect(all[RATE + 10]).toBeGreaterThan(7_000);
    expect(all[RATE + 7_990]).toBeGreaterThan(7_000);
    expect(Math.abs(all[RATE + 8_010] as number)).toBeLessThan(100);
    expect(air.stats()[0]?.delay_ms).toBe(200);
  });

  it("drops audio that comes after its moment was mixed: the delay never grows", () => {
    const { air, pieces, startAt, delayMs } = rig();
    const on = [{ key: "a", eligible: true, total: 0, order: 1 }];
    air.put("a", 0, 0, tone(1_600, 1_000), startAt + 100);
    for (let t = 0; t <= 2_000; t += 250) air.tick(startAt + delayMs - AIR_LEAD_MS + t, on);
    // Song time 0.5 s arrives after the mix passed 2 s: late, silence there.
    air.put("a", 500, 0, tone(1_600, 9_000), startAt + delayMs + 2_000);
    air.tick(startAt + delayMs + 2_000, on);
    const all = joined(pieces);
    expect(Math.abs(all[RATE / 2 + 100] as number)).toBeLessThan(100);
    expect(air.stats()[0]?.late_ms).toBe(100);
    expect(air.cursor).toBeLessThanOrEqual(
      ((delayMs + 2_000 - delayMs + AIR_LEAD_MS) * RATE) / 1000,
    );
  });

  it("switches voices in the next gap between lines with a crossfade", () => {
    const { air, pieces, startAt, delayMs } = rig({ solo: false, gaps: [1_500] });
    air.put("a", 0, 0, tone(4 * RATE, 4_000), startAt);
    air.put("b", 0, 0, tone(4 * RATE, -4_000), startAt);
    const base = startAt + delayMs - AIR_LEAD_MS;
    const board = (a: number, b: number) => [
      { key: "a", eligible: true, total: a, order: 1 },
      { key: "b", eligible: true, total: b, order: 2 },
    ];
    air.tick(base, board(0, 0)); // before any score: the first to join
    expect(air.onAir()).toBe("a");
    air.tick(base + 250, board(50, 60));
    air.tick(base + 500, board(50, 60));
    air.tick(base + 1_250, board(50, 60)); // held 1 s: the switch waits for the gap at 1.5 s
    for (let t = 1_500; t <= 3_000; t += 250) air.tick(base + t, board(50, 60));
    expect(air.onAir()).toBe("b");
    const all = joined(pieces);
    const at = (ms: number) => all[Math.round((ms * RATE) / 1000)] as number;
    expect(at(1_400)).toBeGreaterThan(3_500);
    expect(Math.abs(at(1_600))).toBeLessThan(500); // the middle of the 200 ms fade
    expect(at(1_800)).toBeLessThan(-3_500);
  });

  it("forgets and zeroes everything when the round ends", () => {
    const { air, pieces, startAt, delayMs } = rig();
    air.put("a", 0, 0, tone(RATE, 5_000), startAt);
    air.close();
    air.tick(startAt + delayMs + 5_000, [{ key: "a", eligible: true, total: 0, order: 1 }]);
    expect(pieces).toEqual([]);
    expect(air.stats()).toEqual([]);
  });
});

describe("lyricGaps", () => {
  it("puts a switch in each rest of at least 0.3 s, a little after the line ends", () => {
    const gaps = lyricGaps([
      { start: 1, end: 3 },
      { start: 3.1, end: 5 },
      { start: 6, end: 8 },
    ]);
    expect(gaps).toEqual([5_300]);
  });
});
