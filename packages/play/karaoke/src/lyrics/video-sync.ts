// The background video follows the song, never the other way round (docs/design/karaoke.md
// 「做了什麼第三步」). Every check (about four a second) compares the video's time with the song's
// time (the member page's audio clock, the stream's song clock): far off, it jumps there; a little
// off, it plays a touch faster or slower until it catches up; when the song is not playing, it
// holds still at the song's place. A video that will not play or stops moving is dropped for the
// still picture. No DOM here; the member page's `StageBackground.tsx` and the overlay's karaoke
// scene apply the steps.

/** How often the video is checked against the song, in ms. */
export const VIDEO_CHECK_MS = 250;
/** Further off than this, in seconds, the video jumps to the song's time. */
export const VIDEO_SEEK_S = 0.25;
/** Closer than this it plays at normal speed. */
export const VIDEO_NEAR_S = 0.04;
/** How far the speed may move from 1 while catching up. */
export const VIDEO_RATE_SPAN = 0.05;
/** A video that should play but has not moved for this long, in seconds, is given up. */
export const VIDEO_STALL_S = 5;

/** What the page knows of the video element. */
export interface VideoNow {
  /** `currentTime`, seconds. */
  time: number;
  paused: boolean;
  /** `playbackRate`. */
  rate: number;
  /** `duration`; `NaN` until known. */
  duration: number;
  /** A jump is still being made. */
  seeking: boolean;
}

/** Where the song is: its time (below 0 before the backing starts) and whether it plays. */
export interface SongNow {
  time: number;
  playing: boolean;
}

/** What to do to the video now; an empty step leaves it as it is. */
export interface VideoStep {
  seek?: number;
  rate?: number;
  play?: true;
  pause?: true;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/** The video's time for a song time: from 0 to just before its end. */
export function videoTarget(song: number, duration: number): number {
  const end =
    Number.isFinite(duration) && duration > 0 ? duration - 0.05 : Number.POSITIVE_INFINITY;
  return Math.max(0, Math.min(end, song));
}

/** The speed that closes `drift` seconds (video ahead is positive) in about two seconds. */
export function catchUpRate(drift: number): number {
  if (Math.abs(drift) <= VIDEO_NEAR_S) return 1;
  return round2(Math.max(1 - VIDEO_RATE_SPAN, Math.min(1 + VIDEO_RATE_SPAN, 1 - drift / 2)));
}

/** One check: what the video needs to stay with the song. */
export function videoStep(video: VideoNow, song: SongNow): VideoStep {
  const step: VideoStep = {};
  const target = videoTarget(song.time, video.duration);
  const ended =
    Number.isFinite(video.duration) && video.duration > 0 && song.time >= video.duration;
  // Not playing (before the start, after the end, between songs): still, at the song's place.
  if (!song.playing || song.time < 0 || ended) {
    if (!video.paused) step.pause = true;
    if (video.rate !== 1) step.rate = 1;
    if (!video.seeking && !ended && Math.abs(video.time - target) > VIDEO_SEEK_S)
      step.seek = target;
    return step;
  }
  if (video.seeking) return step;
  const drift = video.time - target;
  if (Math.abs(drift) > VIDEO_SEEK_S) {
    step.seek = target;
    if (video.rate !== 1) step.rate = 1;
  } else {
    const rate = catchUpRate(drift);
    if (rate !== video.rate) step.rate = rate;
  }
  if (video.paused) step.play = true;
  return step;
}

/**
 * Tells a stuck video: one that should be playing whose time has not moved for `VIDEO_STALL_S`.
 * A jump or a pause starts the count again.
 */
export class StallWatch {
  #lastTime = Number.NaN;
  #since: number | null = null;

  /** One check at `now` seconds (any clock): `true` once the video is given up. */
  check(now: number, videoTime: number, shouldPlay: boolean): boolean {
    if (!shouldPlay) {
      this.#since = null;
      this.#lastTime = videoTime;
      return false;
    }
    // It moved, or it was just asked to play: count from now.
    if (videoTime !== this.#lastTime || this.#since === null) {
      this.#since = now;
      this.#lastTime = videoTime;
      return false;
    }
    return now - this.#since >= VIDEO_STALL_S;
  }

  /** After a jump the video may take a moment: count from now. */
  reset(now: number): void {
    this.#since = now;
  }
}
