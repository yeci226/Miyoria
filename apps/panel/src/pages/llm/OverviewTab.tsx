import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import type { LlmCallRecord, LlmCallStats, LlmGroupStats } from "@/api/types";
import { useLlmStats } from "@/app/queries";
import type { LlmSearch } from "@/app/router";
import { BarList, ChartBlock, ChartEmpty, ColumnChart } from "@/components/charts/charts";
import { ErrorLine, SkeletonRows } from "@/components/query-state";
import { Dot } from "@/components/status";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/misc";
import { Segmented } from "@/components/ui/segmented";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtCompact, fmtInt, fmtTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ERROR_LABEL, FINISH_LABEL, fmtCost, fmtMs, fmtPerMtok, hitRate, moduleLabel, purposeLabel, STATUS_TONE } from "./labels";

const RANGES = [
  { value: "60", label: "1 小時", minutes: 60 },
  { value: "360", label: "6 小時", minutes: 360 },
  { value: "1440", label: "24 小時", minutes: 1440 },
  { value: "all", label: "全部保留的", minutes: null },
] as const;
type RangeValue = (typeof RANGES)[number]["value"];

const SERIES_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)"];

function Kpi({ label, value, aside, tone }: { label: string; value: ReactNode; aside?: ReactNode; tone?: "danger" | "warning" }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("text-[15px] font-semibold", tone === "danger" && "text-primary", tone === "warning" && "text-primary")}>{value}</dd>
      {aside && <dd className="truncate text-xs text-muted-foreground">{aside}</dd>}
    </div>
  );
}

function Kpis({ s }: { s: LlmCallStats }) {
  const t = s.total;
  const errorRate = t.calls > 0 ? t.errors / t.calls : 0;
  return (
    <dl aria-label="LLM 概況" className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-3 xl:grid-cols-6">
      <Kpi label="呼叫" value={fmtInt(t.calls)} aside={s.since ? `${fmtTime(s.since)} 以來` : `最早 ${s.oldest ? fmtTime(s.oldest) : "—"}`} />
      <Kpi label="花費" value={fmtCost(t.cost_usd)} aside={t.calls > 0 ? `平均每次 ${fmtCost(t.cost_usd / t.calls)}` : undefined} />
      <Kpi label="token" value={fmtCompact(t.prompt_tokens + t.completion_tokens)} aside={`輸入 ${fmtCompact(t.prompt_tokens)} · 輸出 ${fmtCompact(t.completion_tokens)}${t.reasoning_tokens ? ` · 推理 ${fmtCompact(t.reasoning_tokens)}` : ""}`} />
      <Kpi label="快取命中" value={`${Math.round(hitRate(t.prompt_tokens, t.cached_prompt_tokens) * 100)}%`} aside={`${fmtCompact(t.cached_prompt_tokens)} token 走快取`} />
      <Kpi label="錯誤率" value={`${(errorRate * 100).toFixed(errorRate > 0 && errorRate < 0.01 ? 1 : 0)}%`} aside={`${t.errors} 次失敗`} tone={errorRate >= 0.1 ? "danger" : errorRate >= 0.03 ? "warning" : undefined} />
      <Kpi label="首字延遲" value={fmtMs(t.p50_ms)} aside={`最慢 5%:${fmtMs(t.p95_ms)}`} />
    </dl>
  );
}

/** Cost per hour stacked by purpose (the four costliest; the rest as 其他). */
function CostByHour({ s }: { s: LlmCallStats }) {
  const top = s.by_purpose.slice(0, 4).map((g) => g.key);
  const series = [
    ...top.map((k, i) => ({ key: k, label: purposeLabel(k), color: SERIES_COLORS[i] as string })),
    ...(s.by_purpose.length > 4 ? [{ key: "__other", label: "其他", color: "var(--chart-quiet)" }] : []),
  ];
  const columns = s.by_hour.map((h) => {
    const values: Record<string, number> = {};
    for (const [p, usd] of Object.entries(h.by_purpose)) {
      const k = top.includes(p) ? p : "__other";
      values[k] = (values[k] ?? 0) + usd;
    }
    return { t: Date.parse(h.hour), values };
  });
  return (
    <ChartBlock title="每小時花費(依用途)" value={fmtCost(s.total.cost_usd)}>
      {columns.length === 0 ? <ChartEmpty>這段時間沒有呼叫</ChartEmpty> : <ColumnChart label="每小時花費" columns={columns} series={series} bucketMs={3_600_000} format={(v) => fmtCost(v)} totalLabel="合計" />}
    </ChartBlock>
  );
}

