// A dev-only stand-in for the Core, to look at 深海交易所 without one: open the dev server at
// `/?exchange-demo`. `main.tsx` loads this only when `import.meta.env.DEV` (a production build has
// none of it) and the query asks for it. Every name and number here is made up.
//
// What it shows: the member page's exchange block alone, on the page's glass, with a member who has
// an account, a few holdings (a 1× lot of 2330, a 2× AAPL position, RICE) and made-up candles for
// every ticker in all four timeframes (real stocks with volume, the local ones without). The query
// picks where it opens:
//
//   ?exchange-demo            the market tab
//   ?exchange-demo=chart      2330.TW's candle chart (their cost line on it)
//   ?exchange-demo=chart-us   AAPL's, with the 2× selling line, in the us convention (green up)
//   ?exchange-demo=local      RICE's (no volume; what moved today's open)
//   ?exchange-demo=map        熱力圖: 伺服器持股圖 (=map-tw, =map-us for the 熱門 maps)
//   ?exchange-demo=owner      經濟 / 交易所 for the owner, with the mint report's warning
//   ?exchange-demo=closed     a Sunday on a brand-new instance: 台股 and 美股 at their last close
//                             (收盤價, 休市中), the local stocks at their opening reference before
//                             the first tick, a waiting order with the next open (=closed-map,
//                             =closed-chart for its heat map and 2330.TW's page)

import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type {
  ExchangeAccount,
  ExchangeAdmin,
  ExchangeBoards,
  ExchangeCandles,
  ExchangeLine,
  ExchangeMap,
  ExchangeMarket,
  ExchangePortfolio,
} from "@miyoria/contracts/api";
import { Backdrop } from "@/app/Backdrop";
import { ConnectionProvider } from "@/app/connection";
import { createQueryClient } from "@/app/queries";
import { Page } from "@/components/page";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ExchangeTab } from "@/pages/economy/ExchangeTab";
import { Exchange } from "../Exchange";

const raw = new URLSearchParams(window.location.search).get("exchange-demo") ?? "";
/** The closed-market Sunday: the same scenes, every market closed. */
const closed = raw.startsWith("closed");
const scene = closed ? (raw === "closed-map" ? "map-tw" : raw === "closed-chart" ? "chart" : "") : raw;
const colors: "tw" | "us" = scene.endsWith("-us") && scene.startsWith("chart") ? "us" : "tw";

const BASE = "魚幣是遊戲點數,沒有現金價值,不能用真錢或現實物品買賣、交換。這裡的行情只供遊戲使用,不是投資建議。";
// Friday 13:25 Taipei: Taiwan open, the US closed; or Sunday 11:30 Taipei, everything closed.
const NOW = closed ? Date.UTC(2026, 10, 22, 3, 30) : Date.UTC(2026, 10, 20, 5, 25);
/** The next opens from that Sunday: Taiwan Monday 09:00, the US Monday 22:30 Taipei, the local stocks 12:00. */
const NEXT_OPEN = { tw: "2026-11-23T01:00:00.000Z", us: "2026-11-23T14:30:00.000Z", local: "2026-11-22T04:00:00.000Z" } as const;

/** A seeded number in [0, 1). */
function rng(seed: string): () => number {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ (ch.codePointAt(0) ?? 0), 16777619) >>> 0;
  return () => {
    h = (Math.imul(h, 1103515245) + 12345) >>> 0;
    return h / 4294967296;
  };
}

interface Stock {
  code: string;
  name: string;
  market: "tw" | "us" | "local";
  price: number;
  change: number;
  sector: string;
  weight: number;
}

