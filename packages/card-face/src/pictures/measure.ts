// How wide a line of text is drawn, so a long name or a big number is shortened before it runs
// out of its column. The widths are the bundled fonts' own advances (`fonts/NotoSansTC-*.ttf`,
// read once from their `cmap` and `hmtx` tables); when the files cannot be read, or for a
// character they lack, an estimate stands in: a CJK or full-width character is 1 em, anything else
// a little over half an em. Kerning is left out, which resvg applies, so a column keeps a few
// pixels spare (`fitText` takes them off).

import { readFileSync } from "node:fs";
import { CARD_FONT_FILES } from "../fonts.js";

export type Weight = 400 | 700;

/** Advance widths in em of one font, by code point. */
interface Metrics {
  advance(code: number): number | null;
}

/** East Asian wide and full-width ranges, which the estimate draws at 1 em. */
function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

/** The estimate for one character, in em. */
export function estimateAdvance(code: number, weight: Weight): number {
  if (isWide(code)) return 1;
  if (code === 0x20) return 0.23;
  if (code >= 0x30 && code <= 0x39) return 0.55;
  return weight === 700 ? 0.6 : 0.56;
}

/** Reads `cmap` (format 4 or 12) and `hmtx` of a TrueType font. */
function readMetrics(bytes: Uint8Array): Metrics {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tables = new Map<string, number>();
  const count = view.getUint16(4);
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    const tag = String.fromCharCode(
      view.getUint8(at),
      view.getUint8(at + 1),
      view.getUint8(at + 2),
      view.getUint8(at + 3),
    );
    tables.set(tag, view.getUint32(at + 8));
  }
  const head = tables.get("head");
  const hhea = tables.get("hhea");
  const hmtx = tables.get("hmtx");
  const cmap = tables.get("cmap");
  if (head === undefined || hhea === undefined || hmtx === undefined || cmap === undefined) {
    throw new Error("not a TrueType font with cmap and hmtx");
  }
  const unitsPerEm = view.getUint16(head + 18);
  const longMetrics = view.getUint16(hhea + 34);
  const widthOf = (glyph: number): number =>
    view.getUint16(hmtx + Math.min(glyph, longMetrics - 1) * 4) / unitsPerEm;

  // The best Unicode subtable: (3,10) or (0,4+) format 12 first, then (3,1) format 4.
  let format12 = -1;
  let format4 = -1;
  const subtables = view.getUint16(cmap + 2);
  for (let i = 0; i < subtables; i++) {
    const at = cmap + 4 + i * 8;
    const platform = view.getUint16(at);
    const encoding = view.getUint16(at + 2);
    const offset = cmap + view.getUint32(at + 4);
    const format = view.getUint16(offset);
    if (format === 12 && (platform === 3 || platform === 0)) format12 = offset;
    if (format === 4 && ((platform === 3 && encoding === 1) || platform === 0)) format4 = offset;
  }

  let glyphOf: (code: number) => number;
  if (format12 >= 0) {
    const groups = view.getUint32(format12 + 12);
    glyphOf = (code) => {
      let lo = 0;
      let hi = groups - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const at = format12 + 16 + mid * 12;
        const start = view.getUint32(at);
        const end = view.getUint32(at + 4);
        if (code < start) hi = mid - 1;
        else if (code > end) lo = mid + 1;
        else return view.getUint32(at + 8) + (code - start);
      }
      return 0;
    };
  } else if (format4 >= 0) {
    const segs = view.getUint16(format4 + 6) / 2;
    const ends = format4 + 14;
    const starts = ends + segs * 2 + 2;
    const deltas = starts + segs * 2;
    const ranges = deltas + segs * 2;
    glyphOf = (code) => {
      if (code > 0xffff) return 0;
      for (let i = 0; i < segs; i++) {
        if (code > view.getUint16(ends + i * 2)) continue;
        const start = view.getUint16(starts + i * 2);
        if (code < start) return 0;
        const delta = view.getInt16(deltas + i * 2);
        const range = view.getUint16(ranges + i * 2);
        if (range === 0) return (code + delta) & 0xffff;
        const at = ranges + i * 2 + range + (code - start) * 2;
        const glyph = view.getUint16(at);
        return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
      }
      return 0;
    };
  } else {
    throw new Error("no Unicode cmap");
  }

  const cache = new Map<number, number | null>();
  return {
    advance(code) {
      const hit = cache.get(code);
      if (hit !== undefined) return hit;
      const glyph = glyphOf(code);
      const width = glyph === 0 ? null : widthOf(glyph);
      cache.set(code, width);
      return width;
    },
  };
}

