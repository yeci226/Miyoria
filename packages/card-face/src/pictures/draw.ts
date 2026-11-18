// The parts every picture is made of, in the panel's own vocabulary (apps/panel/DESIGN.md): the
// frame (a `.glass-dock` header flush with the top edge) and the content glass under it, block
// titles, strips of facts (label over value, no cell walls), hairline rows, meters, the column
// chart, the bar list, the segment bar, the rarity tag and the bond ring. Everything is plain SVG
// that resvg draws with the bundled fonts: no `var()`, no CSS, no `foreignObject`.
//
// A picture is laid out on a logical canvas `WIDTH` px wide and drawn at `SCALE` times that, so
// the type scale is the panel's at about the size Discord shows a picture. Text is measured
// (`measure.ts`) and shortened to its column; nothing is allowed to run past the edge.

import { renderBondRingSvg } from "../render.js";
import { CARD_FONT_FAMILY } from "../fonts.js";
import { drawable, fitText, textWidth, type Weight, wrap } from "./measure.js";
import {
  DUSK_STOPS,
  SECONDARY_LINE,
  SPACE,
  SURFACES,
  type SurfaceKind,
  T,
  TEXT_SHADOW,
  TYPE,
} from "./tokens.js";

/** The logical width of every picture. */
export const WIDTH = 540;
/** Pixels per logical pixel in the PNG. */
export const SCALE = 2;
/** The frame's height. */
export const HEADER = 52;
/** Where the content starts and how wide it is. */
export const X0 = SPACE.page;
export const CONTENT = WIDTH - SPACE.page * 2;

const FONT = CARD_FONT_FAMILY;

/** XML text. */
export function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // Control characters are not allowed in XML.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "");
}