const STOCKS: Stock[] = [
  { code: "2330.TW", name: "示範半導體", market: "tw", price: 2000, change: -0.0476, sector: "半導體", weight: 300 },
  { code: "2317.TW", name: "示範代工", market: "tw", price: 218, change: 0.0141, sector: "科技", weight: 30 },
  { code: "2454.TW", name: "示範晶片", market: "tw", price: 1450, change: -0.021, sector: "半導體", weight: 23 },
  { code: "2308.TW", name: "示範電子", market: "tw", price: 965, change: 0.032, sector: "科技", weight: 20 },
  { code: "2382.TW", name: "示範電腦", market: "tw", price: 301, change: 0.004, sector: "科技", weight: 11 },
  { code: "2412.TW", name: "示範電信", market: "tw", price: 130, change: 0.0, sector: "電信", weight: 10 },
  { code: "2881.TW", name: "示範金控", market: "tw", price: 92, change: 0.007, sector: "金融", weight: 12 },
  { code: "2882.TW", name: "示範保險", market: "tw", price: 70.5, change: -0.004, sector: "金融", weight: 10 },
  { code: "2891.TW", name: "示範銀行", market: "tw", price: 46.2, change: 0.012, sector: "金融", weight: 9 },
  { code: "2303.TW", name: "示範晶圓", market: "tw", price: 52.1, change: -0.009, sector: "半導體", weight: 6 },
  { code: "1301.TW", name: "示範塑膠", market: "tw", price: 41.8, change: -0.031, sector: "原物料", weight: 3 },
  { code: "2002.TW", name: "示範鋼鐵", market: "tw", price: 21.3, change: 0.002, sector: "原物料", weight: 3 },
  { code: "0050.TW", name: "示範五十", market: "tw", price: 61.2, change: -0.018, sector: "ETF", weight: 6 },
  { code: "0056.TW", name: "示範高股息", market: "tw", price: 36.4, change: -0.006, sector: "ETF", weight: 4 },
  { code: "00878.TW", name: "示範永續", market: "tw", price: 22.1, change: -0.003, sector: "ETF", weight: 4 },
  { code: "AAPL", name: "示範蘋果", market: "us", price: 342.56, change: -0.019, sector: "科技", weight: 38 },
  { code: "MSFT", name: "示範軟體", market: "us", price: 512.3, change: 0.008, sector: "科技", weight: 38 },
  { code: "NVDA", name: "示範顯卡", market: "us", price: 188.4, change: 0.027, sector: "半導體", weight: 45 },
  { code: "AMZN", name: "示範商城", market: "us", price: 231.9, change: -0.011, sector: "消費", weight: 24 },
  { code: "GOOGL", name: "示範搜尋", market: "us", price: 288.2, change: 0.013, sector: "科技", weight: 30 },
  { code: "META", name: "示範社群", market: "us", price: 640.1, change: -0.024, sector: "科技", weight: 18 },
  { code: "TSLA", name: "示範電動車", market: "us", price: 402.7, change: 0.041, sector: "消費", weight: 14 },
  { code: "JPM", name: "示範銀行 US", market: "us", price: 301.5, change: 0.003, sector: "金融", weight: 8 },
  { code: "SPY", name: "示範大盤", market: "us", price: 668.2, change: -0.005, sector: "ETF", weight: 7 },
  { code: "QQQ", name: "示範科技 ETF", market: "us", price: 598.4, change: -0.009, sector: "ETF", weight: 4 },
  { code: "RICE", name: "白飯食品", market: "local", price: 101.2, change: 0.018, sector: "這裡獨家", weight: 0 },
  { code: "WHLE", name: "鯨落唱片", market: "local", price: 106.1, change: -0.012, sector: "這裡獨家", weight: 0 },
  { code: "NAPS", name: "打盹床業", market: "local", price: 88.3, change: 0.002, sector: "這裡獨家", weight: 0 },
  { code: "CUBE", name: "方塊礦業", market: "local", price: 119, change: 0.031, sector: "這裡獨家", weight: 0 },
  { code: "DPSK", name: "DipSick AI", market: "local", price: 91.2, change: -0.045, sector: "這裡獨家", weight: 0 },
];

const WHAT_MOVES: Record<string, [string, string]> = {
  RICE: ["大家多餵她,白飯食品就容易漲", "昨天她被餵了 16 次,比平常多 → 今天開盤 +1.8%"],
  WHLE: ["她唱完的歌越多,鯨落唱片越好", "昨天她唱完 1 首歌,比平常少 → 今天開盤 -1.2%"],
  NAPS: ["她安靜不說話的時間越長,打盹床業越好", "昨天她有 9 個小時沒說話,跟平常差不多 → 今天開盤 +0.1%"],
  CUBE: ["她在遊戲裡達成目標就漲,死掉就跌", "昨天她在遊戲裡達成 4 個目標、死了 1 次,比平常多 → 今天開盤 +2.4%"],
  DPSK: ["她的模型出錯變多,DipSick AI 就跌", "昨天她的模型出錯 31 次、太慢 4 次,比平常多 → 今天開盤 -1.8%"],
};

