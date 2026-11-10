import { useState } from "react";
import type { Goal, GoalTrigger } from "@/api/types";
import { useDayPlan, useGoals } from "@/app/queries";
import { EmptyLine, QueryView } from "@/components/query-state";
import { StatusBadge } from "@/components/status";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { contextShort, fmtDateTime, fmtRelative } from "@/lib/format";
import { GOAL_SOURCE_LABEL, GOAL_STATUS_LABEL, GOAL_STATUS_TONE } from "./labels";

/** When a goal should happen, in words. */
export function triggerText(t: GoalTrigger): string {
  switch (t.kind) {
    case "at":
      return `${fmtDateTime(t.time)} 之後`;
    case "when_online":
      return `${t.person} 上線時`;
    case "after_activity":
      return `${t.activity} 結束後`;
    case "whenever":
      return "有空就做";
  }
}

function When({ at }: { at: string }) {
  return (
    <time dateTime={at} title={fmtDateTime(at)} className="whitespace-nowrap">
      {fmtRelative(at)}
    </time>
  );
}

function DayPlanCard() {
  const plan = useDayPlan();
  return (
    <Card>
      <CardHeader>
        <CardTitle>今天的計畫</CardTitle>
      </CardHeader>
      <QueryView query={plan} isEmpty={(p) => !p.day_plan} empty={<EmptyLine>今天還沒寫計畫</EmptyLine>}>
        {(p) => <p className="pb-2 text-sm leading-relaxed whitespace-pre-wrap">{p.day_plan}</p>}
      </QueryView>
    </Card>
  );
}

function GoalRows({ goals }: { goals: Goal[] }) {
  if (goals.length === 0) return <EmptyLine>沒有目標</EmptyLine>;
  return (
    <Table aria-label="目標">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>目標</TableHead>
          <TableHead className="hidden w-36 md:table-cell">什麼時候</TableHead>
          <TableHead className="hidden w-20 lg:table-cell">來源</TableHead>
          <TableHead className="w-20">狀態</TableHead>
          <TableHead className="w-24">到期</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {goals.map((g) => {
          const closed = g.status === "done" || g.status === "dropped";
          return (
            <TableRow key={g.id} className={closed ? "text-muted-foreground" : undefined}>
              <TableCell className="min-w-56 whitespace-normal">
                <span className="grid gap-0.5">
                  <span>{g.what}</span>
                  {g.why && <span className="text-[13px] text-muted-foreground">{g.why}</span>}
                  {g.steps.length > 0 && (
                    <ol className="mt-1 list-decimal pl-5 text-[13px] text-muted-foreground">
                      {g.steps.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ol>
                  )}
                  {g.close_reason && <span className="text-[13px] text-muted-foreground">結束原因:{g.close_reason}</span>}
                  {(g.person || g.context) && (
                    <span className="text-xs text-muted-foreground">
                      {g.person && <span className="mr-2">{g.person}</span>}
                      {g.context && contextShort(g.context)}
                    </span>
                  )}
                </span>
              </TableCell>
              <TableCell className="hidden text-muted-foreground md:table-cell">{triggerText(g.trigger)}</TableCell>
              <TableCell className="hidden text-muted-foreground lg:table-cell">
                {GOAL_SOURCE_LABEL[g.source] ?? g.source}
              </TableCell>
              <TableCell>
                <StatusBadge tone={GOAL_STATUS_TONE[g.status] ?? "neutral"}>{GOAL_STATUS_LABEL[g.status] ?? g.status}</StatusBadge>
              </TableCell>
              <TableCell className="text-muted-foreground">
                <When at={closed && g.closed_at ? g.closed_at : g.expires} />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** Her structured agenda and today's plan. */
export function GoalsTab() {
  const [closed, setClosed] = useState(false);
  const goals = useGoals(closed);
  return (
    <div className="grid gap-(--stage-gap)">
      <DayPlanCard />
      <Card>
        <CardHeader>
          <CardTitle>目標</CardTitle>
          <div className="flex items-center gap-2">
            <Switch id="goals-closed" checked={closed} onCheckedChange={setClosed} />
            <Label htmlFor="goals-closed" className="font-normal text-muted-foreground">
              含已結束的
            </Label>
          </div>
        </CardHeader>
        <QueryView query={goals}>
          {(v) => <GoalRows goals={v.goals} />}
        </QueryView>
      </Card>
    </div>
  );
}
