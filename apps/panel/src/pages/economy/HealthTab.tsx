import { useMemo } from "react";
import type { EconomyHealth } from "@/api/v4-types";
import { useEconomyHealth } from "@/app/v4-queries";
import { ChartBlock, ChartEmpty, TimeChart } from "@/components/charts/charts";
import { ModuleQuery } from "@/components/module-query";
import { Dot } from "@/components/status";
import { Skeleton } from "@/components/ui/misc";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtInt, fmtPct } from "@/lib/format";
import { ISSUED_REASONS, reasonLabel, RECOVERED_REASONS } from "./labels";

const SERIES = [
  { key: "issued", label: "發出", color: "var(--chart-1)" },
  { key: "recovered", label: "收回", color: "var(--chart-2)" },
];

const dayText = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.getMonth() + 1}/${d.getDate()}`;
};

/** The state while no store provides the ledger totals: nothing is drawn, and it says why. */
function Unavailable() {
  return (
    <ChartEmpty height={220}>
      <span className="flex items-center gap-2 px-4 text-center">
        <Dot tone="neutral" className="[&>span]:bg-transparent [&>span]:ring-[1.5px] [&>span]:ring-inset [&>span]:ring-muted-foreground/70" />
        還沒有每天的發出與回收統計:帳本的資料庫沒有提供每日總數
      </span>
    </ChartEmpty>
  );
}

function Counted() {
  const names = (reasons: readonly string[]) => reasons.map(reasonLabel).join("、");
  return (
    <dl aria-label="怎麼算" className="grid gap-x-10 gap-y-3 text-[13px] sm:grid-cols-2">
      <div className="grid gap-1">
        <dt className="text-xs text-muted-foreground">算「發出」的</dt>
        <dd className="break-words">{names(ISSUED_REASONS)}</dd>
      </div>
      <div className="grid gap-1">
        <dt className="text-xs text-muted-foreground">算「收回」的</dt>
        <dd className="break-words">{names(RECOVERED_REASONS)}</dd>
      </div>
    </dl>
  );
}

function Body({ h }: { h: EconomyHealth }) {
  const times = useMemo(() => h.days.map((d) => Date.parse(d.date)), [h.days]);
  const series = useMemo(() => SERIES.map((s) => ({ ...s, values: h.days.map((d) => d[s.key as "issued" | "recovered"]) })), [h.days]);
  const ratio = h.week.ratio;
  return (
    <div className="grid gap-(--stage-gap)">
      {h.warn && (
        <p role="alert" className="flex items-start gap-2 text-[13px]">
          <Dot tone="warning" className="mt-1" />
          <span className="min-w-0 break-words">{h.warn}</span>
        </p>
      )}
      <ChartBlock
        title="這七天回收率"
        value={ratio === null ? "—" : fmtPct(ratio)}
        aside={ratio === null ? "這七天沒有發出任何幣" : `發出 ${fmtInt(h.week.issued)}、收回 ${fmtInt(h.week.recovered)} ${h.currency}`}
      >
        {!h.available ? (
          <Unavailable />
        ) : h.days.length === 0 ? (
          <ChartEmpty height={220}>還沒有任何一天的紀錄</ChartEmpty>
        ) : (
          <TimeChart label={`每天發出與收回的${h.currency}`} times={times} series={series} height={220} fromZero format={(v) => fmtInt(Math.round(v))} />
        )}
      </ChartBlock>
      {h.available && h.days.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>每天</CardTitle>
          </CardHeader>
          <Table aria-label="每天的發出與收回">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>日期</TableHead>
                <TableHead className="text-right">發出</TableHead>
                <TableHead className="text-right">收回</TableHead>
                <TableHead className="text-right">回收率</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...h.days].reverse().map((d) => (
                <TableRow key={d.day}>
                  <TableCell className="tabular-nums">{dayText(d.date)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtInt(d.issued)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtInt(d.recovered)}</TableCell>
                  <TableCell className="text-right text-muted-foreground tabular-nums">{d.ratio === null ? "—" : fmtPct(d.ratio)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      <Counted />
    </div>
  );
}

/** Coins issued against recovered, per day: where inflation shows up first. */
export function HealthTab() {
  const q = useEconomyHealth();
  return (
    <ModuleQuery query={q} module="經濟(economy 模組)" skeleton={<Skeleton className="h-64 w-full" aria-busy="true" aria-label="載入中" />}>
      {(h) => <Body h={h} />}
    </ModuleQuery>
  );
}
