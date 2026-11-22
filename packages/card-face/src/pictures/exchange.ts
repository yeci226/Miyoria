// The deep-sea exchange's pictures (docs/design/exchange.md §7): the market overview (the five
// local stocks with their lines, what the server holds most, the sessions), a ticker's quote with
// its line, a member's own portfolio, the rich list, a trade receipt and the bankruptcy notice.
// They read like the panel's exchange page: the frame with `交易所 / 頁面`, a chart block with its
// 24 px headline, strips of facts, hairline rows.
//
// Up and down (owner 2026-11-21): one convention for the whole product, `colors` in the data —
// `tw` red up and green down (the default), `us` green up and red down — stated in a legend on
// every chart. A move is never colour alone: every change carries its sign and an arrow (▲ +1.2% /
// ▼ −0.8%). These two are the only red and green the pictures use. Prices come in cents and are
// drawn with two decimals. Every picture ends with the exchange's small print.

import type {
  ExchangeBankruptPicture,
  ExchangeBoardPicture,
  ExchangeCandlePoint,
  ExchangeColors,
  ExchangeMapPicture,
  ExchangeOverviewPicture,
  ExchangePortfolioPicture,
  ExchangeQuotePicture,
  ExchangeReceiptPicture,
  ExchangeTimeframe,
} from "@miyoria/types";
import { DEFAULT_CURRENCY } from "@miyoria/types";
import {
  changeText,
  layoutMap,
  MA_PERIODS,
  maDirection,
  moveColors as marketColors,
  movingAverage,
  TILE_LINES,
  type TileLines,
  tileColor,
  tileRoom,
} from "../market.js";
import {
  baseline,
  blockTitle,
  type Canvas,
  CONTENT,
  facts,
  finish,
  legend,
  meter,
  num,
  page,
  paragraph,
  plainLine,
  rows,
  SPACE,
  T,
  TYPE,
  X0,
} from "./draw.js";
import { textWidth } from "./measure.js";

type Out = { drawn: ReturnType<typeof finish>; alt: string };

/** Up's and down's colours under a convention (the market's red and green, `../market.ts`). */
export function moveColors(colors: ExchangeColors): { up: string; down: string } {
  return marketColors(colors);
}

/** The legend's words (`紅漲綠跌`). */
export function conventionWord(colors: ExchangeColors): string {
  return colors === "us" ? "綠漲紅跌(美股習慣)" : "紅漲綠跌(台股習慣)";
}

/** The small print at the bottom of every exchange picture (legible at Discord's preview size). */
function smallPrint(c: Canvas, y: number, text: string): number {
  c.hairline(X0, y + 10, CONTENT);
  return paragraph(c, y + 20, text, 4, { size: TYPE.label, fill: T.sheetMuted });
}

/** The convention's legend: ▲ up and ▼ down in their colours. */
function moveLegend(c: Canvas, top: number, colors: ExchangeColors): number {
  const m = moveColors(colors);
  return legend(c, top, [
    { label: "▲ 漲", color: m.up },
    { label: "▼ 跌", color: m.down },
    { label: conventionWord(colors), color: T.chartFaint },
  ]);
}

