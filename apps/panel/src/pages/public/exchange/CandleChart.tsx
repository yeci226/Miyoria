// A ticker's candle chart on the member page (owner 2026-11-21: "a real stock chart"), loaded only
// when someone opens a ticker: candles in the product's up/down convention, MA5 / MA20 / MA60
// (worked out here from the candles), volume in its own pane under them, the timeframe switch
// 當日 / 日線 / 週線 / 月線 (a radio group: arrow keys move it), a legend with each average's
// value and direction at the crosshair, a tooltip with the bar's open, high, low, close and change,
// and the member's own average cost and each 2× position's selling line as horizontal lines.
// Colours are the panel's tokens, read from the page when the chart is drawn.
//
// Drawn with TradingView Lightweight Charts™ (Apache-2.0), Copyright (c) 2025 TradingView, Inc.,
// https://www.tradingview.com/. Its attribution logo stays on the chart, as its licence asks.

import { useQuery } from "@tanstack/react-query";
import {
  type AutoscaleInfo,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  createChart,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { ExchangeCandles } from "@miyoria/contracts/api";
import { moveColors } from "@miyoria/card-face/market";
import { isNotProvided } from "@/api/http";
import { useApi } from "@/app/connection";
import { ChartBlock, ChartEmpty } from "@/components/charts/charts";
import { ErrorLine } from "@/components/query-state";
import { Segmented } from "@/components/ui/segmented";
import {
  type BarWords,
  barWords,
  type ChartSeries,
  chartSeries,
  type Convention,
  priceText,
  TIMEFRAME_LABEL,
  TIMEFRAMES,
  type Timeframe,
  timeText,
} from "./chart-data";

/** The averages' colours: the light neutral first (MA5 lies on the candles), then the theme's two. */
const MA_VARS = ["--chart-3", "--chart-2", "--chart-1"] as const;
const MA_FALLBACK = ["#c9c8d1", "#8a68ee", "#d9609a"] as const;

export interface CandleChartProps {
  code: string;
  title: string;
  colors: Convention;
  /** Its market is in session: the chart opens on 當日. */
  open: boolean;
  /** Today's move, written beside the title. */
  move: ReactNode;
}

function Legend({ words, colors }: { words: BarWords | null; colors: Convention }) {
  const m = moveColors(colors);
  if (!words) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs tabular-nums text-muted-foreground">
      {words.ma.map((a, i) => (
        <span key={a.period} className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-0.5 w-3 rounded-full" style={{ background: `var(${MA_VARS[i]}, ${MA_FALLBACK[i]})` }} />
          {`MA${a.period} ${a.value}`}
          {a.dir !== null && a.dir !== 0 && (
            <span style={{ color: a.dir > 0 ? m.up : m.down }} aria-label={a.dir > 0 ? "向上" : "向下"}>
              {a.dir > 0 ? "▲" : "▼"}
            </span>
          )}
        </span>
      ))}
    </p>
  );
}

function Tip({ words, x, y, width, colors }: { words: BarWords; x: number; y: number; width: number; colors: Convention }) {
  const m = moveColors(colors);
  const left = x + 168 > width ? Math.max(0, x - 176) : x + 12;
  return (
    <div
      role="status"
      className="glass-float pointer-events-none absolute z-10 grid w-40 gap-0.5 rounded-md px-2.5 py-2 text-xs tabular-nums"
      style={{ left, top: Math.max(0, y - 60) }}
    >
      <span className="font-medium">{words.when}</span>
      <span>{`開 ${words.open}`}</span>
      <span>{`高 ${words.high}`}</span>
      <span>{`低 ${words.low}`}</span>
      <span>{`收 ${words.close}`}</span>
      <span style={{ color: words.move > 0 ? m.up : words.move < 0 ? m.down : undefined }}>{`漲跌 ${words.change}`}</span>
    </div>
  );
}