function TokensByHour({ s }: { s: LlmCallStats }) {
  const series = [
    { key: "cached", label: "快取命中", color: "var(--chart-3)" },
    { key: "prompt", label: "輸入", color: "var(--chart-1)" },
    { key: "completion", label: "輸出", color: "var(--chart-2)" },
  ];
  const columns = s.by_hour.map((h) => ({
    t: Date.parse(h.hour),
    values: { cached: h.cached_prompt_tokens, prompt: h.prompt_tokens - h.cached_prompt_tokens, completion: h.completion_tokens },
  }));
  return (
    <ChartBlock title="每小時 token" value={fmtCompact(s.total.prompt_tokens + s.total.completion_tokens)} aside={`${fmtInt(s.total.calls)} 次呼叫`}>
      {columns.length === 0 ? <ChartEmpty>這段時間沒有呼叫</ChartEmpty> : <ColumnChart label="每小時 token" columns={columns} series={series} bucketMs={3_600_000} format={fmtCompact} totalLabel="合計" />}
    </ChartBlock>
  );
}

/** Calls, tokens, cost and latency of each group. */
function GroupTable({ title, rows, name, prices }: { title: string; rows: LlmGroupStats[]; name: (key: string) => ReactNode; prices?: LlmCallStats["prices"] }) {
  const total = rows.reduce((n, g) => n + g.cost_usd, 0);
  const r = "text-right tabular-nums";
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <Table aria-label={title}>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>名稱</TableHead>
            <TableHead className={r}>呼叫</TableHead>
            <TableHead className={cn(r, "hidden sm:table-cell")}>錯誤</TableHead>
            <TableHead className={r}>輸入</TableHead>
            <TableHead className={cn(r, "hidden md:table-cell")}>快取</TableHead>
            <TableHead className={r}>輸出</TableHead>
            <TableHead className={cn(r, "hidden lg:table-cell")}>首字 p50 / p95</TableHead>
            {prices && <TableHead className={cn(r, "hidden xl:table-cell")}>單價 入 / 出</TableHead>}
            <TableHead className={r}>花費</TableHead>
            <TableHead className="hidden w-28 md:table-cell">
              <span className="sr-only">佔比</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((g) => {
            const p = prices?.[g.key];
            return (
              <TableRow key={g.key}>
                <TableCell className="max-w-56">{name(g.key)}</TableCell>
                <TableCell className={r}>{fmtInt(g.calls)}</TableCell>
                <TableCell className={cn(r, "hidden sm:table-cell", g.errors > 0 ? "text-primary" : "text-muted-foreground")}>{g.errors}</TableCell>
                <TableCell className={r}>{fmtCompact(g.prompt_tokens)}</TableCell>
                <TableCell className={cn(r, "hidden text-muted-foreground md:table-cell")}>{Math.round(hitRate(g.prompt_tokens, g.cached_prompt_tokens) * 100)}%</TableCell>
                <TableCell className={r}>{fmtCompact(g.completion_tokens)}</TableCell>
                <TableCell className={cn(r, "hidden lg:table-cell")}>
                  {fmtMs(g.p50_ms)} <span className="text-muted-foreground">/ {fmtMs(g.p95_ms)}</span>
                </TableCell>
                {prices && (
                  <TableCell className={cn(r, "hidden font-mono text-[12px] xl:table-cell", !p && "text-primary")}>
                    {p ? `${fmtPerMtok(p.input_per_mtok)} / ${fmtPerMtok(p.output_per_mtok)}` : g.key === "—" ? "—" : "沒有價格"}
                  </TableCell>
                )}
                <TableCell className={cn(r, "font-mono text-[12px]")}>{fmtCost(g.cost_usd)}</TableCell>
                <TableCell className="hidden md:table-cell">
                  <span className="block h-1 rounded-[2px] bg-muted">
                    <span className="block h-full rounded-[2px] bg-secondary-line" style={{ width: `${total > 0 ? Math.max(2, (g.cost_usd / total) * 100) : 0}%` }} />
                  </span>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Card>
  );
}

function CallList({ title, calls, value }: { title: string; calls: LlmCallRecord[]; value: (c: LlmCallRecord) => string }) {
  const navigate = useNavigate();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      {calls.length === 0 ? (
        <p className="py-3 text-[13px] text-muted-foreground">沒有呼叫</p>
      ) : (
        <ol className="divide-y divide-line-soft">
          {calls.map((c, i) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => void navigate({ to: "/llm", search: (s: LlmSearch) => ({ ...s, call: c.id }) })}
                className="flex w-full items-center gap-3 py-(--row-y) text-left text-sm outline-none hover:bg-hover focus-visible:bg-hover"
              >
                <span className="w-4 text-xs text-muted-foreground tabular-nums">{i + 1}</span>
                <Dot tone={STATUS_TONE[c.status]} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">
                    {purposeLabel(c.purpose)}
                    <span className="text-muted-foreground"> · {moduleLabel(c.module)}{c.label ? ` · ${c.label}` : ""}</span>
                  </span>
                  <span className="block truncate font-mono text-[11px] text-muted-foreground">
                    {fmtTime(c.at)} · {c.model} · {c.usage ? `${fmtCompact(c.usage.prompt_tokens)} → ${fmtCompact(c.usage.completion_tokens)}` : "—"}
                  </span>
                </span>
                <span className="font-mono text-[13px] tabular-nums">{value(c)}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

function LatencyBlock({ s }: { s: LlmCallStats }) {
  const total = s.latency.reduce((n, b) => n + b.count, 0);
  let prev = 0;
  const items = s.latency.map((b) => {
    const label = b.le_ms >= Number.MAX_SAFE_INTEGER ? `> ${fmtMs(prev)}` : `${fmtMs(prev)} – ${fmtMs(b.le_ms)}`;
    prev = b.le_ms;
    return { key: String(b.le_ms), label, value: b.count };
  });
  return (
    <ChartBlock title="首字延遲分布" value={fmtMs(s.total.p50_ms)} aside={`p95 ${fmtMs(s.total.p95_ms)} · ${total} 次成功呼叫`}>
      {total === 0 ? <ChartEmpty height={200}>沒有成功的呼叫</ChartEmpty> : <BarList label="首字延遲分布" items={items.filter((i, k) => i.value > 0 || k < items.length - 1)} format={fmtInt} />}
    </ChartBlock>
  );
}

function OutcomesBlock({ s }: { s: LlmCallStats }) {
  return (
    <ChartBlock title="結束方式與錯誤" value={fmtInt(s.total.errors)} unit="次錯誤">
      <div className="grid gap-6">
        <BarList label="結束方式" items={s.finish_reasons.map((r) => ({ key: r.reason, label: FINISH_LABEL[r.reason] ?? r.reason, value: r.count }))} format={fmtInt} />
        {s.errors.length > 0 && (
          <BarList label="錯誤種類" color="var(--primary)" items={s.errors.map((e) => ({ key: e.kind, label: ERROR_LABEL[e.kind] ?? e.kind, value: e.count }))} format={fmtInt} />
        )}
      </div>
    </ChartBlock>
  );
}

export function OverviewTab() {
  const [range, setRange] = useState<RangeValue>("1440");
  const minutes = RANGES.find((r) => r.value === range)?.minutes ?? null;
  const stats = useLlmStats(minutes);
  const s = stats.data;
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[15px] font-semibold tracking-[-0.01em]">呼叫概況</h2>
        <Segmented label="時間範圍" value={range} onChange={setRange} options={RANGES.map((r) => ({ value: r.value, label: r.label }))} />
      </div>
      {stats.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : stats.isError ? (
        <Card>
          <ErrorLine error={stats.error} onRetry={() => void stats.refetch()} />
        </Card>
      ) : s ? (
        <div className={cn("grid gap-(--stage-gap) transition-opacity", stats.isPlaceholderData && "opacity-60")}>
          <Kpis s={s} />
          <div className="grid gap-(--stage-gap) lg:grid-cols-2">
            <CostByHour s={s} />
            <TokensByHour s={s} />
          </div>
          <GroupTable title="依用途" rows={s.by_purpose} name={(k) => (<><span className="font-medium">{purposeLabel(k)}</span> <code className="text-xs text-muted-foreground">{k}</code></>)} />
          <GroupTable title="依模型" rows={s.by_model} prices={s.prices} name={(k) => <code className="break-all text-[13px]">{k}</code>} />
          <GroupTable title="依模組" rows={s.by_module} name={(k) => moduleLabel(k)} />
          <div className="grid gap-(--stage-gap) lg:grid-cols-2">
            <LatencyBlock s={s} />
            <OutcomesBlock s={s} />
          </div>
          <div className="grid gap-(--stage-gap) lg:grid-cols-2">
            <CallList title="最貴的呼叫" calls={s.expensive} value={(c) => fmtCost(c.cost_usd)} />
            <CallList title="最慢的呼叫" calls={s.slowest} value={(c) => fmtMs(c.total_ms)} />
          </div>
        </div>
      ) : (
        <SkeletonRows />
      )}
    </div>
  );
}
