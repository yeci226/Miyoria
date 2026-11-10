// Chart blocks over `GET /api/telemetry` (and her thought journal), shared by 總覽, 內心 and 系統.

import { useMemo, useState } from "react";
import { isApiError } from "@/api/http";
import type { SelfView, TelemetryPoint } from "@/api/types";
import { useCost, useThoughtHistory, useTelemetry } from "@/app/queries";
import { Segmented } from "@/components/ui/segmented";
import { fmtCompact, fmtInt, fmtUsd } from "@/lib/format";
import { readStorage, writeStorage } from "@/lib/storage";
import { bucketize, type Range, RANGES, rangeOf, thoughtColumns } from "@/lib/telemetry";
import { DRIVE_LABEL, DRIVE_ORDER } from "@/pages/inner/labels";
import { ChartBlock, ChartEmpty, ColumnChart, type Facet, Facets, Legend, TimeChart } from "./charts/charts";
import { Skeleton } from "./ui/misc";

const RANGE_KEY = "miyoria.panel.range";

/** The chart range, remembered per browser. */
export function useRange(): [Range, (r: Range) => void] {
  const [range, set] = useState<Range>(() => {
    const saved = readStorage(RANGE_KEY);
    return RANGES.some((r) => r.range === saved) ? (saved as Range) : "6h";
  });
  return [
    range,
    (r) => {
      writeStorage(RANGE_KEY, r);
      set(r);
    },
  ];
}

export function RangeToggle({ range, onChange }: { range: Range; onChange: (r: Range) => void }) {
  return (
    <Segmented
      label="時間範圍"
      value={range}
      onChange={onChange}
      options={RANGES.map((r) => ({ value: r.range, label: r.label }))}
    />
  );
}

/** Telemetry for `range`, bucketed. */
export function useTrend(range: Range) {
  const cfg = rangeOf(range);
  const query = useTelemetry(cfg.minutes);
  const points = query.data?.points ?? [];
  const buckets = useMemo(() => bucketize(points, cfg.bucketMs, cfg.minutes), [points, cfg]);
  const times = useMemo(() => points.map((p) => Date.parse(p.at)), [points]);
  return { cfg, query, points, buckets, times };
}

type Trend = ReturnType<typeof useTrend>;

