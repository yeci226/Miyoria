import { useMemo, useState } from "react";
import { useEvalData, useVoice } from "@/app/queries";
import { BarList, ChartBlock, ChartEmpty, TimeChart } from "@/components/charts/charts";
import { Page, PageHeader } from "@/components/page";
import { EmptyLine, ErrorLine } from "@/components/query-state";
import { StatusBadge } from "@/components/status";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/misc";
import { Segmented } from "@/components/ui/segmented";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { EvalData } from "@/lib/eval-data";
import { fmtMs } from "@/lib/e2e";
import { fmtDateTime, fmtPct, fmtTime } from "@/lib/format";
import {
  FLOOR_CLAIM_LABEL,
  floorMix,
  type MetricDef,
  METRICS,
  meets,
  read,
  type Reading,
  trend,
  UNMEASURED,
} from "@/lib/metrics";
import { readStorage, writeStorage } from "@/lib/storage";
import { V4Metrics } from "./V4Metrics";

const HOUR = 3_600_000;

export const EVAL_RANGES = [
  { range: "24h", label: "24 小時", ms: 24 * HOUR, bucketMs: HOUR },
  { range: "3d", label: "3 天", ms: 72 * HOUR, bucketMs: 6 * HOUR },
  { range: "7d", label: "7 天", ms: 168 * HOUR, bucketMs: 24 * HOUR },
] as const;

type EvalRange = (typeof EVAL_RANGES)[number]["range"];

const RANGE_KEY = "miyoria.panel.evalRange";

function useEvalRange(): [(typeof EVAL_RANGES)[number], (r: EvalRange) => void] {
  const [range, set] = useState<EvalRange>(() => {
    const saved = readStorage(RANGE_KEY);
    return EVAL_RANGES.find((r) => r.range === saved)?.range ?? "24h";
  });
  return [
    EVAL_RANGES.find((r) => r.range === range) ?? (EVAL_RANGES[0] as (typeof EVAL_RANGES)[number]),
    (r) => {
      writeStorage(RANGE_KEY, r);
      set(r);
    },
  ];
}

/** A value of `def` as it is written next to its target. */
export function fmtMetric(def: MetricDef, v: number): string {
  if (def.unit === "ms") return fmtMs(v);
  if (def.unit === "rate") return fmtPct(v, v > 0 && v < 0.1 ? 1 : 0);
  return String(Math.round(v));
}

/** What a reading was measured over, and from when when a source did not reach back that far. */
function coverage(def: MetricDef, r: Reading, since: number): string {
  const unit = def.id === "latency" ? "次" : def.id === "repeat" || def.id === "monologue" ? "句" : def.id === "broken" ? "個承諾" : "回合";
  const cut = r.from - since > 60_000 ? `,只讀到 ${fmtTime(new Date(r.from).toISOString())} 之後` : "";
  return `${r.n} ${unit}${cut}`;
}

function MetricBlock({ def, data, range }: { def: MetricDef; data: EvalData; range: (typeof EVAL_RANGES)[number] }) {
  const voice = useVoice();
  const whole = useMemo(() => read(def.id, data, data.since, data.now), [def.id, data]);
  const points = useMemo(() => trend(def.id, data, data.since, data.now, range.bucketMs), [def.id, data, range.bucketMs]);
  const measured = whole.value !== null;
  const live = def.id === "latency" ? voice.data?.sessions.map((s) => s.latency.e2e?.total).find((t) => t && t.p50_ms !== null) : undefined;
  const format = (v: number) => fmtMetric(def, v);
  const times = points.map((p) => p.t + range.bucketMs / 2);
  const pass = whole.value === null ? null : meets(def, whole.value);
  // Counts are whole numbers: an axis of halves would read 1, 1, 0.
  const top = Math.max(def.target, 1, ...points.map((p) => p.value ?? 0));
  const domain = def.unit === "count" ? ([0, Math.ceil(top / 2) * 2] as const) : undefined;

  return (
    <ChartBlock
      title={<span title={def.source}>{def.label}</span>}
      value={measured ? format(whole.value as number) : "—"}
      aside={
        <>
          目標 {def.targetLabel}
          {measured ? ` · ${coverage(def, whole, data.since)}` : ""}
          {live?.p50_ms != null ? ` · 現在 ${fmtMs(live.p50_ms)}` : ""}
        </>
      }
      action={pass === null ? undefined : <StatusBadge tone={pass ? "success" : "warning"}>{pass ? "達標" : "未達標"}</StatusBadge>}
    >
      {measured ? (
        <TimeChart
          label={`${def.label}的趨勢`}
          times={times}
          fromZero
          domain={domain}
          height={160}
          format={format}
          series={[
            { key: def.id, label: def.label, color: "var(--chart-line)", values: points.map((p) => p.value) },
            { key: "target", label: "目標", color: "var(--chart-quiet)", values: points.map(() => def.target) },
          ]}
        />
      ) : (
        <ChartEmpty height={160}>這段時間沒有量到</ChartEmpty>
      )}
    </ChartBlock>
  );
}

