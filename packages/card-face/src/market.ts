// The exchange's chart and map arithmetic, shared by the panel and the rendered pictures so both
// draw the same thing (docs/design/exchange.md §11): the moving averages over a candle chart's
// closes, the market's up and down colours under the product's one convention, the heat maps'
// diverging tile colour, and the squarified treemap layout (`d3-hierarchy`) of a heat map's tiles,
// grouped by sector. Pure: no DOM, no fonts, nothing but numbers in and numbers out. The panel
// imports this file directly (`@miyoria/card-face/market` in its Vite and TypeScript aliases).

import { hierarchy, treemap, treemapSquarify } from "d3-hierarchy";

/** `tw`: red up, green down (the default); `us`: green up, red down. */
export type MoveConvention = "tw" | "us";

/** The market's red and green (the only red and green the exchange uses, on up and down only). */
export const MARKET_RED = "#ef5f5f";
export const MARKET_GREEN = "#3fc48a";

/** Up's and down's colours under a convention. */
export function moveColors(colors: MoveConvention): { up: string; down: string } {
  return colors === "us"
    ? { up: MARKET_GREEN, down: MARKET_RED }
    : { up: MARKET_RED, down: MARKET_GREEN };
}

/** The colour of a move (`flat` for none). */
export function moveColor(x: number, colors: MoveConvention, flat: string): string {
  const m = moveColors(colors);
  return x > 0 ? m.up : x < 0 ? m.down : flat;
}

// ---- moving averages ------------------------------------------------------------------------

/** The moving averages a candle chart draws. */
export const MA_PERIODS = [5, 20, 60] as const;

/** The simple moving average of `n` closes at each bar (`null` until there are `n`). */
export function movingAverage(closes: readonly number[], n: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i] as number;
    if (i >= n) sum -= closes[i - n] as number;
    out.push(i >= n - 1 ? sum / n : null);
  }
  return out;
}

/** Whether a moving average is rising at its last value (`null`: too short to say). */
export function maDirection(ma: readonly (number | null)[]): -1 | 0 | 1 | null {
  const last = ma.at(-1);
  const before = ma.at(-2);
  if (last === null || last === undefined || before === null || before === undefined) return null;
  return last > before ? 1 : last < before ? -1 : 0;
}

// ---- heat map colours -----------------------------------------------------------------------

/** A tile with no move (or none known). */
export const TILE_NEUTRAL = "#3b3f4c";
/** The ends of the diverging scale: deeper than the line colours, so white text reads on them. */
const TILE_RED = "#b8383d";
const TILE_GREEN = "#1d8a5a";
/** A move this big or bigger is the full colour (finviz's map stops at ±3% too). */
export const TILE_FULL_AT = 0.03;

const rgb = (hex: string): [number, number, number] => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
];
const hex2 = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");

/** `a` mixed toward `b` by `t` (0..1). */
export function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = rgb(a);
  const [br, bg, bb] = rgb(b);
  const k = Math.max(0, Math.min(1, t));
  return `#${hex2(ar + (br - ar) * k)}${hex2(ag + (bg - ag) * k)}${hex2(ab + (bb - ab) * k)}`;
}

/**
 * A heat map tile's colour: neutral at 0 (and when nothing is known), toward the convention's up
 * colour above and its down colour below, full at ±`TILE_FULL_AT`. Colour is never the only
 * carrier: every tile that has room writes its change with an arrow and a sign.
 */
export function tileColor(change: number | null, colors: MoveConvention): string {
  if (change === null || !Number.isFinite(change) || change === 0) return TILE_NEUTRAL;
  const upRed = colors !== "us";
  const end = change > 0 === upRed ? TILE_RED : TILE_GREEN;
  return mix(TILE_NEUTRAL, end, Math.abs(change) / TILE_FULL_AT);
}

// ---- the treemap ----------------------------------------------------------------------------

export interface MapTileInput {
  code: string;
  sector: string;
  weight: number;
}

