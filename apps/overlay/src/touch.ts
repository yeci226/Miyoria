// Touches: where a viewer touched the stream on the website. Pure bookkeeping (no DOM, no timers):
// parsing, the cap on how many are on screen, and when each one is over. The view draws them.

export const TOUCH_PARTS = ["head", "face", "body", "screen"] as const;
export type TouchPart = (typeof TOUCH_PARTS)[number];

export interface Touch {
  /** 0..1 across the picture, origin top left. */
  x: number;
  y: number;
  part: TouchPart;
}

/** How long a touch stays on screen (ms); the CSS animation runs for the same time. */
export const TOUCH_SHOW_MS = 1300;
/** Touches on screen at once; past this the oldest goes at once. */
export const MAX_TOUCHES = 12;

/** One touch as a feed message, or null when it is not one (every number must be in range). */
export function parseTouch(raw: Record<string, unknown>): Touch | null {
  const { x, y, part } = raw;
  if (typeof x !== "number" || typeof y !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
  if (typeof part !== "string" || !(TOUCH_PARTS as readonly string[]).includes(part)) return null;
  return { x, y, part: part as TouchPart };
}

export interface LiveTouch extends Touch {
  id: number;
  until: number;
}

/** The touches on screen. */
export class TouchSet {
  private seq = 0;
  private live: LiveTouch[] = [];

  /** Adds a touch at `now`; returns it and the ids that must go (the oldest, over the cap). */
  add(touch: Touch, now: number): { touch: LiveTouch; dropped: number[] } {
    const t: LiveTouch = { ...touch, id: ++this.seq, until: now + TOUCH_SHOW_MS };
    this.live.push(t);
    const dropped = this.live.splice(0, Math.max(this.live.length - MAX_TOUCHES, 0)).map((d) => d.id);
    return { touch: t, dropped };
  }

  /** Takes out the touches whose time is up at `now`; returns their ids. */
  expire(now: number): number[] {
    const gone = this.live.filter((t) => now >= t.until).map((t) => t.id);
    if (gone.length > 0) this.live = this.live.filter((t) => now < t.until);
    return gone;
  }

  get size(): number {
    return this.live.length;
  }
}
