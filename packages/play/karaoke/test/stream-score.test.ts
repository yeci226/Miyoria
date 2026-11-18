// `StreamScore`: a room singer's official score while the voice streams in. The property that
// matters: whatever pieces the frames come in (any sizes, out of order, revised, repeated), the
// final number is exactly `scoreSinging` on the whole track at once, and the running number equals
// it once the singing reached the end of the song.

import { describe, expect, it } from "vitest";
import {
  asSubmitted,
  type ScoreInput,
  StreamScore,
  scoreSinging,
  TRACK_HZ,
} from "../src/score/index.js";
import { humanSinger, noiseSinger, rng, synthSong } from "../src/synth.js";

const song = synthSong(4, 6);

function input(latency = 120): Omit<ScoreInput, "sung"> {
  return {
    reference: song.reference,
    latency_ms: latency,
    calibrated: true,
    phrases: song.lines,
    tuning: { tolerance_cents: 50 },
  };
}

/** A sung track as the worker gives it: 50 Hz, a quarter semitone a step. */
const whole = asSubmitted(humanSinger(song, { seed: 9, lateMs: 120 }));

/** Some made-up provisional frames (what the worker said before it settled). */
const wrong = (n: number, r: () => number) =>
  Array.from({ length: n }, () => (r() < 0.3 ? null : 50 + r() * 20));

describe("StreamScore", () => {
  it("ends at exactly the whole track's score, whatever pieces it came in", {
    timeout: 30_000,
  }, () => {
    const once = scoreSinging({ ...input(), sung: { hz: TRACK_HZ, midi: whole } });
    for (let seed = 1; seed <= 25; seed++) {
      const r = rng(seed);
      const s = new StreamScore(input(), song.reference.midi.length / TRACK_HZ + 30);
      let at = 0;
      while (at < whole.length) {
        const size = 1 + Math.floor(r() * 60);
        // A provisional guess first, sometimes (never past the audio there is), then the settled
        // frames over it.
        if (r() < 0.4) s.put(at, wrong(Math.min(size + 10, whole.length - at), r));
        // Sometimes back a little: a revision of frames already given.
        const from = Math.max(0, at - Math.floor(r() * 30));
        s.put(from, whole.slice(from, at + size));
        // A late repeat of an old piece, settled the same.
        if (r() < 0.2 && at > 100) s.put(at - 100, whole.slice(at - 100, at - 50));
        at += size;
      }
      expect(s.final()).toEqual(once);
      s.finish();
      expect(s.finished).toBe(true);
      expect(s.score()).toEqual(once);
      expect(s.score().total).toBe(once.total);
    }
  });

  it("scores the song so far: a phrase not reached yet costs nothing", () => {
    const s = new StreamScore(input(), 600);
    const half = Math.floor(whole.length / 2);
    s.put(0, whole.slice(0, half));
    const soFar = s.score();
    const finalNow = s.final();
    // Half sung well is a good running number, while the whole song with half missing is not.
    expect(soFar.total).toBeGreaterThan(finalNow.total + 15);
    expect(s.reached()).toBeLessThan(song.reference.midi.length);
    // Sung past the end of the reference: the running number is the whole song's.
    s.put(half, [...whole.slice(half), ...new Array(50).fill(null)]);
    expect(s.reached()).toBe(song.reference.midi.length);
    expect(s.score()).toEqual(s.final());
  });

  it("takes a final curve as the whole track, dropping provisional frames past its end", () => {
    const s = new StreamScore(input(0), 600);
    s.put(0, [60, 61, 62, 63, 64]);
    s.put(0, [59, 59, 59], true);
    expect(s.track.midi).toEqual([59, 59, 59]);
    s.put(5, [60], true);
    expect(s.track.midi).toEqual([59, 59, 59, null, null, 60]);
  });

  it("keeps nothing past its limit and drops nonsense", () => {
    const s = new StreamScore(input(0), 2);
    s.put(0, [60, Number.NaN, null, Number.POSITIVE_INFINITY]);
    expect(s.track.midi).toEqual([60, null, null, null]);
    s.put(95, [61, 62, 63, 64, 65, 66, 67, 68]);
    expect(s.length).toBe(100);
    s.put(-1, [60]);
    s.put(1.5, [60]);
    expect(s.length).toBe(100);
  });

  it("tells a noise track from a singer while both are on the way", () => {
    const good = new StreamScore(input(0), 600);
    const noise = new StreamScore(input(0), 600);
    const n = asSubmitted(noiseSinger(song, 5));
    const g = asSubmitted(humanSinger(song, { seed: 2 }));
    for (let at = 0; at < 1200; at += 25) {
      good.put(at, g.slice(at, at + 25));
      noise.put(at, n.slice(at, at + 25));
    }
    expect(good.score().total).toBeGreaterThan(noise.score().total + 30);
  });
});
