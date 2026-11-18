// One line's timeline in the reference editor: a ruler and the line's pieces as blocks over where
// the lead is voiced and how loud the backing is, then the guide notes on the singing lane's staff
// (`drawLane`, as the singer sees it) with the reference curve. Pieces: drag an edge (a shared one
// moves both pieces) or the block. Notes: click to pick (Shift or Ctrl adds), drag to move in time
// and by whole semitones, drag an edge to resize, double-click empty lane to add one. Clicking
// anywhere else puts the cursor there. Every drag is one undo step, committed when it ends.

import type { WorkersKaraokeLineV2, WorkersKaraokeNote, WorkersKaraokePiece } from "@miyoria/contracts/workers/karaoke";
import type { ReferenceCurve } from "@miyoria/play/karaoke/score";
import { useCallback, useEffect, useRef, useState } from "react";
import { drawLane, type LaneColors, laneColors, noteHeight } from "../lane-draw";
import { midiToY, type MidiRange } from "../lane";
import {
  dragPiece,
  grabNote,
  grabPiece,
  laneOver,
  MIN_LEN_S,
  type NoteGrab,
  type PieceGrab,
  type Span,
  tToX,
  xToT,
  yToMidi,
} from "./model";
import { ENVELOPE_HZ } from "./player";

const RULER_H = 22;
const STRIP_H = 60;
const LANE_H = 232;
/** Seconds a drag moves by at least (time snaps to it). */
const SNAP_S = 0.01;

export interface TimelineProps {
  line: WorkersKaraokeLineV2;
  /** The time shown. */
  window: { from: number; to: number };
  notes: readonly WorkersKaraokeNote[];
  selection: readonly number[];
  piece: number | null;
  curve: ReferenceCurve;
  envelope: Float32Array;
  range: MidiRange;
  songEnd: number;
  cursor: number;
  /** Song time of the playhead, `null` when stopped. */
  playhead: () => number | null;
  playing: boolean;
  onCursor: (t: number) => void;
  onPiece: (k: number | null) => void;
  /** Pieces dragged: `[k, start, end]` each. */
  onPieces: (changes: [number, number, number][]) => void;
  onSelect: (selection: number[]) => void;
  /** Notes moved by `dt` seconds and `semitones`. */
  onMoveNotes: (selection: readonly number[], dt: number, semitones: number) => void;
  onResizeNote: (i: number, start: number, end: number) => void;
  onAddNote: (start: number, end: number, midi: number) => void;
}

type Drag =
  | { kind: "piece"; grab: PieceGrab; x0: number; moved: boolean; preview: [number, number, number][] }
  | { kind: "note"; grab: NoteGrab; x0: number; y0: number; moved: boolean; dt: number; dm: number; selection: number[] };

const snap = (t: number) => Math.round(t / SNAP_S) * SNAP_S;

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

function sized(canvas: HTMLCanvasElement | null, width: number, height: number): CanvasRenderingContext2D | null {
  if (!canvas || width <= 0) return null;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(width * dpr);
  const h = Math.round(height * dpr);
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

interface Ink extends LaneColors {
  accent: string;
  second: string;
  text: string;
  muted: string;
  line: string;
}

function inkOf(el: Element): Ink {
  const css = getComputedStyle(el);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    ...laneColors(el),
    accent: v("--primary", "#f29dc4"),
    second: v("--secondary", "#7355e8"),
    text: "#f1f0f4",
    muted: "rgba(241, 240, 244, 0.68)",
    line: "rgba(255, 255, 255, 0.2)",
  };
}

const FONT = '"Geist Variable", "PingFang TC", "Microsoft JhengHei UI", "Noto Sans TC", sans-serif';
const MONO = '"Geist Mono Variable", ui-monospace, monospace';

