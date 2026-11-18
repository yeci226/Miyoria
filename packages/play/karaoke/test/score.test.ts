import { describe, expect, it } from "vitest";
import {
  asSubmitted,
  decodeTrack,
  encodeTrack,
  fromBase64,
  LiveScore,
  type PitchTrack,
  placeRecording,
  recordingInSong,
  resampleTrack,
  type ScoreInput,
  scoreSinging,
  TRACK_HZ,
  TrackRecorder,
  toBase64,
  voiceChecks,
} from "../src/score/index.js";
import {
  copySinger,
  humanSinger,
  noiseSinger,
  rng,
  type SynthSong,
  silentSinger,
  synthSong,
} from "../src/synth.js";

const song = synthSong(1);

/** Scores `sung` as Core does: the submitted 50 Hz form, the song's lines as phrases. */
function score(
  sung: PitchTrack,
  options: Partial<Omit<ScoreInput, "reference" | "sung">> = {},
  s: SynthSong = song,
) {
  return scoreSinging({
    reference: s.reference,
    sung: { hz: TRACK_HZ, midi: asSubmitted(sung) },
    latency_ms: 0,
    calibrated: true,
    phrases: s.lines,
    ...options,
  });
}

describe("the track", () => {
  it("keeps a frame to a quarter semitone in one byte, and nothing outside C1..D#6", () => {
    const midi = [null, 24, 60, 60.12, 60.13, 69.49, 87.5, 23.5, 88, Number.NaN];
    const back = decodeTrack(encodeTrack(midi));
    expect(back).toEqual([null, 24, 60, 60, 60.25, 69.5, 87.5, null, null, null]);
    for (let m = 30; m < 80; m += 0.07) {
      expect(Math.abs((decodeTrack(encodeTrack([m]))[0] as number) - m)).toBeLessThanOrEqual(0.125);
    }
  });

  it("goes through base64 and back, padded or not", () => {
    for (const n of [0, 1, 2, 3, 4, 5, 250]) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 37 + 11) & 255);
      const text = toBase64(bytes);
      expect(text.length % 4).toBe(0);
      expect(fromBase64(text)).toEqual(bytes);
    }
    expect(toBase64(new Uint8Array([0, 0x10, 0x83]))).toBe("ABCD");
    expect(fromBase64("AB$D")).toBeNull();
    expect(fromBase64("ABC")).toBeNull();
  });

  it("records detections on a grid and sends them at 50 Hz", () => {
    const rec = new TrackRecorder(100);
    rec.push(0.0, 60);
    rec.push(0.011, 62); // frame 1
    rec.push(0.05, null);
    rec.push(0.06, 64);
    rec.push(0.06, 65); // the same frame again: the last stays
    expect(rec.track.midi).toEqual([60, 62, null, null, null, null, 65]);
    expect(rec.seconds).toBeCloseTo(0.07, 5);
    // Seven frames at 100 Hz are three at 50 Hz (the odd one at the end waits for its pair).
    expect(decodeTrack(fromBase64(rec.encode()) as Uint8Array)).toEqual([60, 62, null]);
    rec.cut(0.02);
    expect(rec.track.midi).toEqual([60, 62]);
  });

  it("goes from 100 Hz to 50 Hz by the mean of the voiced frames", () => {
    const at = resampleTrack({ hz: 100, midi: [60, 62, 61, null, null, null, 64, 66] }, 50);
    // Output frame k takes input frames 2k-1 and 2k.
    expect(at).toEqual([60, 61.5, null, 64]);
    expect(resampleTrack({ hz: 50, midi: [1, null] }, 50)).toEqual([1, null]);
  });
});

