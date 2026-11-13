import { useState } from "react";
import type { ReachedGoal } from "@/api/v4-types";
import { READ_ONLY_HINT, useCanWrite } from "@/app/session";
import { useFulfillGoal, useReachedGoals } from "@/app/v4-queries";
import { ConfirmDialog } from "@/components/confirm";
import { ModuleQuery } from "@/components/module-query";
import { StatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtDateTime, fmtInt, fmtRelative } from "@/lib/format";
import { notify } from "@/lib/notify";

/** Who marked a promise kept, in words. */
export function keptBy(goal: ReachedGoal): string {
  return goal.fulfilled_by === "self" ? "她自己說做到了" : "主人記的";
}

/**
 * The goals people filled: what she promised, and whether she kept it. One still owed can be marked
 * kept here (she can also mark it herself with `goal_done`); the first mark stands.
 */
export function GoalsTab() {
  const q = useReachedGoals();
  const fulfill = useFulfillGoal();
  const canWrite = useCanWrite();
  const [marking, setMarking] = useState<ReachedGoal | null>(null);
  const now = q.dataUpdatedAt > 0 ? q.dataUpdatedAt : Date.now();
  const owed = q.data?.goals.filter((g) => g.fulfilled_at === null).length ?? 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle>湊滿的目標</CardTitle>
        {owed > 0 && <span className="text-[13px] text-muted-foreground tabular-nums">{owed} 個還沒做到</span>}
      </CardHeader>
      <ModuleQuery query={q} module="經濟(economy 模組)" isEmpty={(d) => d.goals.length === 0} empty="還沒有湊滿的目標">
        {(d) => (
          <Table aria-label="湊滿的目標">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-40">目標</TableHead>
                <TableHead>她答應的</TableHead>
                <TableHead className="hidden w-24 text-right md:table-cell">湊了</TableHead>
                <TableHead className="hidden w-32 md:table-cell">湊滿</TableHead>
                <TableHead className="w-44">做到了嗎</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.goals.map((g) => (
                <TableRow key={g.id}>
                  <TableCell className="whitespace-normal break-words font-medium">{g.title}</TableCell>
                  <TableCell className="min-w-48 whitespace-normal break-words">{g.promise}</TableCell>
                  <TableCell className="hidden text-right tabular-nums md:table-cell">{fmtInt(g.target)}</TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">
                    {g.reached_at ? (
                      <time dateTime={g.reached_at} title={fmtDateTime(g.reached_at)}>
                        {fmtRelative(g.reached_at, now)}
                      </time>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>
                    {g.fulfilled_at ? (
                      <span className="grid gap-0.5">
                        <StatusBadge tone="success">做到了</StatusBadge>
                        <span className="text-xs text-muted-foreground">
                          {keptBy(g)} · <time dateTime={g.fulfilled_at}>{fmtRelative(g.fulfilled_at, now)}</time>
                        </span>
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!canWrite}
                        title={canWrite ? undefined : READ_ONLY_HINT}
                        onClick={() => setMarking(g)}
                      >
                        記成做到了
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </ModuleQuery>
      <ConfirmDialog
        open={marking !== null}
        title={`「${marking?.title ?? ""}」做到了?`}
        confirmLabel="記成做到了"
        busy={fulfill.isPending}
        onClose={() => setMarking(null)}
        onConfirm={() =>
          marking &&
          fulfill.mutate(marking.id, {
            onSuccess: () => {
              notify.ok("記下來了,她不會再被提醒這件事");
              setMarking(null);
            },
            onError: (e) => notify.error(e, "沒有記下來"),
          })
        }
      >
        <p>{marking ? `她答應的:${marking.promise}。記下來之後她的提示詞就不再提醒,會員頁也會顯示做到了。` : ""}</p>
      </ConfirmDialog>
    </Card>
  );
}