const byCode = new Map(STOCKS.map((s) => [s.code, s]));

/** The local stocks' anchors: what a brand-new instance shows before their first tick. */
const ANCHOR: Record<string, number> = { RICE: 100, WHLE: 108, NAPS: 88, CUBE: 116, DPSK: 94 };

function lineOf(s: Stock): ExchangeLine {
  const local = s.market === "local";
  const rate = s.market === "us" ? 30 : 1;
  const open = !closed && (s.market === "tw" || local);
  // Closed: a real stock at Friday's close, a local one at its anchor before its first tick.
  const reference = closed && local;
  const price = reference ? (ANCHOR[s.code] ?? s.price) : s.price;
  const basis = reference ? "reference" : open ? "quote" : "close";
  const date = "2026-11-20";
  return {
    code: s.code,
    name: s.name,
    market: s.market,
    price,
    basis,
    price_date: reference ? null : date,
    price_note:
      basis === "quote" ? null : basis === "reference" ? "開盤參考價・第一筆價格在 11/22(日)12:00" : `收盤價(11/20)・${open ? "等今天第一筆報價" : "休市中"}`,
    next_open: open ? null : closed ? NEXT_OPEN[s.market] : s.market === "us" ? "2026-11-20T14:30:00.000Z" : null,
    currency: local ? "COIN" : s.market === "us" ? "USD" : "TWD",
    local: local ? { what_moves: WHAT_MOVES[s.code]?.[0] ?? "", today: reference ? null : (WHAT_MOVES[s.code]?.[1] ?? null) } : null,
    coin_price: Math.round(price * rate * 100) / 100,
    age_minutes: basis === "quote" ? 2 : null,
    source: local ? "這裡獨家:價格由程式模擬" : "資料來源:Yahoo Finance",
    change: reference ? null : s.change,
    at: reference ? null : new Date(open ? NOW - 120_000 : s.market === "us" ? Date.UTC(2026, 10, 20, 21, 0) : Date.UTC(2026, 10, 20, 5, 30, 1)).toISOString(),
    open,
    stale: false,
    quotes: "intraday",
  };
}

const ZONE = { tw: "Asia/Taipei", us: "America/New_York", local: "Asia/Taipei" } as const;

/** Made-up candles ending at the stock's price: a walk with a trend, each bar's range around it. */
function candlesOf(s: Stock, tf: ExchangeCandles["tf"]): ExchangeCandles {
  const r = rng(`${s.code}:${tf}`);
  const local = s.market === "local";
  const step =
    tf === "intraday" ? (local ? 3_600_000 : 300_000) : tf === "daily" ? 86_400_000 : tf === "weekly" ? 7 * 86_400_000 : 30.4 * 86_400_000;
  const n = tf === "intraday" ? (local ? 2 : s.market === "us" ? 78 : 54) : tf === "daily" ? 126 : tf === "weekly" ? 105 : 120;
  const vol = tf === "intraday" ? 0.0025 : tf === "daily" ? 0.016 : tf === "weekly" ? 0.035 : 0.07;
  const drift = tf === "monthly" ? 0.012 : tf === "weekly" ? 0.003 : 0.0006;
  // Walk backwards from the last close so the chart ends at today's price.
  const closes: number[] = [s.price];
  for (let i = 1; i < n; i++) {
    const prev = closes[i - 1] as number;
    closes.push(prev / Math.exp(drift + (r() - 0.5) * 2 * vol));
  }
  closes.reverse();
  const start =
    tf === "intraday"
      ? local
        ? Date.UTC(2026, 10, 20, 4, 0) // 12:00 Taipei
        : s.market === "us"
          ? Date.UTC(2026, 10, 19, 14, 30)
          : Date.UTC(2026, 10, 20, 1, 0)
      : Date.UTC(2026, 10, 20, s.market === "us" ? 14 : 1, s.market === "us" ? 30 : 0) - (n - 1) * step;
  // A brand-new instance has no local ticks yet: no candles for them.
  if (closed && local) closes.length = 0;
  const candles = closes.map((c, i) => {
    const o = i === 0 ? c * (1 + (r() - 0.5) * vol) : (closes[i - 1] as number) * (1 + (r() - 0.5) * vol * 0.4);
    const h = Math.max(o, c) * (1 + r() * vol * 0.6);
    const l = Math.min(o, c) * (1 - r() * vol * 0.6);
    const round = (x: number) => Math.round(x * 100) / 100;
    return {
      t: Math.round(start + i * step),
      o: round(o),
      h: round(h),
      l: round(l),
      c: round(c),
      v: local ? null : Math.round((s.market === "us" ? 4e7 : 2e7) * (0.5 + r()) * (tf === "intraday" ? 0.02 : tf === "daily" ? 1 : tf === "weekly" ? 5 : 21)),
    };
  });
  const marks: ExchangeCandles["marks"] =
    s.code === "2330.TW"
      ? { avg_cost: 2060, liquidation: [] }
      : s.code === "AAPL"
        ? { avg_cost: 331.4, liquidation: [276.2] }
        : s.code === "RICE"
          ? { avg_cost: 97.5, liquidation: [] }
          : { avg_cost: null, liquidation: [] };
  return {
    code: s.code,
    tf,
    zone: ZONE[s.market],
    currency: local ? "COIN" : s.market === "us" ? "USD" : "TWD",
    candles,
    volume: !local,
    source: local ? "ticks" : "provider",
    stale: false,
    marks,
  };
}

