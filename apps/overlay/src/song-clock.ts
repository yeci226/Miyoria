// The karaoke round's song clock on this page. Each `karaoke` frame says where the song is on the
// stream at the moment it was sent (`position_ms`, negative while it counts down); the page moves
// it on with its own clock (`performance.now()`) until the next frame. Frames come about once a
// second with a little network jitter, so a small difference is eased away over a second and a
// half (the song plays a touch faster or slower, never backwards); a large one (a seek, a frame
// after a stall, the first frame) is jumped to. Pure: the caller passes the time.

/** Off by more than this (ms), the clock jumps to the frame's time instead of easing. */
export const CLOCK_JUMP_MS = 300;
/** How long a small difference takes to ease away (ms). */
export const CLOCK_EASE_MS = 1_500;

export class SongClock {
  /** The song's time at `#at` according to the latest frame. */
  #position: number | null = null;
  #at = 0;
  /** What the page showed less what the frame said, at `#at`; eased to 0 over `CLOCK_EASE_MS`. */
  #offset = 0;

  /** A frame: the song was at `positionMs` when it was received at `now` (ms, the page's clock). */
  update(positionMs: number, now: number): void {
    const shown = this.at(now);
    this.#position = positionMs;
    this.#at = now;
    const off = shown === null ? 0 : shown - positionMs;
    this.#offset = Math.abs(off) > CLOCK_JUMP_MS ? 0 : off;
  }

  /** No round: the clock stops (`at` is null until the next frame). */
  reset(): void {
    this.#position = null;
    this.#offset = 0;
  }

  /** The song's time at `now` (ms), or `null` without a round. */
  at(now: number): number | null {
    if (this.#position === null) return null;
    const since = Math.max(now - this.#at, 0);
    const left = Math.max(1 - since / CLOCK_EASE_MS, 0);
    return this.#position + since + this.#offset * left;
  }
}
