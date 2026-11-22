// The exchange's candle chart and heat map on the member page. jsdom cannot draw a canvas, so
// `lightweight-charts` is replaced by a recorder: what the page asks it to draw (candles in the
// convention's colours, MA5/MA20/MA60, volume in its own pane, the member's cost and 2× lines) is
// checked instead of pixels. The timeframe switch, the legend and the map's tiles (areas, colours,
// names, opening a ticker) are the page's own. Every name and number here is made up.

import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ExchangeCandles, ExchangeLine, ExchangeMap, ExchangeMarket } from "@miyoria/contracts/api";
import { MA_PERIODS, moveColors, movingAverage, tileColor } from "@miyoria/card-face/market";
import { mockFetch, renderPage } from "@/test/render";
import { barWords, chartSeries, wallSeconds } from "./exchange/chart-data";
import { Exchange } from "./Exchange";

const drawn = vi.hoisted(() => ({
  charts: [] as {
    options: Record<string, unknown>;
    series: { kind: string; options: Record<string, unknown>; pane: number; data: unknown[]; lines: Record<string, unknown>[] }[];
    move: ((p: unknown) => void) | null;
    removed: boolean;
  }[],
}));

vi.mock("lightweight-charts", () => {
  const createChart = (_el: HTMLElement, options: Record<string, unknown>) => {
    const chart = { options, series: [] as (typeof drawn.charts)[number]["series"], move: null as ((p: unknown) => void) | null, removed: false };
    drawn.charts.push(chart);
    const pane = { setStretchFactor: () => undefined };
    return {
      addSeries: (kind: string, o: Record<string, unknown> = {}, paneIndex = 0) => {
        const s = { kind, options: o, pane: paneIndex, data: [] as unknown[], lines: [] as Record<string, unknown>[] };
        chart.series.push(s);
        return {
          setData: (d: unknown[]) => {
            s.data = d;
          },
          createPriceLine: (l: Record<string, unknown>) => {
            s.lines.push(l);
            return {};
          },
        };
      },
      panes: () => [pane, pane],
      timeScale: () => ({ fitContent: () => undefined }),
      subscribeCrosshairMove: (f: (p: unknown) => void) => {
        chart.move = f;
      },
      unsubscribeCrosshairMove: () => undefined,
      remove: () => {
        chart.removed = true;
      },
    };
  };
  return {
    createChart,
    CandlestickSeries: "Candlestick",
    HistogramSeries: "Histogram",
    LineSeries: "Line",
    ColorType: { Solid: "solid" },
    CrosshairMode: { Normal: 0 },
    LineStyle: { Solid: 0, Dotted: 1, Dashed: 2 },
  };
});

const BASE = "魚幣是遊戲點數,沒有現金價值,不能用真錢或現實物品買賣、交換。這裡的行情只供遊戲使用,不是投資建議。";

const line = (code: string, name: string, chg: number | null, more: Partial<ExchangeLine> = {}): ExchangeLine & { holders: number | null } => ({
  code,
  name,
  market: "tw",
  price: 2000,
  basis: "close",
  price_date: "2026-11-20",
  price_note: "收盤價(11/20)・休市中",
  next_open: "2026-11-23T01:00:00.000Z",
  currency: "TWD",
  local: null,
  coin_price: 2000,
  age_minutes: 3,
  source: "資料來源:Yahoo Finance",
  change: chg,
  at: "2026-11-23T02:00:00.000Z",
  open: false,
  stale: false,
  quotes: "intraday",
  holders: null,
  ...more,
});

const TSMC = line("2330.TW", "示範半導體", 0.0174);

const market = (colors: "tw" | "us"): ExchangeMarket => ({
  enabled: true,
  currency: "魚幣",
  colors,
  rates: { twd_per_coin: 1, twd_per_usd: 30 },
  house: { buys_halted: false, net_today: 0, cap_daily: 0 },
  sessions: [{ market: "tw", open: false, hours: "09:00–13:30", zone: "Asia/Taipei", stale: false, notice: null }],
  lists: [{ kind: "tw", label: "熱門台股" }],
  default_list: "tw",
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
  no_exchange: "魚幣永遠不能換成真錢或現實中的物品。",
});

