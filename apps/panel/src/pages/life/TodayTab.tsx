import { useMemo } from "react";
import type { LifeEntry } from "@/api/v4-types";
import { useLifeToday } from "@/app/v4-queries";
import { ChartBlock, ColumnChart } from "@/components/charts/charts";
import { ModuleQuery } from "@/components/module-query";
import { EmptyLine } from "@/components/query-state";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtDateTime, fmtTime } from "@/lib/format";
import { startOfDay } from "@/lib/rules";
import { activityLabel, fmtMinutes } from "./labels";

const DAY_MS = 86_400_000;
/** Categories take the chart colours in this order; the rest are "其他". */
const COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];
const OTHER = "__other";

/** Minutes of one entry in her day: its own duration, or nothing for a single act. */
const minutesOf = (e: LifeEntry): number => e.minutes ?? 0;

/** Per local day of the last `days` days, what she did of each activity (counts). */
export function dayColumns(entries: LifeEntry[], now: number, days: number) {
  const first = startOfDay(now) - (days - 1) * DAY_MS;
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.activity, (counts.get(e.activity) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, COLORS.length);
  const keys = new Set(top.map(([k]) => k));
  const columns = Array.from({ length: days }, (_, i) => ({ t: first + i * DAY_MS, values: {} as Record<string, number> }));
  for (const e of entries) {
    const at = Date.parse(e.at);
    const col = columns[Math.floor((startOfDay(at) - first) / DAY_MS)];
    if (!col) continue;
    const key = keys.has(e.activity) ? e.activity : OTHER;
    col.values[key] = (col.values[key] ?? 0) + 1;
  }
  const series = top.map(([key], i) => ({ key, label: activityLabel(key), color: COLORS[i] as string }));
  if (counts.size > top.length) series.push({ key: OTHER, label: "其他", color: "var(--chart-quiet)" });
  return { columns, series };
}

function Strip({ today }: { today: LifeEntry[] }) {
  const minutes = today.reduce((n, e) => n + minutesOf(e), 0);
  const kinds = new Set(today.map((e) => e.activity)).size;
  const last = today[today.length - 1];
  return (
    <dl aria-label="今天" className="flex flex-wrap gap-x-10 gap-y-3">
      {[
        ["做了", `${today.length} 件`],
        ["種類", `${kinds} 種`],
        ["花的時間", minutes > 0 ? fmtMinutes(minutes) : "—"],
        ["最近一次", last ? fmtTime(last.at) : "—"],
      ].map(([label, value]) => (
        <div key={label} className="flex min-w-0 flex-col gap-1">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="text-sm font-medium tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function EntryRows({ entries }: { entries: LifeEntry[] }) {
  return (
    <Table aria-label="今天做的事">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-16">時間</TableHead>
          <TableHead className="w-28">活動</TableHead>
          <TableHead>做了什麼</TableHead>
          <TableHead className="hidden w-24 md:table-cell">花了</TableHead>
          <TableHead className="hidden w-36 lg:table-cell">用的功能</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((e) => (
          <TableRow key={e.id}>
            <TableCell className="text-muted-foreground tabular-nums">
              <time dateTime={e.at} title={fmtDateTime(e.at)}>
                {fmtTime(e.at)}
              </time>
            </TableCell>
            <TableCell>{activityLabel(e.activity)}</TableCell>
            <TableCell className="whitespace-normal break-words">{e.what}</TableCell>
            <TableCell className="hidden text-muted-foreground tabular-nums md:table-cell">{e.minutes === null ? "—" : fmtMinutes(e.minutes)}</TableCell>
            <TableCell className="hidden font-mono text-xs text-muted-foreground lg:table-cell">{e.capability ?? "—"}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** What she did today and lately, from what really ran. */
export function TodayTab() {
  const day = useLifeToday();
  const now = day.dataUpdatedAt > 0 ? day.dataUpdatedAt : Date.now();
  const chart = useMemo(() => dayColumns(day.data?.lately ?? [], now, 7), [day.data, now]);
  return (
    <ModuleQuery query={day} module="她的生活(mind 模組)">
      {(d) => (
        <div className="grid gap-(--stage-gap)">
          <Strip today={d.today} />
          <ChartBlock title="最近七天做的事" aside="每天幾件">
            {d.lately.length === 0 ? (
              <EmptyLine>這幾天沒有紀錄</EmptyLine>
            ) : (
              <ColumnChart label="每天做的事" bucketMs={DAY_MS} columns={chart.columns} series={chart.series} totalLabel="合計" integer height={160} format={(v) => `${Math.round(v)} 件`} />
            )}
          </ChartBlock>
          <Card>
            <CardHeader>
              <CardTitle>今天</CardTitle>
            </CardHeader>
            {d.today.length === 0 ? <EmptyLine>今天還沒做任何事</EmptyLine> : <EntryRows entries={d.today} />}
          </Card>
          {(d.summary_today || d.summary_lately) && (
            <Card>
              <CardHeader>
                <CardTitle>她自己記得的</CardTitle>
              </CardHeader>
              <div className="grid gap-3 sm:grid-cols-2">
                {[
                  ["今天", d.summary_today],
                  ["這幾天", d.summary_lately],
                ].map(([label, text]) =>
                  text ? (
                    <section key={label} aria-label={label ?? ""} className="min-w-0 rounded-md bg-well px-3 py-2.5">
                      <h3 className="mb-1 text-[13px] font-medium text-muted-foreground">{label}</h3>
                      <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">{text}</p>
                    </section>
                  ) : null,
                )}
              </div>
            </Card>
          )}
        </div>
      )}
    </ModuleQuery>
  );
}
