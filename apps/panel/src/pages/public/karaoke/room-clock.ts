// Core's clock in a room (docs/design/karaoke.md §6.1): a round starts for everyone at one moment
// of Core's clock (`start_at_ms`). The browser learns how far its own clock is from Core's with a
// few round trips (`POST .../rooms/{code}/clock`), keeps the one that came back quickest (its error
// is at most half its round trip), and does it again every ten seconds while in the room. The start
// is then placed on the audio context's clock so the backing comes *out of the headphones* at that
// moment: the context time heard now (`heardContextTime`, the output timestamp or the output
// latency) plus how long until then.

/** One round trip: sent at `t0`, answered at `t1` (both this browser's ms), Core's time between. */
export interface ClockSample {
  t0: number;
  t1: number;
  server_ms: number;
}

/** Core's clock minus this browser's, in ms, and the round trip it came from. */
export interface ClockOffset {
  offset: number;
  rtt: number;
}

/** Round trips per sync, and how often it is done again while in a room. */
export const CLOCK_PINGS = 8;
export const CLOCK_EVERY_MS = 10_000;

/** The offset from the quickest round trip: Core's time less the middle of the trip. */
export function clockOffset(samples: readonly ClockSample[]): ClockOffset | null {
  let best: ClockOffset | null = null;
  for (const s of samples) {
    const rtt = s.t1 - s.t0;
    if (!Number.isFinite(rtt) || rtt < 0 || !Number.isFinite(s.server_ms)) continue;
    if (best === null || rtt < best.rtt) best = { offset: s.server_ms - (s.t0 + s.t1) / 2, rtt };
  }
  return best;
}

/** `CLOCK_PINGS` round trips one after another (a failed one is skipped). */
export async function syncClock(
  ping: (t0: number) => Promise<{ server_ms: number }>,
  now: () => number = () => Date.now(),
  pings = CLOCK_PINGS,
): Promise<ClockOffset | null> {
  const samples: ClockSample[] = [];
  for (let i = 0; i < pings; i++) {
    const t0 = now();
    try {
      const reply = await ping(t0);
      samples.push({ t0, t1: now(), server_ms: reply.server_ms });
    } catch {
      // One lost trip: the others will do.
    }
  }
  return clockOffset(samples);
}

/**
 * The context time at which a sound must be rendered to be heard at Core time `startAtMs`:
 * `heardNow` is the context time coming out of the speakers at this browser's `localNowMs`.
 */
export function contextTimeFor(startAtMs: number, offsetMs: number, heardNow: number, localNowMs: number): number {
  return heardNow + (startAtMs - offsetMs - localNowMs) / 1000;
}

/** The song time now by Core's clock (seconds; below 0 before the start). */
export function songTimeByCore(startAtMs: number, offsetMs: number, localNowMs: number): number {
  return (localNowMs + offsetMs - startAtMs) / 1000;
}

/** Whole seconds left before the start, for the countdown (never below 0). */
export function secondsLeft(songTime: number): number {
  return songTime >= 0 ? 0 : Math.ceil(-songTime - 1e-6);
}
