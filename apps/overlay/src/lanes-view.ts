// The karaoke scene's pitch lanes on the page: a column of lanes over the round's screen, one per
// singer (src/lanes.ts decides who and where), each a canvas with the reference notes going past the
// now line and the singer's line in their colour (dashed for colours six to eight), the name and
// running score beside it as text. Redrawn every animation frame on the scene's song clock.

import type { KaraokeLine, KaraokeNote } from "./feed.js";
import { memberSwatch, scoreText } from "./karaoke.js";
import {
  type LaneSinger,
  LaneTracks,
  laneHeight,
  laneRange,
  laneWindow,
  laneX,
  laneY,
  notesIn,
  strokes,
} from "./lanes.js";

/** The column's height and the gap between lanes (rem), as style.css has them. */
const COLUMN_REM = 34;
const COLUMN_RUBY_REM = 29;
const GAP_REM = 0.5;
/** A point this recent (s) gets a dot at the tip of the line. */
const TIP_S = 0.4;

const NOTE = "rgba(240, 238, 244, 0.62)";
const NOTE_NOW = "#ffffff";
const NOTE_PAST = "rgba(240, 238, 244, 0.22)";
const OCTAVE = "rgba(255, 255, 255, 0.10)";
const NOW = "rgba(255, 255, 255, 0.55)";

interface Lane {
  singer: LaneSinger;
  el: HTMLElement;
  score: HTMLElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D | null;
  width: number;
  height: number;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent?: Element, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  parent?.append(e);
  return e;
}

export class LanesView {
  readonly el: HTMLElement;
  readonly #tracks = new LaneTracks();
  #lanes: Lane[] = [];
  #key = "";
  #notes: readonly KaraokeNote[] = [];
  #range = laneRange([]);
  #ruby = false;
  #measured = false;
  /** The members' colours as the canvas takes them (from style.css), read once. */
  #colors: string[] | null = null;

  constructor(parent: Element) {
    this.el = el("div", "k-lanes is-out", parent);
    this.el.hidden = true;
    this.el.setAttribute("aria-hidden", "true");
    addEventListener("resize", () => {
      this.#measured = false;
    });
  }

  /** The singers with a lane now (their order and scores) and the round's notes. */
  set(singers: readonly LaneSinger[], notes: readonly KaraokeNote[], ruby: boolean): void {
    if (notes !== this.#notes) {
      this.#notes = notes;
      this.#range = laneRange(notes);
    }
    const key = JSON.stringify([singers.map((s) => s.key), ruby]);
    if (key !== this.#key) {
      this.#key = key;
      this.#ruby = ruby;
      this.#build(singers);
    }
    singers.forEach((s, i) => {
      const lane = this.#lanes[i];
      if (lane === undefined) return;
      lane.singer = s;
      const text = scoreText(s.total);
      if (lane.score.textContent !== text) lane.score.textContent = text;
    });
  }

  /** A board's pitch pieces. */
  take(board: readonly KaraokeLine[]): void {
    this.#tracks.take(board);
  }

  /** A new round: no pitch is kept. */
  clear(): void {
    this.#tracks.clear();
  }

