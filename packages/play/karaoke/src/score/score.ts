// The system's score of one song (docs/design/karaoke.md §5, changed by the owner 2026-11-17: the
// score never depends on the cut notes). The singer's pitch curve is compared frame by frame with
// the reference curve of the lead vocal, after the singer's latency, in the octave the singer
// sings each phrase in, with a tolerance. Four parts:
//
// | part | max | what |
// |---|---|---|
// | pitch | 60 | per reference voiced frame: full within the tolerance, falling to nothing at twice it; a frame not sung counts as missed. The share maps linearly from `pitch_floor` (what noise gets) to `pitch_ceil` |
// | stability | 15 | on the stretches the reference holds for 0.4 s or more: the wobble of the singer's offset once vibrato is smoothed away |
// | rhythm | 15 | the voice's start against each reference onset: the median (early / late) and the spread. Without a calibrated latency, the pitch share instead |
// | expression | 10 | vibrato, long tones, scoops, falls (`expression.ts`), scaled down when the pitch is poor |
//
// Deterministic: the same input gives the same result in the browser and in Core.

import {
  curvePhrases,
  heldSpans,
  median,
  onsets,
  ramp,
  type Span,
  smooth,
  std,
  voicedRuns,
} from "./curve.js";
import { type Expression, expression } from "./expression.js";
import { type PitchFrames, type PitchTrack, resampleTrack } from "./track.js";

/** The reference: the lead vocal's curve, frame `i` at `start + i / hz` seconds. */
export interface ReferenceCurve {
  hz: number;
  start: number;
  midi: PitchFrames;
}

/** A phrase in seconds (a lyric line); `end` `null`: until the next one starts. */
export interface PhraseTime {
  start: number;
  end: number | null;
}

export interface ScoreTuning {
  /** Cents either way that count fully; credit falls to nothing at twice this. */
  tolerance_cents: number;
  /** The pitch share that maps to nothing (about what a random track gets). */
  pitch_floor: number;
  /** The pitch share that maps to full marks. */
  pitch_ceil: number;
}

export const DEFAULT_TUNING: ScoreTuning = {
  tolerance_cents: 50,
  pitch_floor: 0.15,
  pitch_ceil: 0.9,
};

export const PARTS = { pitch: 60, stability: 15, rhythm: 15, expression: 10 } as const;

export interface ScoreInput {
  reference: ReferenceCurve;
  /** The singer's detected pitch as captured (before the latency), at any rate. */
  sung: PitchTrack;
  /** Output plus input latency of the singer's device: the capture is this late. */
  latency_ms: number;
  /** The latency was measured on the device (rhythm counts only then). */
  calibrated: boolean;
  /** The lyric lines, as phrases; without them the phrases come from the curve's rests. */
  phrases?: readonly PhraseTime[] | null;
  tuning?: Partial<ScoreTuning>;
}

export interface PhraseScore {
  /** The lyric line's index, or the phrase's number when the phrases come from the curve. */
  index: number;
  start: number;
  end: number;
  /** 0..100 from this phrase's pitch share. */
  score: number;
  /** Pitch share 0..1. */
  hit: number;
  /** The share of the reference's voiced frames the singer voiced at all. */
  sung: number;
}

export type RhythmFeel = "early" | "late" | "steady";

export interface ScoreResult {
  /** 0..100, the four parts added up. */
  total: number;
  pitch: { score: number; max: number; hit: number };
  stability: { score: number; max: number; wobble_cents: number | null; held: number };
  rhythm: {
    score: number;
    max: number;
    calibrated: boolean;
    /** It was measured (calibrated, and enough onsets found); else the pitch share stood in. */
    measured: boolean;
    /** Median of the voice's start minus the reference's: positive is late. */
    offset_ms: number | null;
    spread_ms: number | null;
    onsets: number;
    found: number;
    feel: RhythmFeel | null;
  };
  expression: { score: number; max: number } & Expression;
  phrases: PhraseScore[];
  facts: {
    /** Share of the reference's voiced frames the singer voiced. */
    coverage: number;
    /** Index into `phrases` of the best and the weakest phrase (half a second of voice or more). */
    best: number | null;
    weakest: number | null;
    /** The singer's octave against the original: -1 an octave below. */
    octave: number;
    /** Median offset in cents where the singer is within a semitone and a half: negative is flat. */
    offset_cents: number | null;
    sung_s: number;
    reference_s: number;
  };
  /** A track that looks made from the reference rather than sung (§9): shown, but unranked. */
  flags: { too_perfect: boolean; reasons: string[] };
}

const round1 = (x: number) => Math.round(x * 10) / 10;
const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** The pitch share as a fraction of full marks. */
export function pitchFraction(hit: number, tuning: ScoreTuning = DEFAULT_TUNING): number {
  return ramp(hit, tuning.pitch_ceil, tuning.pitch_floor);
}

/** Credit of one frame `cents` off. */
export function frameCredit(cents: number, tolerance: number): number {
  const off = Math.abs(cents);
  if (off <= tolerance) return 1;
  return Math.max(0, 1 - (off - tolerance) / tolerance);
}

