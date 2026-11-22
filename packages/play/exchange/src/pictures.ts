// The exchange's picture messages (v1), as templates of `PicturesKey`: the market overview, a
// ticker's quote with its line, a member's own holdings (only ever drawn for them, or shared by
// them), the rich list, a trade receipt and the bankruptcy notice. Each carries the exchange's
// small print at the bottom and the product's one up/down colour convention (`colors`). A picture
// goes above the text card with its one-line summary as the alt text; the text card is all there
// is when the renderer is absent, slow or answers `null`. Drawing never decides anything.

import { type CommandReply, pictureParts } from "@miyoria/commands";
import {
  DEFAULT_CURRENCY,
  type ExchangeBankruptPicture,
  type ExchangeBoardPicture,
  type ExchangeMapPicture,
  type ExchangeOverviewPicture,
  type ExchangePortfolioPicture,
  type ExchangeQuotePicture,
  type ExchangeReceiptPicture,
  exchangeSmallPrint,
  type PictureDataMap,
  type PictureFile,
  type PictureKind,
  type Pictures,
} from "@miyoria/types";
import type { Timeframe } from "./real/candles.js";
import type { CandleSet, RealLine, RealPortfolio } from "./real/desk.js";
import { QTY_REAL } from "./real/house.js";
import { taipeiWhen, zonedParts } from "./real/instruments.js";
import type { ListRow } from "./real/lists.js";
import type { MapData } from "./real/maps.js";
import type { BoardsView, ExchangeService } from "./service.js";

/** Longest wait for a picture before the answer goes out with its text alone. */
export const PICTURE_TIMEOUT_MS = 8_000;

export const MARKET_WORD: Readonly<Record<string, string>> = {
  tw: "台股",
  us: "美股",
  local: "獨家",
  crypto: "加密",
};

/** Cents of a price, as the templates draw them (two decimals). */
const cents = (x: number) => Math.round(x * 100);

const local = (iso: string | number, offsetMinutes: number) =>
  new Date(
    (typeof iso === "number" ? iso : Date.parse(iso)) + offsetMinutes * 60_000,
  ).toISOString();

/** `2026-11-23 10:05`, in the exchange's zone. */
export function timeText(iso: string | number, offsetMinutes: number): string {
  const d = local(iso, offsetMinutes);
  return `${d.slice(0, 10)} ${d.slice(11, 16)}`;
}

/** A share count as drawn: whole shares plainly, a fraction to four places. */
export function sharesText(qty: number): string {
  const shares = qty / QTY_REAL;
  return Number.isInteger(shares) ? String(shares) : shares.toFixed(4);
}

/** Coins as drawn: `2,045` (two decimals below 100). */
export function coinText(x: number): string {
  return x >= 100 ? Math.round(x).toLocaleString("en-US") : (Math.round(x * 100) / 100).toString();
}

/**
 * `台股開盤中・報價約 3 分鐘前` (the source states no delay; the quote's own time is what we
 * know); a close or a reference says what it is and when the market opens (Taipei time).
 */
export function marketLine(l: RealLine): string {
  const where = MARKET_WORD[l.market] ?? l.market;
  const state = l.open ? "開盤中" : "休市";
  const opens =
    l.next_open === null ? "" : `・下一個開盤 ${taipeiWhen(Date.parse(l.next_open))}(台北時間)`;
  if (l.basis === "close" || l.basis === "reference")
    return `${where}${state}・${l.price_note ?? ""}${opens}`;
  const age =
    l.age_minutes === null
      ? "還沒有報價"
      : l.age_minutes <= 1
        ? "報價是最新的"
        : `報價約 ${l.age_minutes} 分鐘前${l.stale ? "(太舊,暫停成交)" : ""}`;
  return `${where}${state}・${age}${opens}`;
}

/** The headline word of a line's price: `現價`, `收盤價(11/20)・休市中`, `開盤參考價`. */
export function priceLabel(l: RealLine): string {
  if (l.basis === "reference") return "開盤參考價";
  if (l.basis === "close") return l.price_note ?? "收盤價";
  return l.price === null ? "還沒有價格" : "現價";
}

/** A bar's time as the date axis writes it, in the market's zone: `10:05`, `11/20`, `2025/11`. */
export function candleLabel(at: number, tf: Timeframe, zone: string): string {
  const z = zonedParts(at, zone);
  const [y, m, d] = z.date.split("-").map(Number) as [number, number, number];
  if (tf === "intraday")
    return `${String(Math.floor(z.minutes / 60)).padStart(2, "0")}:${String(z.minutes % 60).padStart(2, "0")}`;
  if (tf === "monthly") return `${y}/${m}`;
  return `${m}/${d}`;
}

