import { useMemo, useState } from "react";
import type { EvalLiveRun, EvalNightly } from "@miyoria/contracts/api";
import { useEvalLive } from "@/app/queries";
import { type Facet, Facets } from "@/components/charts/charts";
import { ModuleQuery } from "@/components/module-query";
import { EmptyLine } from "@/components/query-state";
import { StatusBadge } from "@/components/status";
import { Card, CardAction, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/misc";
import { Segmented } from "@/components/ui/segmented";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtDateTime, fmtPct, fmtScore, fmtUsd } from "@/lib/format";

interface Measure {
  suite: string;
  /** The key of the number in the suite's headline. */
  key: string;
  label: string;
  format: (v: number) => string;
}

const pct = (v: number) => fmtPct(v, v > 0 && v < 0.1 ? 1 : 0);

/** The headline numbers of the four live suites, each between 0 and 1. */
export const LIVE_MEASURES: Measure[] = [
  { suite: "persona", key: "score", label: "人設分數", format: fmtScore },
  { suite: "persona", key: "low_share", label: "人設低分的比例", format: pct },
  { suite: "tools", key: "success", label: "工具任務成功率", format: pct },
  { suite: "relationship", key: "told_apart", label: "分得出親疏", format: pct },
  { suite: "relationship", key: "line_held", label: "界線守住", format: pct },
  { suite: "memory", key: "recall@5", label: "記憶前 5 筆命中", format: pct },
  { suite: "memory", key: "mrr", label: "記憶 MRR", format: fmtScore },
  { suite: "memory", key: "nothing_returned_rate", label: "不該想起時沒想起", format: pct },
];

/** How many runs the table lists, newest first. */
const TABLE_RUNS = 10;

function fmtDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} 秒`;
  const minutes = ms / 60_000;
  return `${minutes < 10 ? minutes.toFixed(1) : Math.round(minutes)} 分`;
}

function NightlyLine({ nightly }: { nightly: EvalNightly }) {
  const items: [string, string][] =
    nightly.state === "scheduled"
      ? [
          ["每晚排程", nightly.time ?? ""],
          ["下一次", nightly.running ? "正在跑" : nightly.next_at ? fmtDateTime(nightly.next_at) : "—"],
        ]
      : nightly.state === "no_checkout"
        ? [["每晚排程", "需要原始碼的資料夾,這個安裝沒有 tools/eval"]]
        : [["每晚排程", "沒有開"]];
  return (
    <dl aria-label="每晚排程" className="flex flex-wrap gap-x-8 gap-y-2">
      {items.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="text-sm tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Trend({ runs }: { runs: EvalLiveRun[] }) {
  const times = useMemo(() => runs.map((r) => Date.parse(r.at)), [runs]);
  const facets = useMemo<Facet[]>(
    () =>
      LIVE_MEASURES.map((m) => ({
        key: `${m.suite}.${m.key}`,
        label: m.label,
        values: runs.map((r) => r.suites[m.suite]?.headline[m.key] ?? null),
        domain: [0, 1] as const,
        format: m.format,
      })),
    [runs],
  );
  return <Facets times={times} facets={facets} className="xl:grid-cols-4" />;
}

function Runs({ runs }: { runs: EvalLiveRun[] }) {
  const shown = runs.slice(-TABLE_RUNS).reverse();
  return (
    <Table aria-label="最近的真模型評測">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>時間</TableHead>
          <TableHead>commit</TableHead>
          <TableHead>受測</TableHead>
          <TableHead className="text-right">花費</TableHead>
          <TableHead className="text-right">耗時</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {shown.map((r) => (
          <TableRow key={`${r.at}-${r.subject}`}>
            <TableCell className="tabular-nums">
              <span className="flex flex-wrap items-center gap-2">
                {fmtDateTime(r.at)}
                {r.stopped === "budget" && <StatusBadge tone="warning">到上限,沒跑完</StatusBadge>}
              </span>
            </TableCell>
            <TableCell className="font-mono text-[13px]" title={r.commit ?? undefined}>
              {r.commit ? r.commit.slice(0, 8) : "—"}
            </TableCell>
            <TableCell>
              {r.subject}
              {r.repeat > 1 && <span className="text-muted-foreground"> ×{r.repeat}</span>}
            </TableCell>
            <TableCell className="text-right font-mono whitespace-nowrap tabular-nums">{r.usd === null ? "—" : fmtUsd(r.usd)}</TableCell>
            <TableCell className="text-right font-mono whitespace-nowrap tabular-nums">{fmtDuration(r.duration_ms)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** The live suites' headline numbers over the runs in `history.jsonl`, and the nightly run. */
export function LiveEval() {
  const query = useEvalLive();
  const all = query.data?.runs;
  // Two brains are not one trend: the newest run's subject unless another is picked.
  const subjects = useMemo(() => [...new Set((all ?? []).map((r) => r.subject))], [all]);
  const [picked, setPicked] = useState<string | null>(null);
  const subject = picked !== null && subjects.includes(picked) ? picked : (all?.[all.length - 1]?.subject ?? null);
  const runs = useMemo(() => (all ?? []).filter((r) => r.subject === subject), [all, subject]);
  return (
    <Card aria-label="真模型評測" className="gap-4">
      <CardHeader>
        <CardTitle>真模型評測</CardTitle>
        {subjects.length > 1 && subject !== null && (
          <CardAction>
            <Segmented label="受測的大腦" value={subject} onChange={setPicked} options={subjects.map((s) => ({ value: s, label: s }))} />
          </CardAction>
        )}
      </CardHeader>
      <ModuleQuery query={query} module="真模型評測" skeleton={<Skeleton className="h-40 w-full" />}>
        {(data) => (
          <>
            <NightlyLine nightly={data.nightly} />
            {runs.length === 0 ? (
              <EmptyLine>還沒有跑過真模型評測</EmptyLine>
            ) : (
              <>
                <Trend runs={runs} />
                <Runs runs={runs} />
              </>
            )}
          </>
        )}
      </ModuleQuery>
    </Card>
  );
}