/** Cents as `123.45`. */
export function price(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** A change with its arrow and sign: `▲ +1.2%` / `▼ −0.8%` / `0.0%`. */
export function change(x: number): string {
  return changeText(x);
}

function limitWord(limit: "up" | "down" | null): string {
  return limit === "up" ? "漲停" : limit === "down" ? "跌停" : "";
}

const colorOf = (x: number, colors: ExchangeColors) => {
  const m = moveColors(colors);
  return x > 0 ? m.up : x < 0 ? m.down : T.sheetMuted;
};

/** The headline block: title, the big number, the change with its sign beside it. */
function head(c: Canvas, top: number, title: string, value: string, delta: string, color: string, aside: string | null): number {
  c.text(X0, baseline(top, TYPE.label), title, { size: TYPE.label, fill: T.sheetMuted, max: CONTENT });
  const y = baseline(top + TYPE.label + 6, TYPE.headline);
  const w = c.text(X0, y, value, { size: TYPE.headline, weight: 700, max: CONTENT * 0.5 });
  c.text(X0 + w + 10, y, delta, { size: TYPE.title, weight: 700, fill: color, max: CONTENT * 0.25 });
  if (aside !== null) c.text(X0 + CONTENT, y, aside, { size: TYPE.label, fill: T.sheetMuted, anchor: "end", max: CONTENT * 0.3 });
  return top + TYPE.label + 6 + TYPE.headline + 10;
}

/** The timeframe's word on the switch and in the header. */
export const TIMEFRAME_WORD: Readonly<Record<ExchangeTimeframe, string>> = {
  intraday: "當日",
  daily: "日線",
  weekly: "週線",
  monthly: "月線",
};

/** The most bars a timeframe's picture draws (the moving averages read the ones before too). */
const MAX_BARS: Readonly<Record<ExchangeTimeframe, number>> = {
  intraday: 80,
  daily: 60,
  weekly: 60,
  monthly: 60,
};

/** The moving averages' colours: the light neutral first (MA5 lies on the candles), then the theme's two. */
export const MA_COLORS = [T.chart3, T.chart2, T.chart1] as const;

const r1 = (n: number) => n.toFixed(1);

/** A price axis number: fewer decimals as it grows. */
function axisPrice(cents: number): string {
  const v = cents / 100;
  if (v >= 1000) return num(v);
  if (v >= 100) return v.toFixed(1);
  return v.toFixed(2);
}

/** A volume as `1.2萬`, `3.4億`. */
function volumeText(v: number): string {
  if (v >= 1e8) return `${(v / 1e8).toFixed(1)}億`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(1)}萬`;
  return num(v);
}

/**
 * The candle chart (owner 2026-11-21: "a real stock chart"): candles coloured by the convention,
 * MA5 / MA20 / MA60 over them, volume bars under them, the price axis on the right with the last
 * price tagged, the date axis below. The legend names each average with its last value and an
 * arrow for its direction. Answers the bottom.
 */
function candleChart(c: Canvas, top: number, d: ExchangeQuotePicture): number {
  const m = moveColors(d.colors);
  const axisW = 58;
  const plotW = CONTENT - axisW;
  const priceH = 176;
  const all = d.candles;
  const shown = all.slice(-MAX_BARS[d.timeframe]);
  const offset = all.length - shown.length;
  // The legend: each average's last value and its direction (arrow and colour), then the volume.
  const closes = all.map((k) => k.c);
  const mas = MA_PERIODS.map((n) => movingAverage(closes, n));
  let lx = X0;
  MA_PERIODS.forEach((n, i) => {
    const ma = mas[i] as (number | null)[];
    const last = ma.at(-1) ?? null;
    const dir = maDirection(ma);
    const color = MA_COLORS[i] as string;
    c.rect(lx, top + 4, 10, 2, color, 1);
    const w = c.text(lx + 14, baseline(top, TYPE.small), `MA${n} ${last === null ? "—" : axisPrice(last)}`, { size: TYPE.small, fill: T.sheetMuted, max: 110 });
    lx += 14 + w + 4;
    if (dir !== null && dir !== 0) {
      lx += c.text(lx, baseline(top, TYPE.small), dir > 0 ? "▲" : "▼", { size: TYPE.small, weight: 700, fill: dir > 0 ? m.up : m.down });
    }
    lx += 14;
  });
  const plotTop = top + TYPE.small + 10;
  if (shown.length < 2) {
    c.rect(X0, plotTop, plotW, priceH, T.chartFaint, 4);
    c.text(X0 + plotW / 2, baseline(plotTop + priceH / 2 - 8, TYPE.label), "還沒有 K 線", { size: TYPE.label, fill: T.sheetMuted, anchor: "middle" });
    return plotTop + priceH;
  }
  // The price range: the bars shown and the averages over them.
  const values: number[] = [];
  for (const k of shown) values.push(k.h, k.l);
  for (const ma of mas) for (const v of ma.slice(offset)) if (v !== null) values.push(v);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (hi === lo) {
    hi += Math.max(1, hi * 0.01);
    lo -= Math.max(1, lo * 0.01);
  }
  const pad = (hi - lo) * 0.06;
  lo -= pad;
  hi += pad;
  const slot = plotW / shown.length;
  const bodyW = Math.max(1, Math.min(14, slot * 0.64));
  const x = (i: number) => X0 + slot * i + slot / 2;
  const y = (v: number) => plotTop + (1 - (v - lo) / (hi - lo)) * priceH;
  const lastClose = (shown.at(-1) as ExchangeCandlePoint).c;
  const ly = Math.max(plotTop + 8, Math.min(plotTop + priceH - 8, y(lastClose)));
  // Gridlines with their prices on the right (one the last price's tag would cover is left out).
  for (let g = 0; g <= 4; g++) {
    const gy = plotTop + (g / 4) * priceH;
    c.hairline(X0, gy, plotW, T.chartGrid);
    if (Math.abs(gy - ly) < 16) continue;
    const v = hi - ((hi - lo) * g) / 4;
    c.text(X0 + CONTENT, baseline(gy - 6, TYPE.tick), axisPrice(v), { size: TYPE.tick, fill: T.sheetMuted, anchor: "end", max: axisW - 6 });
  }
  // The candles: a 1 px wick and a body, up in the up colour, down in the down colour.
  shown.forEach((k, i) => {
    const up = k.c >= k.o;
    const color = up ? m.up : m.down;
    const cx = x(i);
    c.rect(cx - 0.5, y(k.h), 1, Math.max(1, y(k.l) - y(k.h)), color);
    const top2 = y(Math.max(k.o, k.c));
    const h = Math.max(1, Math.abs(y(k.o) - y(k.c)));
    c.rect(cx - bodyW / 2, top2, bodyW, h, color);
  });
  // The moving averages over the bars shown.
  MA_PERIODS.forEach((_, i) => {
    const ma = (mas[i] as (number | null)[]).slice(offset);
    let path = "";
    let pen = false;
    ma.forEach((v, j) => {
      if (v === null) {
        pen = false;
        return;
      }
      path += `${pen ? "L" : "M"}${r1(x(j))},${r1(y(v))}`;
      pen = true;
    });
    if (path !== "") c.shape(`<path d="${path}" fill="none" stroke="${MA_COLORS[i]}" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/>`);
  });
  // The last price, tagged on the axis in its move's colour.
  const last = shown.at(-1) as ExchangeCandlePoint;
  const tag = colorOf(d.change, d.colors);
  c.shape(`<line x1="${X0}" y1="${r1(ly)}" x2="${X0 + plotW}" y2="${r1(ly)}" stroke="${tag}" stroke-width="1" stroke-dasharray="3 3" stroke-opacity="0.7"/>`);
  c.rect(X0 + plotW + 2, ly - 9, axisW - 2, 18, tag, 3);
  c.shape(`<text x="${r1(X0 + CONTENT - 3)}" y="${r1(ly + 4)}" font-size="${TYPE.tick}" font-weight="700" fill="${T.background}" text-anchor="end">${axisPrice(last.c)}</text>`);
  let y2 = plotTop + priceH;
  // Volume underneath, when the bars have it.
  const vols = shown.map((k) => k.v ?? 0);
  const maxV = Math.max(0, ...vols);
  if (maxV > 0) {
    const volTop = y2 + 8;
    const volH = 44;
    c.hairline(X0, volTop + volH, plotW, T.chartAxis);
    shown.forEach((k, i) => {
      const v = k.v ?? 0;
      if (v <= 0) return;
      const h = Math.max(1, (v / maxV) * volH);
      const color = k.c >= k.o ? m.up : m.down;
      c.shape(`<rect x="${r1(x(i) - bodyW / 2)}" y="${r1(volTop + volH - h)}" width="${r1(bodyW)}" height="${r1(h)}" fill="${color}" fill-opacity="0.55"/>`);
    });
    c.text(X0 + CONTENT, baseline(volTop + 4, TYPE.tick), volumeText(maxV), { size: TYPE.tick, fill: T.sheetMuted, anchor: "end", max: axisW - 6 });
    c.text(X0 + CONTENT, baseline(volTop + volH - 12, TYPE.tick), "成交量", { size: TYPE.tick, fill: T.sheetMuted, anchor: "end", max: axisW - 6 });
    y2 = volTop + volH;
  } else c.hairline(X0, y2, plotW, T.chartAxis);
  // The date axis: five labels at their bars, the first and last held inside.
  const marks = Math.min(5, shown.length);
  for (let k = 0; k < marks; k++) {
    const i = marks === 1 ? 0 : Math.round((k * (shown.length - 1)) / (marks - 1));
    const label = (shown[i] as ExchangeCandlePoint).label;
    const anchor = k === 0 ? "start" : k === marks - 1 ? "end" : "middle";
    const lx2 = k === 0 ? X0 : k === marks - 1 ? X0 + plotW : x(i);
    c.text(lx2, baseline(y2 + 5, TYPE.tick), label, { size: TYPE.tick, fill: T.sheetMuted, anchor, max: plotW / marks });
  }
  return y2 + 5 + TYPE.tick + 4;
}

/** A small line (a sparkline) in a box, coloured by its move. */
function sparkline(c: Canvas, x0: number, top: number, w: number, h: number, values: readonly number[], colors: ExchangeColors): void {
  if (values.length < 2) {
    c.hairline(x0, top + h / 2, w, T.chartGrid);
    return;
  }
  const lo = Math.min(...values);
  const hi = Math.max(...values) === lo ? lo + 1 : Math.max(...values);
  const pts = values.map((v, i) => `${(x0 + (i / (values.length - 1)) * w).toFixed(1)},${(top + (1 - (v - lo) / (hi - lo)) * h).toFixed(1)}`);
  const color = colorOf((values.at(-1) as number) - (values[0] as number), colors);
  c.shape(`<path d="M${pts.join(" L")}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>`);
}