/** The singer's frames in the reference's frames: resampled, then moved by the latency. */
export function alignSung(
  reference: ReferenceCurve,
  sung: PitchTrack,
  latencyMs: number,
): (number | null)[] {
  const at = resampleTrack(sung, reference.hz);
  const shift = Math.round((reference.start + latencyMs / 1000) * reference.hz);
  return reference.midi.map((_, i) => at[i + shift] ?? null);
}

/** Phrases as frame spans of the reference. */
export function phraseSpans(
  reference: ReferenceCurve,
  phrases: readonly PhraseTime[] | null | undefined,
): { index: number; span: Span }[] {
  const { hz, start, midi } = reference;
  const frame = (s: number) => Math.min(midi.length, Math.max(0, Math.round((s - start) * hz)));
  if (phrases && phrases.length > 0) {
    const lastVoiced = voicedRuns(midi).at(-1)?.end ?? midi.length;
    return phrases
      .map((p, index) => {
        const next = phrases[index + 1]?.start;
        const end = p.end ?? next ?? start + lastVoiced / hz;
        return { index, span: { start: frame(p.start), end: frame(end) } };
      })
      .filter((p) => p.span.end > p.span.start);
  }
  return curvePhrases(midi, Math.round(0.6 * hz), Math.round(2 * hz)).map((span, index) => ({
    index,
    span,
  }));
}

