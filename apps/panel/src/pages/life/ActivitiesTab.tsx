import type { ActivityView } from "@/api/v4-types";
import { useActivities } from "@/app/v4-queries";
import { SegmentBar } from "@/components/charts/charts";
import { ModuleQuery } from "@/components/module-query";
import { Dot, StatusBadge } from "@/components/status";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { hoursText, PEOPLE_LABEL } from "./labels";

function Capabilities({ a }: { a: ActivityView }) {
  return (
    <ul aria-label={`${a.label} 要用的功能`} className="grid gap-1">
      {a.capabilities.map((c) => (
        <li key={c.id} className="flex items-center gap-2 font-mono text-xs">
          <Dot tone={c.registered ? "success" : "neutral"} className={c.registered ? undefined : "[&>span]:bg-transparent [&>span]:ring-[1.5px] [&>span]:ring-inset [&>span]:ring-muted-foreground/70"} />
          <span className={c.registered ? undefined : "text-muted-foreground"}>{c.id}</span>
          <span className="font-sans text-[11px] text-muted-foreground">{c.registered ? (c.id === a.capability ? "會用這個" : "有") : "沒有"}</span>
        </li>
      ))}
    </ul>
  );
}

function State({ a }: { a: ActivityView }) {
  if (!a.available) return <StatusBadge tone="warning">功能沒開,略過</StatusBadge>;
  if (!a.generic) return <StatusBadge tone="neutral">只記錄</StatusBadge>;
  return <StatusBadge tone="success">可以做</StatusBadge>;
}

/** The §8.1 table: which activities she can pick from, and which are skipped for want of a capability. */
export function ActivitiesTab() {
  const q = useActivities();
  return (
    <Card>
      <CardHeader>
        <CardTitle>她能做的事</CardTitle>
      </CardHeader>
      <ModuleQuery query={q} module="她的生活(mind 模組)" isEmpty={(d) => d.activities.length === 0} empty="沒有活動">
        {(d) => {
          const ready = d.activities.filter((a) => a.available).length;
          return (
            <div className="grid gap-4">
              <SegmentBar
                label="活動的狀態"
                parts={[
                  { key: "ready", label: "可以做", value: ready, color: "var(--chart-line)" },
                  { key: "skipped", label: "功能沒開,略過", value: d.activities.length - ready, color: "var(--chart-quiet)" },
                ]}
              />
              <Table aria-label="活動">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-28">活動</TableHead>
                    <TableHead className="hidden md:table-cell">她做什麼</TableHead>
                    <TableHead className="w-60">用的功能</TableHead>
                    <TableHead className="hidden w-40 xl:table-cell">什麼時候</TableHead>
                    <TableHead className="w-20">今天</TableHead>
                    <TableHead className="w-36">狀態</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.activities.map((a) => (
                    <TableRow key={a.id} className={a.available ? undefined : "text-muted-foreground"}>
                      <TableCell className="align-top font-medium">{a.label}</TableCell>
                      <TableCell className="hidden whitespace-normal align-top md:table-cell">
                        <span className="grid gap-0.5">
                          <span>{a.does}</span>
                          <span className="text-[13px] text-muted-foreground">留下:{a.leaves}</span>
                        </span>
                      </TableCell>
                      <TableCell className="align-top">
                        <Capabilities a={a} />
                      </TableCell>
                      <TableCell className="hidden whitespace-normal align-top text-[13px] text-muted-foreground xl:table-cell">
                        {hoursText(a.hours)} · {PEOPLE_LABEL[a.people]}
                        {a.per_day !== null && ` · 一天 ${a.per_day} 次`}
                        {a.share < 1 && ` · 最多佔 ${Math.round(a.share * 100)}%`}
                      </TableCell>
                      <TableCell className="align-top tabular-nums">{a.done_today === null ? "—" : a.done_today}</TableCell>
                      <TableCell className="align-top">
                        <State a={a} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          );
        }}
      </ModuleQuery>
    </Card>
  );
}