/** A row with a coloured change on the right, the sign and arrow always written. */
function moveRows(c: Canvas, top: number, items: readonly { text: string; value: string; delta: number | null; note: string }[], colors: ExchangeColors): number {
  let y = top;
  items.forEach((item, i) => {
    if (i > 0) c.hairline(X0, y, CONTENT);
    const ty = baseline(y + SPACE.rowY, TYPE.body);
    const deltaText = `${item.delta === null ? "—" : change(item.delta)}${item.note === "" ? "" : ` ${item.note}`}`;
    const dw = textWidth(deltaText, TYPE.label) + 4;
    const vw = textWidth(item.value, TYPE.body) + 12;
    c.text(X0, ty, item.text, { max: CONTENT - dw - vw - 16 });
    c.text(X0 + CONTENT - dw - 8, ty, item.value, { anchor: "end", max: vw });
    c.text(X0 + CONTENT, ty, deltaText, { size: TYPE.label, weight: 700, fill: colorOf(item.delta ?? 0, colors), anchor: "end", max: dw });
    y += SPACE.rowY * 2 + TYPE.body + 4;
  });
  return y;
}

export function exchangeOverviewPicture(d: ExchangeOverviewPicture): Out {
  const { canvas: c, top } = page("交易所", "市場總覽", d.as_of);
  const sessions = d.markets.map((m) => `${m.label} ${m.hours} ${m.open ? "開盤中" : "休市"}`).join("・");
  c.text(X0, baseline(top, TYPE.label), sessions, { size: TYPE.label, fill: T.sheetMuted, max: CONTENT });
  let y = top + TYPE.label + 14;
  y = blockTitle(c, y, "新手推薦 · 這裡獨家", "單日漲跌最多 ±10%・不開放槓桿");
  const rowH = SPACE.rowY * 2 + TYPE.body + 4;
  const sparkW = 96;
  d.local.forEach((s, i) => {
    if (i > 0) c.hairline(X0, y - SPACE.rowY, CONTENT);
    const ty = baseline(y, TYPE.body);
    const delta = change(s.change);
    const dw = textWidth(delta, TYPE.label) + 4;
    c.text(X0, ty, `${s.code} ${s.name}`, { max: CONTENT - sparkW - dw - 90 });
    sparkline(c, X0 + CONTENT - dw - 80 - sparkW, y, sparkW, TYPE.body, s.series, d.colors);
    c.text(X0 + CONTENT - dw - 8, ty, `${price(s.price)}`, { anchor: "end", max: 70 });
    c.text(X0 + CONTENT, ty, delta, { size: TYPE.label, weight: 700, fill: colorOf(s.change, d.colors), anchor: "end", max: dw });
    y += rowH;
  });
  y = plainLine(c, y - 4, `價格單位:${d.currency ?? DEFAULT_CURRENCY}一股`);
  y += SPACE.stage - 12;
  y = blockTitle(c, y, "大家都在買", "持有人數;不顯示是誰");
  y =
    d.popular.length === 0
      ? plainLine(c, y, "還沒有人持有")
      : moveRows(c, y - SPACE.rowY, d.popular.slice(0, 6).map((p) => ({ text: `${p.code} ${p.name}`, value: `${num(p.holders)} 人`, delta: p.change, note: "" })), d.colors) - 4;
  y += 10;
  y = moveLegend(c, y, d.colors);
  const alt = `市場總覽:${d.local.map((s) => `${s.code} ${price(s.price)}(${change(s.change)})`).join("、")}${d.popular[0] ? `;大家最常持有 ${d.popular[0].code}(${d.popular[0].holders} 人)` : ""}。`;
  y = smallPrint(c, y, d.small_print);
  return { drawn: finish(c, y), alt };
}

