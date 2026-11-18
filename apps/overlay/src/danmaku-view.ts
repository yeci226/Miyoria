// The danmaku layer's DOM: one band the lines cross, clipped at its edges. Each line is measured
// off-screen when it arrives, so the lanes (src/danmaku.ts) work with its real width; then it is
// placed and moved with a transform from the rAF clock, and removed once it is past the left edge.
// The page's answers about each line are sent here, exactly as the lane logic reports them.
import type { OverlayMessage, OverlayReply } from "@miyoria/contracts/overlay";
import type { DanmakuBand } from "./config.js";
import {
  DANMAKU_GAP_REM,
  DANMAKU_LANE_REM,
  DANMAKU_SPEED_REM,
  type DanmakuGeometry,
  DanmakuLanes,
  type DanmakuStep,
  laneCount,
} from "./danmaku.js";
import { motionMs, remPx } from "./motion.js";

type DanmakuFrame = Extract<OverlayMessage, { type: "danmaku" }>;

export class DanmakuLayer {
  private readonly band: HTMLElement;
  private readonly lanes: DanmakuLanes;
  /** Lines crossing, by id. */
  private readonly crossing = new Map<string, HTMLElement>();
  /** Lines measured and waiting for a lane, by id (not in the document). */
  private readonly waiting = new Map<string, HTMLElement>();
  private resized = false;

  constructor(
    parent: Element,
    band: DanmakuBand | null,
    private readonly reply: (r: OverlayReply) => void,
  ) {
    this.band = document.createElement("div");
    this.band.className = "danmaku";
    this.band.setAttribute("aria-hidden", "true");
    if (band !== null) {
      this.band.style.top = `${(band.top * 100).toFixed(3)}%`;
      this.band.style.height = `${((band.bottom - band.top) * 100).toFixed(3)}%`;
    }
    this.band.style.setProperty("--dm-lane", `${DANMAKU_LANE_REM}rem`);
    parent.append(this.band);
    this.lanes = new DanmakuLanes(this.measureGeometry());
    new ResizeObserver(() => {
      this.resized = true;
    }).observe(this.band);
  }

  /** The node's `danmaku_ready`, sent after each connect while this layer is on. */
  ready(): void {
    this.reply({ type: "danmaku_ready" });
  }

  receive(m: DanmakuFrame, now: number): void {
    const line = document.createElement("div");
    line.className = "danmaku__line is-measuring";
    if (m.name !== null) {
      const name = document.createElement("span");
      name.className = "danmaku__name";
      name.textContent = m.name;
      line.append(name);
    }
    const text = document.createElement("span");
    text.className = "danmaku__text";
    text.textContent = m.text;
    line.append(text);
    // Laid out in the band (same font, same size) but not seen, then taken out again.
    this.band.append(line);
    const width = Math.ceil(line.getBoundingClientRect().width);
    line.remove();
    line.classList.remove("is-measuring");
    // A repeated frame of a line already here keeps the element it has (the lane logic ignores it).
    const known = this.waiting.has(m.id) || this.crossing.has(m.id);
    if (!known) this.waiting.set(m.id, line);
    this.apply(this.lanes.receive({ id: m.id, width }, limits(m), now));
    if (!known && !this.lanes.isWaiting(m.id)) this.waiting.delete(m.id);
  }

  /** `danmaku_clear`: every line off the screen (a short fade), the waiting ones dropped. */
  clear(): void {
    const step = this.lanes.clear();
    for (const id of step.finished) {
      const e = this.crossing.get(id);
      this.crossing.delete(id);
      if (e === undefined) continue;
      e.classList.add("is-leaving");
      setTimeout(() => e.remove(), motionMs("--t-exit") + 40);
    }
    step.finished = [];
    this.apply(step);
  }

  /** The socket went away: waiting lines are forgotten (no answer can go out); crossing ones go on. */
  disconnect(): void {
    for (const id of this.lanes.disconnect()) this.waiting.delete(id);
  }

  /** Call once per animation frame with the rAF timestamp. */
  frame(now: number): void {
    if (this.resized) {
      this.resized = false;
      this.lanes.setGeometry(this.measureGeometry());
    }
    this.apply(this.lanes.tick(now));
    for (const [id, e] of this.crossing) {
      const x = this.lanes.x(id, now);
      if (x !== null) e.style.transform = `translate3d(${x.toFixed(1)}px, 0, 0)`;
    }
  }

  /** Paints and answers what one step of the lane logic says, nothing more. */
  private apply(step: DanmakuStep): void {
    for (const id of step.finished) {
      this.crossing.get(id)?.remove();
      this.crossing.delete(id);
    }
    for (const p of step.started) {
      const e = this.waiting.get(p.id);
      this.waiting.delete(p.id);
      if (e === undefined) continue;
      e.style.top = `${(p.lane * DANMAKU_LANE_REM * remPx()).toFixed(1)}px`;
      e.style.transform = `translate3d(${p.startX.toFixed(1)}px, 0, 0)`;
      this.band.append(e);
      this.crossing.set(p.id, e);
      // In the document at the right edge: it is crossing now.
      this.reply({ type: "danmaku_shown", id: p.id });
    }
    for (const d of step.dropped) {
      this.waiting.delete(d.id);
      this.reply({ type: "danmaku_dropped", id: d.id, reason: d.reason });
    }
  }

  private measureGeometry(): DanmakuGeometry {
    const rem = remPx();
    const box = this.band.getBoundingClientRect();
    return {
      width: box.width,
      lanes: laneCount(box.height, DANMAKU_LANE_REM * rem),
      speed: DANMAKU_SPEED_REM * rem,
      gap: DANMAKU_GAP_REM * rem,
    };
  }
}

function limits(m: DanmakuFrame): { maxOnScreen: number; queueMax: number; maxWaitMs: number } {
  return { maxOnScreen: m.max_on_screen, queueMax: m.queue_max, maxWaitMs: m.max_wait_ms };
}
