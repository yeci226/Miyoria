import type { ColumnDef } from "@tanstack/react-table";
import { Pencil, Trash2 } from "lucide-react";
import { useDeferredValue, useId, useMemo, useState } from "react";
import type { MemoryItem, MemoryKind, MemoryRecordView, MemoryScope } from "@/api/types";
import { useDeleteMemory, useMemory, useUpdateMemory } from "@/app/queries";
import { ConfirmDialog } from "@/components/confirm";
import { RowActions, SearchInput } from "@/components/controls";
import { DataTable } from "@/components/data-table";
import { Toolbar } from "@/components/page";
import { ErrorLine, SkeletonRows } from "@/components/query-state";
import { Meter } from "@/components/status";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/input";
import { Field, Label } from "@/components/ui/label";
import { Checkbox, Slider } from "@/components/ui/misc";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { accountString, contextShort, fmtDateTime, fmtRelative, fmtScore } from "@/lib/format";
import { notify } from "@/lib/notify";

export const KIND_LABEL: Record<MemoryKind, string> = {
  episode: "事件",
  fact: "事實",
  self_note: "她自己",
  followup: "待追問",
};

const KIND_BADGE: Record<MemoryKind, BadgeVariant> = {
  episode: "outline",
  fact: "outline",
  self_note: "brand",
  followup: "warning",
};

export function scopeLabel(s: MemoryScope): string {
  switch (s.type) {
    case "global":
      return "全域";
    case "guild":
      return `伺服器 ${s.guild}`;
    case "channel":
      return contextShort(s.context);
    case "dm":
      return `私訊 ${accountString(s.account)}`;
    case "person":
      return "跟著人";
  }
}