export function exchangeQuotePicture(d: ExchangeQuotePicture): Out {
  const { canvas: c, top } = page("交易所", `${d.code} ${d.name}`, d.as_of);
  const word = limitWord(d.limit);
  const tf = TIMEFRAME_WORD[d.timeframe];
  let y = head(c, top, `${d.price_label}(${d.sector}・${d.currency})`, price(d.price), `${change(d.change)}${word === "" ? "" : ` ${word}`}`, colorOf(d.change, d.colors), d.range === null ? tf : `${tf}・${d.range}`);
  if (d.coin_line !== null) {
    c.text(X0, baseline(y - 6, TYPE.label), d.coin_line, { size: TYPE.label, fill: T.sheetMuted, max: CONTENT });
    y += TYPE.label + 4;
  }
  y = candleChart(c, y + 6, d) + 8;
  y = moveLegend(c, y, d.colors) + 8;
  const shown = d.candles.slice(-MAX_BARS[d.timeframe]);
  const hi = shown.length > 0 ? Math.max(...shown.map((k) => k.h)) : d.price;
  const lo = shown.length > 0 ? Math.min(...shown.map((k) => k.l)) : d.price;
  y = facts(c, y, [
    { label: "參考價", value: price(d.ref) },
    { label: "漲跌", value: change(d.change) },
    { label: `${tf}最高`, value: price(hi) },
    { label: `${tf}最低`, value: price(lo) },
  ]);
  y += 10;
  y = plainLine(c, y, d.market_line);
  if (d.today !== null) {
    y += 2;
    y = paragraph(c, y, d.today, 2, { size: TYPE.label });
  }
  y += 4;
  y = paragraph(c, y, d.blurb, 2, { fill: T.sheetMuted, size: TYPE.label });
  const alt = `${d.code} ${d.name}(${tf}):${d.price_label} ${d.currency} ${price(d.price)}(${change(d.change)}${word === "" ? "" : `,${word}`})${d.coin_line === null ? "" : `,${d.coin_line}`},${d.market_line}${d.today === null ? "" : `;${d.today}`}。`;
  y = smallPrint(c, y, d.small_print);
  return { drawn: finish(c, y), alt };
}