describe("the score", () => {
  const good = humanSinger(song);
  const goodScore = score(good);

  it("gives a good singer a high score and no flag", () => {
    expect(goodScore.total).toBeGreaterThanOrEqual(85);
    expect(goodScore.pitch.hit).toBeGreaterThan(0.85);
    expect(goodScore.facts.coverage).toBeGreaterThan(0.9);
    expect(goodScore.rhythm.measured).toBe(true);
    expect(goodScore.rhythm.feel).toBe("steady");
    expect(goodScore.flags.too_perfect).toBe(false);
    expect(goodScore.phrases).toHaveLength(song.lines.length);
    const parts =
      goodScore.pitch.score +
      goodScore.stability.score +
      goodScore.rhythm.score +
      goodScore.expression.score;
    expect(goodScore.total).toBeCloseTo(parts, 5);
  });

  it("is the same every time", () => {
    expect(score(good)).toEqual(goodScore);
  });

  it("counts an octave lower as right", () => {
    const low = score(humanSinger(song, { transpose: -12 }));
    expect(low.facts.octave).toBe(-1);
    expect(Math.abs(low.total - goodScore.total)).toBeLessThanOrEqual(1);
    const high = score(humanSinger(song, { transpose: 12 }));
    expect(high.facts.octave).toBe(1);
    expect(Math.abs(high.total - goodScore.total)).toBeLessThanOrEqual(1);
  });

  it("gives a semitone off almost nothing for pitch", () => {
    const off = score(humanSinger(song, { transpose: 1 }));
    expect(off.pitch.score).toBeLessThan(5);
    expect(off.total).toBeLessThan(40);
    expect(off.facts.offset_cents).toBeGreaterThan(80);
    const flat = score(humanSinger(song, { transpose: -0.3 }));
    expect(flat.facts.offset_cents).toBeLessThan(-20);
    expect(flat.total).toBeGreaterThan(off.total);
  });

  it("takes a calibrated latency out", () => {
    const late = humanSinger(song, { lateMs: 150 });
    const fixed = score(late, { latency_ms: 150 });
    expect(Math.abs(fixed.total - goodScore.total)).toBeLessThanOrEqual(1.5);
    expect(fixed.rhythm.feel).toBe("steady");
  });

  it("hears a late singer as late when the latency is calibrated", () => {
    const late = score(humanSinger(song, { lateMs: 150 }));
    expect(late.rhythm.measured).toBe(true);
    expect(late.rhythm.feel).toBe("late");
    expect(late.rhythm.offset_ms).toBeGreaterThanOrEqual(130);
    expect(late.rhythm.offset_ms).toBeLessThanOrEqual(170);
    expect(late.rhythm.score).toBeLessThan(goodScore.rhythm.score - 3);
    expect(late.total).toBeLessThan(goodScore.total);
  });

  it("does not judge rhythm without a calibration", () => {
    const late = score(humanSinger(song, { lateMs: 150 }), { calibrated: false });
    expect(late.rhythm.measured).toBe(false);
    expect(late.rhythm.feel).toBeNull();
    expect(late.rhythm.score).toBeCloseTo((15 * late.pitch.score) / 60, 0);
  });

  it("gives silence nothing", () => {
    const quiet = score(silentSinger(song));
    expect(quiet.total).toBe(0);
    expect(quiet.facts.coverage).toBe(0);
    expect(quiet.facts.best).not.toBeNull();
    expect(quiet.flags.too_perfect).toBe(false);
  });

  it("gives random noise a low score", () => {
    for (const voicing of [1, 0.6, 0.3]) {
      const noise = score(noiseSinger(song, 3, voicing));
      expect(noise.total).toBeLessThan(15);
      expect(noise.expression.vibrato_s).toBe(0);
      expect(noise.flags.too_perfect).toBe(false);
    }
  });

  it("flags a track copied from the reference", () => {
    const copy = score(copySinger(song));
    expect(copy.flags.too_perfect).toBe(true);
    expect(copy.flags.reasons.length).toBeGreaterThan(0);
    const raw = scoreSinging({
      reference: song.reference,
      sung: copySinger(song, 100),
      latency_ms: 0,
      calibrated: true,
    });
    expect(raw.flags.too_perfect).toBe(true);
  });

  it("names the weakest phrase", () => {
    const r = rng(5);
    const bad = 3;
    const line = song.lines[bad] as { start: number; end: number };
    const track = humanSinger(song);
    const midi = track.midi.map((m, j) => {
      const t = j / track.hz;
      return m !== null && t >= line.start && t < line.end ? m + 3 + r() * 0.1 : m;
    });
    const result = score({ hz: track.hz, midi });
    expect(result.facts.weakest).toBe(bad);
    expect(result.facts.best).not.toBe(bad);
    expect(result.phrases[bad]?.score).toBeLessThan(20);
  });

  it("makes phrases from the rests without lyrics", () => {
    const result = score(good, { phrases: null });
    expect(result.phrases.length).toBeGreaterThanOrEqual(song.lines.length - 1);
    expect(result.phrases.length).toBeLessThanOrEqual(song.lines.length + 1);
  });

  it("scores half a song as about half", () => {
    const half = score(humanSinger(song, { stopAfter: song.lines.length / 2 }));
    expect(half.facts.coverage).toBeGreaterThan(0.35);
    expect(half.facts.coverage).toBeLessThan(0.65);
    expect(half.total).toBeLessThan(goodScore.total - 25);
  });

  it("is within a point of the 100 Hz curve the browser had", () => {
    const browser = scoreSinging({
      reference: song.reference,
      sung: good,
      latency_ms: 0,
      calibrated: true,
      phrases: song.lines,
    });
    expect(Math.abs(browser.total - goodScore.total)).toBeLessThanOrEqual(1);
  });
});