function EditMemory({ record, onClose }: { record: MemoryRecordView; onClose: () => void }) {
  const update = useUpdateMemory();
  const id = useId();
  const [content, setContent] = useState(record.content);
  const [kind, setKind] = useState<MemoryKind>(record.kind);
  const [importance, setImportance] = useState(record.importance);
  const [done, setDone] = useState(record.done);
  const save = () =>
    update.mutate(
      {
        id: record.id,
        req: { content: content.trim(), kind, importance, ...(kind === "followup" ? { done } : {}) },
      },
      {
        onSuccess: () => {
          notify.ok("記憶已更新");
          onClose();
        },
        onError: (e) => notify.error(e, "更新失敗"),
      },
    );
  return (
    <Dialog open onOpenChange={(o) => !o && !update.isPending && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>編輯記憶</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (content.trim()) save();
          }}
        >
          <Field label="內容" htmlFor={`${id}-c`}>
            <Textarea id={`${id}-c`} rows={5} value={content} onChange={(e) => setContent(e.target.value)} />
          </Field>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="種類" htmlFor={`${id}-k`}>
              <Select value={kind} onValueChange={(v) => setKind(v as MemoryKind)}>
                <SelectTrigger id={`${id}-k`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(KIND_LABEL) as MemoryKind[]).map((k) => (
                    <SelectItem key={k} value={k}>
                      {KIND_LABEL[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <div className="grid gap-2">
              <Label htmlFor={`${id}-i`} className="justify-between">
                重要度
                <span className="font-mono text-xs text-muted-foreground tabular-nums">{importance.toFixed(2)}</span>
              </Label>
              <Slider
                id={`${id}-i`}
                aria-label="重要度"
                min={0}
                max={1}
                step={0.05}
                value={[importance]}
                onValueChange={([v]) => setImportance(v ?? importance)}
                className="h-9"
              />
            </div>
          </div>
          {kind === "followup" && (
            <Label className="font-normal">
              <Checkbox checked={done} onCheckedChange={(v) => setDone(v === true)} />
              已追問
            </Label>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={update.isPending}>
              取消
            </Button>
            <Button writes type="submit" busy={update.isPending} disabled={!content.trim()}>
              儲存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const ALL = "__all";

export function MemoryTab() {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<MemoryKind | typeof ALL>(ALL);
  const [superseded, setSuperseded] = useState(false);
  const deferred = useDeferredValue(q.trim());
  const memory = useMemory({
    q: deferred || undefined,
    kind: kind === ALL ? undefined : kind,
    include_superseded: superseded || undefined,
  });
  const del = useDeleteMemory();
  const [editing, setEditing] = useState<MemoryRecordView | null>(null);
  const [deleting, setDeleting] = useState<MemoryRecordView | null>(null);
  const id = useId();

  const items = useMemo(() => memory.data?.pages.flatMap((p) => p.items) ?? [], [memory.data]);

  const columns = useMemo<ColumnDef<MemoryItem>[]>(
    () => [
      {
        id: "content",
        header: "內容",
        cell: ({ row: { original: item } }) => {
          const r = item.record;
          return (
            <div className="grid min-w-0 gap-1.5 py-0.5">
              <p className={r.superseded_by ? "break-words text-muted-foreground line-through decoration-muted-foreground/50" : "break-words"}>
                {r.content}
              </p>
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <Badge variant={KIND_BADGE[r.kind]}>{KIND_LABEL[r.kind]}</Badge>
                <Badge variant="outline">{scopeLabel(r.scope)}</Badge>
                {r.kind === "followup" && r.due && <span>{r.done ? "已追問" : `預定 ${fmtRelative(r.due)}`}</span>}
                {item.text_score !== undefined && <span className="font-mono">文字 {fmtScore(item.text_score)}</span>}
                {item.vector_score != null && <span className="font-mono">向量 {fmtScore(item.vector_score)}</span>}
              </div>
            </div>
          );
        },
      },
      {
        id: "importance",
        header: "重要度",
        meta: { className: "hidden w-24 sm:table-cell" },
        cell: ({ row }) => <Meter value={row.original.record.importance} label={`重要度 ${row.original.record.importance.toFixed(2)}`} />,
      },
      {
        id: "recall",
        header: "想起",
        meta: { className: "hidden w-16 text-right text-muted-foreground md:table-cell" },
        cell: ({ row }) => row.original.record.access_count,
      },
      {
        id: "created",
        header: "建立",
        meta: { className: "hidden w-24 whitespace-nowrap text-muted-foreground sm:table-cell" },
        cell: ({ row }) => (
          <time dateTime={row.original.record.created_at} title={fmtDateTime(row.original.record.created_at)}>
            {fmtRelative(row.original.record.created_at)}
          </time>
        ),
      },
      {
        id: "actions",
        header: () => <span className="sr-only">動作</span>,
        meta: { className: "w-12 text-right" },
        cell: ({ row }) => (
          <RowActions label="記憶的動作">
            <DropdownMenuItem onSelect={() => setEditing(row.original.record)}>
              <Pencil />
              編輯
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(row.original.record)}>
              <Trash2 />
              刪除
            </DropdownMenuItem>
          </RowActions>
        ),
      },
    ],
    [],
  );

  return (
    <div className="grid gap-4">
      <Toolbar>
        <SearchInput value={q} onChange={setQ} placeholder="搜尋記憶" label="搜尋記憶" />
        <Select value={kind} onValueChange={(v) => setKind(v as MemoryKind | typeof ALL)}>
          <SelectTrigger aria-label="種類" className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>所有種類</SelectItem>
            {(Object.keys(KIND_LABEL) as MemoryKind[]).map((k) => (
              <SelectItem key={k} value={k}>
                {KIND_LABEL[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Label htmlFor={`${id}-sup`} className="ml-1 font-normal text-muted-foreground">
          <Checkbox id={`${id}-sup`} checked={superseded} onCheckedChange={(v) => setSuperseded(v === true)} />
          含已取代
        </Label>
      </Toolbar>
      <Card>
        {memory.isPending ? (
          <SkeletonRows />
        ) : memory.isError ? (
          <ErrorLine error={memory.error} onRetry={() => void memory.refetch()} />
        ) : (
          <>
            <DataTable
              label="記憶"
              columns={columns}
              data={items}
              getRowId={(i) => i.record.id}
              empty={deferred ? `沒有跟「${deferred}」有關的記憶` : "還沒有記憶"}
            />
            {memory.hasNextPage && (
              <div className="pt-3">
                <Button size="sm" variant="outline" busy={memory.isFetchingNextPage} onClick={() => void memory.fetchNextPage()}>
                  載入更多
                </Button>
              </div>
            )}
          </>
        )}
      </Card>

      {editing && <EditMemory record={editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={deleting !== null}
        title="刪除這則記憶?"
        confirmLabel="刪除"
        busy={del.isPending}
        onClose={() => setDeleting(null)}
        onConfirm={() =>
          deleting &&
          del.mutate(deleting.id, {
            onSuccess: () => {
              notify.ok("已刪除");
              setDeleting(null);
            },
            onError: (e) => notify.error(e, "刪除失敗"),
          })
        }
      >
        <p className="text-foreground">「{deleting?.content}」</p>
      </ConfirmDialog>
    </div>
  );
}