/** A Taiwan code without its board (`2330.TW` → `2330`): the tiles have little room. */
export const shortCode = (code: string): string => code.replace(/\.TWO?$/, "");

/** A tile at least this wide may ellipsize a long name above its code. */
const NAME_CUT_MIN = 90;

/**
 * What a tile of `w` × `h` writes and at what sizes: the first of `TILE_LINES` that fits whole
 * (the name over its code and the move, the name and the move, the code and the move, the code),
 * the biggest size that fits it; `null`: nothing fits (the alt text names it).
 */
function tileText(name: string, code: string, move: string, w: number, h: number): { lines: TileLines; size: number; small: number } | null {
  if (tileRoom(w, h) === 0) return null;
  const sizes = [TYPE.title, TYPE.label, TYPE.tick];
  const under = (s: number) => (s === TYPE.title ? TYPE.label : TYPE.tick);
  for (const lines of TILE_LINES) {
    for (const size of sizes) {
      const small = under(size);
      let height = 0;
      let ok = true;
      lines.forEach((part, i) => {
        const big = i === 0;
        const px = big ? size : small;
        const text = part === "name" ? name : part === "code" ? code : move;
        // A long name may be ellipsized when its code is written under it (the panel does the same).
        const cut = part === "name" && (lines as readonly string[]).includes("code") && w >= NAME_CUT_MIN;
        if (!cut && textWidth(text, px, big ? 700 : 400) > w - 6) ok = false;
        height += px + (i > 0 ? 3 : 0);
      });
      if (ok && height + 6 <= h) return { lines, size, small };
    }
  }
  return null;
}

