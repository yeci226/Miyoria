// What the candle chart draws, worked out from `GET /api/member/exchange/candles/{code}` (pure, so
// it is tested without a canvas): the bars on the market's own wall clock (the library shows UTC,
// so each bar's time is moved by its zone's offset at that moment), the volume coloured by each
// bar's direction, MA5/MA20/MA60 from the closes (the same arithmetic as the pictures), and the
// legend's and the tooltip's words at a bar.

import type { ExchangeCandles } from "@miyoria/contracts/api";
import { changeText, MA_PERIODS, maDirection, moveColors, movingAverage } from "@miyoria/card-face/market";

export type Timeframe = ExchangeCandles["tf"];
export type Convention = "tw" | "us";

export const TIMEFRAMES: readonly Timeframe[] = ["intraday", "daily", "weekly", "monthly"];
export const TIMEFRAME_LABEL: Readonly<Record<Timeframe, string>> = {
  intraday: "當日",
  daily: "日線",
  weekly: "週線",
  monthly: "月線",
};

const parts = new Map<string, Intl.DateTimeFormat>();

/** `ms` as seconds of the same wall-clock time in UTC (what the chart's UTC axis then shows). */
export function wallSeconds(ms: number, zone: string): number {
  let f = parts.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    parts.set(zone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) / 1000;
}

export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface ChartSeries {
  bars: Bar[];
  /** One per bar, coloured by its direction; empty without volume. */
  volume: { time: number; value: number; color: string }[];
  /** MA5, MA20, MA60: one point per bar that has a value. */
  ma: { period: number; points: { time: number; value: number }[]; values: (number | null)[] }[];
}

/** The chart's series from the answer: bars, volume and the moving averages. */
export function chartSeries(c: Pick<ExchangeCandles, "candles" | "zone" | "volume">, colors: Convention): ChartSeries {
  const m = moveColors(colors);
  const bars: Bar[] = [];
  const vols: number[] = [];
  for (const k of c.candles) {
    const time = wallSeconds(k.t, c.zone);
    // The library wants each time once, rising.
    if (bars.length > 0 && time <= (bars.at(-1) as Bar).time) continue;
    bars.push({ time, open: k.o, high: k.h, low: k.l, close: k.c });
    vols.push(k.v ?? 0);
  }
  const volume = c.volume
    ? bars.map((b, i) => ({
        time: b.time,
        value: vols[i] ?? 0,
        // Translucent: the volume sits under the price.
        color: `${b.close >= b.open ? m.up : m.down}8c`,
      }))
    : [];
  const closes = bars.map((b) => b.close);
  const ma = MA_PERIODS.map((period) => {
    const values = movingAverage(closes, period);
    return {
      period,
      values,
      points: values.flatMap((v, i) => (v === null ? [] : [{ time: (bars[i] as Bar).time, value: v }])),
    };
  });
  return { bars, volume, ma };
}

/** A price as the legend writes it: fewer decimals as it grows. */
export function priceText(v: number): string {
  if (v >= 1000) return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (v >= 100) return v.toFixed(1);
  return v.toFixed(2);
}

/** A bar's time as the axis and the tooltip write it (from wall-clock seconds). */
export function timeText(seconds: number, tf: Timeframe): string {
  const d = new Date(seconds * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  if (tf === "intraday") return `${hh}:${mm}`;
  if (tf === "monthly") return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}`;
  return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

export interface BarWords {
  when: string;
  open: string;
  high: string;
  low: string;
  close: string;
  /** From the bar before (`—` for the first), with arrow and sign. */
  change: string;
  move: number;
  /** Each average at the bar, and which way it is going there. */
  ma: { period: number; value: string; dir: -1 | 0 | 1 | null }[];
}

/** The legend's and the tooltip's words at bar `i` of `s`. */
export function barWords(s: ChartSeries, i: number, tf: Timeframe): BarWords | null {
  const b = s.bars[i];
  if (!b) return null;
  const before = s.bars[i - 1];
  const move = before ? b.close / before.close - 1 : 0;
  return {
    when: timeText(b.time, tf),
    open: priceText(b.open),
    high: priceText(b.high),
    low: priceText(b.low),
    close: priceText(b.close),
    change: before ? changeText(move) : "—",
    move,
    ma: s.ma.map((m) => {
      const v = m.values[i] ?? null;
      return { period: m.period, value: v === null ? "—" : priceText(v), dir: maDirection(m.values.slice(0, i + 1)) };
    }),
  };
}