const loaded = new Map<Weight, Metrics | null>();

/** The bundled font of `weight`, read once; `null` when it cannot be read. */
function metricsOf(weight: Weight): Metrics | null {
  if (loaded.has(weight)) return loaded.get(weight) ?? null;
  let metrics: Metrics | null = null;
  try {
    const file = CARD_FONT_FILES[weight === 700 ? 1 : 0];
    if (file !== undefined) metrics = readMetrics(readFileSync(file));
  } catch {
    metrics = null;
  }
  loaded.set(weight, metrics);
  return metrics;
}

/** The advance of one character in em: the font's, or the estimate. */
export function advance(code: number, weight: Weight = 400): number {
  return metricsOf(weight)?.advance(code) ?? estimateAdvance(code, weight);
}

/** Whether the bundled font has `code` (yes when the font cannot be read: nothing to check). */
export function hasGlyph(code: number, weight: Weight = 400): boolean {
  const metrics = metricsOf(weight);
  return metrics === null || metrics.advance(code) !== null;
}

/** What stands for a character the font does not have: the geta mark, as typesetters use it. */
export const MISSING = "〓";

/**
 * `text` with every character the bundled font lacks (a Japanese-only kanji such as 駆, an emoji)
 * replaced by `MISSING`, instead of the empty box resvg would draw.
 */
export function drawable(text: string, weight: Weight = 400): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    // Joiners and variation selectors draw nothing either way.
    const invisible = code === 0x200d || (code >= 0xfe00 && code <= 0xfe0f);
    if (invisible && !hasGlyph(code, weight)) continue;
    out += code < 0x20 || hasGlyph(code, weight) ? ch : MISSING;
  }
  return out;
}

/** How wide `text` is drawn at `size` px. */
export function textWidth(text: string, size: number, weight: Weight = 400): number {
  let em = 0;
  for (const ch of text) em += advance(ch.codePointAt(0) ?? 0, weight);
  return em * size;
}

/** Pixels a column keeps spare for kerning and rounding. */
const SPARE = 1.5;
const ELLIPSIS = "…";

/**
 * `text` as it fits in `max` px at `size`: whole when it fits, otherwise cut at a character and
 * ended with an ellipsis (never in the middle of a surrogate pair). Whitespace runs become one
 * space and line breaks are dropped.
 */
export function fitText(text: string, max: number, size: number, weight: Weight = 400): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (textWidth(clean, size, weight) <= max - SPARE) return clean;
  const room = max - SPARE - textWidth(ELLIPSIS, size, weight);
  let out = "";
  let width = 0;
  for (const ch of clean) {
    const w = advance(ch.codePointAt(0) ?? 0, weight) * size;
    if (width + w > room) break;
    out += ch;
    width += w;
  }
  return `${out.trimEnd()}${ELLIPSIS}`;
}

/**
 * `text` broken into at most `lines` lines of `max` px: at spaces between Latin words, anywhere
 * between CJK characters; the last line is shortened with an ellipsis when there is more.
 */
export function wrap(
  text: string,
  max: number,
  size: number,
  lines: number,
  weight: Weight = 400,
): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean === "" || lines < 1) return [];
  // Tokens: a Latin word with the space after it, or one other character.
  const tokens = clean.match(/[A-Za-z0-9'’.,!?:;%+\-−/]+ ?|./gsu) ?? [];
  const out: string[] = [];
  let line = "";
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string;
    const next = line + token;
    if (line === "" || textWidth(next.trimEnd(), size, weight) <= max - SPARE) {
      line = next;
      continue;
    }
    if (out.length === lines - 1) {
      // The last line takes what is left, shortened.
      out.push(fitText(line + tokens.slice(i).join(""), max, size, weight));
      return out;
    }
    out.push(fitText(line, max, size, weight));
    line = token.trimStart();
  }
  if (line !== "") out.push(fitText(line, max, size, weight));
  return out;
}
