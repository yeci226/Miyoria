// Paints the singing lane on a canvas over the stage: a faint line per semitone (stronger at each
// C), the guide notes as bars (bright ahead, brightest while sung, dim once passed), the reference
// curve thin, the now line, and the singer's line: the primary colour where it is on the
// reference, the secondary where it is off. The look follows the owner's karaoke app; the
// colours are the panel's two accents. Geometry from `lane.ts`.

import type { WorkersKaraokeNote } from "@miyoria/contracts/workers/karaoke";
import type { ReferenceCurve } from "@miyoria/play/karaoke/score";
import { type LaneView, midiToY, NOW_AT, onPitch, referenceAt, timeToX, visibleNotes, visibleWindow } from "./lane";
import type { TrailPoint } from "./take";

export interface LaneColors {
  /** The singer on pitch, and the tip. */
  primary: string;
  /** The singer off pitch. */
  secondary: string;
  curve: string;
  note: string;
  noteNow: string;
  notePast: string;
  semitone: string;
  octave: string;
  now: string;
}

/** A colour the canvas understands, else `fallback` (a theme colour may be a `color-mix`). */
function usable(value: string, fallback: string): string {
  if (!value || typeof document === "undefined") return value || fallback;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return value;
  ctx.fillStyle = "#010203";
  ctx.fillStyle = value;
  return ctx.fillStyle === "#010203" ? fallback : value;
}

/** The theme's colours, read once per canvas. */
export function laneColors(el: Element): LaneColors {
  const css = getComputedStyle(el);
  const v = (name: string, fallback: string) => usable(css.getPropertyValue(name).trim(), fallback);
  return {
    primary: v("--primary", "#f29dc4"),
    secondary: v("--secondary-line", "#a78bfa"),
    curve: "rgba(255, 255, 255, 0.38)",
    note: "rgba(240, 238, 244, 0.82)",
    noteNow: "#ffffff",
    notePast: "rgba(240, 238, 244, 0.26)",
    semitone: "rgba(255, 255, 255, 0.045)",
    octave: "rgba(255, 255, 255, 0.14)",
    now: "rgba(255, 255, 255, 0.55)",
  };
}

export interface LaneFrame {
  view: LaneView;
  reference: ReferenceCurve;
  notes: readonly WorkersKaraokeNote[];
  trail: readonly TrailPoint[];
  /** How close counts as on pitch, in cents. */
  tolerance: number;
  colors: LaneColors;
  /** Device pixels per CSS pixel. */
  dpr: number;
  /**
   * The reference editor's lane: no now line, and every note drawn alike (the editor marks its
   * own selection and playhead over it).
   */
  plain?: boolean;
}

const NOTE_MIN_H = 5;
const NOTE_MAX_H = 12;
/** A gap in the singer's line: silent this long, or a jump this many semitones. */
const GAP_S = 0.12;
const GAP_JUMP = 5;

/** The height of a note's bar on a lane. */
export function noteHeight(view: LaneView): number {
  const semitone = (midiToY(view.lo, view) - midiToY(view.hi, view)) / (view.hi - view.lo);
  return Math.max(NOTE_MIN_H, Math.min(NOTE_MAX_H, semitone * 0.8));
}