export function scoreSinging(input: ScoreInput): ScoreResult {
  const tuning: ScoreTuning = { ...DEFAULT_TUNING, ...input.tuning };
  const tol = tuning.tolerance_cents;
  const { reference } = input;
  const hz = reference.hz;
  const ref = reference.midi;
  const sung = alignSung(reference, input.sung, input.latency_ms);
  const phrases = phraseSpans(reference, input.phrases);

  // The octave of each frame: per phrase, the singer's median offset to the nearest octave;
  // outside every phrase, the song's.
  const diffs = (from: number, to: number) => {
    const out: number[] = [];
    for (let i = from; i < to; i++) {
      const r = ref[i];
      const s = sung[i];
      if (r !== null && r !== undefined && s !== null && s !== undefined) out.push(s - r);
    }
    return out;
  };
  const toOctave = (d: number | null) => (d === null ? 0 : 12 * Math.round(d / 12) || 0);
  const songOctave = toOctave(median(diffs(0, ref.length)));
  const octave: number[] = new Array(ref.length).fill(songOctave);
  for (const { span } of phrases) {
    const d = median(diffs(span.start, span.end));
    if (d !== null) octave.fill(toOctave(d), span.start, span.end);
  }
  const cents = (i: number): number | null => {
    const r = ref[i];
    const s = sung[i];
    if (r === null || r === undefined || s === null || s === undefined) return null;
    return (s - r - (octave[i] as number)) * 100;
  };

  // Pitch.
  let refVoiced = 0;
  let both = 0;
  let credit = 0;
  let close = 0;
  const near: number[] = [];
  const frameCredits = new Float64Array(ref.length);
  for (let i = 0; i < ref.length; i++) {
    if (ref[i] === null || ref[i] === undefined) continue;
    refVoiced++;
    const c = cents(i);
    if (c === null) continue;
    both++;
    const f = frameCredit(c, tol);
    frameCredits[i] = f;
    credit += f;
    if (Math.abs(c) <= 15) close++;
    if (Math.abs(c) <= 150) near.push(c);
  }
  const hit = refVoiced === 0 ? 0 : credit / refVoiced;
  const pitchFrac = pitchFraction(hit, tuning);
  const pitchScore = round1(PARTS.pitch * pitchFrac);

  // Stability.
  const held = heldSpans(ref, Math.round(0.4 * hz));
  let weighted = 0;
  let weight = 0;
  const wobbles: number[] = [];
  for (const { span } of held) {
    const len = span.end - span.start;
    const offs: number[] = [];
    for (let i = span.start; i < span.end; i++) {
      const c = cents(i);
      if (c !== null) offs.push(c);
    }
    weight += len;
    if (offs.length < 0.5 * len) continue;
    const wobble = std(smooth(offs, 9));
    wobbles.push(wobble);
    weighted += len * ramp(wobble, 12, 60);
  }
  const stabilityFrac = weight === 0 ? pitchFrac : weighted / weight;
  const stabilityScore = round1(PARTS.stability * stabilityFrac);

  // Rhythm.
  const refOnsets = onsets(ref, 3, Math.round(0.15 * hz));
  const window = Math.round(0.3 * hz);
  const offsets: number[] = [];
  for (const i of refOnsets) {
    const target = median(ref.slice(i, i + 6).filter((m): m is number => m !== null));
    if (target === null) continue;
    let best: number | null = null;
    for (let f = Math.max(0, i - window); f <= Math.min(sung.length - 1, i + window); f++) {
      const s = sung[f];
      if (s === null || s === undefined) continue;
      if (f > 0 && sung[f - 1] !== null && sung[f - 1] !== undefined) continue;
      const start = median(sung.slice(f, f + 6).filter((m): m is number => m !== null));
      if (start === null) continue;
      if (Math.abs((start - target - (octave[i] as number)) * 100) > 100) continue;
      if (best === null || Math.abs(f - i) < Math.abs(best - i)) best = f;
    }
    if (best !== null) offsets.push(((best - i) / hz) * 1000);
  }
  const offsetMs = median(offsets);
  const spreadMs =
    offsetMs === null
      ? null
      : 1.4826 * (median(offsets.map((o) => Math.abs(o - offsetMs))) as number);
  const measured = input.calibrated && offsets.length >= 3 && offsetMs !== null;
  let rhythmFrac = pitchFrac;
  if (measured) {
    const timing =
      0.7 * ramp(Math.abs(offsetMs as number), 60, 250) + 0.3 * ramp(spreadMs ?? 0, 40, 200);
    rhythmFrac = timing * Math.min(1, offsets.length / refOnsets.length / 0.7);
  }
  const rhythmScore = round1(PARTS.rhythm * rhythmFrac);
  const feel: RhythmFeel | null =
    !measured || offsetMs === null
      ? null
      : offsetMs > 60
        ? "late"
        : offsetMs < -60
          ? "early"
          : "steady";

  // Expression.
  const exp = expression({ hz, ref, sung, octave, toleranceCents: tol, held });
  const bonus =
    Math.min(4, exp.vibrato_s / 1.5) +
    Math.min(3, 0.6 * exp.long_tones) +
    Math.min(1.5, 0.3 * exp.scoops) +
    Math.min(1.5, 0.3 * exp.falls);
  const expressionScore = round1(Math.min(PARTS.expression, bonus) * Math.min(1, hit / 0.6));

  // Phrases.
  const phraseVoiced: number[] = [];
  const phraseScores: PhraseScore[] = phrases.map(({ index, span }) => {
    let voiced = 0;
    let sungThere = 0;
    let sum = 0;
    for (let i = span.start; i < span.end; i++) {
      if (ref[i] === null || ref[i] === undefined) continue;
      voiced++;
      if (sung[i] !== null && sung[i] !== undefined) sungThere++;
      sum += frameCredits[i] as number;
    }
    phraseVoiced.push(voiced);
    const share = voiced === 0 ? 0 : sum / voiced;
    return {
      index,
      start: round3(reference.start + span.start / hz),
      end: round3(reference.start + span.end / hz),
      score: Math.round(100 * pitchFraction(share, tuning)),
      hit: round3(share),
      sung: voiced === 0 ? 0 : round3(sungThere / voiced),
    };
  });
  let best: number | null = null;
  let weakest: number | null = null;
  let eligible = 0;
  phraseScores.forEach((p, at) => {
    if ((phraseVoiced[at] as number) < Math.round(0.5 * hz)) return;
    eligible++;
    if (best === null || p.score > (phraseScores[best] as PhraseScore).score) best = at;
    if (weakest === null || p.score < (phraseScores[weakest] as PhraseScore).score) weakest = at;
  });
  if (eligible < 2) weakest = null;

  // Made rather than sung: nine frames in ten within 15 cents of the reference over most of it,
  // or nearly that with onsets that do not vary at all.
  const reasons: string[] = [];
  const closeShare = both === 0 ? 0 : close / both;
  const covered = refVoiced > 0 && both >= 0.8 * refVoiced;
  if (covered && closeShare >= 0.9) reasons.push("九成以上的格離原唱不到 15 cents");
  const tight =
    offsets.length >= 8 &&
    spreadMs !== null &&
    spreadMs < 10 &&
    Math.abs(offsetMs ?? 0) < 10 &&
    covered &&
    closeShare >= 0.75;
  if (tight) reasons.push("每一句的起點都和原唱分毫不差");

  const total = round1(Math.min(100, pitchScore + stabilityScore + rhythmScore + expressionScore));
  let sungFrames = 0;
  for (const s of sung) if (s !== null) sungFrames++;
  return {
    total,
    pitch: { score: pitchScore, max: PARTS.pitch, hit: round3(hit) },
    stability: {
      score: stabilityScore,
      max: PARTS.stability,
      wobble_cents: wobbles.length === 0 ? null : round1(median(wobbles) as number),
      held: held.length,
    },
    rhythm: {
      score: rhythmScore,
      max: PARTS.rhythm,
      calibrated: input.calibrated,
      measured,
      offset_ms: offsetMs === null ? null : Math.round(offsetMs),
      spread_ms: spreadMs === null ? null : Math.round(spreadMs),
      onsets: refOnsets.length,
      found: offsets.length,
      feel,
    },
    expression: {
      score: expressionScore,
      max: PARTS.expression,
      vibrato_s: round1(exp.vibrato_s),
      long_tones: exp.long_tones,
      scoops: exp.scoops,
      falls: exp.falls,
    },
    phrases: phraseScores,
    facts: {
      coverage: refVoiced === 0 ? 0 : round3(both / refVoiced),
      best,
      weakest,
      octave: songOctave / 12,
      offset_cents: near.length === 0 ? null : Math.round(median(near) as number),
      sung_s: round1(sungFrames / hz),
      reference_s: round1(refVoiced / hz),
    },
    flags: { too_perfect: reasons.length > 0, reasons },
  };
}
