// One singing of one song in the browser: the detections feed the screen (the running number and
// the singer's line) and the track that is sent. Core scores that track again with the same module
// (`@miyoria/play/karaoke/score`); the number here is shown until Core's comes back.
//
// The score's track comes through a `ScoreTrackSource`, so an accurate detector can fill it later
// (owner 2026-11-17: two layers). This milestone's source is the same detections as the screen.

import type { KaraokeSubmit } from "@miyoria/contracts/api";
import type { WorkersKaraokeReference } from "@miyoria/contracts/workers/karaoke";
import {
  decodeTrack,
  fromBase64,
  LiveScore,
  type PhraseTime,
  type ReferenceCurve,
  type ScoreResult,
  scoreSinging,
  TRACK_HZ,
  TrackRecorder,
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

/** The same detections as the screen, kept at 100 Hz and sent at 50. */
export function liveTrackSource(name = "mcleod"): ScoreTrackSource {
  const recorder = new TrackRecorder(100);
  return {
    name,
    push: (t, midi) => recorder.push(t, midi),
    cut: (t) => recorder.cut(t),
    finish: async () => recorder.encode(),
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
  source?: ScoreTrackSource;
}

export class Take {
  readonly reference: ReferenceCurve;
  readonly source: ScoreTrackSource;
  readonly latencyMs: number;
  readonly #tolerance: number;
  #live: LiveScore;
  #trail: TrailPoint[] = [];

  constructor(reference: ReferenceCurve, options: TakeOptions) {
    this.reference = reference;
    this.source = options.source ?? liveTrackSource();
    this.latencyMs = options.latency_ms;
    this.#tolerance = options.tolerance_cents;
    this.#live = this.#newLive();
  }

  #newLive(): LiveScore {
    return new LiveScore(this.reference, {
      tolerance_cents: this.#tolerance,
      latency_ms: this.latencyMs,
    });
  }

  /** A detection captured at `t` seconds of the song. */
  push(t: number, midi: number | null): void {
    if (t < 0) return;
    this.source.push(t, midi);
    this.#live.push(t, midi);
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
    this.#trail = [];
  }

  get live(): LiveScore {
    return this.#live;
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