export function Timeline(props: TimelineProps) {
  const [box, width] = useWidth();
  const strip = useRef<HTMLCanvasElement | null>(null);
  const lane = useRef<HTMLCanvasElement | null>(null);
  const drag = useRef<Drag | null>(null);
  const ink = useRef<Ink | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const [hover, setHover] = useState<string>("default");

  const span: Span = { from: props.window.from, to: props.window.to, width };
  const view = laneOver(span, LANE_H, props.range);

  const draw = useCallback(() => {
    const p = latest.current;
    const s: Span = { from: p.window.from, to: p.window.to, width };
    const v = laneOver(s, LANE_H, p.range);
    if (!ink.current && box.current) ink.current = inkOf(box.current);
    const k = ink.current;
    if (!k) return;
    const d = drag.current;
    const head = p.playhead();
    const pieces = piecesWith(p.line.pieces ?? [], d?.kind === "piece" ? d.preview : []);
    const notes = d?.kind === "note" && d.moved ? notesWith(p.notes, d) : p.notes;
    const sctx = sized(strip.current, width, RULER_H + STRIP_H);
    if (sctx) drawStrip(sctx, s, p, pieces, k, head);
    const lctx = sized(lane.current, width, LANE_H);
    if (lctx) {
      drawLane(lctx, {
        view: v,
        reference: p.curve,
        notes,
        trail: [],
        tolerance: 50,
        colors: k,
        dpr: window.devicePixelRatio || 1,
        plain: true,
      });
      drawLaneMarks(lctx, s, v, p, notes, k, head);
    }
  }, [width, box]);

  // Drawn on every change, and every frame while playing or dragging.
  useEffect(() => {
    draw();
  });
  useEffect(() => {
    if (!props.playing) return;
    let raf = 0;
    const loop = () => {
      draw();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [props.playing, draw]);

  const local = (e: React.PointerEvent | React.MouseEvent, el: HTMLCanvasElement | null) => {
    const r = el?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };
  const lineEnd = props.line.end ?? props.songEnd;

  // ---- the strip ----
  const onStripDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = local(e, strip.current);
    if (y < RULER_H) {
      props.onCursor(Math.max(0, snap(xToT(x, span))));
      return;
    }
    const grab = grabPiece(props.line.pieces ?? [], span, x);
    if (grab === null) {
      props.onPiece(null);
      props.onCursor(Math.max(0, snap(xToT(x, span))));
      return;
    }
    props.onPiece(grab.k);
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { kind: "piece", grab, x0: x, moved: false, preview: [] };
  };
  const onStripMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = local(e, strip.current);
    const d = drag.current;
    if (d?.kind === "piece") {
      if (Math.abs(x - d.x0) > 2) d.moved = true;
      if (!d.moved) return;
      const dt = snap(((x - d.x0) / Math.max(1, width)) * (span.to - span.from));
      d.preview = dragPiece(props.line.pieces ?? [], d.grab, dt, props.line.start, lineEnd);
      draw();
      return;
    }
    if (y < RULER_H) return setHover("text");
    const grab = grabPiece(props.line.pieces ?? [], span, x);
    setHover(grab === null ? "default" : grab.kind === "move" ? "grab" : "ew-resize");
  };
  const onStripUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.kind === "piece" && d.moved && d.preview.length > 0) props.onPieces(d.preview);
    else draw();
  };

  // ---- the lane ----
  const onLaneDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = local(e, lane.current);
    const grab = grabNote(props.notes, span, view, x, y, noteHeight(view));
    const adding = e.shiftKey || e.ctrlKey || e.metaKey;
    if (grab === null) {
      if (!adding) props.onSelect([]);
      props.onCursor(Math.max(0, snap(xToT(x, span))));
      return;
    }
    let selection = [...props.selection];
    if (adding) {
      selection = selection.includes(grab.i) ? selection.filter((i) => i !== grab.i) : [...selection, grab.i];
    } else if (!selection.includes(grab.i) || grab.kind !== "move") {
      selection = [grab.i];
    }
    props.onSelect(selection);
    if (!selection.includes(grab.i)) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { kind: "note", grab, x0: x, y0: y, moved: false, dt: 0, dm: 0, selection };
  };
  const onLaneMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = local(e, lane.current);
    const d = drag.current;
    if (d?.kind === "note") {
      if (Math.abs(x - d.x0) > 2 || Math.abs(y - d.y0) > 3) d.moved = true;
      if (!d.moved) return;
      d.dt = snap(((x - d.x0) / Math.max(1, width)) * (span.to - span.from));
      d.dm = d.grab.kind === "move" ? Math.round(yToMidi(y, view) - yToMidi(d.y0, view)) : 0;
      draw();
      return;
    }
    const grab = grabNote(props.notes, span, view, x, y, noteHeight(view));
    setHover(grab === null ? "crosshair" : grab.kind === "move" ? "grab" : "ew-resize");
  };
  const onLaneUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.kind !== "note" || !d.moved) {
      draw();
      return;
    }
    const n = props.notes[d.grab.i];
    if (d.grab.kind === "move") {
      if (d.dt !== 0 || d.dm !== 0) props.onMoveNotes(d.selection, d.dt, d.dm);
    } else if (n !== undefined) {
      const [start, end] = resized(n, d);
      props.onResizeNote(d.grab.i, start, end);
    }
  };
  const onLaneDouble = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = local(e, lane.current);
    if (grabNote(props.notes, span, view, x, y, noteHeight(view)) !== null) return;
    const start = Math.max(0, snap(xToT(x, span)));
    const following = props.notes.find((n) => n.start > start);
    const end = Math.min(start + 0.3, following?.start ?? Number.POSITIVE_INFINITY, props.songEnd);
    if (end - start < MIN_LEN_S) return;
    props.onAddNote(start, end, Math.round(yToMidi(y, view)));
  };

  return (
    <div ref={box} className="grid select-none gap-1" style={{ touchAction: "none" }}>
      <canvas
        ref={strip}
        aria-label="這一行的字和時間"
        role="img"
        className="block w-full rounded-t-md bg-well"
        style={{ height: RULER_H + STRIP_H, cursor: hover }}
        onPointerDown={onStripDown}
        onPointerMove={onStripMove}
        onPointerUp={onStripUp}
        onPointerCancel={onStripUp}
      />
      <canvas
        ref={lane}
        aria-label="這一行的音符"
        role="img"
        className="block w-full rounded-b-md bg-well"
        style={{ height: LANE_H, cursor: hover }}
        onPointerDown={onLaneDown}
        onPointerMove={onLaneMove}
        onPointerUp={onLaneUp}
        onPointerCancel={onLaneUp}
        onDoubleClick={onLaneDouble}
      />
    </div>
  );
}