const MARKET: ExchangeMarket = {
  enabled: true,
  currency: "魚幣",
  colors,
  rates: { twd_per_coin: 1, twd_per_usd: 30 },
  house: { buys_halted: false, net_today: 412, cap_daily: 0 },
  sessions: [
    { market: "tw", open: !closed, hours: "09:00–13:30", zone: "Asia/Taipei", stale: false, notice: null },
    { market: "us", open: false, hours: "09:30–16:00", zone: "America/New_York", stale: false, notice: null },
  ],
  lists: [
    { kind: "local", label: "新手推薦 · 這裡獨家" },
    { kind: "popular", label: "大家都在買" },
    { kind: "movers", label: "今天漲跌最多" },
    { kind: "tw", label: "熱門台股" },
    { kind: "us", label: "熱門美股" },
    { kind: "mine", label: "我的持股" },
    { kind: "recent", label: "我最近看過" },
    { kind: "watch", label: "我的觀察" },
  ],
  default_list: closed ? "tw" : "mine",
  rules: {
    fee: 0.01,
    fee_min: 1,
    order_min: 10,
    order_max: 0,
    orders_per_day: 20,
    buy_per_day: 0,
    limit_total: 0,
    min_hold_minutes: 10,
    leverage: true,
    leverage_line: 0.2,
    leverage_min_days: 30,
    leverage_min_tier: "朋友",
    margin_cap: 0,
    account_min_days: 7,
    account_min_tier: "認識",
    bankrupt_cooling_days: 7,
    quote_max_age_seconds: 300,
    payout_cap_daily: 0,
    watch_max: 20,
  },
  small_print: { base: BASE, real: "資料來源:Yahoo Finance,報價可能延遲。", leverage: "槓桿可能讓你賠光錢包和其他持股。" },
  no_dividends: "不發放股息;除息日股價下跌屬正常。",
  no_exchange: "魚幣永遠不能換成真錢或現實中的物品,也不能用真錢或物品買魚幣,在伺服器裡外都一樣。",
};

const ACCOUNT: ExchangeAccount = {
  currency: "魚幣",
  known: true,
  blocked: false,
  opened: true,
  opened_at: "2026-11-01T00:00:00.000Z",
  cannot_open: null,
  leverage: { allowed: true, why: null, opted_in: true },
  limits: { company: 0, total: 0, mult: 1.35 },
  today: { orders: 2, bought: 2_100, orders_left: 18, buy_left: null },
  balance: 4_820,
  investable: 4_820,
  hide_boards: false,
  show_holdings: false,
};