/** 70 made-up daily bars (Taipei, 09:00), with volume. */
const candles = (tf: ExchangeCandles["tf"]): ExchangeCandles => ({
  code: "2330.TW",
  tf,
  zone: "Asia/Taipei",
  currency: "TWD",
  candles: Array.from({ length: 70 }, (_, i) => {
    const o = 1900 + i * 2;
    const c = o + (i % 3 === 0 ? -5 : 7);
    return { t: Date.UTC(2026, 7, 1, 1, 0) + i * 86_400_000, o, h: Math.max(o, c) + 4, l: Math.min(o, c) - 4, c, v: 1_000_000 + i };
  }),
  volume: true,
  source: "provider",
  stale: false,
  marks: { avg_cost: 1950, liquidation: [1600] },
});

const MAP: ExchangeMap = {
  kind: "holdings",
  title: "伺服器持股圖",
  footnote: "格子大小為伺服器合計持有的市值(魚幣,照最後的價格);少於 2 人持有的併入「其他」,不顯示是誰持有",
  hidden: 0,
  max_share: 1,
  tiles: [
    { code: "2330.TW", name: "示範半導體", sector: "半導體", weight: 6000, change: 0.0174, price: 2000, currency: "TWD", coin_price: 2000, basis: "伺服器合計約 6,000 魚幣・3 人持有" },
    { code: "RICE", name: "白飯食品", sector: "這裡獨家", weight: 3000, change: -0.02, price: 101, currency: "COIN", coin_price: 101, basis: "伺服器合計約 3,000 魚幣・5 人持有" },
    { code: "其他", name: "少於 2 人持有的", sector: "其他", weight: 1000, change: null, price: null, currency: null, coin_price: null, basis: "2 檔合計約 1,000 魚幣" },
  ],
};

function serve(colors: "tw" | "us" = "tw") {
  const asked: string[] = [];
  mockFetch((_method, url) => {
    const path = url.pathname;
    if (!path.startsWith("/api/member/exchange")) return undefined;
    asked.push(`${path}${url.search}`);
    if (path === "/api/member/exchange") return { body: market(colors) };
    if (path === "/api/member/exchange/list/tw") return { body: { kind: "tw", label: "熱門台股", rows: [TSMC] } };
    if (path.startsWith("/api/member/exchange/ticker/")) return { body: { line: TSMC, points: [], watching: false } };
    if (path.startsWith("/api/member/exchange/candles/")) return { body: candles((url.searchParams.get("tf") ?? "daily") as ExchangeCandles["tf"]) };
    if (path.startsWith("/api/member/exchange/map/")) return { body: { ...MAP, kind: path.split("/").at(-1) } };
    if (path === "/api/member/exchange/account") return { status: 403, body: { error: "她還不認識你" } };
    return undefined;
  });
  return asked;
}

const openTicker = async () => {
  await userEvent.click(await screen.findByRole("button", { name: "2330.TW" }));
  await waitFor(() => expect(drawn.charts.some((c) => !c.removed)).toBe(true));
  return drawn.charts.filter((c) => !c.removed).at(-1) as (typeof drawn.charts)[number];
};