function piecesWith(pieces: readonly WorkersKaraokePiece[], changes: readonly [number, number, number][]): WorkersKaraokePiece[] {
  if (changes.length === 0) return [...pieces];
  const out = [...pieces];
  for (const [k, start, end] of changes) {
    const p = out[k];
    if (p) out[k] = { ...p, start, end };
  }
  return out;
}

function resized(n: WorkersKaraokeNote, d: Extract<Drag, { kind: "note" }>): [number, number] {
  if (d.grab.kind === "start") return [Math.min(n.start + d.dt, n.end - MIN_LEN_S), n.end];
  return [n.start, Math.max(n.end + d.dt, n.start + MIN_LEN_S)];
}

function notesWith(notes: readonly WorkersKaraokeNote[], d: Extract<Drag, { kind: "note" }>): WorkersKaraokeNote[] {
  return notes.map((n, i) => {
    if (d.grab.kind === "move") {
      return d.selection.includes(i) ? { ...n, start: n.start + d.dt, end: n.end + d.dt, midi: n.midi + d.dm } : n;
    }
    if (i !== d.grab.i) return n;
    const [start, end] = resized(n, d);
    return { ...n, start, end };
  });
}

function drawStrip(
  ctx: CanvasRenderingContext2D,
  s: Span,
  p: TimelineProps,
  pieces: readonly WorkersKaraokePiece[],
  k: Ink,
  head: number | null,
) {
  const w = s.width;
  ctx.clearRect(0, 0, w, RULER_H + STRIP_H);
  // The ruler: a tick every half second, the time every second.
  ctx.font = `12px ${MONO}`;
  ctx.textBaseline = "middle";
  ctx.lineWidth = 1;
  const first = Math.ceil(s.from * 2) / 2;
  for (let t = first; t <= s.to; t += 0.5) {
    const x = Math.round(tToX(t, s)) + 0.5;
    const whole = Math.abs(t - Math.round(t)) < 1e-6;
    ctx.strokeStyle = whole ? k.line : "rgba(255,255,255,0.1)";
    ctx.beginPath();
    ctx.moveTo(x, whole ? RULER_H - 8 : RULER_H - 4);
    ctx.lineTo(x, RULER_H);
    ctx.stroke();
    if (whole) {
      ctx.fillStyle = k.muted;
      ctx.fillText(`${Math.round(t)}s`, x + 3, RULER_H / 2 - 1);
    }
  }
  const top = RULER_H;
  // Outside the line: darker.
  const ls = tToX(p.line.start, s);
  const le = tToX(p.line.end ?? p.songEnd, s);
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.fillRect(0, top, Math.max(0, ls), STRIP_H);
  ctx.fillRect(le, top, Math.max(0, w - le), STRIP_H);
  // The backing's loudness, faint, and where the lead is voiced, a band along the bottom.
  if (p.envelope.length > 0) {
    ctx.fillStyle = "rgba(255,255,255,0.07)";
    ctx.beginPath();
    ctx.moveTo(0, top + STRIP_H);
    for (let x = 0; x <= w; x += 2) {
      const v = p.envelope[Math.round(xToT(x, s) * ENVELOPE_HZ)] ?? 0;
      ctx.lineTo(x, top + STRIP_H - v * (STRIP_H - 6));
    }
    ctx.lineTo(w, top + STRIP_H);
    ctx.closePath();
    ctx.fill();
  }
  ctx.fillStyle = "rgba(255,255,255,0.32)";
  for (let x = 0; x < w; x += 2) {
    const t = xToT(x, s);
    const m = p.curve.midi[Math.round((t - p.curve.start) * p.curve.hz)];
    if (m !== null && m !== undefined) ctx.fillRect(x, top + STRIP_H - 4, 2, 4);
  }
  // The line's own start and end.
  ctx.strokeStyle = k.line;
  ctx.setLineDash([4, 3]);
  for (const x of [ls, le]) {
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, top);
    ctx.lineTo(Math.round(x) + 0.5, top + STRIP_H);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  // The pieces.
  pieces.forEach((piece, i) => {
    if (!piece.sung || piece.start === null || piece.end === null) return;
    const x0 = tToX(piece.start, s);
    const x1 = tToX(piece.end, s);
    const bw = Math.max(2, x1 - x0);
    const picked = p.piece === i;
    ctx.fillStyle = picked ? k.second : "rgba(255,255,255,0.13)";
    ctx.beginPath();
    ctx.roundRect(x0 + 0.5, top + 6, bw - 1, STRIP_H - 16, 4);
    ctx.fill();
    ctx.strokeStyle = picked ? k.second : "rgba(255,255,255,0.28)";
    ctx.stroke();
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0 + 1, top, bw - 2, STRIP_H);
    ctx.clip();
    ctx.textAlign = "center";
    ctx.fillStyle = k.text;
    ctx.font = `15px ${FONT}`;
    ctx.fillText(piece.text, x0 + bw / 2, top + STRIP_H / 2 + 6);
    if (piece.reading) {
      ctx.font = `12px ${FONT}`;
      ctx.fillStyle = k.muted;
      ctx.fillText(piece.reading, x0 + bw / 2, top + 16);
    }
    ctx.restore();
  });
  drawHeads(ctx, s, p, head, RULER_H + STRIP_H, k);
}