const PORTFOLIO: ExchangePortfolio = {
  balance: 4_820,
  holdings: [
    { id: "p1", code: "2330.TW", name: "示範半導體", leverage: 1, qty: 1_000_000, cost: 2_060, margin: 2_060, loan: 0, price: 2000, value: 2000, equity: 2000, ratio: null, line_price: null, warn_half_price: null, warn_near_price: null, opened_at: "2026-11-18T02:00:00.000Z", can_sell: true },
    { id: "p2", code: "AAPL", name: "示範蘋果", leverage: 2, qty: 200_000, cost: 1_988, margin: 994, loan: 994, price: 10_276.8, value: 2_055, equity: 1_061, ratio: 1.07, line_price: 8_286, warn_half_price: null, warn_near_price: null, opened_at: "2026-11-12T15:00:00.000Z", can_sell: true },
    { id: "p3", code: "RICE", name: "白飯食品", leverage: 1, qty: 3_000_000, cost: 293, margin: 293, loan: 0, price: 101.2, value: 303.6, equity: 303.6, ratio: null, line_price: null, warn_half_price: null, warn_near_price: null, opened_at: "2026-11-19T05:00:00.000Z", can_sell: true },
  ],
  orders: closed
    ? [
        { id: "o1", code: "2330.TW", side: "buy", coins: 2_020, qty: 1_000_000, leverage: 1, position: null, status: "open", why: null, at: new Date(NOW - 600_000).toISOString(), next_open: NEXT_OPEN.tw },
        { id: "o2", code: "AAPL", side: "sell", coins: 0, qty: 100_000, leverage: 1, position: null, status: "open", why: null, at: new Date(NOW - 300_000).toISOString(), next_open: NEXT_OPEN.us },
      ]
    : [],
  fills: [{ id: "f1", code: "RICE", side: "buy", kind: "fill", qty: 3_000_000, price: 97.5, gross: 293, fee: 3, paid: 0, shortfall: 0, leverage: 1, at: "2026-11-19T05:00:00.000Z" }],
  notices: [],
  bankrupt: null,
  totals: { cost: 4_341, value: 3_364.6 },
};

const BOARDS: ExchangeBoards = {
  currency: "魚幣",
  space: null,
  rich: [
    { rank: 1, name: "海帶芽", worth: 23_420, holdings: null, me: false },
    { rank: 2, name: "小魚乾", worth: 8_185, holdings: null, me: true },
    { rank: 3, name: "珊瑚礁的守門員", worth: 5_120, holdings: null, me: false },
  ],
  me: { rich: 2, hidden: false },
};

function starterMap(kind: "tw" | "us"): ExchangeMap {
  return {
    kind,
    title: kind === "tw" ? "熱門台股圖" : "熱門美股圖",
    footnote: "格子大小為預設權重,非即時市值;單一格最多占整張圖的 35%,超過的縮到這個大小",
    hidden: 0,
    max_share: 0.35,
    tiles: STOCKS.filter((s) => s.market === kind).map((s) => {
      const l = lineOf(s);
      return { code: s.code, name: s.name, sector: s.sector, weight: s.weight, change: s.change, price: l.price, currency: l.currency, coin_price: l.coin_price, basis: `預設權重 ${s.weight}` };
    }),
  };
}

const HELD: [string, number, number][] = [
  ["2330.TW", 48_200, 9],
  ["RICE", 12_400, 14],
  ["AAPL", 21_900, 6],
  ["NVDA", 15_300, 5],
  ["0050.TW", 9_800, 4],
  ["CUBE", 6_100, 7],
  ["DPSK", 2_300, 3],
  ["2317.TW", 4_400, 2],
  ["TSLA", 7_700, 3],
  ["WHLE", 3_900, 5],
  ["NAPS", 2_800, 4],
];

const HOLDINGS_MAP: ExchangeMap = {
  kind: "holdings",
  title: "伺服器持股圖",
  footnote: "格子大小為伺服器合計持有的市值(魚幣,照最後的價格);少於 2 人持有的併入「其他」,不顯示是誰持有;單一格最多占整張圖的 35%,超過的縮到這個大小",
  hidden: 0,
  max_share: 0.35,
  tiles: [
    ...HELD.map(([code, value, people]) => {
      const s = byCode.get(code) as Stock;
      const l = lineOf(s);
      const sector = s.market === "local" ? "這裡獨家" : s.sector;
      return { code, name: s.name, sector, weight: value, change: s.change, price: l.price, currency: l.currency, coin_price: l.coin_price, basis: `伺服器合計約 ${value.toLocaleString("en-US")} 魚幣・${people} 人持有` };
    }),
    { code: "其他", name: "少於 2 人持有的", sector: "其他", weight: 5_600, change: null, price: null, currency: null, coin_price: null, basis: "7 檔合計約 5,600 魚幣" },
  ],
};