describe("the candle chart", () => {
  it("draws candles in the convention's colours, MA5/MA20/MA60, volume in its own pane and their own lines", async () => {
    drawn.charts.length = 0;
    serve("tw");
    renderPage(<Exchange />);
    const chart = await openTicker();
    const m = moveColors("tw");
    const bars = chart.series.find((s) => s.kind === "Candlestick");
    expect(bars?.options).toMatchObject({ upColor: m.up, downColor: m.down, wickUpColor: m.up, wickDownColor: m.down });
    expect(bars?.data).toHaveLength(70);
    // The averages, worked out here from the closes.
    const lines = chart.series.filter((s) => s.kind === "Line");
    expect(lines).toHaveLength(3);
    const closes = candles("daily").candles.map((k) => k.c);
    MA_PERIODS.forEach((n, i) => {
      const want = movingAverage(closes, n).filter((v) => v !== null);
      expect(((lines[i]?.data ?? []) as { value: number }[]).map((p) => p.value)).toEqual(want);
    });
    // Volume under the price, coloured by each bar's direction.
    const volume = chart.series.find((s) => s.kind === "Histogram");
    expect(volume?.pane).toBe(1);
    expect((volume?.data[0] as { color: string } | undefined)?.color.startsWith(m.down)).toBe(true);
    expect((volume?.data[1] as { color: string } | undefined)?.color.startsWith(m.up)).toBe(true);
    // Their average cost and the 2× line.
    expect(bars?.lines.map((l) => [l.price, l.title])).toEqual([
      [1950, "你的成本"],
      [1600, "2 倍自動賣出"],
    ]);
    // The library's attribution stays.
    expect((chart.options.layout as { attributionLogo: boolean }).attributionLogo).toBe(true);
    // The legend: each average with its value and direction.
    expect(screen.getByText(/^MA5 /)).toBeInTheDocument();
    expect(screen.getByText(/^MA60 /)).toBeInTheDocument();
    expect(screen.getByText(/虛線是你的平均成本/)).toBeInTheDocument();
  });

  it("switches green and red under the us convention", async () => {
    drawn.charts.length = 0;
    serve("us");
    renderPage(<Exchange />);
    const chart = await openTicker();
    expect(chart.series.find((s) => s.kind === "Candlestick")?.options).toMatchObject({ upColor: moveColors("us").up });
    expect(moveColors("us").up).toBe(moveColors("tw").down);
  });

  it("changes timeframe from the keyboard and asks for those candles", async () => {
    drawn.charts.length = 0;
    const asked = serve();
    renderPage(<Exchange />);
    await openTicker();
    const group = screen.getByRole("radiogroup", { name: "K 線的週期" });
    expect(within(group).getAllByRole("radio").map((r) => r.textContent)).toEqual(["當日", "日線", "週線", "月線"]);
    // The market is closed: it opens on 日線.
    const daily = within(group).getByRole("radio", { name: "日線" });
    expect(daily).toHaveAttribute("aria-checked", "true");
    daily.focus();
    await userEvent.keyboard("{ArrowRight}");
    await waitFor(() => expect(asked).toContain("/api/member/exchange/candles/2330.TW?tf=weekly"));
    expect(within(group).getByRole("radio", { name: "週線" })).toHaveAttribute("aria-checked", "true");
  });

  it("shows the bar's open, high, low, close and change at the crosshair", async () => {
    drawn.charts.length = 0;
    serve();
    renderPage(<Exchange />);
    const chart = await openTicker();
    const bars = chart.series.find((s) => s.kind === "Candlestick")?.data as { time: number }[];
    act(() => chart.move?.({ time: bars[10]?.time, point: { x: 40, y: 80 } }));
    const tip = await screen.findByRole("status");
    const k = candles("daily").candles[10];
    expect(tip).toHaveTextContent(`開 ${(k?.o ?? 0).toLocaleString("en-US")}`);
    expect(tip).toHaveTextContent(`收 ${(k?.c ?? 0).toLocaleString("en-US")}`);
    expect(tip).toHaveTextContent(/漲跌 [▲▼] [+−]/);
    act(() => chart.move?.({}));
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });
});

