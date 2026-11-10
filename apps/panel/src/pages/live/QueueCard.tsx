import type { ColumnDef } from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronsUp, SkipForward } from "lucide-react";
import { useId, useMemo } from "react";
import type { QueueItem } from "@/api/types";
import { useQueue, useQueueMutations } from "@/app/queries";
import { READ_ONLY_HINT, useCanWrite } from "@/app/session";
import { DataTable } from "@/components/data-table";
import { QueryView } from "@/components/query-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { contextShort, fmtDateTime, fmtRelative } from "@/lib/format";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";

const KIND: Record<string, string> = {
  chat: "聊天",
  song: "點歌",
  game_goal: "遊戲目標",
  message: "訊息",
  voice: "語音",
  initiative: "主動",
  request: "點播",
};

export function QueueCard() {
  const queue = useQueue();
  const { skip, move, pause } = useQueueMutations();
  const canWrite = useCanWrite();
  const id = useId();
  const items = queue.data?.items ?? [];
  const paused = queue.data?.paused ?? false;

  const columns = useMemo<ColumnDef<QueueItem>[]>(
    () => [
      {
        id: "pos",
        header: "#",
        meta: { className: "w-10 text-muted-foreground tabular-nums" },
        cell: ({ row }) => row.index + 1,
      },
      {
        id: "text",
        header: "請求",
        cell: ({ row: { original: i } }) => (
          <div className="flex min-w-0 items-center gap-2">
            <Badge variant={i.state === "active" ? "brand" : "outline"}>{KIND[i.kind] ?? i.kind}</Badge>
            <span className="min-w-0 break-words">{i.text}</span>
          </div>
        ),
      },
      {
        id: "from",
        header: "來自",
        meta: { className: "hidden whitespace-nowrap text-muted-foreground md:table-cell" },
        cell: ({ row: { original: i } }) => (
          <>
            {i.author?.display_name ?? "系統"}
            {i.context && <span className="ml-1.5 text-xs">{contextShort(i.context)}</span>}
          </>
        ),
      },
      {
        id: "at",
        header: "時間",
        meta: { className: "hidden whitespace-nowrap text-muted-foreground sm:table-cell" },
        cell: ({ row: { original: i } }) => (
          <time dateTime={i.enqueued_at} title={fmtDateTime(i.enqueued_at)}>
            {fmtRelative(i.enqueued_at)}
          </time>
        ),
      },
      {
        id: "actions",
        header: () => <span className="sr-only">動作</span>,
        meta: { className: "w-px whitespace-nowrap text-right" },
        cell: ({ row }) => {
          const i = row.original;
          const n = items.length;
          const busy = (move.isPending && move.variables?.id === i.id) || (skip.isPending && skip.variables === i.id);
          const moveTo = (position: number) =>
            move.mutate({ id: i.id, position }, { onError: (e) => notify.error(e, "移動失敗") });
          const act = (label: string, icon: React.ReactNode, onClick: () => void, disabled: boolean, className?: string) => (
            <Button
              writes
              size="icon-sm"
              variant="ghost"
              aria-label={`${label} #${row.index + 1}`}
              title={label}
              disabled={disabled || busy}
              onClick={onClick}
              className={cn("size-7 text-muted-foreground hover:text-foreground", className)}
            >
              {icon}
            </Button>
          );
          return (
            <div className="inline-flex items-center gap-0.5">
              {act("移到最前", <ChevronsUp />, () => moveTo(0), row.index === 0, "hidden sm:inline-flex")}
              {act("往前", <ArrowUp />, () => moveTo(row.index - 1), row.index === 0)}
              {act("往後", <ArrowDown />, () => moveTo(row.index + 1), row.index === n - 1)}
              {act(
                "跳過",
                <SkipForward />,
                () => skip.mutate(i.id, { onSuccess: () => notify.ok(`已跳過 #${row.index + 1}`), onError: (e) => notify.error(e, "跳過失敗") }),
                false,
              )}
            </div>
          );
        },
      },
    ],
    [items.length, move, skip],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          請求佇列
          {items.length > 0 && <span className="font-normal text-muted-foreground tabular-nums">{items.length}</span>}
        </CardTitle>
        {queue.isSuccess && (
          <CardAction>
            <Label htmlFor={`${id}-pause`} className="font-normal text-muted-foreground">
              暫停處理
            </Label>
            <Switch
              id={`${id}-pause`}
              checked={paused}
              disabled={!canWrite || pause.isPending}
              title={!canWrite ? READ_ONLY_HINT : undefined}
              onCheckedChange={(p) =>
                pause.mutate(p, {
                  onSuccess: () => notify.ok(p ? "佇列已暫停" : "佇列恢復處理"),
                  onError: (e) => notify.error(e),
                })
              }
            />
          </CardAction>
        )}
      </CardHeader>
      <QueryView query={queue}>
        {(state) => (
          <DataTable label="請求佇列" columns={columns} data={state.items} getRowId={(i) => i.id} empty="佇列是空的" />
        )}
      </QueryView>
    </Card>
  );
}