/** A number with thousands separators, and `−` for a minus. */
export function num(n: number): string {
  const r = Math.round(n);
  const s = String(Math.abs(r)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return r < 0 ? `−${s}` : s;
}

/** A signed amount: `+340`, `−220`, `0`. */
export function signed(n: number): string {
  const r = Math.round(n);
  return r > 0 ? `+${num(r)}` : num(r);
}

const r2 = (n: number): string => String(Math.round(n * 100) / 100);

/** `YYYY-MM-DD` as `M/D`. */
export function shortDate(date: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(date);
  return m ? `${Number(m[1])}/${Number(m[2])}` : date;
}

/** An ISO time as `M/D HH:mm` in the given offset. */
export function localTime(iso: string, offsetMinutes: number): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const d = new Date(ms + offsetMinutes * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export interface TextOptions {
  size?: number;
  weight?: Weight;
  fill?: string;
  anchor?: "start" | "middle" | "end";
  /** Shortened to this width. */
  max?: number;
  opacity?: number;
}

/** Where the baseline of a line of `size` px sits below the line's top. */
export const baseline = (top: number, size: number): number => top + size * 0.86;

/** A picture's SVG being built: shapes first, text over them with the glass's text shadow. */
export class Canvas {
  readonly shapes: string[] = [];
  readonly texts: string[] = [];
  /** Text on the frame (its own shadow). */
  readonly frameTexts: string[] = [];

  shape(svg: string): void {
    this.shapes.push(svg);
  }

  /** One line of text whose baseline is at `y`; answers the width drawn. */
  text(x: number, y: number, text: string, o: TextOptions = {}, frame = false): number {
    const size = o.size ?? TYPE.body;
    const weight = o.weight ?? 400;
    const safe = drawable(text, weight);
    const shown = o.max === undefined ? safe : fitText(safe, o.max, size, weight);
    if (shown === "") return 0;
    const attrs = [
      `x="${r2(x)}"`,
      `y="${r2(y)}"`,
      `font-size="${size}"`,
      `font-weight="${weight}"`,
      `fill="${o.fill ?? T.foreground}"`,
    ];
    if (o.anchor && o.anchor !== "start") attrs.push(`text-anchor="${o.anchor}"`);
    if (o.opacity !== undefined) attrs.push(`fill-opacity="${o.opacity}"`);
    (frame ? this.frameTexts : this.texts).push(`<text ${attrs.join(" ")}>${esc(shown)}</text>`);
    return textWidth(shown, size, weight);
  }

  rect(x: number, y: number, w: number, h: number, fill: string, radius = 0): void {
    if (w <= 0 || h <= 0) return;
    const r = radius > 0 ? ` rx="${r2(Math.min(radius, w / 2, h / 2))}"` : "";
    this.shapes.push(
      `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}"${r} fill="${fill}"/>`,
    );
  }

  /** A 1 px line across. */
  hairline(x: number, y: number, w: number, color: string = T.border): void {
    this.rect(x, y, w, 1, color);
  }
}

// ---- the page -------------------------------------------------------------------------------

/** A glass surface: where the backdrop is blurred and darkened, and its fill. */
export interface Surface {
  kind: SurfaceKind;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A laid-out picture: its size, its glass and what is drawn on it. */
export interface Drawn {
  width: number;
  height: number;
  surfaces: Surface[];
  canvas: Canvas;
}

/** The moon with the whale's tail (docs/assets/logo), in a 100 × 100 box. */
const MARK =
  "M71.62 12.34 66.12 9.42 60.29 7.3 54.2 6.02 48 5.6 41.79 6.04 36.39 7.16 30.52 9.22 24.4 12.44 19.4 16.12 15.4 19.95 11.53 24.81 8.37 30.16 6.22 35.26 4.56 41.25 3.77 47.42 3.85 53.63 4.38 57.75 5.69 63.13 7.65 68.29 10.24 73.18 13.4 77.7 18.13 82.75 23.57 87 29.61 90.36 34.1 92.13 40.13 93.67 44.93 94.28 50.45 94.33 55.26 93.81 59.32 92.95 63.42 91.66 67.59 89.72 70.79 87.48 72.81 85.53 74.81 82.85 76.27 79.76 76.95 77.69 77.86 76.7 80.15 75.57 86.73 73.6 90.94 71.92 94.22 69.79 96.14 67.62 96.12 66.25 94.91 65.24 93.34 64.84 87.24 64.36 84.31 64.61 81.56 65.31 79.34 66.33 76.57 68.39 75.9 66.75 74.87 64.93 73.34 63.03 71.51 61.41 68.66 59.61 62.88 57.2 61.43 56.99 60.33 57.32 59.74 58.13 60.11 60.71 61.19 63.1 63.85 66.8 69.7 72.68 71.53 75.13 71.85 76.1 71.59 77.83 70.35 80.34 68.59 82.46 66.59 84.12 63.15 86.03 60.29 87.08 57.29 87.57 54.22 87.48 50.62 86.78 46.13 85.04 42.13 82.71 37.87 79.25 34.15 75.09 31.31 70.8 28.81 65.4 27.38 60.55 26.56 55.21 26.44 50.76 26.76 46.74 27.49 42.74 29.03 37.72 31.03 33.3 33.07 29.86 35.65 26.39 38.86 22.96 42.36 20 46 17.56 49.62 15.66 54.26 13.86 58.74 12.73 62.84 12.15 67.16 12 71.62 12.34Z";

/**
 * Starts a picture: the frame along the top with the mark, `分類 / 頁面` as the panel's header
 * says it, and an aside on the right (a date, a range). Answers the canvas and where the content
 * starts.
 */
export function page(category: string, title: string, aside: string | null): {
  canvas: Canvas;
  top: number;
} {
  const canvas = new Canvas();
  const mid = HEADER / 2;
  canvas.shape(
    `<path d="${MARK}" fill="${T.primary}" transform="translate(${X0} ${mid - 9}) scale(0.18)"/>`,
  );
  const crumbX = X0 + 28;
  const y = baseline(mid - TYPE.body * 0.72, TYPE.body);
  const asideW = aside === null ? 0 : textWidth(aside, TYPE.label) + 16;
  const room = WIDTH - SPACE.page - crumbX - asideW;
  const catW = canvas.text(crumbX, y, category, { fill: T.dockMuted, max: room * 0.45 }, true);
  // SVG drops the spaces around a lone slash, so they are offsets.
  const slashW = canvas.text(crumbX + catW + 6, y, "/", { fill: T.dockMuted, opacity: 0.6 }, true) + 12;
  canvas.text(crumbX + catW + slashW, y, title, { max: room - catW - slashW, weight: 700 }, true);
  if (aside !== null) {
    canvas.text(WIDTH - SPACE.page, y, aside, { size: TYPE.label, fill: T.dockMuted, anchor: "end" }, true);
  }
  canvas.hairline(0, HEADER - 1, WIDTH, T.border);
  return { canvas, top: HEADER + 24 };
}

/** Ends a picture at `bottom`: the frame and the content glass, flush with the edges. */
export function finish(canvas: Canvas, bottom: number): Drawn {
  const height = Math.ceil(bottom + SPACE.page);
  return {
    width: WIDTH,
    height,
    surfaces: [
      { kind: "dock", x: 0, y: 0, w: WIDTH, h: HEADER },
      { kind: "sheet", x: 0, y: HEADER, w: WIDTH, h: height - HEADER },
    ],
    canvas,
  };
}

/**
 * The whole SVG. `backdrop` is the picture behind, already blurred and darkened per surface by
 * the renderer (a data URL at the picture's size); without it the 暮色 gradient stands in, dimmed
 * the way each surface dims the picture.
 */
export function toSvg(drawn: Drawn, backdrop: string | null): string {
  const { width: W, height: H, canvas } = drawn;
  const back: string[] = [];
  if (backdrop !== null) {
    back.push(`<image href="${backdrop}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="none"/>`);
  } else {
    const stops = DUSK_STOPS.map((s) => `<stop offset="${s.offset}" stop-color="${s.color}"/>`).join("");
    back.push(
      `<defs><linearGradient id="dusk" x1="0" y1="0" x2="0.6" y2="1">${stops}</linearGradient></defs>`,
      `<rect width="${W}" height="${H}" fill="url(#dusk)"/>`,
    );
    for (const s of drawn.surfaces) {
      const kept = SURFACES.picture.brightness * SURFACES[s.kind].brightness;
      back.push(
        `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" fill="#000" fill-opacity="${r2(1 - kept)}"/>`,
      );
    }
  }
  const fills = drawn.surfaces.map(
    (s) => `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" fill="${SURFACES[s.kind].fill}"/>`,
  );
  const shadow = (id: string, opacity: number) =>
    `<filter id="${id}" x="-2%" y="-30%" width="104%" height="180%"><feDropShadow dx="0" dy="1" stdDeviation="1" flood-color="#000" flood-opacity="${opacity}"/></filter>`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">`,
    `<defs>${shadow("ts", TEXT_SHADOW.sheet)}${shadow("tf", TEXT_SHADOW.dock)}</defs>`,
    `<rect width="${W}" height="${H}" fill="${T.background}"/>`,
    ...back,
    ...fills,
    ...canvas.shapes,
    `<g filter="url(#tf)">${canvas.frameTexts.join("")}</g>`,
    `<g filter="url(#ts)">${canvas.texts.join("")}</g>`,
    "</svg>",
  ].join("\n");
}

// ---- blocks ---------------------------------------------------------------------------------

/** A block title (15, bold) at `top`; answers where the block's data starts. */
export function blockTitle(c: Canvas, top: number, title: string, aside: string | null = null): number {
  c.text(X0, baseline(top, TYPE.title), title, { size: TYPE.title, weight: 700, max: CONTENT * 0.6 });
  if (aside !== null) {
    c.text(X0 + CONTENT, baseline(top + 1, TYPE.label), aside, {
      size: TYPE.label,
      fill: T.sheetMuted,
      anchor: "end",
      max: CONTENT * 0.38,
    });
  }
  return top + TYPE.title + 12;
}

/** One plain line, for an empty block. */
export function plainLine(c: Canvas, top: number, text: string): number {
  c.text(X0, baseline(top, TYPE.body), text, { fill: T.sheetMuted, max: CONTENT });
  return top + TYPE.body + 6;
}

export interface Fact {
  label: string;
  value: string;
  /** A smaller muted part after the value (a unit). */
  unit?: string;
}

/**
 * A strip of facts: label over value, spaced across the width, no cell walls. `size` is the
 * value's (14 on a strip; 24 for a chart's headline). Answers the bottom.
 */
export function facts(
  c: Canvas,
  top: number,
  items: readonly Fact[],
  size: number = TYPE.body,
  x = X0,
  width = CONTENT,
): number {
  if (items.length === 0) return top;
  const col = width / items.length;
  items.forEach((f, i) => {
    const cx = x + i * col;
    const room = col - 14;
    c.text(cx, baseline(top, TYPE.small), f.label, { size: TYPE.small, fill: T.sheetMuted, max: room });
    const vy = baseline(top + TYPE.small + 6, size);
    const unit = f.unit ?? "";
    const unitW = unit === "" ? 0 : textWidth(unit, TYPE.label) + 4;
    const w = c.text(cx, vy, f.value, { size, weight: 700, max: Math.max(room - unitW, room * 0.6) });
    if (unit !== "") {
      c.text(cx + w + 4, vy, unit, { size: TYPE.label, fill: T.sheetMuted, max: Math.max(room - w - 4, 0) });
    }
  });
  return top + TYPE.small + 6 + size + 4;
}

/** A meter: a 4 px track with the filled part (DESIGN.md `Meter`). */
export function meter(c: Canvas, x: number, y: number, w: number, frac: number, color: string = SECONDARY_LINE): void {
  const f = Math.max(0, Math.min(1, Number.isFinite(frac) ? frac : 0));
  c.rect(x, y, w, 4, T.control, 2);
  if (f > 0) c.rect(x, y, Math.max(w * f, 4), 4, color, 2);
}

/** A meter in steps (the member page's bands): `lit` of `steps` segments. */
export function stepMeter(c: Canvas, x: number, y: number, w: number, steps: number, lit: number): void {
  const gap = 3;
  const seg = (w - gap * (steps - 1)) / steps;
  for (let i = 0; i < steps; i++) {
    c.rect(x + i * (seg + gap), y, seg, 4, i < lit ? SECONDARY_LINE : T.control, 2);
  }
}

/** -1..1 from a centre line (DESIGN.md `Bipolar`). */
export function bipolar(c: Canvas, x: number, y: number, w: number, value: number): void {
  const v = Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
  const mid = x + w / 2;
  c.rect(x, y, w, 4, T.control, 2);
  const len = (Math.abs(v) * w) / 2;
  if (len > 0.5) c.rect(v > 0 ? mid : mid - len, y, len, 4, v > 0 ? SECONDARY_LINE : T.primary, 1);
  c.rect(mid - 0.5, y - 3, 1, 10, T.chartAxis);
}

/** A legend: a swatch and a name each, in one row; answers the bottom. */
export function legend(c: Canvas, top: number, items: readonly { label: string; color: string }[], x = X0): number {
  let cx = x;
  for (const item of items) {
    c.rect(cx, top + 3, 8, 8, item.color, 2);
    cx += 12 + c.text(cx + 12, baseline(top, TYPE.small), item.label, { size: TYPE.small, fill: T.sheetMuted }) + 16;
  }
  return top + TYPE.small + 4;
}

/** A column (or a stacked segment) whose data end is rounded by 4 px. */
function column(c: Canvas, x: number, top: number, w: number, h: number, color: string, roundTop: boolean): void {
  if (h <= 0) return;
  const r = Math.min(4, w / 2, h);
  if (r <= 0.5) {
    c.rect(x, top, w, h, color);
    return;
  }
  const b = top + h;
  const d = roundTop
    ? `M${r2(x)} ${r2(b)}V${r2(top + r)}Q${r2(x)} ${r2(top)} ${r2(x + r)} ${r2(top)}H${r2(x + w - r)}Q${r2(x + w)} ${r2(top)} ${r2(x + w)} ${r2(top + r)}V${r2(b)}Z`
    : `M${r2(x)} ${r2(top)}V${r2(b - r)}Q${r2(x)} ${r2(b)} ${r2(x + r)} ${r2(b)}H${r2(x + w - r)}Q${r2(x + w)} ${r2(b)} ${r2(x + w)} ${r2(b - r)}V${r2(top)}Z`;
  c.shape(`<path d="${d}" fill="${color}"/>`);
}

export interface ColumnSeries {
  label: string;
  color: string;
  /** One value per column, 0 or more. */
  values: readonly number[];
  /** Drawn below the baseline (a diverging chart). */
  down?: boolean;
}

/**
 * The column chart (DESIGN.md `ColumnChart`): columns at most 24 px wide, a 4 px rounded data
 * end, 2 px between stacked segments; series going up are stacked in order, a `down` series hangs
 * below the baseline. A gridline at the top value with its number, ticks under the columns, the
 * last column's tick in full text (today). Answers the bottom.
 */
export function columnChart(
  c: Canvas,
  top: number,
  ticks: readonly string[],
  series: readonly ColumnSeries[],
  height = 112,
): number {
  const n = ticks.length;
  if (n === 0) return top;
  const up = series.filter((s) => !s.down);
  const down = series.filter((s) => s.down);
  const sumAt = (list: readonly ColumnSeries[], i: number) =>
    list.reduce((t, s) => t + Math.max(0, s.values[i] ?? 0), 0);
  const maxUp = Math.max(0, ...ticks.map((_, i) => sumAt(up, i)));
  const maxDown = Math.max(0, ...ticks.map((_, i) => sumAt(down, i)));
  const total = maxUp + maxDown;
  const labelW = Math.max(textWidth(num(maxUp), TYPE.tick), textWidth(num(maxDown), TYPE.tick)) + 8;
  const plotX = X0 + labelW;
  const plotW = CONTENT - labelW;
  const plotTop = top + 6;
  const upH = total === 0 ? height : (height * maxUp) / total;
  const base = plotTop + (down.length === 0 ? height : Math.max(upH, total === 0 ? height / 2 : upH));
  const scale = total === 0 ? 0 : height / total;
  // Gridlines with their values.
  if (maxUp > 0) {
    c.hairline(plotX, plotTop, plotW, T.chartGrid);
    c.text(X0, plotTop + 4, num(maxUp), { size: TYPE.tick, fill: T.sheetMuted });
  }
  if (maxDown > 0) {
    const y = base + maxDown * scale;
    c.hairline(plotX, y, plotW, T.chartGrid);
    c.text(X0, y + 4, num(maxDown), { size: TYPE.tick, fill: T.sheetMuted });
  }
  c.hairline(plotX, base, plotW, T.chartAxis);
  const slot = plotW / n;
  const w = Math.min(24, slot * 0.56);
  for (let i = 0; i < n; i++) {
    const x = plotX + slot * i + (slot - w) / 2;
    // Up: stacked from the baseline, 2 px between segments, the top one rounded.
    let y = base;
    const parts = up.map((s) => ({ s, v: Math.max(0, s.values[i] ?? 0) })).filter((p) => p.v > 0);
    parts.forEach((p, k) => {
      const h = p.v * scale;
      const gap = k === 0 ? 0 : 2;
      const hh = Math.max(h - gap, 1);
      column(c, x, y - gap - hh, w, hh, p.s.color, k === parts.length - 1);
      y -= gap + hh;
    });
    let yd = base + 1;
    const below = down.map((s) => ({ s, v: Math.max(0, s.values[i] ?? 0) })).filter((p) => p.v > 0);
    below.forEach((p, k) => {
      const h = Math.max(p.v * scale - (k === 0 ? 1 : 2), 1);
      const at = yd + (k === 0 ? 0 : 2);
      column(c, x, at, w, h, p.s.color, false);
      yd = at + h;
    });
    const last = i === n - 1;
    c.text(x + w / 2, plotTop + height + (maxDown > 0 ? 0 : 0) + 18, ticks[i] ?? "", {
      size: TYPE.tick,
      fill: last ? T.foreground : T.sheetMuted,
      anchor: "middle",
      max: slot,
    });
  }
  return plotTop + height + 24;
}

export interface BarRow {
  label: string;
  value: number;
  /** What the value column says; the number by default. */
  shown?: string;
  color?: string;
  /** A rarity tag before the label. */
  rarity?: string;
}

/**
 * The bar list (DESIGN.md `BarList`): horizontal bars, largest first (the caller sorts), the label
 * on the left, the value in a fixed column on the right. `max` is the value of a full bar (the
 * largest by default). Answers the bottom.
 */
export function barList(
  c: Canvas,
  top: number,
  rows: readonly BarRow[],
  color: string,
  options: { max?: number; labelShare?: number; valueWidth?: number; x?: number; width?: number } = {},
): number {
  const x = options.x ?? X0;
  const width = options.width ?? CONTENT;
  const max = options.max ?? Math.max(0, ...rows.map((r) => r.value));
  const hasTag = rows.some((r) => r.rarity !== undefined);
  const labelW = width * (options.labelShare ?? 0.36);
  const valueW =
    options.valueWidth ??
    Math.max(40, ...rows.map((r) => textWidth(r.shown ?? num(r.value), TYPE.label) + 8));
  const barX = x + labelW + 10;
  const barW = width - labelW - 10 - valueW - 8;
  let y = top;
  for (const row of rows) {
    let lx = x;
    if (hasTag) {
      if (row.rarity !== undefined) rarityTag(c, lx, y + 1, row.rarity, 28);
      lx += 34;
    }
    c.text(lx, baseline(y, TYPE.label), row.label, { size: TYPE.label, max: x + labelW - lx });
    const frac = max > 0 ? row.value / max : 0;
    c.rect(barX, y + 5, barW, 8, T.chartFaint, 2);
    if (frac > 0) c.rect(barX, y + 5, Math.max(barW * Math.min(frac, 1), 3), 8, row.color ?? color, 2);
    c.text(x + width, baseline(y, TYPE.label), row.shown ?? num(row.value), {
      size: TYPE.label,
      anchor: "end",
      max: valueW,
    });
    y += 26;
  }
  return y - 8;
}

/** The segment bar (DESIGN.md `SegmentBar`): one 100% bar, the counts in the legend. */
export function segmentBar(
  c: Canvas,
  top: number,
  parts: readonly { label: string; count: number; color: string }[],
): number {
  const total = parts.reduce((t, p) => t + Math.max(0, p.count), 0);
  const shown = parts.filter((p) => p.count > 0);
  if (total > 0) {
    const gap = 2;
    const least = 4;
    const room = CONTENT - gap * (shown.length - 1);
    // A segment too small to see keeps `least` px; the others share what is left by count.
    const small = shown.filter((p) => (room * p.count) / total < least);
    const bigTotal = total - small.reduce((t, p) => t + p.count, 0);
    const bigRoom = room - small.length * least;
    let x = X0;
    shown.forEach((p, i) => {
      const w = small.includes(p) || bigTotal <= 0 ? least : (bigRoom * p.count) / bigTotal;
      const last = i === shown.length - 1;
      c.rect(x, top, last ? X0 + CONTENT - x : w, 10, p.color, 2);
      x += w + gap;
    });
  } else {
    c.rect(X0, top, CONTENT, 10, T.chartFaint, 2);
  }
  return legend(
    c,
    top + 22,
    parts.map((p) => ({ label: `${p.label} ${num(p.count)}`, color: p.color })),
  );
}

/** Rarity, rising in weight in the two accents (DESIGN.md "卡冊"): N quiet, R bright, SR primary text, SSR solid primary. */
export function rarityTag(c: Canvas, x: number, y: number, rarity: string, w = 34): void {
  const h = 16;
  const solid = rarity === "SSR";
  const fill = solid ? T.primary : rarity === "N" ? "none" : T.control;
  if (fill === "none") {
    c.shape(
      `<rect x="${r2(x + 0.5)}" y="${r2(y + 0.5)}" width="${w - 1}" height="${h - 1}" rx="3" fill="none" stroke="${T.lineStrong}"/>`,
    );
  } else {
    c.rect(x, y, w, h, fill, 3);
  }
  const color = solid ? T.primaryInk : rarity === "SR" ? T.primary : rarity === "N" ? T.sheetMuted : T.foreground;
  // The tag is solid: its letters carry no shadow.
  c.shape(
    `<text x="${r2(x + w / 2)}" y="${r2(y + 12)}" font-size="${TYPE.tick}" font-weight="700" fill="${color}" text-anchor="middle">${esc(fitText(rarity, w - 4, TYPE.tick, 700))}</text>`,
  );
}

/** The bond ring (`BondRing`, the same drawing as the panel's) in a `size` px square. */
export function ring(
  c: Canvas,
  x: number,
  y: number,
  size: number,
  spec: { lap: number; fraction: number; full: boolean; below: number; value?: number },
  title: string,
): void {
  const svg = renderBondRingSvg({
    lap: spec.lap,
    fraction: spec.fraction,
    full: spec.full,
    below: spec.below,
    ...(spec.value === undefined ? {} : { value: spec.value }),
    title,
  });
  c.shape(svg.replace(/^<svg /, `<svg x="${r2(x)}" y="${r2(y)}" width="${size}" height="${size}" `));
}

/** Rows of text with a hairline between them; answers the bottom. */
export function rows(
  c: Canvas,
  top: number,
  items: readonly { text: string; aside?: string | null }[],
): number {
  let y = top;
  items.forEach((item, i) => {
    if (i > 0) c.hairline(X0, y, CONTENT);
    const asideW = item.aside ? textWidth(item.aside, TYPE.label) + 16 : 0;
    const ty = baseline(y + SPACE.rowY, TYPE.body);
    c.text(X0, ty, item.text, { max: CONTENT - Math.min(asideW, CONTENT * 0.45) });
    if (item.aside) {
      c.text(X0 + CONTENT, ty, item.aside, {
        size: TYPE.label,
        fill: T.sheetMuted,
        anchor: "end",
        max: CONTENT * 0.45 - 16,
      });
    }
    y += SPACE.rowY * 2 + TYPE.body + 4;
  });
  return y;
}

/** A paragraph of up to `lines` lines; answers the bottom. */
export function paragraph(
  c: Canvas,
  top: number,
  text: string,
  lines: number,
  o: { x?: number; width?: number; size?: number; fill?: string } = {},
): number {
  const size = o.size ?? TYPE.body;
  const out = wrap(text, o.width ?? CONTENT, size, lines);
  out.forEach((line, i) => {
    c.text(o.x ?? X0, baseline(top + i * size * 1.55, size), line, { size, fill: o.fill ?? T.foreground });
  });
  return top + out.length * size * 1.55;
}

/** The categorical colours in DESIGN.md's fixed order. */
export const CHART = [T.chart1, T.chart2, T.chart3, T.chart4, T.chart5] as const;
export { SECONDARY_LINE, SPACE, T, TYPE };