function drawLaneMarks(
  ctx: CanvasRenderingContext2D,
  s: Span,
  v: ReturnType<typeof laneOver>,
  p: TimelineProps,
  notes: readonly WorkersKaraokeNote[],
  k: Ink,
  head: number | null,
) {
  const h = noteHeight(v);
  ctx.lineWidth = 2;
  for (const i of p.selection) {
    const n = notes[i];
    if (!n || n.end < s.from || n.start > s.to) continue;
    const x0 = tToX(n.start, s);
    const x1 = tToX(n.end, s);
    const y = midiToY(n.midi, v);
    ctx.fillStyle = k.accent;
    ctx.beginPath();
    ctx.roundRect(x0, y - h / 2, Math.max(2, x1 - x0), h, 3);
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
  }
  // The octave's name at each C, at the left.
  ctx.font = `12px ${MONO}`;
  ctx.fillStyle = k.muted;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  for (let m = Math.ceil(v.lo); m <= v.hi; m++) {
    if (m % 12 === 0) ctx.fillText(`C${m / 12 - 1}`, 4, midiToY(m, v) - 8);
  }
  drawHeads(ctx, s, p, head, LANE_H, k);
}

function drawHeads(ctx: CanvasRenderingContext2D, s: Span, p: TimelineProps, head: number | null, height: number, k: Ink) {
  const cx = Math.round(tToX(p.cursor, s)) + 0.5;
  if (cx >= 0 && cx <= s.width) {
    ctx.strokeStyle = "rgba(255,255,255,0.6)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, height);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (head === null) return;
  const hx = Math.round(tToX(head, s)) + 0.5;
  if (hx < 0 || hx > s.width) return;
  ctx.strokeStyle = k.accent;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(hx, 0);
  ctx.lineTo(hx, height);
  ctx.stroke();
}
