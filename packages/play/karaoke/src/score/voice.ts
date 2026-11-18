// The official score's second layer (docs/design/karaoke.md 「做了什麼第三步」): the song worker
// reads the pitch of a recording of the singer (RMVPE), and Core scores that with `scoreSinging`
// instead of the pitch the browser detected. Two things here, both deterministic:
//
// - `placeRecording`: where the recording's frames fall in song time. The browser says when the
//   recording started (`offset_ms`, from its audio clock); the recorder's own start lag is not
//   known, so the recording is slid, within `range_ms` of that, to where its pitch agrees best with
//   the browser's own track of the same microphone (octaves folded). Both then share the browser
//   track's timeline, so the session's latency applies to both alike.
// - `voiceChecks`: a voice that is very quiet against its own floor, or pitch heard where the song
//   has no voice for seconds (intros, interludes): most likely the backing from speakers reaching
//   the microphone. Either keeps the result off the bests and is shown to the singer.

import type { ReferenceCurve } from "./score.js";
import { type PitchFrames, type PitchTrack, resampleTrack, TRACK_HZ } from "./track.js";

/** Within this many cents (octaves folded) a recorded frame agrees with the browser's. */
const AGREE_CENTS = 50;
/** Fewer agreeing frames than this (two seconds) and the browser's start is taken as it is. */
const MIN_AGREE = 2 * TRACK_HZ;

export interface Placement {
  /** Song time (ms) of the recording's first frame. */
  offset_ms: number;
  /** Frames that agreed with the browser's track there. */
  agreed: number;
  /** The slide was found from the pitch; `false`: the browser's start was used as given. */
  found: boolean;
}

/** `a - b` in semitones, folded into an octave around 0. */
function folded(a: number, b: number): number {
  const d = a - b;
  return d - 12 * Math.round(d / 12);
}

/**
 * Where the recording (`recorded`, from its first sample) sits in the browser's track (`live`,
 * song time): the slide within `rangeMs` of `aroundMs` where most voiced frames agree.
 */
export function placeRecording(
  live: PitchTrack,
  recorded: PitchTrack,
  aroundMs: number,
  rangeMs = 500,
): Placement {
  const a = resampleTrack(live, TRACK_HZ);
  const b = resampleTrack(recorded, TRACK_HZ);
  const base = Math.round((aroundMs / 1000) * TRACK_HZ);
  const reach = Math.max(0, Math.round((rangeMs / 1000) * TRACK_HZ));
  let best = { shift: base, agreed: -1 };
  for (let d = 0; d <= reach; d++) {
    for (const shift of d === 0 ? [base] : [base - d, base + d]) {
      let agreed = 0;
      for (let j = 0; j < b.length; j++) {
        const r = b[j];
        const l = a[j + shift];
        if (r == null || l == null) continue;
        if (Math.abs(folded(r, l)) * 100 <= AGREE_CENTS) agreed++;
      }
      // Ties keep the slide nearest the browser's start (looked at first).
      if (agreed > best.agreed) best = { shift, agreed };
    }
  }
  if (best.agreed < MIN_AGREE)
    return { offset_ms: aroundMs, agreed: Math.max(0, best.agreed), found: false };
  return { offset_ms: (best.shift / TRACK_HZ) * 1000, agreed: best.agreed, found: true };
}

/** The recording's frames in song time from 0 (`offsetMs` from `placeRecording`), at 50 Hz. */
export function recordingInSong(recorded: PitchTrack, offsetMs: number): (number | null)[] {
  const frames = resampleTrack(recorded, TRACK_HZ);
  const shift = Math.round((offsetMs / 1000) * TRACK_HZ);
  const out: (number | null)[] = new Array(Math.max(0, frames.length + shift)).fill(null);
  for (let j = 0; j < frames.length; j++) {
    const i = j + shift;
    if (i >= 0) out[i] = frames[j] ?? null;
  }
  return out;
}

export type VoiceCheck = "quiet" | "bleed";

export interface VoiceLevels {
  /** Median dBFS of the voiced frames, `null` without any. */
  level_db: number | null;
  /** 10th percentile dBFS of all frames. */
  floor_db: number | null;
}

export interface VoiceCheckResult {
  checks: VoiceCheck[];
  /** Share of the frames of the song's long rests where pitch was heard; `null` without rests. */
  rest_voiced: number | null;
  /** Voiced level over the floor, in dB. */
  above_floor_db: number | null;
}

/** Below this the voice is too quiet to trust (dBFS, no automatic gain in the browser). */
export const QUIET_DB = -48;
/** A voice less than this far over the recording's floor is not told from the room. */
export const QUIET_ABOVE_FLOOR_DB = 8;
/** A rest of the reference at least this long (seconds) counts for the bleed check. */
const REST_S = 2;
/** At least this much rest in the song (seconds) for the check to say anything. */
const REST_TOTAL_S = 5;
/** Pitch heard in more than this share of the rests: the backing is reaching the microphone. */
export const BLEED_SHARE = 0.4;

/**
 * Checks of a recorded voice: `sung` in the reference's frames (after the latency, as the score
 * reads it), with the worker's loudness figures.
 */
export function voiceChecks(
  reference: ReferenceCurve,
  sung: PitchFrames,
  levels: VoiceLevels,
): VoiceCheckResult {
  const checks: VoiceCheck[] = [];
  const voicedSung = sung.some((m) => m != null);
  const above =
    levels.level_db === null || levels.floor_db === null
      ? null
      : Math.round((levels.level_db - levels.floor_db) * 10) / 10;
  if (
    voicedSung &&
    ((levels.level_db !== null && levels.level_db < QUIET_DB) ||
      (above !== null && above < QUIET_ABOVE_FLOOR_DB))
  ) {
    checks.push("quiet");
  }
  // The reference's long rests (the intro, interludes, the end), within what was recorded.
  const ref = reference.midi;
  const minRest = Math.round(REST_S * reference.hz);
  let restFrames = 0;
  let heard = 0;
  let run: number[] = [];
  const flush = () => {
    if (run.length >= minRest) {
      for (const i of run) {
        restFrames++;
        if (sung[i] != null) heard++;
      }
    }
    run = [];
  };
  const last = Math.min(ref.length, sung.length);
  for (let i = 0; i < last; i++) {
    if (ref[i] == null) run.push(i);
    else flush();
  }
  flush();
  const restVoiced = restFrames >= REST_TOTAL_S * reference.hz ? heard / restFrames : null;
  if (restVoiced !== null && restVoiced > BLEED_SHARE) checks.push("bleed");
  return {
    checks,
    rest_voiced: restVoiced === null ? null : Math.round(restVoiced * 1000) / 1000,
    above_floor_db: above,
  };
}