function Plot({
  series,
  tf,
  colors,
  marks,
  label,
  onHover,
}: {
  series: ChartSeries;
  tf: Timeframe;
  colors: Convention;
  marks: ExchangeCandles["marks"];
  label: string;
  onHover: (h: { i: number; x: number; y: number } | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const css = getComputedStyle(el);
    const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    const grid = token("--chart-grid", "rgba(255, 255, 255, 0.07)");
    const axis = token("--chart-axis", "rgba(255, 255, 255, 0.18)");
    const text = token("--muted-foreground", "#dedce4");
    const m = moveColors(colors);
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: text,
        fontSize: 11,
        fontFamily: css.fontFamily || "sans-serif",
        attributionLogo: true,
        panes: { separatorColor: grid, separatorHoverColor: axis, enableResize: false },
      },
      grid: { vertLines: { color: grid }, horzLines: { color: grid } },
      rightPriceScale: { borderColor: axis },
      timeScale: {
        borderColor: axis,
        timeVisible: tf === "intraday",
        secondsVisible: false,
        tickMarkFormatter: (t: Time) => {
          const s = timeText(t as number, tf);
          return tf === "daily" || tf === "weekly" ? s.slice(s.indexOf("/") + 1) : s;
        },
      },
      localization: {
        locale: "zh-TW",
        timeFormatter: (t: Time) => timeText(t as number, tf),
        priceFormatter: priceText,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: axis, labelBackgroundColor: "#2a2c37" },
        horzLine: { color: axis, labelBackgroundColor: "#2a2c37" },
      },
    });
    // Their own lines stay in view when they are near the bars (within half the price again).
    const last = series.bars.at(-1)?.close ?? 0;
    const near = [marks.avg_cost, ...marks.liquidation].filter(
      (p): p is number => p !== null && p > last * 0.5 && p < last * 1.5,
    );
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: m.up,
      downColor: m.down,
      borderUpColor: m.up,
      borderDownColor: m.down,
      wickUpColor: m.up,
      wickDownColor: m.down,
      autoscaleInfoProvider: (base: () => AutoscaleInfo | null) => {
        const r = base();
        if (!r?.priceRange || near.length === 0) return r;
        return {
          ...r,
          priceRange: {
            minValue: Math.min(r.priceRange.minValue, ...near),
            maxValue: Math.max(r.priceRange.maxValue, ...near),
          },
        };
      },
    });
    candles.setData(series.bars.map((b) => ({ ...b, time: b.time as UTCTimestamp })));
    series.ma.forEach((a, i) => {
      const line = chart.addSeries(LineSeries, {
        color: token(MA_VARS[i] as string, MA_FALLBACK[i] as string),
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      line.setData(a.points.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
    });
    if (marks.avg_cost !== null)
      candles.createPriceLine({
        price: marks.avg_cost,
        color: token("--chart-3", "#c9c8d1"),
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "你的成本",
      });
    for (const price of marks.liquidation)
      candles.createPriceLine({
        price,
        color: token("--primary", "#f29dc4"),
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: true,
        title: "2 倍自動賣出",
      });
    if (series.volume.length > 0) {
      const volume = chart.addSeries(
        HistogramSeries,
        { priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: false },
        1,
      );
      volume.setData(series.volume.map((v) => ({ ...v, time: v.time as UTCTimestamp })));
      chart.panes()[0]?.setStretchFactor(3);
      chart.panes()[1]?.setStretchFactor(1);
    }
    chart.timeScale().fitContent();
    // Every bar in view again when the page's width changes (a phone turned, a window resized).
    const fit = new ResizeObserver(() => chart.timeScale().fitContent());
    fit.observe(el);
    const index = new Map(series.bars.map((b, i) => [b.time, i]));
    const move = (p: MouseEventParams<Time>) => {
      const i = p.time === undefined ? undefined : index.get(p.time as number);
      onHover(i === undefined || !p.point ? null : { i, x: p.point.x, y: p.point.y });
    };
    chart.subscribeCrosshairMove(move);
    return () => {
      fit.disconnect();
      chart.unsubscribeCrosshairMove(move);
      chart.remove();
    };
  }, [series, tf, colors, marks, onHover]);
  return <div ref={ref} role="img" aria-label={label} className="h-72 w-full sm:h-80" />;
}

/** The candle chart block of one ticker: the switch, the legend, the chart. */
export default function CandleChart({ code, title, colors, open, move }: CandleChartProps) {
  const api = useApi();
  const [tf, setTf] = useState<Timeframe>(open ? "intraday" : "daily");
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const q = useQuery({
    queryKey: ["member", "exchange", "candles", code, tf],
    queryFn: ({ signal }) => api.rpc.exchange.candles({ params: { code }, query: { tf } }, { signal }),
    refetchInterval: (s) => (s.state.error ? false : tf === "intraday" ? 60_000 : 300_000),
    retry: (n, e) => !isNotProvided(e) && n < 1,
  });
  const series = useMemo(() => (q.data ? chartSeries(q.data, colors) : null), [q.data, colors]);
  const last = series ? series.bars.length - 1 : -1;
  const shown = series ? barWords(series, hover?.i ?? last, tf) : null;
  const tip = series && hover ? barWords(series, hover.i, tf) : null;
  const lastWords = series ? barWords(series, last, tf) : null;
  const label = lastWords
    ? `${title} ${TIMEFRAME_LABEL[tf]} K 線圖:最後一根收 ${lastWords.close}(${lastWords.change}),${lastWords.ma.map((a) => `MA${a.period} ${a.value}`).join("、")}`
    : `${title} ${TIMEFRAME_LABEL[tf]} K 線圖`;
  return (
    <ChartBlock
      title={title}
      value={lastWords ? lastWords.close : "—"}
      aside={move}
      action={
        <Segmented
          label="K 線的週期"
          value={tf}
          onChange={(v) => {
            setHover(null);
            setTf(v);
          }}
          options={TIMEFRAMES.map((v) => ({ value: v, label: TIMEFRAME_LABEL[v] }))}
        />
      }
    >
      <Legend words={shown} colors={colors} />
      {q.isPending ? (
        <ChartEmpty height={288}>載入 K 線…</ChartEmpty>
      ) : q.isError ? (
        <ErrorLine error={q.error} onRetry={() => void q.refetch()} />
      ) : !series || series.bars.length < 2 ? (
        <ChartEmpty height={288}>還沒有 K 線</ChartEmpty>
      ) : (
        <div ref={box} className="relative min-w-0">
          <Plot series={series} tf={tf} colors={colors} marks={q.data.marks} label={label} onHover={setHover} />
          {tip && hover && <Tip words={tip} x={hover.x} y={hover.y} width={box.current?.clientWidth ?? 320} colors={colors} />}
        </div>
      )}
      {q.data && (
        <p className="text-xs text-muted-foreground">
          {[
            q.data.volume ? "下方是成交量" : "這檔沒有成交量",
            q.data.marks.avg_cost !== null ? "虛線是你的平均成本" : null,
            q.data.marks.liquidation.length > 0 ? "點線是 2 倍部位依規則自動賣出的價格" : null,
            q.data.stale ? "報價來源暫時沒有回應,K 線可能不是最新的" : null,
          ]
            .filter((x) => x !== null)
            .join(";")}
        </p>
      )}
    </ChartBlock>
  );
}