/**
 * A heat map (伺服器持股圖, 熱門台股圖, 熱門美股圖): the shared squarified layout (no tile over
 * `max_share` of the map), each tile filled by its last session's change on the diverging scale,
 * with its name over its code and its change (arrow and sign) as far as it has room; a sector's
 * name on its top strip. Tiles too small for text are named in the alt text and under the map.
 */
export function exchangeMapPicture(d: ExchangeMapPicture): Out {
  const { canvas: c, top } = page("交易所", d.title, d.as_of);
  const h = 300;
  const layout = layoutMap(d.tiles, CONTENT, h, { header: 16, gap: 2, maxShare: d.max_share });
  if (layout.tiles.length === 0) {
    c.rect(X0, top, CONTENT, 120, T.chartFaint, 4);
    c.text(X0 + CONTENT / 2, baseline(top + 52, TYPE.label), "還沒有可以畫的股票", { size: TYPE.label, fill: T.sheetMuted, anchor: "middle" });
  }
  for (const s of layout.sectors) {
    c.text(X0 + s.x + 2, baseline(top + s.y + 1, TYPE.tick), s.name, { size: TYPE.tick, weight: 700, fill: T.sheetMuted, max: Math.max(0, s.w - 4) });
  }
  const unlabeled: string[] = [];
  for (const t of layout.tiles) {
    const tx = X0 + t.x;
    const ty = top + t.y;
    c.rect(tx, ty, t.w, t.h, tileColor(t.tile.change, d.colors), 2);
    const code = shortCode(t.tile.code);
    const name = t.tile.name === "" ? code : t.tile.name;
    const move = changeText(t.tile.change);
    const fit = tileText(name, code, move, t.w, t.h);
    if (fit === null) {
      unlabeled.push(`${name}(${code})${move}`);
      continue;
    }
    const heights = fit.lines.map((_, i) => (i === 0 ? fit.size : fit.small));
    const block = heights.reduce((a, b) => a + b, 0) + 3 * (heights.length - 1);
    let y0 = ty + (t.h - block) / 2;
    const cx = tx + t.w / 2;
    fit.lines.forEach((part, i) => {
      const px = heights[i] as number;
      const text = part === "name" ? name : part === "code" ? code : move;
      c.text(cx, baseline(y0, px), text, { size: px, weight: i === 0 ? 700 : 400, anchor: "middle", max: t.w - 4 });
      y0 += px + 3;
    });
    if (!(fit.lines as readonly string[]).includes("move")) unlabeled.push(`${name}(${code})${move}`);
  }
  let y = top + (layout.tiles.length === 0 ? 120 : h) + 12;
  y = moveLegend(c, y, d.colors) + 4;
  y = paragraph(c, y, `顏色是最近一個交易日的漲跌(休市時是上一個交易日),±3% 以上最深;${d.footnote}`, 3, { size: TYPE.label, fill: T.sheetMuted });
  if (unlabeled.length > 0) y = paragraph(c, y + 2, `太小沒寫完的:${unlabeled.join("、")}`, 3, { size: TYPE.tick, fill: T.sheetMuted });
  const named = [...d.tiles]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 8)
    .map((t) => `${t.name}(${shortCode(t.code)})${changeText(t.change)}`)
    .join("、");
  const alt = `${d.title}:${named === "" ? "還沒有可以畫的股票" : named}。${d.footnote}。`;
  y = smallPrint(c, y, d.small_print);
  return { drawn: finish(c, y), alt };
}