function listRows(kind: string) {
  const pick = (codes: string[]) => codes.flatMap((c) => (byCode.has(c) ? [{ ...lineOf(byCode.get(c) as Stock), holders: null }] : []));
  if (kind === "local") return pick(["RICE", "WHLE", "NAPS", "CUBE", "DPSK"]);
  if (kind === "tw") return pick(STOCKS.filter((s) => s.market === "tw").map((s) => s.code));
  if (kind === "us") return pick(STOCKS.filter((s) => s.market === "us").map((s) => s.code));
  if (kind === "mine") return pick(["2330.TW", "AAPL", "RICE"]);
  if (kind === "popular") return HELD.map(([code, , people]) => ({ ...lineOf(byCode.get(code) as Stock), holders: people }));
  if (kind === "movers") return pick([...STOCKS].sort((a, b) => Math.abs(b.change) - Math.abs(a.change)).slice(0, 10).map((s) => s.code));
  return pick(["2330.TW", "NVDA"]);
}

const ADMIN: ExchangeAdmin = {
  enabled: true,
  rates: { twd_per_coin: 1, twd_per_usd: 30 },
  report: {
    today: { day: 20_778, date: "2026-11-20", burned: 6_120, minted: 6_532, net: 412, written_off: 0, buys_halted: false },
    days: Array.from({ length: 10 }, (_, i) => {
      const burned = 4_000 + i * 310;
      const minted = burned + 900 - i * 120;
      return { day: 20_777 - i, date: `2026-11-${String(19 - i).padStart(2, "0")}`, burned, minted, net: minted - burned, written_off: i === 3 ? 37 : 0 };
    }),
    cap_daily: 0,
    bankrupt: [],
    quotes: [],
    books: { postings: 182_330, lines: 182_330, pending: 0 },
    mint: {
      windows: [
        { days: 1, burned: 6_120, minted: 6_532, net: 412, share: 412 / 96_000 },
        { days: 7, burned: 32_400, minted: 37_810, net: 5_410, share: 5_410 / 96_000 },
        { days: 30, burned: 121_000, minted: 129_300, net: 8_300, share: 8_300 / 96_000 },
      ],
      circulation: 96_000,
      warn_share: 0.05,
      warning: "過去 7 天交易所淨發出 5,410 魚幣,是現在所有錢包合計的 5.6%,超過提醒線 5.0%。沒有每天淨發出上限時,上漲的市場會讓魚幣變多;要限制,在 系統 / 交易所 設「每天最多淨發出」。",
    },
  },
  tickers: STOCKS.slice(0, 6).map((s, i) => ({ code: s.code, name: s.name, provider_name: `Demo Provider Name ${i + 1} Corporation Limited`, name_override: i === 1 ? s.name : null, market: s.market, exchange: s.market === "us" ? "NMS" : s.market === "local" ? "LOCAL" : "TAI", type: "EQUITY", status: "active", reason: null, added_at: "2026-11-02T02:00:00.000Z", missing_days: 0, holders: 3 })),
  providers: [{ id: "yahoo", last_error: null }],
  refresh_seconds: 60,
  positions: [{ id: "p1", name: "小魚乾", code: "2330.TW", leverage: 1, qty: 1_000_000, value: 2000 }],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function answer(method: string, path: string, query: URLSearchParams): Response | null {
  if (path === "/api/member/exchange") return json(MARKET);
  if (path === "/api/member/exchange/account") return json(ACCOUNT);
  if (path === "/api/member/exchange/portfolio") return json(PORTFOLIO);
  if (path === "/api/member/exchange/boards") return json(BOARDS);
  if (path === "/api/exchange") return json(ADMIN);
  const list = /^\/api\/member\/exchange\/list\/(\w+)$/.exec(path);
  if (list) return json({ kind: list[1], label: MARKET.lists.find((l) => l.kind === list[1])?.label ?? "", rows: listRows(list[1] as string) });
  const ticker = /^\/api\/member\/exchange\/ticker\/(.+)$/.exec(path);
  if (ticker) {
    const s = byCode.get(decodeURIComponent(ticker[1] as string));
    return s ? json({ line: lineOf(s), points: [], watching: s.code === "2330.TW" }) : json({ error: "沒有這個標的(先查詢代號)" }, 404);
  }
  const candles = /^\/api\/member\/exchange\/candles\/(.+)$/.exec(path);
  if (candles) {
    const s = byCode.get(decodeURIComponent(candles[1] as string));
    const tf = (query.get("tf") ?? "daily") as ExchangeCandles["tf"];
    return s ? json(candlesOf(s, tf)) : json({ error: "沒有這個標的(先查詢代號)" }, 404);
  }
  const map = /^\/api\/member\/exchange\/map\/(\w+)$/.exec(path);
  if (map) return json(map[1] === "holdings" ? HOLDINGS_MAP : starterMap(map[1] as "tw" | "us"));
  if (path === "/api/member/exchange/suggest") return json({ items: STOCKS.slice(0, 6).map((s) => ({ code: s.code, name: s.name })) });
  if (path === "/api/member/exchange/lookup") return json({ instrument: lineOf(STOCKS[0] as Stock) });
  if (path === "/api/member/exchange/watch") return json({ watching: true, count: 2 });
  if (path === "/api/member/exchange/quote" && method === "POST")
    return json(
      closed
        ? { side: "buy", code: "2330.TW", price: 2000, open: false, coins: 2_020, margin: 2_000, exposure: 2_000, fee: 20, qty: 1_000_000, leverage: 1, gross: 0, net: 0, line_price: null, price_note: "收盤價(11/20)・休市中", next_open: NEXT_OPEN.tw, sentence: "付 2020 魚幣(含手續費 20),照收盤價(11/20)估約 1.0000 股,現在休市,下一個開盤 11/23(一)09:00(台北時間)後第一筆有效報價成交,之前都可以取消。買進後 10 分鐘才能賣。", warning: null }
        : { side: "buy", code: "2330.TW", price: 2000, open: true, coins: 101, margin: 100, exposure: 100, fee: 1, qty: 50_000, leverage: 1, gross: 0, net: 0, line_price: null, price_note: null, next_open: null, sentence: "付 101 魚幣(含手續費 1),照現價約 0.0500 股,下一筆有效報價成交。買進後 10 分鐘才能賣。", warning: null },
    );
  if (path === "/api/member/exchange/order" && method === "POST")
    return json({ id: "o9", code: "2330.TW", side: "buy", coins: 101, qty: 50_000, leverage: 1, position: null, status: "open", why: null, at: new Date(NOW).toISOString(), next_open: closed ? NEXT_OPEN.tw : null });
  if (path.startsWith("/api/")) return json({ error: "no such endpoint" }, 404);
  return null;
}

function installFetch(): void {
  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url, window.location.href);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    await new Promise((r) => setTimeout(r, 80));
    return answer(method, url.pathname, url.searchParams) ?? real(input, init);
  };
}

