// Whether an event stream is still alive, as the page sees it. A connection a proxy or a tunnel
// holds open after the other side is gone never errors and never ends: only silence shows it.
// Both of the panel's streams say something at least every 15 s (the push streams a `ping`
// event, the admin one a comment, which the client sees as bytes), so nothing for `SILENT_MS`
// means dead.
//
// A check that comes very late means the page's timers were held back: a tab in the background
// (its network still runs, so the heartbeats keep arriving: nothing happens) or a laptop that
// slept (nothing arrived: the stream is reconnected once, at once, without backoff). Either way
// one late check costs at most one reconnect, never a storm.

/** Silence after which a stream counts as dead: three heartbeats missed. */
export const SILENT_MS = 45_000;
/** How often the silence is looked at. */
export const WATCH_EVERY_MS = 5_000;
/** A check this much later than it was due means the page's timers were asleep. */
const ASLEEP_MS = 3 * WATCH_EVERY_MS;

export type Death = "silent" | "asleep";

export interface Watchdog {
  /** Something arrived. */
  seen(): void;
  stop(): void;
}

/** Calls `dead` once, when the stream went silent or the page woke up; then stops by itself. */
export function watchdog(dead: (why: Death) => void, now: () => number = Date.now): Watchdog {
  let last = now();
  let checked = last;
  let stopped = false;
  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };
  const timer = setInterval(() => {
    if (stopped) return;
    const t = now();
    const late = t - checked > ASLEEP_MS;
    checked = t;
    // Heard from recently: alive, however late this check is.
    if (t - last < SILENT_MS) return;
    stop();
    dead(late ? "asleep" : "silent");
  }, WATCH_EVERY_MS);
  return {
    seen: () => {
      last = now();
    },
    stop,
  };
}