/** What a candle chart covers, in words (`11/20`, `5/21 – 11/20`, `2016/12 – 2026/11`). */
export function candleRange(set: Pick<CandleSet, "candles" | "tf" | "zone">): string | null {
  const first = set.candles[0];
  const last = set.candles.at(-1);
  if (!first || !last) return null;
  const tf = set.tf === "intraday" ? "daily" : set.tf;
  if (set.tf === "intraday") return candleLabel(last.at, tf, set.zone);
  return `${candleLabel(first.at, tf, set.zone)} – ${candleLabel(last.at, tf, set.zone)}`;
}

/** The timeframe a quote card opens on: the session in progress while there is one, else daily. */
export function defaultTimeframe(line: RealLine): Timeframe {
  return line.open ? "intraday" : "daily";
}

export function quotePictureData(service: ExchangeService, set: CandleSet): ExchangeQuotePicture {
  const l = set.line;
  const offset = service.config.utc_offset_minutes;
  const last = set.candles.at(-1);
  const price = l.price ?? last?.c ?? 0;
  const ref = l.change === null ? price : price / (1 + l.change);
  const isLocal = l.local !== null;
  const coin = l.currency === "COIN";
  return {
    code: l.code,
    name: l.name,
    sector: MARKET_WORD[l.market] ?? l.market,
    blurb: isLocal ? (l.local?.what_moves ?? "") : l.source,
    currency: coin ? service.currency : l.currency,
    price: cents(price),
    price_label: priceLabel(l),
    ref: cents(ref),
    change: l.change ?? 0,
    limit: null,
    timeframe: set.tf,
    candles: set.candles.map((k) => ({
      o: cents(k.o),
      h: cents(k.h),
      l: cents(k.l),
      c: cents(k.c),
      v: set.volume ? k.v : null,
      label: candleLabel(k.at, set.tf, set.zone),
    })),
    range: candleRange(set),
    // The local stock's line of what moved today's open (the card and the member page have it too).
    today: l.local?.today ?? null,
    news: [],
    as_of:
      l.basis === "reference"
        ? "還沒有第一筆價格"
        : l.at === null
          ? "還沒有報價"
          : `${timeText(l.at, offset)} 的${l.basis === "close" ? "收盤價" : "報價"}`,
    coin_line:
      coin || l.coin_price === null ? null : `約 ${coinText(l.coin_price)} ${service.currency}一股`,
    market_line: `${marketLine(l)}${set.stale ? "・K 線暫時沒有更新" : ""}`,
    colors: service.config.colors,
    small_print: exchangeSmallPrint({ real: !isLocal, currency: service.currency }),
  };
}

/** A heat map as its picture: tiles, the footnote, the convention, the small print. */
export function mapPictureData(
  service: ExchangeService,
  map: MapData,
  now: number,
): ExchangeMapPicture {
  return {
    title: map.title,
    tiles: map.tiles.map((t) => ({
      code: t.code,
      name: t.name,
      sector: t.sector,
      weight: t.weight,
      change: t.change,
    })),
    footnote: map.footnote,
    max_share: map.max_share,
    as_of: timeText(now, service.config.utc_offset_minutes),
    colors: service.config.colors,
    small_print: exchangeSmallPrint({ real: true, currency: service.currency }),
  };
}

export function portfolioPictureData(
  service: ExchangeService,
  name: string,
  p: RealPortfolio,
  balance: number | null,
): ExchangePortfolioPicture {
  const leverage = p.holdings.some((h) => h.leverage > 1);
  return {
    name,
    currency: service.currency,
    balance,
    worth: balance === null ? null : Math.floor(balance + p.totals.value),
    holdings: p.holdings
      .filter((h) => h.leverage <= 1)
      .map((h) => ({
        code: h.code,
        qty: sharesText(h.qty),
        cost: h.cost,
        value: Math.floor(h.value ?? 0),
      })),
    leveraged: p.holdings
      .filter((h) => h.leverage > 1)
      .map((h) => ({
        code: h.code,
        margin: h.margin,
        equity: Math.floor(h.equity ?? 0),
        ratio: h.ratio ?? 0,
        price: cents(h.price ?? 0),
        line_price: cents(h.line_price ?? 0),
      })),
    as_of: p.bankrupt ? "破產冷靜期中" : "以最新報價計算",
    colors: service.config.colors,
    small_print: exchangeSmallPrint({ real: true, leverage, currency: service.currency }),
  };
}