const client = createQueryClient();

function Frame({ children }: { children: ReactNode }) {
  return (
    <ConnectionProvider initial={{ baseUrl: "", token: "" }}>
      <QueryClientProvider client={client}>
        <TooltipProvider delayDuration={0}>
          <Backdrop />
          <div className="flex min-h-svh flex-col">
            <main className="flex min-w-0 flex-1 flex-col">
              <Page>{children}</Page>
            </main>
          </div>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ConnectionProvider>
  );
}

/** Renders the demo into `root` in place of the app. */
export function startExchangeDemo(root: HTMLElement): void {
  installFetch();
  try {
    if (scene.startsWith("map")) {
      window.localStorage.setItem("miyoria.exchange.tab", "map");
      const kind = scene === "map-tw" ? "tw" : scene === "map-us" ? "us" : "holdings";
      window.localStorage.setItem("miyoria.exchange.map", kind);
    } else window.localStorage.setItem("miyoria.exchange.tab", "market");
  } catch {
    // No storage: the market tab.
  }
  const code = scene === "chart" ? "2330.TW" : scene === "chart-us" ? "AAPL" : scene === "local" ? "RICE" : null;
  createRoot(root).render(<Frame>{scene === "owner" ? <ExchangeTab /> : <Exchange initialCode={code} />}</Frame>);
}
