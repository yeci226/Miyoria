// The browser's side of the score: its detections cleaned the way the song worker cleans RMVPE's
// (`cleanPitch`), and the number shown while singing (`RunningScore`), which is the score of the
// song so far, the measure Core's board shows, not the pitch part alone.

import { describe, expect, it } from "vitest";
import {
  asSubmitted,
  cleanPitch,
  cleanTrack,
  LiveScore,
  type PitchTrack,
  RunningScore,
  type ScoreInput,
  StreamScore,
  scoreSinging,
  TRACK_HZ,
} from "../src/score/index.js";
import { humanSinger, rng, synthSong } from "../src/synth.js";

const song = synthSong(4, 6);
const SONG_S = song.reference.midi.length / song.reference.hz;

function input(latency = 120, calibrated = false): Omit<ScoreInput, "sung"> {
  return {
    reference: song.reference,
    latency_ms: latency,
    calibrated,
    phrases: song.lines,
    tuning: { tolerance_cents: 50 },
  };
}

/** `track` with bursts of `len` frames an octave up (or down), starting on one voiced frame in `every`. */
function slips(track: PitchTrack, every: number, seed = 5, down = false): PitchTrack {
  const r = rng(seed);
  let left = 0;
  return {
    hz: track.hz,
    midi: track.midi.map((m) => {
      if (m === null) return null;
      if (left === 0 && r() < 1 / every) left = 3 + Math.floor(r() * 4);
      if (left === 0) return m;
      left--;
      return m + (down ? -12 : 12);
    }),
  };
}

describe("cleanPitch", () => {
  it("folds short octave slips back to the voice around them", () => {
    const sung = humanSinger(song, { seed: 9 });
    const slipped = slips(sung, 40);
    const changed = slipped.midi.filter((m, i) => m !== sung.midi[i]).length;
    expect(changed).toBeGreaterThan(100);
    const cleaned = cleanPitch(slipped.midi, 100);
    let off = 0;
    cleaned.forEach((m, i) => {
      const s = sung.midi[i];
      if ((m === null) !== (s === null || s === undefined)) off += 1000;
      else if (m !== null && Math.abs(m - (s as number)) > 1) off++;
    });
    expect(off).toBeLessThan(changed / 20);
    // Down as well. (As in the worker, a slip right where a phrase starts can stay.)
    const down = slips(sung, 40, 6, true);
    const left = cleanPitch(down.midi, 100).filter(
      (m, i) => m !== null && Math.abs(m - (sung.midi[i] as number)) > 6,
    ).length;
    expect(left).toBeLessThan(down.midi.filter((m, i) => m !== sung.midi[i]).length / 20);
  });

  it("keeps a real leap that is held, and leaves the unvoiced alone", () => {
    const midi = [...new Array(80).fill(60), null, null, ...new Array(80).fill(72)];
    const cleaned = cleanPitch(midi, 100);
    expect(cleaned.slice(0, 80).every((m) => m === 60)).toBe(true);
    expect(cleaned.slice(80, 82)).toEqual([null, null]);
    // The leap is kept from where the median moves (within a quarter second of it).
    expect(cleaned.slice(82 + 25).every((m) => m === 72)).toBe(true);
    expect(cleanPitch([60, null, 61], 100)).toEqual([60, null, 61]);
  });

  it("filters a one-frame spike inside a run", () => {
    const midi = [60, 60, 60, 63, 60, 60, 60];
    expect(cleanPitch(midi, 100)).toEqual([60, 60, 60, 60, 60, 60, 60]);
  });

  it("gives the score of a slipping singer back", () => {
    const sung = humanSinger(song, { seed: 9, lateMs: 120 });
    const whole = scoreSinging({ ...input(), sung: { hz: TRACK_HZ, midi: asSubmitted(sung) } });
    const slipped = slips(sung, 30);
    const raw = scoreSinging({ ...input(), sung: { hz: TRACK_HZ, midi: asSubmitted(slipped) } });
    const cleaned = scoreSinging({
      ...input(),
      sung: { hz: TRACK_HZ, midi: asSubmitted(cleanTrack(slipped)) },
    });
    expect(whole.total - raw.total).toBeGreaterThan(8);
    expect(Math.abs(whole.total - cleaned.total)).toBeLessThanOrEqual(2);
  });
});

describe("RunningScore", () => {
  it("is the score of the song so far, the board's measure, not the pitch part alone", () => {
    const sung = humanSinger(song, { seed: 9, lateMs: 120, wanderCents: 45 });
    const running = new RunningScore(input());
    const pitchPart = new LiveScore(song.reference, { latency_ms: 120 });
    const half = Math.round((SONG_S / 2) * sung.hz);
    sung.midi.slice(0, half).forEach((m, j) => {
      running.push(j / sung.hz, m);
      pitchPart.push(j / sung.hz, m);
    });
    const board = new StreamScore(input(), SONG_S + 30);
    board.put(0, asSubmitted(cleanTrack({ hz: sung.hz, midi: sung.midi.slice(0, half) })));
    expect(running.result()).toEqual(board.score());
    expect(running.score).toBe(Math.round(board.score().total));
    // The pitch part on a scale of 100 is another number altogether.
    expect(Math.abs(pitchPart.score - running.score)).toBeGreaterThan(5);
    // A phrase not reached yet costs nothing: well above the whole song with half of it missing.
    expect(running.score).toBeGreaterThan(board.final().total + 15);
  });

  it("ends at the score of the whole track as sent", () => {
    const sung = humanSinger(song, { seed: 3, lateMs: 120 });
    const running = new RunningScore(input(120, true));
    sung.midi.forEach((m, j) => {
      running.push(j / sung.hz, m);
    });
    const sent = asSubmitted(cleanTrack(sung));
    expect(running.result()).toEqual(
      scoreSinging({ ...input(120, true), sung: { hz: TRACK_HZ, midi: sent } }),
    );
  });

  it("is computed again once every two seconds of song, and nothing before a detection", () => {
    const running = new RunningScore(input(0));
    expect(running.result()).toBeNull();
    expect(running.score).toBe(0);
    const sung = humanSinger(song, { seed: 2 });
    let j = 0;
    const until = (s: number) => {
      for (; j < s * sung.hz; j++) running.push(j / sung.hz, sung.midi[j] ?? null);
    };
    until(6);
    const first = running.result();
    until(7.5);
    expect(running.result()).toBe(first);
    until(8.2);
    expect(running.result()).not.toBe(first);
  });
});