export interface PlacedTile<T extends MapTileInput> {
  tile: T;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlacedSector {
  name: string;
  weight: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MapLayout<T extends MapTileInput> {
  sectors: PlacedSector[];
  tiles: PlacedTile<T>[];
}

type Node<T> = { name: string; tile?: T; children?: Node<T>[] };

/**
 * The tiles with no one taking more than `maxShare` of their total (2330 alone is two thirds of
 * the Taiwan list): a bigger tile is cut to exactly that share and the rest share what is left in
 * their own proportions, repeated until none is over (water-filling). The total stays the same.
 * When the cap cannot hold (fewer than 1 ÷ `maxShare` tiles) every tile gets an equal share.
 * `maxShare` of 1 or more (or not a number) changes nothing.
 */
export function capShares<T extends { weight: number }>(tiles: readonly T[], maxShare: number): T[] {
  const kept = tiles.filter((t) => Number.isFinite(t.weight) && t.weight > 0);
  if (!(maxShare > 0 && maxShare < 1) || kept.length === 0) return [...tiles];
  const total = kept.reduce((s, t) => s + t.weight, 0);
  if (kept.length * maxShare < 1) return kept.map((t) => ({ ...t, weight: total / kept.length }));
  const capped = new Set<T>();
  for (;;) {
    const free = kept.filter((t) => !capped.has(t));
    const freeTotal = free.reduce((s, t) => s + t.weight, 0);
    const left = 1 - capped.size * maxShare;
    const over = free.filter((t) => (t.weight / freeTotal) * left > maxShare + 1e-12);
    if (over.length === 0) {
      return kept.map((t) => ({
        ...t,
        weight: capped.has(t) ? maxShare * total : (t.weight / freeTotal) * left * total,
      }));
    }
    for (const t of over) capped.add(t);
  }
}

/**
 * Lays tiles out in a `width` × `height` box: one squarified treemap of the sectors, each sector
 * a squarified treemap of its tiles, every area by weight. Sectors keep `header` px on top for their
 * label and `gap` px between neighbours. The order is stable: bigger first, then by name (a
 * sector) or code (a tile), so the same tiles always land in the same places.
 */
export function layoutMap<T extends MapTileInput>(
  tiles: readonly T[],
  width: number,
  height: number,
  options: { header?: number; gap?: number; maxShare?: number } = {},
): MapLayout<T> {
  const header = options.header ?? 14;
  const gap = options.gap ?? 1;
  // The layout's weights, capped; the tiles handed back are the caller's own (real weights).
  const real = tiles.filter((t) => Number.isFinite(t.weight) && t.weight > 0);
  const sized = capShares(
    real.map((tile) => ({ tile, weight: tile.weight })),
    options.maxShare ?? 1,
  );
  const area = new Map(sized.map((x) => [x.tile, x.weight]));
  const kept = real;
  if (kept.length === 0 || width <= 0 || height <= 0) return { sectors: [], tiles: [] };
  const bySector = new Map<string, T[]>();
  for (const t of kept) bySector.set(t.sector, [...(bySector.get(t.sector) ?? []), t]);
  const data: Node<T> = {
    name: "",
    children: [...bySector].map(([name, list]) => ({
      name,
      children: list.map((tile) => ({ name: tile.code, tile })),
    })),
  };
  const root = hierarchy<Node<T>>(data, (d) => d.children)
    .sum((d) => (d.tile ? (area.get(d.tile) ?? 0) : 0))
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0) || a.data.name.localeCompare(b.data.name));
  const laid = treemap<Node<T>>()
    .tile(treemapSquarify)
    .size([width, height])
    .paddingInner(gap)
    .paddingTop((n) => (n.depth === 1 ? header : 0))
    .round(false)(root);
  const sectors: PlacedSector[] = (laid.children ?? []).map((s) => ({
    name: s.data.name,
    weight: s.value ?? 0,
    x: s.x0,
    y: s.y0,
    w: Math.max(0, s.x1 - s.x0),
    h: Math.max(0, s.y1 - s.y0),
  }));
  const placed: PlacedTile<T>[] = laid.leaves().flatMap((l) =>
    l.data.tile
      ? [
          {
            tile: l.data.tile,
            x: l.x0,
            y: l.y0,
            w: Math.max(0, l.x1 - l.x0),
            h: Math.max(0, l.y1 - l.y0),
          },
        ]
      : [],
  );
  return { sectors, tiles: placed };
}

/**
 * What a heat map tile writes, best first (owner 2026-11-22: the name people know first): its
 * display name over its code in a smaller size and its move; the name and the move; the code and
 * the move; the code alone. The first that fits the tile is drawn; none: nothing (the tooltip, the
 * label and the picture's alt text always carry the name and the code).
 */
export const TILE_LINES = [
  ["name", "code", "move"],
  ["name", "move"],
  ["code", "move"],
  ["code"],
] as const;
export type TileLines = (typeof TILE_LINES)[number];

/**
 * A rough width in px of `text` at `size` px, for the panel's choice of what a tile writes (the
 * picture measures its own font): a CJK or full-width character, an arrow or a math sign is an em,
 * a capital or a digit
 * about 0.62 em, other Latin about 0.52 em, a space 0.3 em; bold about 6% wider.
 */
export function approxTextWidth(text: string, size: number, bold = false): number {
  let em = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    // CJK, full-width, and the arrows, math signs and shapes (▲ ▼ −) a move is written with.
    if (c >= 0x2e80 || (c >= 0xff00 && c <= 0xffef) || (c >= 0x2190 && c <= 0x25ff)) em += 1;
    else if (c === 0x20) em += 0.3;
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39) || c === 0x25) em += 0.62;
    else em += 0.52;
  }
  return em * size * (bold ? 1.06 : 1);
}

/**
 * How much a tile of `w` × `h` px can say: 2 its code and its change, 1 its code, 0 nothing (the
 * panel's tooltip and label, and the picture's alt text, carry it then).
 */
export function tileRoom(w: number, h: number): 0 | 1 | 2 {
  if (w >= 46 && h >= 30) return 2;
  if (w >= 30 && h >= 16) return 1;
  return 0;
}

/** A change with its arrow and sign: `▲ +1.2%`, `▼ −0.8%`, `0.0%`, `—`. */
export function changeText(x: number | null): string {
  if (x === null || !Number.isFinite(x)) return "—";
  const v = Math.round(x * 1000) / 10;
  if (v > 0) return `▲ +${v.toFixed(1)}%`;
  if (v < 0) return `▼ −${Math.abs(v).toFixed(1)}%`;
  return "0.0%";
}
