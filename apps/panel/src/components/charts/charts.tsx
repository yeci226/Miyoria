// Hand-drawn SVG charts in the panel's chart system: 2px lines, 10% area washes, ≤24px columns
// with 4px data ends and 2px surface gaps, hairline grids, mono tick labels, one tooltip per X
// (keyboard too), a legend from two series up, and a screen-reader table behind every chart.

import {
  createContext,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import {
  areaPath,
  columnPath,
  type Domain,
  linear,
  linePath,
  nearest,
  niceMax,
  sampleIndexes,
  ticks,
} from "./scale";

// ---- shared bits ---------------------------------------------------------------------------

export interface SeriesDef {
  key: string;
  label: string;
  /** A `--chart-*` color (CSS value). */
  color: string;
}

export interface LineSeries extends SeriesDef {
  values: (number | null)[];
}

const clockFmt = new Intl.DateTimeFormat("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false });
const dayFmt = new Intl.DateTimeFormat("zh-TW", { month: "numeric", day: "numeric" });

export const fmtClock = (t: number) => clockFmt.format(t);

/** Width of the element, tracked with a ResizeObserver. */
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setW(Math.round(entry.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

const STEPS = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440].map((m) => m * 60_000);

/** Round local-time ticks between `t0` and `t1`. */
function timeTicks(t0: number, t1: number, max: number): number[] {
  const span = t1 - t0;
  const step = STEPS.find((s) => span / s <= max) ?? STEPS[STEPS.length - 1] ?? 3_600_000;
  const offset = new Date(t0).getTimezoneOffset() * 60_000;
  const out: number[] = [];
  for (let t = Math.ceil((t0 - offset) / step) * step + offset; t <= t1; t += step) out.push(t);
  return out;
}

function timeLabel(t: number, span: number): string {
  return span > 36 * 3_600_000 ? dayFmt.format(t) : clockFmt.format(t);
}

/** Tooltip heading: the time, with the day when the chart spans days. */
function tipLabel(t: number, span: number): string {
  return span > 20 * 3_600_000 ? `${dayFmt.format(t)} ${clockFmt.format(t)}` : clockFmt.format(t);
}

/** Legend: a short line (lines) or a square (columns) per series, in text ink. */
export function Legend({ series, shape = "line", className }: { series: SeriesDef[]; shape?: "line" | "box"; className?: string }) {
  return (
    <ul className={cn("flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground", className)}>
      {series.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className={shape === "line" ? "h-0.5 w-3 rounded-full" : "size-2 rounded-[2px]"}
            style={{ background: s.color }}
          />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

function Tooltip({ x, width, title, rows }: { x: number; width: number; title: string; rows: { key: string; color?: string; label: string; value: string }[] }) {
  const right = x > width * 0.6;
  return (
    <div
      role="presentation"
      className="glass-float pointer-events-none absolute top-1 z-10 min-w-36 rounded-md px-2.5 py-2 text-xs"
      style={right ? { right: width - x + 12 } : { left: x + 12 }}
    >
      <p className="mb-1.5 font-mono text-[11px] text-muted-foreground tabular-nums">{title}</p>
      <ul className="grid gap-1">
        {rows.map((r) => (
          <li key={r.key} className="flex items-center gap-2">
            {r.color && <span aria-hidden className="h-0.5 w-2.5 shrink-0 rounded-full" style={{ background: r.color }} />}
            <span className="font-mono font-medium text-foreground tabular-nums">{r.value}</span>
            <span className="ml-auto pl-3 text-muted-foreground">{r.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A visually hidden table of the plotted values (at most 24 rows). */
function DataTableSr({ caption, head, rows }: { caption: string; head: string[]; rows: string[][] }) {
  // `overflow: hidden` does not apply to a table box: the wrapper keeps it out of the layout.
  return (
    <div className="sr-only">
    <table>
      <caption>{caption}</caption>
      <thead>
        <tr>
          {head.map((h) => (
            <th key={h} scope="col">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, row) => (
          <tr key={`${row}:${r[0]}`}>
            {r.map((c, i) => (
              <td key={i}>{c}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}

// ---- synced hover (small multiples share one crosshair) -------------------------------------

interface HoverSync {
  t: number | null;
  set: (t: number | null) => void;
}

const HoverContext = createContext<HoverSync | null>(null);

export function HoverGroup({ children }: { children: ReactNode }) {
  const [t, set] = useState<number | null>(null);
  const value = useMemo(() => ({ t, set }), [t]);
  return <HoverContext.Provider value={value}>{children}</HoverContext.Provider>;
}

/** Hover state: the group's when inside a `HoverGroup`, else local. */
function useHover(): HoverSync {
  const group = useContext(HoverContext);
  const [t, set] = useState<number | null>(null);
  return group ?? { t, set };
}

export function useHoverTime(): number | null {
  return useContext(HoverContext)?.t ?? null;
}

// ---- time series ---------------------------------------------------------------------------

export interface TimeChartProps {
  /** Sample times (ms), ascending. */
  times: number[];
  series: LineSeries[];
  label: string;
  height?: number;
  /** Fixed y domain; default from the data (from 0 when `fromZero`). */
  domain?: Domain;
  fromZero?: boolean;
  /** A 10% wash under each line. */
  area?: boolean;
  /** Hairline at 0 (for -1..1 values). */
  zero?: boolean;
  format?: (v: number) => string;
  /** No axes or tooltip box: small multiples read the hovered value elsewhere. */
  compact?: boolean;
  legend?: boolean;
  className?: string;
}

export function TimeChart({
  times,
  series,
  label,
  height = 180,
  domain,
  fromZero,
  area,
  zero,
  format = (v) => v.toFixed(2),
  compact,
  legend = true,
  className,
}: TimeChartProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const hover = useHover();
  const titleId = useId();

  const m = compact ? { l: 0, r: 0, t: 4, b: 2 } : { l: 40, r: 8, t: 8, b: 22 };
  const t0 = times[0] ?? 0;
  const t1 = times[times.length - 1] ?? 1;
  const yDomain = useMemo<Domain>(() => {
    if (domain) return domain;
    let hi = Number.NEGATIVE_INFINITY;
    let lo = Number.POSITIVE_INFINITY;
    for (const s of series)
      for (const v of s.values)
        if (v !== null && Number.isFinite(v)) {
          hi = Math.max(hi, v);
          lo = Math.min(lo, v);
        }
    if (!Number.isFinite(hi)) return [0, 1];
    if (fromZero || lo >= 0) return niceMax(hi);
    return [Math.min(lo, 0), Math.max(hi, 0)];
  }, [domain, series, fromZero]);

  const x = linear([t0, t1 === t0 ? t0 + 1 : t1], [m.l, Math.max(m.l + 1, width - m.r)]);
  const y = linear(yDomain, [height - m.b, m.t]);
  const xs = times.map(x);
  const yTicks = compact ? [] : ticks(yDomain, height < 140 ? 2 : 3);
  const xTicks = compact || width === 0 ? [] : timeTicks(t0, t1, Math.max(2, Math.floor(width / 110)));
  const base = y(Math.max(yDomain[0], Math.min(0, yDomain[1])));

  const hi = hover.t === null || times.length === 0 ? -1 : nearest(times, hover.t);
  const hx = hi >= 0 ? (xs[hi] ?? 0) : 0;

  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left + m.l;
    const i = nearest(xs, px);
    hover.set(i >= 0 ? (times[i] ?? null) : null);
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (times.length === 0) return;
    const cur = hi < 0 ? times.length - 1 : hi;
    const step = e.shiftKey ? 10 : 1;
    let next = cur;
    if (e.key === "ArrowLeft") next = Math.max(0, cur - step);
    else if (e.key === "ArrowRight") next = Math.min(times.length - 1, cur + step);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = times.length - 1;
    else if (e.key === "Escape") {
      hover.set(null);
      return;
    } else return;
    e.preventDefault();
    hover.set(times[next] ?? null);
  };

  const rows = sampleIndexes(times.length, 24).map((i) => [
    tipLabel(times[i] ?? 0, t1 - t0),
    ...series.map((s) => {
      const v = s.values[i];
      return v === null || v === undefined ? "—" : format(v);
    }),
  ]);

  return (
    <div className={cn("grid gap-3", className)}>
      {legend && series.length > 1 && <Legend series={series} />}
      <div ref={ref} className="relative" style={{ height }}>
        {width > 0 && (
          <svg
            width={width}
            height={height}
            role="img"
            aria-labelledby={titleId}
            tabIndex={compact ? -1 : 0}
            onKeyDown={onKey}
            onBlur={() => hover.set(null)}
            className="block overflow-visible rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <title id={titleId}>{label}</title>
            {yTicks.map((v) => (
              <g key={v}>
                <line x1={m.l} x2={width - m.r} y1={y(v)} y2={y(v)} stroke="var(--chart-grid)" />
                <text
                  x={m.l - 8}
                  y={y(v)}
                  dy="0.32em"
                  textAnchor="end"
                  className="fill-muted-foreground font-mono text-[10.5px] tabular-nums"
                >
                  {format(v)}
                </text>
              </g>
            ))}
            {zero && yDomain[0] < 0 && yDomain[1] > 0 && (
              <line x1={m.l} x2={width - m.r} y1={y(0)} y2={y(0)} stroke="var(--chart-axis)" />
            )}
            {compact && (
              <>
                <line x1={0} x2={width} y1={m.t} y2={m.t} stroke="var(--chart-grid)" />
                <line x1={0} x2={width} y1={height - m.b} y2={height - m.b} stroke={zero ? "var(--chart-grid)" : "var(--chart-axis)"} />
              </>
            )}
            {!compact && <line x1={m.l} x2={width - m.r} y1={height - m.b} y2={height - m.b} stroke="var(--chart-axis)" />}
            {xTicks.map((t) => (
              <text
                key={t}
                x={x(t)}
                y={height - 6}
                textAnchor="middle"
                className="fill-muted-foreground font-mono text-[10.5px] tabular-nums"
              >
                {timeLabel(t, t1 - t0)}
              </text>
            ))}
            {series.map((s) => {
              const ys = s.values.map((v) => (v === null ? null : y(v)));
              return (
                <g key={s.key}>
                  {area && <path d={areaPath(xs, ys, base)} fill={s.color} fillOpacity={0.1} />}
                  <path
                    d={linePath(xs, ys)}
                    fill="none"
                    stroke={s.color}
                    strokeWidth={compact ? 1.5 : 2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                </g>
              );
            })}
            {hi >= 0 && (
              <g pointerEvents="none">
                <line x1={hx} x2={hx} y1={m.t} y2={height - m.b} stroke="var(--chart-axis)" />
                {series.map((s) => {
                  const v = s.values[hi];
                  if (v === null || v === undefined) return null;
                  return (
                    <circle key={s.key} cx={hx} cy={y(v)} r={compact ? 3 : 4} fill={s.color} stroke="var(--chart-surface)" strokeWidth={2} />
                  );
                })}
              </g>
            )}
            <rect
              x={m.l}
              y={0}
              width={Math.max(0, width - m.l - m.r)}
              height={height}
              fill="transparent"
              onPointerMove={onMove}
              onPointerLeave={() => hover.set(null)}
            />
          </svg>
        )}
        {!compact && hi >= 0 && (
          <Tooltip
            x={hx}
            width={width}
            title={tipLabel(times[hi] ?? 0, t1 - t0)}
            rows={series.map((s) => {
              const v = s.values[hi];
              return { key: s.key, color: s.color, label: s.label, value: v === null || v === undefined ? "—" : format(v) };
            })}
          />
        )}
      </div>
      <DataTableSr caption={label} head={["時間", ...series.map((s) => s.label)]} rows={rows} />
    </div>
  );
}

// ---- columns -------------------------------------------------------------------------------

export interface Column {
  /** Bucket start (ms). */
  t: number;
  values: Record<string, number>;
}

export interface ColumnChartProps {
  columns: Column[];
  /** Bottom to top. */
  series: SeriesDef[];
  label: string;
  /** Bucket length, for the tooltip's range. */
  bucketMs: number;
  height?: number;
  format?: (v: number) => string;
  /** Tooltip row for the column total (e.g. `合計`). */
  totalLabel?: string;
  legend?: boolean;
  /** Counts: no tick between whole numbers. */
  integer?: boolean;
  className?: string;
}

export function ColumnChart({
  columns,
  series,
  label,
  bucketMs,
  height = 180,
  format = (v) => String(Math.round(v)),
  totalLabel,
  legend = true,
  integer = false,
  className,
}: ColumnChartProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hi, setHi] = useState<number | null>(null);
  const titleId = useId();
  const m = { l: 40, r: 4, t: 8, b: 22 };

  const totals = columns.map((c) => series.reduce((n, s) => n + (c.values[s.key] ?? 0), 0));
  const yDomain = niceMax(Math.max(0, ...totals), height < 140 ? 2 : 3);
  const y = linear(yDomain, [height - m.b, m.t]);
  const n = Math.max(columns.length, 1);
  const slot = Math.max(0, (width - m.l - m.r) / n);
  const bar = Math.max(2, Math.min(24, slot * 0.62));
  const yTicks = ticks(yDomain, height < 140 ? 2 : 3).filter((v) => !integer || Number.isInteger(v));
  const span = columns.length > 0 ? (columns[columns.length - 1]?.t ?? 0) - (columns[0]?.t ?? 0) : 0;
  // Label the columns that start on a round time, about one per 80px.
  const every = bucketMs * Math.max(1, Math.ceil(n / Math.max(2, Math.floor(width / 80))));
  const labelStep = STEPS.find((s) => s >= every) ?? every;
  const tz = columns[0] ? new Date(columns[0].t).getTimezoneOffset() * 60_000 : 0;
  const labeled = (t: number) => (t - tz) % labelStep === 0;

  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (columns.length === 0) return;
    const cur = hi ?? columns.length - 1;
    if (e.key === "ArrowLeft") setHi(Math.max(0, cur - 1));
    else if (e.key === "ArrowRight") setHi(Math.min(columns.length - 1, cur + 1));
    else if (e.key === "Escape") setHi(null);
    else return;
    e.preventDefault();
  };

  const hoverCol = hi === null ? null : columns[hi];
  const daily = bucketMs >= 86_400_000;
  const when = (t: number) => (daily ? dayFmt.format(t) : clockFmt.format(t));
  const rows = sampleIndexes(columns.length, daily ? 31 : 24).map((i) => {
    const c = columns[i] as Column;
    return [when(c.t), ...series.map((s) => format(c.values[s.key] ?? 0))];
  });

  return (
    <div className={cn("grid gap-3", className)}>
      {legend && series.length > 1 && <Legend series={series} shape="box" />}
      <div ref={ref} className="relative" style={{ height }}>
        {width > 0 && (
          <svg
            width={width}
            height={height}
            role="img"
            aria-labelledby={titleId}
            tabIndex={0}
            onKeyDown={onKey}
            onBlur={() => setHi(null)}
            onPointerLeave={() => setHi(null)}
            className="block overflow-visible rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <title id={titleId}>{label}</title>
            {yTicks.map((v) => (
              <g key={v}>
                <line x1={m.l} x2={width - m.r} y1={y(v)} y2={y(v)} stroke="var(--chart-grid)" />
                <text x={m.l - 8} y={y(v)} dy="0.32em" textAnchor="end" className="fill-muted-foreground font-mono text-[10.5px] tabular-nums">
                  {format(v)}
                </text>
              </g>
            ))}
            {columns.map((c, i) => {
              const cx = m.l + slot * i + (slot - bar) / 2;
              let top = height - m.b;
              const visible = series.filter((s) => (c.values[s.key] ?? 0) > 0);
              const dim = hi !== null && hi !== i;
              return (
                <g key={c.t} opacity={dim ? 0.45 : 1} style={{ transition: "opacity 120ms" }}>
                  {visible.map((s, k) => {
                    const v = c.values[s.key] ?? 0;
                    const h = (height - m.b) - y(v);
                    const isTop = k === visible.length - 1;
                    // 2px surface gap above every segment but the top one.
                    const gap = isTop ? 0 : Math.min(2, h / 2);
                    const segTop = top - h;
                    const d = columnPath(cx, segTop + gap, bar, h - gap, isTop);
                    top = segTop;
                    return <path key={s.key} d={d} fill={s.color} />;
                  })}
                  {labeled(c.t) && (
                    <text x={cx + bar / 2} y={height - 6} textAnchor="middle" className="fill-muted-foreground font-mono text-[10.5px] tabular-nums">
                      {timeLabel(c.t, span)}
                    </text>
                  )}
                  <rect
                    x={m.l + slot * i}
                    y={0}
                    width={slot}
                    height={height - m.b}
                    fill="transparent"
                    onPointerEnter={() => setHi(i)}
                  />
                </g>
              );
            })}
            <line x1={m.l} x2={width - m.r} y1={height - m.b} y2={height - m.b} stroke="var(--chart-axis)" />
          </svg>
        )}
        {hoverCol && hi !== null && (
          <Tooltip
            x={m.l + slot * hi + slot / 2}
            width={width}
            title={daily ? dayFmt.format(hoverCol.t) : `${clockFmt.format(hoverCol.t)}–${clockFmt.format(hoverCol.t + bucketMs)}`}
            rows={[
              ...[...series].reverse().map((s) => ({ key: s.key, color: s.color, label: s.label, value: format(hoverCol.values[s.key] ?? 0) })),
              ...(totalLabel ? [{ key: "__total", label: totalLabel, value: format(totals[hi] ?? 0) }] : []),
            ]}
          />
        )}
      </div>
      <DataTableSr caption={label} head={[daily ? "日期" : "時間", ...series.map((s) => s.label)]} rows={rows} />
    </div>
  );
}

// ---- small multiples -----------------------------------------------------------------------

export interface Facet {
  key: string;
  label: string;
  values: (number | null)[];
  domain: Domain;
  format?: (v: number) => string;
  zero?: boolean;
  color?: string;
}

/** One small chart per measure, a shared crosshair, and the hovered value in each header. */
export function Facets({ times, facets, height = 56, className }: { times: number[]; facets: Facet[]; height?: number; className?: string }) {
  return (
    <HoverGroup>
      <div className={cn("grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 xl:grid-cols-5", className)}>
        {facets.map((f) => (
          <FacetCell key={f.key} times={times} facet={f} height={height} />
        ))}
      </div>
    </HoverGroup>
  );
}

function FacetCell({ times, facet, height }: { times: number[]; facet: Facet; height: number }) {
  const t = useHoverTime();
  const fmt = facet.format ?? ((v: number) => v.toFixed(2));
  const i = t === null ? times.length - 1 : nearest(times, t);
  const v = i >= 0 ? (facet.values[i] ?? null) : null;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[13px] text-muted-foreground">{facet.label}</span>
        <span className="text-sm font-medium tabular-nums">{v === null ? "—" : fmt(v)}</span>
      </div>
      <TimeChart
        compact
        times={times}
        series={[{ key: facet.key, label: facet.label, color: facet.color ?? "var(--chart-line)", values: facet.values }]}
        domain={facet.domain}
        zero={facet.zero}
        label={`${facet.label}走勢`}
        height={height}
        format={fmt}
      />
    </div>
  );
}

// ---- proportions ---------------------------------------------------------------------------

export interface Part {
  key: string;
  label: string;
  value: number;
  color: string;
}

/** One 100% bar with 2px gaps and a legend carrying the counts. */
export function SegmentBar({ parts, label, format = (v) => String(v), className }: { parts: Part[]; label: string; format?: (v: number) => string; className?: string }) {
  const total = parts.reduce((n, p) => n + p.value, 0);
  const shown = parts.filter((p) => p.value > 0);
  return (
    <figure className={cn("grid gap-2.5", className)} aria-label={label}>
      <div className="flex h-2 w-full gap-0.5 overflow-hidden rounded-[2px]" role="img" aria-label={`${label}:${parts.map((p) => `${p.label} ${format(p.value)}`).join(",")}`}>
        {total > 0 &&
          shown.map((p) => (
            <span key={p.key} title={`${p.label} ${format(p.value)}`} className="h-full rounded-[2px]" style={{ width: `${(p.value / total) * 100}%`, background: p.color }} />
          ))}
      </div>
      <figcaption>
        <ul className="flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-muted-foreground">
          {parts.map((p) => (
            <li key={p.key} className="flex items-center gap-1.5">
              <span aria-hidden className="size-2 rounded-[2px]" style={{ background: p.color }} />
              {p.label}
              <span className="font-mono text-foreground tabular-nums">{format(p.value)}</span>
            </li>
          ))}
        </ul>
      </figcaption>
    </figure>
  );
}

/** Horizontal bars, largest first: label, bar, value. */
export function BarList({
  items,
  label,
  format = (v) => String(v),
  color = "var(--chart-line)",
  className,
}: {
  items: { key: string; label: ReactNode; value: number; detail?: string }[];
  label: string;
  format?: (v: number) => string;
  color?: string;
  className?: string;
}) {
  const max = Math.max(0, ...items.map((i) => i.value));
  return (
    <ul aria-label={label} className={cn("grid gap-2.5", className)}>
      {items.map((i) => (
        <li key={i.key} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-center gap-3 text-sm">
          <span className="truncate text-muted-foreground" title={typeof i.label === "string" ? i.label : undefined}>
            {i.label}
          </span>
          <span className="h-1.5 rounded-[2px] bg-muted">
            <span className="block h-full rounded-[2px]" style={{ width: `${max > 0 && i.value > 0 ? Math.max(2, (i.value / max) * 100) : 0}%`, background: color }} />
          </span>
          <span className="text-right font-mono text-[13px] tabular-nums" title={i.detail}>
            {format(i.value)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Wraps a chart with a title row and, optionally, a headline value. */
export function ChartBlock({
  title,
  value,
  unit,
  aside,
  action,
  children,
  className,
}: {
  title: ReactNode;
  value?: ReactNode;
  unit?: ReactNode;
  aside?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex min-w-0 flex-col gap-3", className)}>
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <div className="grid min-w-0 gap-1">
          <h2 className="text-[13px] font-medium text-muted-foreground">
            {title}
            {value === undefined && aside && <span className="ml-2 font-normal text-muted-foreground/80">{aside}</span>}
          </h2>
          {value !== undefined && (
            <p className="flex flex-wrap items-baseline gap-x-1.5 text-2xl font-semibold tracking-[-0.02em]">
              {value}
              {unit && <span className="text-sm font-normal text-muted-foreground">{unit}</span>}
              {aside && <span className="ml-1 text-[13px] font-normal text-muted-foreground">{aside}</span>}
            </p>
          )}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

/** Use for a chart's empty state, at the chart's height. */
export function ChartEmpty({ height = 180, children }: { height?: number; children: ReactNode }) {
  return (
    <div className="flex items-center justify-center rounded-md bg-well text-[13px] text-muted-foreground" style={{ height }}>
      {children}
    </div>
  );
}
