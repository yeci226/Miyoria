// One singing of one song in the browser: the detections feed the screen (the running number and
// the singer's line) and the track that is sent. Core scores that track again with the same module
// (`@miyoria/play/karaoke/score`); the number here is shown until Core's comes back. The number to
// show while singing is `running.score`, the score of the song so far (`RunningScore`), the same
// measure as a room's board and the result (`live.score` is the pitch part alone, on a scale of
// 100). The track is cleaned the way the song worker cleans RMVPE's curve (`cleanTrack`).
//
// The score's track comes through a `ScoreTrackSource`, so an accurate detector can fill it later
// (owner 2026-11-17: two layers). This milestone's source is the same detections as the screen.

import type { KaraokeSubmit } from "@miyoria/contracts/api";
import type { WorkersKaraokeReference } from "@miyoria/contracts/workers/karaoke";
import {
  cleanTrack,
  decodeTrack,
  encodeTrack,
  fromBase64,
  LiveScore,
  type PhraseTime,
  type ReferenceCurve,
  RunningScore,
  resampleTrack,
  type ScoreResult,
  scoreSinging,
  TRACK_HZ,
  TrackRecorder,
  toBase64,
} from "@miyoria/play/karaoke/score";

/** Where the score's track comes from. */
export interface ScoreTrackSource {
  /** For the owner's records (`mcleod`). */
  readonly name: string;
  /** A detection captured at `t` seconds of the song (before the latency). */
  push(t: number, midi: number | null): void;
  /** Drops what was captured from `t` on (a restart). */
  cut(t: number): void;
  /** The track to send: `TRACK_HZ`, one byte a frame, base64. */
  finish(): Promise<string>;
}

/** The same detections as the screen, kept at 100 Hz, cleaned, and sent at 50. */
export function liveTrackSource(name = "mcleod"): ScoreTrackSource {
  const recorder = new TrackRecorder(100);
  return {
    name,
    push: (t, midi) => recorder.push(t, midi),
    cut: (t) => recorder.cut(t),
    finish: async () => toBase64(encodeTrack(resampleTrack(cleanTrack(recorder.track), TRACK_HZ))),
  };
}

export function referenceCurve(ref: Pick<WorkersKaraokeReference, "pitch">): ReferenceCurve {
  return { hz: ref.pitch.hz, start: ref.pitch.start, midi: ref.pitch.midi };
}

/** The lyric lines as phrases, the way Core takes them; `null` without lyrics. */
export function phrasesOf(ref: Pick<WorkersKaraokeReference, "lyrics">): PhraseTime[] | null {
  const lines = ref.lyrics?.lines ?? [];
  return lines.length > 0 ? lines.map((l) => ({ start: l.start, end: l.end })) : null;
}

/** A point of the singer's line: aligned song time and the note moved into the reference's octave. */
export interface TrailPoint {
  t: number;
  midi: number | null;
}

/** Seconds of the singer's line kept behind the now line. */
const TRAIL_KEEP_S = 6;

export interface TakeOptions {
  tolerance_cents: number;
  latency_ms: number;
  /** As sent at the end: rhythm counts only with a measured latency (else the pitch share). */
  calibrated?: boolean;
  /** The lyric lines (`phrasesOf`), as Core takes them; without them the curve's rests. */
  phrases?: PhraseTime[] | null;
  source?: ScoreTrackSource;
}

export class Take {
  readonly reference: ReferenceCurve;
  readonly source: ScoreTrackSource;
  readonly latencyMs: number;
  readonly #tolerance: number;
  readonly #calibrated: boolean;
  readonly #phrases: PhraseTime[] | null;
  #live: LiveScore;
  #running: RunningScore;
  #trail: TrailPoint[] = [];

  constructor(reference: ReferenceCurve, options: TakeOptions) {
    this.reference = reference;
    this.source = options.source ?? liveTrackSource();
    this.latencyMs = options.latency_ms;
    this.#tolerance = options.tolerance_cents;
    this.#calibrated = options.calibrated ?? false;
    this.#phrases = options.phrases ?? null;
    this.#live = this.#newLive();
    this.#running = this.#newRunning();
  }

  #newLive(): LiveScore {
    return new LiveScore(this.reference, {
      tolerance_cents: this.#tolerance,
      latency_ms: this.latencyMs,
    });
  }

  #newRunning(): RunningScore {
    return new RunningScore({
      reference: this.reference,
      latency_ms: this.latencyMs,
      calibrated: this.#calibrated,
      phrases: this.#phrases,
      tuning: { tolerance_cents: this.#tolerance },
    });
  }

  /** A detection captured at `t` seconds of the song. */
  push(t: number, midi: number | null): void {
    if (t < 0) return;
    this.source.push(t, midi);
    this.#live.push(t, midi);
    this.#running.push(t, midi);
    const shown = midi === null ? null : midi - this.#live.octave;
    this.#trail.push({ t: t - this.latencyMs / 1000, midi: shown });
    const keepFrom = t - TRAIL_KEEP_S - this.latencyMs / 1000;
    if ((this.#trail[0]?.t ?? keepFrom) < keepFrom - 1) {
      this.#trail = this.#trail.filter((p) => p.t >= keepFrom);
    }
  }

  /** From the start again: nothing captured so far counts. */
  restart(): void {
    this.source.cut(0);
    this.#live = this.#newLive();
    this.#running = this.#newRunning();
    this.#trail = [];
  }

  /** The pitch part as it comes, and the singer's octave (the line on screen). */
  get live(): LiveScore {
    return this.#live;
  }

  /** The number to show while singing: the score of the song so far (`score`, 0..100). */
  get running(): RunningScore {
    return this.#running;
  }

  get trail(): readonly TrailPoint[] {
    return this.#trail;
  }
}

/** Core's score of exactly what is sent, computed here: what shows until Core answers. */
export function provisionalScore(
  track: string,
  reference: ReferenceCurve,
  opts: {
    latency_ms: number;
    calibrated: boolean;
    phrases: PhraseTime[] | null;
    tolerance_cents: number;
  },
): ScoreResult | null {
  const bytes = fromBase64(track);
  if (bytes === null) return null;
  return scoreSinging({
    reference,
    sung: { hz: TRACK_HZ, midi: decodeTrack(bytes) },
    latency_ms: opts.latency_ms,
    calibrated: opts.calibrated,
    phrases: opts.phrases,
    tuning: { tolerance_cents: opts.tolerance_cents },
  });
}

/** What is posted at the end, and the number shown until Core's comes back. */
export async function finishTake(
  take: Take,
  opts: {
    calibrated: boolean;
    phrases: PhraseTime[] | null;
    tolerance_cents: number;
    browser: string;
  },
): Promise<{ body: KaraokeSubmit; provisional: ScoreResult | null }> {
  const track = await take.source.finish();
  const provisional = provisionalScore(track, take.reference, {
    latency_ms: take.latencyMs,
    calibrated: opts.calibrated,
    phrases: opts.phrases,
    tolerance_cents: opts.tolerance_cents,
  });
  return {
    body: {
      track,
      latency_ms: Math.round(take.latencyMs),
      calibrated: opts.calibrated,
      client_total: provisional === null ? null : provisional.total,
      browser: opts.browser.slice(0, 60),
    },
    provisional,
  };
}
