// The song's clock on the audio context's clock (docs/design/karaoke.md §6). The backing track is
// scheduled at a context time; song time is the context time since then plus where it started.
// A pause ends a stretch and a resume starts a new one, so a detection that arrives late is still
// placed by the moment it was captured: in the stretch that was playing then, or nowhere.

interface Stretch {
  /** Context time the stretch began at. */
  from: number;
  /** Song time at `from`. */
  offset: number;
  /** Context time it ended at; `null` while it plays. */
  until: number | null;
}

export class SongClock {
  #stretches: Stretch[] = [];
  /** Song time while paused (or before the start). */
  #held = 0;

  /** The song plays from `offset` seconds, starting at context time `at`. */
  start(at: number, offset = 0): void {
    this.#stretches = [{ from: at, offset, until: null }];
    this.#held = offset;
  }

  get playing(): boolean {
    return this.#stretches.at(-1)?.until === null;
  }

  /** Pauses at context time `at`; the song time it stopped at. */
  pause(at: number): number {
    const last = this.#stretches.at(-1);
    if (!last || last.until !== null) return this.#held;
    const until = Math.max(last.from, at);
    last.until = until;
    this.#held = last.offset + (until - last.from);
    return this.#held;
  }

  /** Goes on from where it paused, at context time `at`. */
  resume(at: number): void {
    if (this.playing) return;
    this.#stretches.push({ from: at, offset: this.#held, until: null });
  }

  /** Song time now (`at` is the context's time): still while paused, below the offset before the start. */
  songTime(at: number): number {
    const last = this.#stretches.at(-1);
    if (!last) return this.#held;
    if (last.until !== null) return this.#held;
    return last.offset + (at - last.from);
  }

  /** The song time of something captured at context time `at`, or `null` when nothing played then. */
  songTimeAt(at: number): number | null {
    for (let i = this.#stretches.length - 1; i >= 0; i--) {
      const s = this.#stretches[i] as Stretch;
      if (at < s.from) continue;
      if (s.until !== null && at > s.until) return null;
      return s.offset + (at - s.from);
    }
    return null;
  }
}

/** What of an `AudioContext` the heard time needs. */
export interface OutputClock {
  currentTime: number;
  baseLatency?: number;
  outputLatency?: number;
  getOutputTimestamp?: () => AudioTimestamp;
}

/**
 * The context time of what is coming out of the speakers now: the browser's output timestamp
 * carried forward to `perfNow` when it gives one, else the context time less the output latency.
 */
export function heardContextTime(ctx: OutputClock, perfNow: number): number {
  const stamp = ctx.getOutputTimestamp?.();
  if (stamp && (stamp.contextTime ?? 0) > 0 && (stamp.performanceTime ?? 0) > 0) {
    const ahead = (perfNow - (stamp.performanceTime as number)) / 1000;
    // Never ahead of what is rendered, never behind it by more than half a second.
    const heard = (stamp.contextTime as number) + Math.max(0, ahead);
    return Math.min(ctx.currentTime, Math.max(ctx.currentTime - 0.5, heard));
  }
  return ctx.currentTime - (ctx.outputLatency ?? ctx.baseLatency ?? 0);
}