describe("the chart's arithmetic", () => {
  it("puts each bar on its market's wall clock", () => {
    // 09:00 Taipei on 11/20 is 01:00 UTC; drawn as 09:00.
    expect(wallSeconds(Date.UTC(2026, 10, 20, 1, 0), "Asia/Taipei")).toBe(Date.UTC(2026, 10, 20, 9, 0) / 1000);
    // New York in summer (UTC−4) and winter (UTC−5).
    expect(wallSeconds(Date.UTC(2026, 6, 6, 13, 30), "America/New_York")).toBe(Date.UTC(2026, 6, 6, 9, 30) / 1000);
    expect(wallSeconds(Date.UTC(2026, 0, 5, 14, 30), "America/New_York")).toBe(Date.UTC(2026, 0, 5, 9, 30) / 1000);
  });

  it("leaves volume out when there is none and words a bar's change from the one before", () => {
    const c = candles("daily");
    const s = chartSeries({ ...c, volume: false }, "tw");
    expect(s.volume).toEqual([]);
    expect(s.ma.map((m) => m.points.length)).toEqual([66, 51, 11]);
    const w = barWords(s, 1, "daily");
    expect(w?.change).toBe("▲ +0.7%");
    expect(barWords(s, 0, "daily")?.change).toBe("—");
    expect(w?.when).toBe("2026/8/2");
  });
});

describe("the heat map", () => {
  it("lays the tiles out by weight, colours them by the convention and names each one", async () => {
    drawn.charts.length = 0;
    const asked = serve("tw");
    renderPage(<Exchange />);
    await userEvent.click(await screen.findByRole("tab", { name: "熱力圖" }));
    const map = await screen.findByRole("group", { name: "伺服器持股圖" });
    const tsmc = within(map).getByRole("button", { name: /示範半導體\(2330\.TW\)/ });
    expect(tsmc).toHaveAccessibleName(/最近一個交易日 ▲ \+1\.7%/);
    // The name first, the code under it, then the change.
    expect(tsmc).toHaveTextContent("示範半導體2330▲ +1.7%");
    expect(tsmc).toHaveAccessibleName(/伺服器合計約 6,000 魚幣・3 人持有/);
    expect(tsmc).toHaveStyle({ background: tileColor(0.0174, "tw") });
    const rice = within(map).getByRole("button", { name: /白飯食品/ });
    // Area by weight: 2330 holds twice RICE's.
    const area = (el: HTMLElement) => Number.parseFloat(el.style.width) * Number.parseFloat(el.style.height);
    expect(area(tsmc) / area(rice)).toBeCloseTo(2, 0);
    // 其他 is several tickers: named, not a link.
    expect(within(map).queryByRole("button", { name: /少於 2 人持有的/ })).not.toBeInTheDocument();
    expect(within(map).getByRole("note", { name: /2 檔合計約 1,000 魚幣/ })).toBeInTheDocument();
    // Hover or focus shows the tooltip; the footnote and the convention are under the map.
    tsmc.focus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("伺服器合計約 6,000 魚幣");
    expect(screen.getByText(/格子大小為伺服器合計持有的市值/)).toBeInTheDocument();
    expect(screen.getByText(/紅漲綠跌\(台股習慣\)/)).toBeInTheDocument();
    expect(asked).toContain("/api/member/exchange/map/holdings");
    // The switch to the 熱門 maps.
    await userEvent.click(screen.getByRole("radio", { name: "熱門美股" }));
    await waitFor(() => expect(asked).toContain("/api/member/exchange/map/us"));
    // Enter on a tile opens its ticker on the market tab.
    const tile = within(await screen.findByRole("group", { name: "伺服器持股圖" })).getByRole("button", { name: /2330\.TW/ });
    tile.focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(asked.some((a) => a.startsWith("/api/member/exchange/ticker/2330.TW"))).toBe(true));
    expect(await screen.findByRole("radiogroup", { name: "K 線的週期" })).toBeInTheDocument();
  });

  it("swaps red and green under the us convention", () => {
    expect(tileColor(0.02, "us")).toBe(tileColor(-0.02, "tw"));
  });
});