describe("the expression bonus", () => {
  /**
   * The good singer, the long notes after 0.3 s held straight (`depth` 0) or with a 6 Hz vibrato
   * of ± `depth` semitones.
   */
  function longNotes(s: SynthSong, depth: number): PitchTrack {
    const base = humanSinger(s);
    const midi = base.midi.map((m, j) => {
      if (m === null) return null;
      const t = j / base.hz;
      const note = s.notes.find((n) => t >= n.start && t < n.end);
      if (note === undefined || note.end - note.start < 0.8 || t - note.start < 0.3) return m;
      return note.midi + depth * Math.sin(2 * Math.PI * 6 * (t - note.start));
    });
    return { hz: base.hz, midi };
  }

  it("finds a vibrato and pays for it", () => {
    const straight = score(longNotes(song, 0));
    const vib = score(longNotes(song, 0.4));
    expect(straight.expression.vibrato_s).toBeLessThan(0.5);
    expect(vib.expression.vibrato_s).toBeGreaterThan(2);
    expect(vib.expression.score).toBeGreaterThan(straight.expression.score);
  });

  it("does not take a wide wobble for a vibrato", () => {
    expect(score(longNotes(song, 2)).expression.vibrato_s).toBe(0);
  });

  it("finds a scoop into a held note", () => {
    const base = humanSinger(song);
    const midi = [...base.midi];
    let added = 0;
    for (const n of song.notes) {
      if (n.end - n.start < 0.8) continue;
      const at = Math.round(n.start * base.hz);
      // From two semitones below over 120 ms, ending on the note.
      for (let k = 0; k < 12; k++) midi[at - 12 + k] = n.midi - 2 + (2 * k) / 12;
      added++;
    }
    const result = score({ hz: base.hz, midi });
    expect(added).toBeGreaterThan(2);
    expect(result.expression.scoops).toBeGreaterThan(0);
    expect(score(base).expression.scoops).toBe(0);
  });

  it("counts long tones held on pitch", () => {
    expect(goodLong()).toBeGreaterThan(0);
    function goodLong() {
      return score(humanSinger(song)).expression.long_tones;
    }
  });
});

describe("the running number", () => {
  it("follows the pitch part as frames come in", () => {
    const track = humanSinger(song);
    const live = new LiveScore(song.reference, {});
    track.midi.forEach((m, j) => {
      live.push(j / track.hz, m);
    });
    const final = score(track);
    const expected = Math.round((100 * final.pitch.score) / 60);
    expect(Math.abs(live.score - expected)).toBeLessThanOrEqual(5);
    expect(live.octave).toBe(0);
  });

  it("knows an octave low and takes the latency out", () => {
    const track = humanSinger(song, { transpose: -12, lateMs: 120 });
    const live = new LiveScore(song.reference, { latency_ms: 120 });
    track.midi.forEach((m, j) => {
      live.push(j / track.hz, m);
    });
    expect(live.octave).toBe(-12);
    expect(live.score).toBeGreaterThan(80);
  });
});

describe("a recording of the singer (the official score)", () => {
  const live = humanSinger(song, { wanderCents: 60 });
  /** The same singing as RMVPE would read it off a recording that started `startS` in. */
  const recorded = (startS: number, transpose = 0) => ({
    hz: 50,
    midi: resampleTrack(humanSinger(song, { transpose }), 50)
      .slice(Math.round(startS * 50))
      .map((m) => m),
  });

  it("is placed where its pitch meets the browser's track, near the browser's start", () => {
    const placed = placeRecording(live, recorded(0.4), 300);
    expect(placed.found).toBe(true);
    expect(Math.abs(placed.offset_ms - 400)).toBeLessThanOrEqual(20);
    // An octave apart (one of them heard an octave off) still meets.
    expect(
      Math.abs(placeRecording(live, recorded(0.4, -12), 500).offset_ms - 400),
    ).toBeLessThanOrEqual(20);
    // Nothing to meet: the browser's start as given.
    expect(placeRecording(silentSinger(song), recorded(0.4), 300)).toEqual({
      offset_ms: 300,
      agreed: 0,
      found: false,
    });
  });

  it("scores the same as the browser's track once placed", () => {
    const placed = placeRecording(live, recorded(0.4), 350);
    const inSong = recordingInSong(recorded(0.4), placed.offset_ms);
    const official = scoreSinging({
      reference: song.reference,
      sung: { hz: 50, midi: inSong },
      latency_ms: 0,
      calibrated: true,
      phrases: song.lines,
    });
    const direct = score(humanSinger(song));
    expect(Math.abs(official.total - direct.total)).toBeLessThanOrEqual(1);
  });

  it("finds a quiet voice and pitch in the song's long rests", () => {
    // A reference with a six-second interlude in the middle.
    const hz = 50;
    const midi: (number | null)[] = [];
    for (let i = 0; i < 20 * hz; i++)
      midi.push(i >= 7 * hz && i < 13 * hz ? null : 60 + (i % 50) / 50);
    const reference = { hz, start: 0, midi };
    const singer = midi.map((m) => (m === null ? null : m + 0.05));
    const loud = { level_db: -22, floor_db: -60 };
    expect(voiceChecks(reference, singer, loud).checks).toEqual([]);
    const bleed = midi.map((m, i) => m ?? 55 + (i % 7) / 10);
    const found = voiceChecks(reference, bleed, loud);
    expect(found.checks).toEqual(["bleed"]);
    expect(found.rest_voiced).toBe(1);
    expect(voiceChecks(reference, singer, { level_db: -55, floor_db: -70 }).checks).toEqual([
      "quiet",
    ]);
    expect(voiceChecks(reference, singer, { level_db: -30, floor_db: -34 }).checks).toEqual([
      "quiet",
    ]);
    // Nothing sung: nothing to say about it.
    expect(
      voiceChecks(
        reference,
        midi.map(() => null),
        { level_db: null, floor_db: -60 },
      ).checks,
    ).toEqual([]);
  });
});