export function drawLane(ctx: CanvasRenderingContext2D, f: LaneFrame): void {
  const { view, colors } = f;
  ctx.setTransform(f.dpr, 0, 0, f.dpr, 0, 0);
  ctx.clearRect(0, 0, view.width, view.height);

  // A hairline per semitone, a stronger one at every C.
  ctx.lineWidth = 1;
  for (let m = Math.ceil(view.lo); m <= view.hi; m++) {
    const y = Math.round(midiToY(m, view)) + 0.5;
    ctx.strokeStyle = m % 12 === 0 ? colors.octave : colors.semitone;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(view.width, y);
    ctx.stroke();
  }

  // The guide notes.
  const noteH = noteHeight(view);
  for (const n of visibleNotes(f.notes, view)) {
    const x0 = Math.max(-4, timeToX(n.start, view));
    const x1 = Math.min(view.width + 4, timeToX(n.end, view));
    const y = midiToY(n.midi, view);
    const on = !f.plain && n.start <= view.now && n.end > view.now;
    ctx.fillStyle = f.plain ? colors.note : on ? colors.noteNow : n.end <= view.now ? colors.notePast : colors.note;
    roundRect(ctx, x0, y - noteH / 2, Math.max(2, x1 - x0), noteH, 3);
  }

  // The reference curve.
  const { from, to } = visibleWindow(view);
  const ref = f.reference;
  const first = Math.max(0, Math.floor((from - ref.start) * ref.hz));
  const last = Math.min(ref.midi.length - 1, Math.ceil((to - ref.start) * ref.hz));
  ctx.strokeStyle = colors.curve;
  ctx.lineWidth = 1;
  ctx.lineJoin = "round";
  ctx.beginPath();
  let pen = false;
  for (let i = first; i <= last; i++) {
    const m = ref.midi[i];
    if (m === null || m === undefined) {
      pen = false;
      continue;
    }
    const x = timeToX(ref.start + i / ref.hz, view);
    const y = midiToY(m, view);
    if (pen) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
    pen = true;
  }
  ctx.stroke();

  // The singer, one short segment at a time so each takes its colour.
  const clampY = (m: number) => midiToY(Math.min(view.hi, Math.max(view.lo, m)), view);
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  let prev: TrailPoint | null = null;
  for (const p of f.trail) {
    if (p.midi === null || p.t < from - 0.1 || p.t > view.now + 0.05) {
      prev = null;
      continue;
    }
    if (prev !== null && prev.midi !== null && p.t - prev.t < GAP_S && Math.abs(p.midi - prev.midi) < GAP_JUMP) {
      ctx.strokeStyle = onPitch(p.midi, referenceAt(ref, p.t), f.tolerance) ? colors.primary : colors.secondary;
      ctx.beginPath();
      ctx.moveTo(timeToX(prev.t, view), clampY(prev.midi));
      ctx.lineTo(timeToX(p.t, view), clampY(p.midi));
      ctx.stroke();
    }
    prev = p;
  }

  if (f.plain) return;
  // Now.
  const nowX = Math.round(view.width * NOW_AT) + 0.5;
  ctx.strokeStyle = colors.now;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(nowX, 0);
  ctx.lineTo(nowX, view.height);
  ctx.stroke();
  const tip = f.trail.at(-1);
  if (tip && tip.midi !== null && view.now - tip.t < 0.3) {
    ctx.fillStyle = colors.primary;
    ctx.beginPath();
    ctx.arc(timeToX(tip.t, view), clampY(tip.midi), 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
  ctx.fill();
}

/** One singer's line on the spectators' lane. */
export interface SingerLine {
  points: readonly TrailPoint[];
  /** A colour the canvas understands. */
  color: string;
  dashed: boolean;
}

/**
 * The room's singers over a lane already drawn (`drawLane` with no trail): each line in its own
 * colour, dashed for colours six to eight, with a dot at its newest point near now.
 */
export function drawSingerLines(ctx: CanvasRenderingContext2D, view: LaneView, lines: readonly SingerLine[], dpr: number): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const { from } = visibleWindow(view);
  const clampY = (m: number) => midiToY(Math.min(view.hi, Math.max(view.lo, m)), view);
  ctx.lineWidth = 2.5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const line of lines) {
    ctx.strokeStyle = line.color;
    ctx.setLineDash(line.dashed ? [6, 5] : []);
    ctx.beginPath();
    let prev: TrailPoint | null = null;
    let tip: TrailPoint | null = null;
    for (const p of line.points) {
      if (p.midi === null || p.t < from - 0.1 || p.t > view.now + 0.05) {
        prev = null;
        continue;
      }
      if (prev !== null && prev.midi !== null && p.t - prev.t < GAP_S && Math.abs(p.midi - prev.midi) < GAP_JUMP) {
        ctx.lineTo(timeToX(p.t, view), clampY(p.midi));
      } else {
        ctx.moveTo(timeToX(p.t, view), clampY(p.midi));
      }
      prev = p;
      tip = p;
    }
    ctx.stroke();
    ctx.setLineDash([]);
    if (tip && tip.midi !== null && view.now - tip.t < 0.6) {
      ctx.fillStyle = line.color;
      ctx.beginPath();
      ctx.arc(timeToX(tip.t, view), clampY(tip.midi), 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