export function overviewPictureData(
  service: ExchangeService,
  now: number,
): ExchangeOverviewPicture {
  const offset = service.config.utc_offset_minutes;
  const localRows = service.lists.rows("local", null);
  const popular = service.lists.rows("popular", null).slice(0, 6);
  const view = service.real.view();
  const hours = (m: "tw" | "us" | "local") => {
    const s = service.real.sessions[m];
    return `${s.open}–${s.close}`;
  };
  return {
    // Absent: the default name (the data of the first character's pictures stays as it was).
    ...(service.currency === DEFAULT_CURRENCY ? {} : { currency: service.currency }),
    local: localRows.map((r) => {
      const h = service.real.history(r.code, 2, false);
      return {
        code: r.code,
        name: r.name,
        price: cents(r.price ?? 0),
        change: r.change ?? 0,
        series: (h?.points ?? []).map((p) => cents(p.price)),
      };
    }),
    popular: popular.map((r: ListRow) => ({
      code: r.code,
      name: r.name,
      holders: r.holders ?? 0,
      change: r.change,
    })),
    markets: [
      {
        label: "台股",
        open: view.sessions.find((s) => s.market === "tw")?.open ?? false,
        hours: hours("tw"),
      },
      {
        label: "美股",
        open: view.sessions.find((s) => s.market === "us")?.open ?? false,
        hours: hours("us"),
      },
      { label: "獨家", open: localRows.some((r) => r.open), hours: hours("local") },
    ],
    as_of: timeText(now, offset),
    colors: service.config.colors,
    small_print: exchangeSmallPrint({ real: true, currency: service.currency }),
  };
}

export function boardPictureData(b: BoardsView): ExchangeBoardPicture {
  return {
    currency: b.currency,
    week_start: null,
    rows: b.rich.map((r) => ({
      rank: r.rank,
      name: r.name,
      value: r.worth,
      extra: r.holdings === null ? null : r.holdings.map((h) => h.code).join(" "),
    })),
    me: b.me === null ? null : { rank: b.me.rich, hidden: b.me.hidden },
    small_print: exchangeSmallPrint({ real: true, currency: b.currency }),
  };
}

/** A fill as its receipt. */
export function receiptPictureData(
  service: ExchangeService,
  name: string,
  fill: RealPortfolio["fills"][number],
): ExchangeReceiptPicture {
  const line = service.real.view().instruments.find((i) => i.code === fill.code);
  const currency = line?.currency ?? "COIN";
  // The fill's price is in coins a share; its own currency's price is shown when the rate allows.
  const native =
    line && line.price !== null && line.coin_price
      ? (fill.price * line.price) / line.coin_price
      : fill.price;
  return {
    name,
    side: fill.side === "sell" ? "sell" : "buy",
    code: fill.code,
    ticker: line?.name ?? fill.code,
    shares: sharesText(fill.qty),
    price:
      currency === "COIN"
        ? `${coinText(fill.price)} ${service.currency}`
        : `${currency} ${native.toFixed(2)}`,
    coins: fill.side === "sell" ? fill.paid : fill.gross + fill.fee,
    fee: fill.fee,
    currency: service.currency,
    leverage: fill.leverage,
    at: timeText(fill.at, service.config.utc_offset_minutes),
    small_print: exchangeSmallPrint({
      real: line?.local === null,
      leverage: fill.leverage > 1,
      currency: service.currency,
    }),
  };
}

export function bankruptPictureData(
  service: ExchangeService,
  name: string,
  b: NonNullable<RealPortfolio["bankrupt"]>,
): ExchangeBankruptPicture {
  const offset = service.config.utc_offset_minutes;
  return {
    name,
    currency: service.currency,
    written_off: b.written_off,
    since: timeText(b.since, offset).slice(0, 10),
    until: timeText(b.until, offset).slice(0, 10),
    small_print: exchangeSmallPrint({ real: true, leverage: true, currency: service.currency }),
  };
}

/** Draws `kind`, or `null`: no renderer, a failure, or too slow. Never throws. */
export async function drawPicture<K extends PictureKind>(
  pictures: Pictures | null | undefined,
  kind: K,
  data: PictureDataMap[K],
  timeoutMs: number = PICTURE_TIMEOUT_MS,
): Promise<PictureFile | null> {
  if (!pictures) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    return await Promise.race([pictures.render(kind, data).catch(() => null), late]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `reply` with the picture of `kind` above its card, when one can be drawn. The picture ends with
 * the small print; the card's own muted small print is then dropped when the picture's says all of
 * it (owner 2026-11-22: not the same sentence twice), and kept whenever the picture is missing.
 */
export async function withPicture<K extends PictureKind>(
  pictures: Pictures | null | undefined,
  kind: K,
  data: PictureDataMap[K],
  reply: CommandReply,
): Promise<CommandReply> {
  const file = await drawPicture(pictures, kind, data);
  if (file === null || reply.card === undefined) return reply;
  const parts = pictureParts(file);
  const drawn = (data as { small_print?: unknown }).small_print;
  const blocks = reply.card.blocks.filter(
    (b) => !(b.type === "muted" && typeof drawn === "string" && drawn.includes(b.text)),
  );
  return {
    ...reply,
    // The plain text (where a picture cannot go) keeps the small print.
    card: { ...reply.card, blocks: [...parts.blocks, ...blocks] },
    files: [...(reply.files ?? []), ...parts.files],
  };
}
