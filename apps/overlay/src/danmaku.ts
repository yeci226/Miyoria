// Danmaku lanes: which paid line crosses the screen when, and in which lane. Pure bookkeeping (no
// DOM, no clock: the view passes in the time and each line's measured width), so every answer the
// page sends about a line comes from here and is unit tested.
//
// Every line moves left at one constant speed. A line of width w enters at x = W (the band's right
// edge) and is done once x + w < 0. A lane takes its next line once the tail of its last line has
// moved `gap` px left of the right edge; with equal speeds the two can then never touch. New lines
// go to the topmost free lane, at most `maxOnScreen` lines cross at once, and the rest wait in a
// FIFO queue (at most `queueMax`, each for at most `maxWaitMs`).

export type DanmakuDropReason = "queue_full" | "too_late" | "cleared";

/** The band the lines cross, in px, and how they move in it. */
export interface DanmakuGeometry {
  /** Band width: lines enter at x = width. */
  width: number;
  lanes: number;
  /** px per second, the same for every line. */
  speed: number;
  /** px between a lane's last tail and the right edge before the lane takes another line. */
  gap: number;
}

/** The owner's limits, sent with every line; the latest ones apply. */
export interface DanmakuLimits {
  maxOnScreen: number;
  queueMax: number;
  maxWaitMs: number;
}

/** A line that started to cross: the view places it at `startX` and moves it from `startAt`. */
export interface DanmakuPlaced {
  id: string;
  lane: number;
  width: number;
  startX: number;
  startAt: number;
  speed: number;
}

/** What one step did; the view paints and answers exactly this. */
export interface DanmakuStep {
  /** Lines that start crossing now (answer `danmaku_shown`). */
  started: DanmakuPlaced[];
  /** Lines that will never show (answer `danmaku_dropped`). */
  dropped: { id: string; reason: DanmakuDropReason }[];
  /** Lines to take off the screen (already answered; no new answer). */
  finished: string[];
}

/** Gentle constant speed, in rem per second (160 px/s at 1080p). */
export const DANMAKU_SPEED_REM = 10;
/** Room between one line's tail and the next line's head in a lane, in rem. */
export const DANMAKU_GAP_REM = 2.5;
/** One lane's height, in rem (the line's own height plus a little air). */
export const DANMAKU_LANE_REM = 2.75;
/** Answered ids remembered, so a repeated frame of the same line is not answered twice. */
const ANSWERED_KEPT = 256;

/** Lanes that fit a band `bandPx` high; at least one, so a tiny band still shows lines. */
export function laneCount(bandPx: number, lanePx: number): number {
  if (!(bandPx > 0) || !(lanePx > 0)) return 1;
  return Math.max(1, Math.floor(bandPx / lanePx + 1e-6));
}

function emptyStep(): DanmakuStep {
  return { started: [], dropped: [], finished: [] };
}

interface Waiting {
  id: string;
  width: number;
  since: number;
}

export class DanmakuLanes {
  private geo: DanmakuGeometry;
  private limits: DanmakuLimits = { maxOnScreen: 12, queueMax: 20, maxWaitMs: 30_000 };
  private readonly crossing = new Map<string, DanmakuPlaced>();
  /** The last line started in each lane (it may already be gone). */
  private readonly lastInLane = new Map<number, DanmakuPlaced>();
  private queue: Waiting[] = [];
  private readonly answered: string[] = [];
  private readonly answeredSet = new Set<string>();

  constructor(geometry: DanmakuGeometry) {
    this.geo = { ...geometry };
  }

  /** New band size or scale (the frame was resized). Lines already crossing keep their motion. */
  setGeometry(geometry: DanmakuGeometry): void {
    this.geo = { ...geometry };
  }

  get geometry(): Readonly<DanmakuGeometry> {
    return this.geo;
  }

  get onScreen(): number {
    return this.crossing.size;
  }

  get waiting(): number {
    return this.queue.length;
  }

  isWaiting(id: string): boolean {
    return this.queue.some((w) => w.id === id);
  }

  /** Where the line's left edge is at `now`, or null when it is not crossing. */
  x(id: string, now: number): number | null {
    const p = this.crossing.get(id);
    return p === undefined ? null : xAt(p, now);
  }