  #build(singers: readonly LaneSinger[]): void {
    this.el.replaceChildren();
    const height = laneHeight(singers.length, this.#ruby ? COLUMN_RUBY_REM : COLUMN_REM, GAP_REM);
    this.el.classList.toggle("is-compact", height < 5);
    this.el.classList.toggle("has-ruby", this.#ruby);
    this.#lanes = singers.map((singer) => {
      const row = el("div", "k-lane", this.el);
      row.style.height = `${height}rem`;
      const who = el("div", "k-lane__who", row);
      const line = el("div", "k-lane__name", who);
      const { slot, hollow } = memberSwatch(singer.color);
      el("i", `k-swatch k-swatch--${slot}${hollow ? " is-hollow" : ""}`, line);
      // Names are untrusted: text only.
      el("span", "k-lane__text", line, singer.name);
      const score = el("div", "k-lane__score", who, scoreText(singer.total));
      const track = el("div", "k-lane__track", row);
      const canvas = el("canvas", "k-lane__canvas", track);
      return { singer, el: row, score, canvas, ctx: canvas.getContext("2d"), width: 0, height: 0 };
    });
    this.#measured = false;
  }

  #measure(): void {
    const dpr = Math.min(2, devicePixelRatio || 1);
    for (const lane of this.#lanes) {
      lane.width = lane.canvas.clientWidth;
      lane.height = lane.canvas.clientHeight;
      lane.canvas.width = Math.round(lane.width * dpr);
      lane.canvas.height = Math.round(lane.height * dpr);
      lane.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    this.#measured = this.#lanes.every((l) => l.width > 0);
  }

  #color(n: number): string {
    if (this.#colors === null) {
      const css = getComputedStyle(document.documentElement);
      this.#colors = [1, 2, 3, 4, 5].map((i) => css.getPropertyValue(`--k-c${i}`).trim() || "#f29dc4");
    }
    return this.#colors[memberSwatch(n).slot - 1] ?? "#f29dc4";
  }

  /** Draws every lane at song time `t` (seconds). */
  frame(t: number, reduced: boolean): void {
    if (this.el.hidden || this.#lanes.length === 0) return;
    if (!this.#measured) this.#measure();
    const win = laneWindow(t, reduced);
    const notes = notesIn(this.#notes, win.from, win.to);
    for (const lane of this.#lanes) this.#draw(lane, t, win, notes);
  }

  #draw(lane: Lane, t: number, win: { from: number; to: number; nowAt: number }, notes: readonly KaraokeNote[]): void {
    const { ctx, width: w, height: h } = lane;
    if (ctx === null || w <= 0 || h <= 0) return;
    const range = this.#range;
    const pad = Math.min(6, h / 8);
    ctx.clearRect(0, 0, w, h);

    // A hairline at every C.
    ctx.lineWidth = 1;
    ctx.strokeStyle = OCTAVE;
    for (let m = Math.ceil(range.lo / 12) * 12; m <= range.hi; m += 12) {
      const y = Math.round(laneY(m, range, h, pad)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // The reference notes: bright ahead, brightest while sung, dim once passed.
    const semitone = (h - 2 * pad) / (range.hi - range.lo);
    const barH = Math.max(3, Math.min(10, semitone * 0.8));
    for (const n of notes) {
      const x0 = laneX(n.start, win, w);
      const x1 = laneX(n.end, win, w);
      const y = laneY(n.midi, range, h, pad);
      ctx.fillStyle = n.end <= t ? NOTE_PAST : n.start <= t ? NOTE_NOW : NOTE;
      ctx.beginPath();
      const bw = Math.max(2, x1 - x0);
      ctx.roundRect(x0, y - barH / 2, bw, barH, Math.min(3, bw / 2, barH / 2));
      ctx.fill();
    }

    // The singer's line up to now, in their colour.
    const color = this.#color(lane.singer.color);
    const dashed = memberSwatch(lane.singer.color).hollow;
    const points = this.#tracks.line(lane.singer.key, win.from, t, this.#notes);
    ctx.strokeStyle = color;
    ctx.lineWidth = h < 80 ? 2.5 : 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.setLineDash(dashed ? [6, 5] : []);
    for (const run of strokes(points)) {
      ctx.beginPath();
      run.forEach((p, i) => {
        const x = laneX(p.t, win, w);
        const y = laneY(p.midi as number, range, h, pad);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      // A lone point is a dot (a round cap on a line of no length).
      const [only] = run;
      if (run.length === 1 && only !== undefined) ctx.lineTo(laneX(only.t, win, w), laneY(only.midi as number, range, h, pad));
      ctx.stroke();
    }
    ctx.setLineDash([]);
    const tip = points.findLast((p) => p.midi !== null);
    if (tip !== undefined && tip.midi !== null && t - tip.t < TIP_S) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(laneX(tip.t, win, w), laneY(tip.midi, range, h, pad), h < 80 ? 3.5 : 4.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Now.
    const nowX = Math.round(win.nowAt * w) + 0.5;
    ctx.strokeStyle = NOW;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(nowX, 0);
    ctx.lineTo(nowX, h);
    ctx.stroke();
  }
}