export function exchangePortfolioPicture(d: ExchangePortfolioPicture): Out {
  const { canvas: c, top } = page("交易所", `${d.name} 的持股`, d.as_of);
  const held = d.holdings.reduce((t, h) => t + h.value, 0) + d.leveraged.reduce((t, l) => t + Math.max(0, l.equity), 0);
  const cost = d.holdings.reduce((t, h) => t + h.cost, 0) + d.leveraged.reduce((t, l) => t + l.margin, 0);
  const pnl = held - cost;
  const pnlText = cost > 0 ? `${pnl > 0 ? "▲ +" : pnl < 0 ? "▼ −" : ""}${num(Math.abs(pnl))}` : "";
  let y = head(c, top, "總資產(錢包加持股市值)", d.worth === null ? "—" : num(d.worth), pnlText, colorOf(pnl, d.colors), d.balance === null ? null : `錢包 ${num(d.balance)} ${d.currency}`);
  y = facts(c, y, [
    { label: "持股市值", value: num(held), unit: d.currency },
    { label: "成本", value: num(cost), unit: d.currency },
    { label: "損益", value: cost > 0 ? `${pnl >= 0 ? "+" : "−"}${num(Math.abs(pnl))}` : "—", unit: d.currency },
    { label: "槓桿部位", value: num(d.leveraged.length), unit: "個" },
  ]);
  y += SPACE.stage - 8;
  y = blockTitle(c, y, "持股", "市值・損益");
  y =
    d.holdings.length === 0
      ? plainLine(c, y, "沒有持股")
      : moveRows(
          c,
          y - SPACE.rowY,
          d.holdings.map((h) => ({ text: `${h.code}・${h.qty} 股・成本 ${num(h.cost)}`, value: num(h.value), delta: h.cost > 0 ? h.value / h.cost - 1 : 0, note: "" })),
          d.colors,
        ) - 4;
  if (d.leveraged.length > 0) {
    y += SPACE.stage - 8;
    y = blockTitle(c, y, "2 倍部位", "可能賠超過保證金");
    const m = moveColors(d.colors);
    for (const l of d.leveraged) {
      const line = `${l.code}・保證金 ${num(l.margin)}・剩 ${num(Math.max(0, l.equity))}(${Math.max(0, Math.round(l.ratio * 100))}%)`;
      c.text(X0, baseline(y, TYPE.body), line, { max: CONTENT * 0.62 });
      c.text(X0 + CONTENT, baseline(y, TYPE.label), `跌到 ${price(l.line_price)} 自動賣出`, { size: TYPE.label, fill: T.sheetMuted, anchor: "end", max: CONTENT * 0.36 });
      meter(c, X0, y + TYPE.body + 8, CONTENT, Math.max(0, Math.min(1, l.ratio)), l.ratio <= 0.5 ? m.down : m.up);
      y += TYPE.body + 26;
    }
  }
  y += 6;
  y = moveLegend(c, y, d.colors);
  const alt = `${d.name}的持股:總資產 ${d.worth === null ? "—" : num(d.worth)} ${d.currency},持股市值 ${num(held)}、成本 ${num(cost)}、損益 ${pnl >= 0 ? "+" : "−"}${num(Math.abs(pnl))}${d.leveraged.length > 0 ? `;${d.leveraged.length} 個 2 倍部位,${d.leveraged.map((l) => `${l.code} 跌到 ${price(l.line_price)} 自動賣出`).join("、")}` : ""}。`;
  y = smallPrint(c, y, d.small_print);
  return { drawn: finish(c, y), alt };
}