/** Loading, missing (older Core) and empty states at the chart's height. */
function Gate({ trend, height = 180, enough, children }: { trend: Trend; height?: number; enough?: boolean; children: () => React.ReactNode }) {
  if (trend.query.isPending) return <Skeleton className="w-full" style={{ height }} />;
  if (trend.query.isError) {
    const old = isApiError(trend.query.error) && trend.query.error.kind === "not_found";
    return <ChartEmpty height={height}>{old ? "這個 Core 還沒有趨勢資料" : "讀不到趨勢資料"}</ChartEmpty>;
  }
  if (trend.points.length < 2 || enough === false) return <ChartEmpty height={height}>資料還不夠畫圖</ChartEmpty>;
  return <>{children()}</>;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

const ACTIVITY = [
  { key: "messages", label: "聊天訊息", color: "var(--chart-1)" },
  { key: "utterances", label: "語音發言", color: "var(--chart-2)" },
  { key: "turns", label: "她的回覆", color: "var(--chart-3)" },
  { key: "initiatives", label: "主動開口", color: "var(--chart-4)" },
];

export function ActivityBlock({ trend }: { trend: Trend }) {
  const total = sum(trend.buckets.map((b) => (b.events.messages ?? 0) + (b.events.utterances ?? 0)));
  const replies = sum(trend.buckets.map((b) => b.events.turns ?? 0));
  return (
    <ChartBlock title="對話量" value={trend.query.isSuccess ? fmtInt(total) : "—"} unit="則" aside={trend.query.isSuccess ? `她回了 ${fmtInt(replies)} 則` : undefined}>
      <Gate trend={trend}>
        {() => (
          <ColumnChart
            label="每段時間的對話量"
            bucketMs={trend.cfg.bucketMs}
            series={ACTIVITY}
            totalLabel="合計"
            columns={trend.buckets.map((b) => ({ t: b.t, values: Object.fromEntries(ACTIVITY.map((s) => [s.key, b.events[s.key] ?? 0])) }))}
          />
        )}
      </Gate>
    </ChartBlock>
  );
}

const OUTCOMES = [
  { key: "acted", label: "付諸行動", color: "var(--chart-1)" },
  { key: "held", label: "想做但沒做", color: "var(--chart-2)" },
  { key: "none", label: "只是想想", color: "var(--chart-quiet)" },
];

export function ThoughtsBlock({ range }: { range: Range }) {
  const cfg = rangeOf(range);
  const thoughts = useThoughtHistory();
  const columns = useMemo(() => thoughtColumns(thoughts.data ?? [], cfg.bucketMs, cfg.minutes), [thoughts.data, cfg]);
  const total = sum(columns.map((c) => sum(Object.values(c.values))));
  const acted = sum(columns.map((c) => c.values.acted ?? 0));
  return (
    <ChartBlock
      title="想法"
      value={thoughts.isSuccess ? fmtInt(total) : "—"}
      unit="次"
      aside={thoughts.isSuccess && total > 0 ? `${Math.round((acted / total) * 100)}% 付諸行動` : undefined}
    >
      {thoughts.isPending ? (
        <Skeleton className="h-[180px] w-full" />
      ) : thoughts.isError ? (
        <ChartEmpty>心智迴圈沒有在執行</ChartEmpty>
      ) : (
        <ColumnChart label="每段時間的想法" bucketMs={cfg.bucketMs} series={OUTCOMES} totalLabel="合計" columns={columns} />
      )}
    </ChartBlock>
  );
}

type StatePoint = Pick<TelemetryPoint, "mood" | "boredom" | "drives" | "initiative">;
const pick = (points: StatePoint[], f: (p: StatePoint) => number | null | undefined) => points.map((p) => f(p) ?? null);
const signed = (v: number) => (v > 0 ? `+${v.toFixed(2)}` : v.toFixed(2));

/**
 * Her mood, boredom, initiative and drives as small multiples on one crosshair. `live` (the
 * polled `/api/self`) is appended as the newest point, so the values read now, not a minute ago.
 */
export function StateFacets({
  trend,
  live,
  title = "她的狀態",
  action,
}: {
  trend: Trend;
  live?: SelfView;
  title?: string;
  action?: React.ReactNode;
}) {
  const liveAt = live ? Date.parse(live.at) : Number.NaN;
  const last = trend.times[trend.times.length - 1] ?? 0;
  const fresh = live && Number.isFinite(liveAt) && liveAt > last && trend.points.length > 0;
  const p: StatePoint[] = fresh
    ? [...trend.points, { mood: live.mood, boredom: live.boredom, drives: live.drives, initiative: live.policy.initiative }]
    : trend.points;
  const times = fresh ? [...trend.times, liveAt] : trend.times;
  const facets: Facet[] = [
    { key: "valence", label: "心情", values: pick(p, (x) => x.mood?.valence), domain: [-1, 1], zero: true, format: signed },
    { key: "arousal", label: "興奮", values: pick(p, (x) => x.mood?.arousal), domain: [0, 1] },
    { key: "energy", label: "精神", values: pick(p, (x) => x.mood?.energy), domain: [0, 1] },
    { key: "boredom", label: "無聊", values: pick(p, (x) => x.boredom), domain: [0, 1] },
    { key: "initiative", label: "主動程度", values: pick(p, (x) => x.initiative), domain: [0, 1] },
    ...DRIVE_ORDER.map((d) => ({ key: d, label: DRIVE_LABEL[d], values: pick(p, (x) => x.drives?.[d]), domain: [0, 1] as const })),
  ];
  return (
    <section className="flex min-w-0 flex-col gap-3" aria-label={title}>
      <header className="flex min-h-[26px] items-center justify-between gap-3">
        <h2 className="text-[13px] font-medium text-muted-foreground">{title}</h2>
        {action}
      </header>
      {p.length >= 2 ? (
        <Facets times={times} facets={facets} />
      ) : (
        <Gate trend={trend} height={120}>
          {() => null}
        </Gate>
      )}
    </section>
  );
}

const TOKENS = [
  { key: "cached", label: "快取命中", color: "var(--chart-3)" },
  { key: "prompt", label: "輸入", color: "var(--chart-1)" },
  { key: "completion", label: "輸出", color: "var(--chart-2)" },
];

export function TokensBlock({ trend }: { trend: Trend }) {
  const b = trend.buckets;
  const total = sum(b.map((x) => x.cached + x.prompt + x.completion));
  const cost = sum(b.map((x) => x.cost));
  const calls = sum(b.map((x) => x.calls));
  return (
    <ChartBlock
      title="LLM token"
      value={trend.query.isSuccess ? fmtCompact(total) : "—"}
      aside={trend.query.isSuccess ? `${fmtInt(calls)} 次呼叫 · ${fmtUsd(cost)}` : undefined}
    >
      <Gate trend={trend}>
        {() => (
          <ColumnChart
            label="每段時間的 token"
            bucketMs={trend.cfg.bucketMs}
            series={TOKENS}
            format={fmtCompact}
            totalLabel="合計"
            columns={b.map((x) => ({ t: x.t, values: { cached: x.cached, prompt: x.prompt, completion: x.completion } }))}
          />
        )}
      </Gate>
    </ChartBlock>
  );
}

const secs = (v: number) => (v < 10 ? `${v.toFixed(2)}s` : `${v.toFixed(1)}s`);

export function LatencyBlock({ trend }: { trend: Trend }) {
  const b = trend.buckets;
  const last = [...b].reverse().find((x) => x.p50 !== null);
  const errors = sum(b.map((x) => x.errors));
  const series = [
    { key: "p50", label: "中位數", color: "var(--chart-1)", values: b.map((x) => x.p50) },
    { key: "p95", label: "最慢 5%", color: "var(--chart-2)", values: b.map((x) => x.p95) },
  ];
  return (
    <ChartBlock
      title="LLM 首字延遲"
      value={last?.p50 != null ? secs(last.p50) : "—"}
      aside={trend.query.isSuccess ? (errors > 0 ? `${errors} 次失敗` : "沒有失敗") : undefined}
      action={<Legend series={series} className="pt-0.5" />}
    >
      <Gate trend={trend} enough={b.some((x) => x.p50 !== null)}>
        {() => <TimeChart label="LLM 首字延遲" times={b.map((x) => x.t + trend.cfg.bucketMs / 2)} series={series} fromZero format={secs} legend={false} />}
      </Gate>
    </ChartBlock>
  );
}

/** Today's and this month's spend against the budgets. */
export function SpendBlock() {
  const cost = useCost();
  const c = cost.data;
  const meters = c
    ? [
        { key: "today", label: "今天", used: c.today.total_usd, limit: c.daily_usd },
        { key: "month", label: "這個月", used: c.month.total_usd, limit: c.monthly_usd },
      ]
    : [];
  const models = c ? Object.entries(c.today.models).sort(([, a], [, b]) => b.cost_usd - a.cost_usd) : [];
  return (
    <ChartBlock
      title="花費"
      value={c ? fmtUsd(c.today.total_usd) : "—"}
      aside={c ? (c.state === "ok" ? "今天" : c.state === "degraded" ? "已降級到便宜的模型" : "預算用盡") : undefined}
    >
      {cost.isPending ? (
        <Skeleton className="h-28 w-full" />
      ) : !c ? (
        <ChartEmpty height={112}>讀不到花費</ChartEmpty>
      ) : (
        <div className="grid gap-5">
          <dl className="grid gap-3.5">
            {meters.map((m) => {
              const frac = m.limit ? Math.min(1, m.used / m.limit) : null;
              const tone = frac !== null && frac >= c.degrade_at ? "var(--primary)" : "var(--chart-line)";
              return (
                <div key={m.key} className="grid gap-1.5">
                  <div className="flex items-baseline justify-between text-[13px]">
                    <dt className="text-muted-foreground">{m.label}</dt>
                    <dd className="font-mono tabular-nums">
                      {fmtUsd(m.used)}
                      <span className="text-muted-foreground"> / {m.limit === null ? "不限" : fmtUsd(m.limit)}</span>
                    </dd>
                  </div>
                  <div
                    role="meter"
                    aria-label={`${m.label}花費`}
                    aria-valuemin={0}
                    aria-valuemax={1}
                    aria-valuenow={frac === null ? undefined : Number(frac.toFixed(2))}
                    className="relative h-1 overflow-hidden rounded-[2px] bg-muted"
                  >
                    <span className="absolute inset-y-0 left-0 rounded-[2px]" style={{ width: `${(frac ?? 0) * 100}%`, background: tone }} />
                    {m.limit !== null && (
                      <span aria-hidden className="absolute inset-y-0 w-px bg-foreground/40" style={{ left: `${c.degrade_at * 100}%` }} title="降級門檻" />
                    )}
                  </div>
                </div>
              );
            })}
          </dl>
          {models.length > 0 && (
            <ul className="grid gap-2 border-t pt-4 text-[13px]" aria-label="今天各模型花費">
              {models.map(([model, u]) => (
                <li key={model} className="flex items-center justify-between gap-3">
                  <span className="truncate font-mono text-xs text-muted-foreground">{model}</span>
                  <span className="font-mono tabular-nums">{fmtUsd(u.cost_usd)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </ChartBlock>
  );
}