function FloorBlock({ data }: { data: EvalData }) {
  const mix = useMemo(() => floorMix(data, data.since, data.now), [data]);
  return (
    <ChartBlock title="拿到麥克風的理由" value={String(mix.reduce((n, m) => n + m.count, 0))} unit="次">
      {mix.length === 0 ? (
        <EmptyLine>這段時間她沒有拿過麥克風</EmptyLine>
      ) : (
        <BarList label="拿麥的理由" items={mix.map((m) => ({ key: m.kind, label: FLOOR_CLAIM_LABEL[m.kind], value: m.count }))} />
      )}
    </ChartBlock>
  );
}

/** The same measures before and after one start of the Core. */
function Compare({ data }: { data: EvalData }) {
  const boots = data.boots.filter((t) => t > data.since && t < data.now);
  const [picked, setPicked] = useState<string | null>(null);
  const boundary = boots.find((t) => String(t) === picked) ?? boots[boots.length - 1];
  const rows = useMemo(
    () =>
      boundary === undefined
        ? []
        : METRICS.map((def) => ({
            def,
            before: read(def.id, data, data.since, boundary),
            after: read(def.id, data, boundary, data.now),
          })),
    [data, boundary],
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>前後對照</CardTitle>
        {boundary !== undefined && (
          <Select value={String(boundary)} onValueChange={setPicked}>
            <SelectTrigger size="sm" aria-label="以哪次啟動為界" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[...boots].reverse().map((t) => (
                <SelectItem key={t} value={String(t)}>
                  {fmtDateTime(new Date(t).toISOString())} 啟動
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </CardHeader>
      {boundary === undefined ? (
        <EmptyLine>這段時間 Core 沒有重新啟動過,沒有可以對照的前後</EmptyLine>
      ) : (
        <Table aria-label="啟動前後的指標">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>指標</TableHead>
              <TableHead className="text-right">啟動前</TableHead>
              <TableHead className="text-right">啟動後</TableHead>
              <TableHead className="text-right">目標</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ def, before, after }) => (
              <TableRow key={def.id}>
                <TableCell>{def.label}</TableCell>
                <TableCell className="text-right font-mono">{cell(def, before, data.since)}</TableCell>
                <TableCell className="text-right font-mono">{cell(def, after, data.since)}</TableCell>
                <TableCell className="text-right text-muted-foreground">{def.targetLabel}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}

function cell(def: MetricDef, r: Reading, since: number) {
  if (r.value === null) return <span className="text-muted-foreground">沒有資料</span>;
  return (
    <span title={coverage(def, r, since)}>
      {fmtMetric(def, r.value)}
      <span className="text-muted-foreground"> ({r.n})</span>
    </span>
  );
}

function Unmeasured() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>還沒有量</CardTitle>
      </CardHeader>
      <Table aria-label="還沒有量的指標">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>指標</TableHead>
            <TableHead>目標</TableHead>
            <TableHead>缺少</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {UNMEASURED.map((m) => (
            <TableRow key={m.label}>
              <TableCell>{m.label}</TableCell>
              <TableCell className="text-muted-foreground">{m.targetLabel}</TableCell>
              <TableCell className="whitespace-normal">{m.missing}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

/** §18.1's measures, computed from the log and the ledger over the range chosen. */
export function EvalPage() {
  const [range, setRange] = useEvalRange();
  const query = useEvalData(range.ms);
  const data = query.data;
  return (
    <Page>
      <PageHeader
        title="評測"
        actions={
          <Segmented
            label="時間範圍"
            value={range.range}
            onChange={setRange}
            options={EVAL_RANGES.map((r) => ({ value: r.range, label: r.label }))}
          />
        }
      />
      {query.isPending ? (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-(--stage-gap) lg:grid-cols-2" aria-busy="true" aria-label="載入中">
          {METRICS.map((m) => (
            <Skeleton key={m.id} className="h-52 w-full" />
          ))}
        </div>
      ) : !data ? (
        <ErrorLine error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <>
          <div className="grid grid-cols-[minmax(0,1fr)] gap-(--stage-gap) lg:grid-cols-2">
            {METRICS.map((def) => (
              <MetricBlock key={def.id} def={def} data={data} range={range} />
            ))}
          </div>
          <FloorBlock data={data} />
          <Compare data={data} />
          <Unmeasured />
        </>
      )}
      <V4Metrics />
    </Page>
  );
}