export function exchangeReceiptPicture(d: ExchangeReceiptPicture): Out {
  const word = d.side === "buy" ? "買進" : "賣出";
  const { canvas: c, top } = page("交易所", `${d.name} 的成交`, d.at);
  let y = head(c, top, `${word}${d.leverage > 1 ? "(2 倍)" : ""}`, `${d.code}`, d.ticker, T.sheetMuted, null);
  y = facts(c, y, [
    { label: "股數", value: d.shares, unit: "股" },
    { label: "成交價", value: d.price },
    { label: d.side === "buy" ? "付出" : "拿到", value: num(d.coins), unit: d.currency },
    { label: "手續費", value: num(d.fee), unit: d.currency },
  ]);
  y += 10;
  y = plainLine(c, y, d.side === "buy" ? "手續費燒掉,不會回到誰手上。" : `賣出的${d.currency}已經進錢包。`);
  const alt = `${d.name}${word} ${d.code} ${d.shares} 股,成交價 ${d.price},${d.side === "buy" ? "付出" : "拿到"} ${num(d.coins)} ${d.currency}(手續費 ${num(d.fee)})。`;
  y = smallPrint(c, y, d.small_print);
  return { drawn: finish(c, y), alt };
}

export function exchangeBankruptPicture(d: ExchangeBankruptPicture): Out {
  const { canvas: c, top } = page("交易所", `${d.name} 破產了`, d.since);
  let y = head(c, top, "所有持股已經結清", "破產", "", T.sheetMuted, null);
  y = facts(c, y, [
    { label: "交易所吸收", value: num(d.written_off), unit: d.currency },
    { label: "冷靜期到", value: d.until },
  ]);
  y += 10;
  y = paragraph(c, y, "不會欠錢:賠不夠的部分由交易所吸收。冷靜期過後才能再買進。", 3);
  const alt = `${d.name}在交易所破產:所有持股已經結清,冷靜期到 ${d.until},不會欠錢。`;
  y = smallPrint(c, y, d.small_print);
  return { drawn: finish(c, y), alt };
}

export function exchangeRichPicture(d: ExchangeBoardPicture): Out {
  const title = "富人榜";
  const unit = d.currency;
  const { canvas: c, top } = page("交易所", title, null);
  const total = d.rows.reduce((t, r) => t + r.value, 0);
  let y = facts(c, top, [
    { label: "上榜", value: num(d.rows.length), unit: "人" },
    { label: "合計", value: num(total), unit },
    { label: "第一名", value: d.rows[0] ? num(d.rows[0].value) : "—", unit },
  ]);
  y += SPACE.stage - 8;
  y = blockTitle(c, y, title, "錢包加持股市值;設定不上榜的人不列");
  y =
    d.rows.length === 0
      ? plainLine(c, y, "還沒有人上榜")
      : rows(
          c,
          y - SPACE.rowY,
          d.rows.slice(0, 15).map((r) => ({ text: `${r.rank}. ${r.name}`, aside: `${num(r.value)} ${unit}${r.extra === null ? "" : `・${r.extra}`}` })),
        ) - 4;
  y += 12;
  y = plainLine(c, y, "預設會上榜;會員頁的交易所可以設定不上榜。");
  if (d.me !== null) {
    y += 4;
    const mine = d.me.hidden ? "你設定了不上榜" : d.me.rank === null ? "你還沒上榜" : `你是第 ${d.me.rank} 名`;
    y = plainLine(c, y, mine);
  }
  const top3 = d.rows.slice(0, 3).map((r) => `${r.rank}. ${r.name} ${num(r.value)}`).join("、");
  y = smallPrint(c, y, d.small_print);
  return { drawn: finish(c, y), alt: `${title}:${top3 === "" ? "還沒有人上榜" : top3}。` };
}
