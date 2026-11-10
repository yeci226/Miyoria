import { Trash2 } from "lucide-react";
import { useState } from "react";
import type { ReminderView } from "@/api/v4-types";
import { useCancelReminder, useReminders } from "@/app/v4-queries";
import { ConfirmDialog } from "@/components/confirm";
import { RowActions } from "@/components/controls";
import { ModuleQuery } from "@/components/module-query";
import { StatusBadge } from "@/components/status";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { accountString, contextShort, fmtDateTime, fmtRelative } from "@/lib/format";
import { notify } from "@/lib/notify";

/** Who a timer is about or for, in words. */
export function whoOf(r: ReminderView): string {
  if (r.person) return r.person;
  if (r.for_account) return `${accountString(r.for_account)} 要她設的`;
  return "她自己";
}

function Due({ r, now }: { r: ReminderView; now: number }) {
  const late = Date.parse(r.due) < now;
  return (
    <span className="grid gap-0.5">
      <time dateTime={r.due} title={fmtDateTime(r.due)} className={late ? "text-primary" : undefined}>
        {fmtRelative(r.due, now)}
      </time>
      <span className="text-xs text-muted-foreground tabular-nums">{fmtDateTime(r.due)}</span>
    </span>
  );
}

/** The timers she set: what, for whom, when it is due, and a way to cancel one. */
export function RemindersTab() {
  const q = useReminders();
  const cancel = useCancelReminder();
  const [removing, setRemoving] = useState<ReminderView | null>(null);
  const now = q.dataUpdatedAt > 0 ? q.dataUpdatedAt : Date.now();
  return (
    <Card>
      <CardHeader>
        <CardTitle>她設的提醒</CardTitle>
        {q.data && q.data.reminders.length > 0 && <span className="text-[13px] text-muted-foreground tabular-nums">{q.data.reminders.length} 個還沒到</span>}
      </CardHeader>
      <ModuleQuery query={q} module="提醒(mind 模組)" isEmpty={(d) => d.reminders.length === 0} empty="沒有還沒到的提醒">
        {(d) => (
          <Table aria-label="提醒">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>內容</TableHead>
                <TableHead className="w-40">對象</TableHead>
                <TableHead className="w-44">到期</TableHead>
                <TableHead className="hidden w-24 md:table-cell">重複</TableHead>
                <TableHead className="hidden w-32 lg:table-cell">設在</TableHead>
                <TableHead className="w-10">
                  <span className="sr-only">動作</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.reminders.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="min-w-48 whitespace-normal break-words">
                    {r.what}
                    <span className="ml-2 font-mono text-[11px] text-muted-foreground">{r.key}</span>
                  </TableCell>
                  <TableCell className="whitespace-normal break-words text-muted-foreground">{whoOf(r)}</TableCell>
                  <TableCell>
                    <Due r={r} now={now} />
                  </TableCell>
                  <TableCell className="hidden md:table-cell">{r.daily ? <StatusBadge tone="neutral">每天</StatusBadge> : <span className="text-muted-foreground">一次</span>}</TableCell>
                  <TableCell className="hidden text-muted-foreground lg:table-cell">{r.context ? contextShort(r.context) : "—"}</TableCell>
                  <TableCell>
                    <RowActions label={`提醒 ${r.key} 的動作`}>
                      <DropdownMenuItem variant="destructive" onSelect={() => setRemoving(r)}>
                        <Trash2 />
                        取消提醒
                      </DropdownMenuItem>
                    </RowActions>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </ModuleQuery>
      <ConfirmDialog
        open={removing !== null}
        title={`取消「${removing?.what ?? ""}」?`}
        confirmLabel="取消提醒"
        busy={cancel.isPending}
        onClose={() => setRemoving(null)}
        onConfirm={() =>
          removing &&
          cancel.mutate(removing.key, {
            onSuccess: () => {
              notify.ok("已取消提醒");
              setRemoving(null);
            },
            onError: (e) => notify.error(e, "取消失敗"),
          })
        }
      >
        <p>{removing ? `${whoOf(removing)} · ${fmtDateTime(removing.due)}${removing.daily ? " · 每天重複,之後都不會再提醒" : ""}` : ""}</p>
      </ConfirmDialog>
    </Card>
  );
}