  /**
   * A line arrived, `width` px wide, with the owner's current limits. It starts at once if it can
   * and nothing waits before it, else it waits, or is dropped when the queue is full.
   */
  receive(line: { id: string; width: number }, limits: DanmakuLimits, now: number): DanmakuStep {
    this.limits = { ...limits };
    const step = this.tick(now);
    // The same line again (a repeated frame): it already has, or will get, its one answer.
    if (this.crossing.has(line.id) || this.answeredSet.has(line.id) || this.isWaiting(line.id)) {
      return step;
    }
    if (this.queue.length === 0) {
      const placed = this.tryStart(line.id, line.width, now);
      if (placed !== null) {
        step.started.push(placed);
        return step;
      }
    }
    if (this.queue.length >= Math.max(0, this.limits.queueMax)) {
      this.answer(line.id);
      step.dropped.push({ id: line.id, reason: "queue_full" });
      return step;
    }
    this.queue.push({ id: line.id, width: line.width, since: now });
    return step;
  }

  /** Moves time to `now`: lines past the left edge finish, waiting lines start or run out of time. */
  tick(now: number): DanmakuStep {
    const step = emptyStep();
    for (const [id, p] of this.crossing) {
      if (xAt(p, now) + p.width < 0) {
        this.crossing.delete(id);
        step.finished.push(id);
      }
    }
    // FIFO: only the head may start; every lane suits every line, so nothing behind it could either.
    while (this.queue.length > 0) {
      const head = this.queue[0] as Waiting;
      const placed = this.tryStart(head.id, head.width, now);
      if (placed === null) break;
      this.queue.shift();
      step.started.push(placed);
    }
    const wait = Math.max(0, this.limits.maxWaitMs);
    const stay: Waiting[] = [];
    for (const w of this.queue) {
      if (now - w.since >= wait) {
        this.answer(w.id);
        step.dropped.push({ id: w.id, reason: "too_late" });
      } else stay.push(w);
    }
    this.queue = stay;
    return step;
  }

  /** `danmaku_clear`: every line leaves the screen at once; the waiting ones are dropped. */
  clear(): DanmakuStep {
    const step = emptyStep();
    step.finished.push(...this.crossing.keys());
    this.crossing.clear();
    this.lastInLane.clear();
    for (const w of this.queue) {
      this.answer(w.id);
      step.dropped.push({ id: w.id, reason: "cleared" });
    }
    this.queue = [];
    return step;
  }

  /**
   * The socket went away: the node already counts every unanswered line as lost, so the waiting
   * ones are forgotten without an answer. Lines crossing go on. Returns the forgotten ids.
   */
  disconnect(): string[] {
    const gone = this.queue.map((w) => w.id);
    this.queue = [];
    return gone;
  }

  /** Starts the line now if the screen has room and a lane is free, else null. */
  private tryStart(id: string, width: number, now: number): DanmakuPlaced | null {
    if (this.crossing.size >= Math.max(1, this.limits.maxOnScreen)) return null;
    const lane = this.freeLane(now);
    if (lane === null) return null;
    const placed: DanmakuPlaced = { id, lane, width, startX: this.geo.width, startAt: now, speed: this.geo.speed };
    this.crossing.set(id, placed);
    this.lastInLane.set(lane, placed);
    this.answer(id);
    return placed;
  }

  /** The topmost lane whose last line is far enough from the right edge, or null. */
  private freeLane(now: number): number | null {
    const { width, gap, speed } = this.geo;
    for (let lane = 0; lane < this.geo.lanes; lane++) {
      const last = this.lastInLane.get(lane);
      if (last === undefined || !this.crossing.has(last.id)) return lane;
      const tail = xAt(last, now) + last.width;
      // Equal speeds: the gap never shrinks. A faster newcomer (only after a resize) must not
      // reach the old tail before it leaves the screen, so it waits until the tail is further on.
      const room = speed > last.speed ? (width - gap) * (last.speed / speed) : width - gap;
      if (tail <= room) return lane;
    }
    return null;
  }

  /** Remembers that `id` has its answer (a bounded list: old ids are forgotten). */
  private answer(id: string): void {
    this.answeredSet.add(id);
    this.answered.push(id);
    while (this.answered.length > ANSWERED_KEPT) this.answeredSet.delete(this.answered.shift() as string);
  }
}

/** Left edge of a placed line at `now` (never right of where it entered). */
export function xAt(p: DanmakuPlaced, now: number): number {
  return p.startX - (p.speed * Math.max(0, now - p.startAt)) / 1000;
}
