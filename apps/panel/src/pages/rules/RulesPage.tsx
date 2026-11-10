import type { ColumnDef } from "@tanstack/react-table";
import { Ban, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import type { DirectiveRecord } from "@/api/types";
import { useBlocksToday, useDirectiveMutations, useDirectives } from "@/app/queries";
import { ConfirmDialog } from "@/components/confirm";
import { DataTable } from "@/components/data-table";
import { Page, PageHeader } from "@/components/page";
import { EmptyLine, ErrorLine, QueryView } from "@/components/query-state";
import { StatusBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/misc";
import { Segmented } from "@/components/ui/segmented";
import { fmtDateTime, fmtRelative, fmtTime } from "@/lib/format";
import { notify } from "@/lib/notify";
import {
  AUTHORITY_LABEL,
  type Block,
  blocksOf,
  blocksPerRule,
  EFFECT_LABEL,
  enforced,
  expiryLabel,
  inForce,
  scopeParts,
  sourceOf,
} from "@/lib/rules";
import { AddRuleDialog } from "./AddRuleDialog";

type View = "live" | "ended";

function Scope({ rule }: { rule: DirectiveRecord }) {
  const parts = scopeParts(rule.scope);
  if (parts.length === 0) return <span className="text-muted-foreground">全部</span>;
  return (
    <span className="flex flex-wrap gap-x-2 gap-y-0.5">
      {parts.map((p) => (
        <span key={`${p.kind}:${p.text}`} className={p.kind === "capability" ? "font-mono text-xs" : undefined}>
          {p.text}
        </span>
      ))}
    </span>
  );
}

function RulesTable({
  rules,
  view,
  counts,
  onRemove,
}: {
  rules: DirectiveRecord[];
  view: View;
  counts: Map<string, number> | null;
  onRemove: (rule: DirectiveRecord) => void;
}) {
  const columns = useMemo<ColumnDef<DirectiveRecord>[]>(() => {
    const cols: ColumnDef<DirectiveRecord>[] = [
      {
        id: "text",
        header: "規則",
        cell: ({ row: { original: r } }) => <span className="font-medium">{r.text}</span>,
      },
      {
        id: "effect",
        header: "效果",
        cell: ({ row: { original: r } }) => <Badge variant={enforced(r.effect) ? "secondary" : "outline"}>{EFFECT_LABEL[r.effect]}</Badge>,
      },
      { id: "scope", header: "範圍", cell: ({ row }) => <Scope rule={row.original} /> },
      { id: "authority", header: "權限", meta: { className: "hidden md:table-cell" }, cell: ({ row }) => AUTHORITY_LABEL[row.original.authority] },
      {
        id: "source",
        header: "來源",
        meta: { className: "hidden xl:table-cell" },
        cell: ({ row: { original: r } }) => (
          <span className="text-muted-foreground" title={r.source_event}>
            {sourceOf(r)}
          </span>
        ),
      },
    ];
    if (view === "live") {
      cols.push(
        {
          id: "expires",
          header: "到期",
          cell: ({ row: { original: r } }) => <span title={r.expires === "until_revoked" ? undefined : fmtRelative(r.expires)}>{expiryLabel(r)}</span>,
        },
        {
          id: "blocked",
          header: "今天擋下",
          meta: { className: "text-right" },
          cell: ({ row: { original: r } }) => {
            // Only an enforced rule stops anything.
            const n = counts?.get(r.id);
            return <span className="font-mono tabular-nums">{!enforced(r.effect) || n === undefined ? "—" : n}</span>;
          },
        },
        {
          id: "actions",
          header: () => <span className="sr-only">動作</span>,
          meta: { className: "w-16 text-right" },
          cell: ({ row: { original: r } }) => (
            <Button writes size="sm" variant="outline" onClick={() => onRemove(r)} aria-label={`解除「${r.text}」`}>
              解除
            </Button>
          ),
        },
      );
    } else {
      cols.push({
        id: "ended",
        header: "結束",
        cell: ({ row: { original: r } }) =>
          r.revoked_at ? (
            <span title={r.revoked_by ?? undefined}>
              {fmtDateTime(r.revoked_at)}
              {r.revoked_by && <span className="text-muted-foreground"> · {r.revoked_by}</span>}
            </span>
          ) : (
            <span>{r.expires === "until_revoked" ? "—" : `${fmtDateTime(r.expires)} 到期`}</span>
          ),
      });
    }
    return cols;
  }, [view, counts, onRemove]);

  return (
    <DataTable
      label={view === "live" ? "生效中的規則" : "已結束的規則"}
      columns={columns}
      data={rules}
      getRowId={(r) => r.id}
      empty={view === "live" ? "沒有生效中的規則" : "沒有已結束的規則"}
    />
  );
}

function RulesBlock() {
  const [view, setView] = useState<View>("live");
  const directives = useDirectives(view === "ended");
  const blocks = useBlocksToday();
  const { remove } = useDirectiveMutations();
  const [removing, setRemoving] = useState<DirectiveRecord | null>(null);

  const now = Date.now();
  const all = directives.data?.directives ?? [];
  const shown = all.filter((r) => (view === "live" ? inForce(r, now) : !inForce(r, now)));
  const found = useMemo(() => (blocks.data ? blocksOf(blocks.data) : []), [blocks.data]);
  const counts = useMemo(() => (blocks.isSuccess ? blocksPerRule(shown, found) : null), [blocks.isSuccess, shown, found]);
  const total = blocks.isSuccess ? found.length : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>主人規則</CardTitle>
        {total !== null && <span className="text-[13px] text-muted-foreground tabular-nums">今天擋下 {total} 次</span>}
        <CardAction>
          <Segmented
            label="規則範圍"
            value={view}
            onChange={setView}
            options={[
              { value: "live", label: "生效中" },
              { value: "ended", label: "已結束" },
            ]}
          />
        </CardAction>
      </CardHeader>
      {directives.data && !directives.data.healthy && (
        <p className="flex items-center gap-2 text-[13px]">
          <StatusBadge tone="warning">讀不到規則</StatusBadge>
          所有動作先擋下
        </p>
      )}
      <QueryView query={directives}>
        {() => (
          <RulesTable
            rules={shown}
            view={view}
            counts={counts}
            onRemove={(r) => setRemoving(r)}
          />
        )}
      </QueryView>
      <ConfirmDialog
        open={removing !== null}
        title={`解除「${removing?.text ?? ""}」?`}
        confirmLabel="解除"
        busy={remove.isPending}
        onClose={() => setRemoving(null)}
        onConfirm={() =>
          removing &&
          remove.mutate(removing.id, {
            onSuccess: (change) => {
              if (change.status === "question") {
                notify.error(new Error(change.question));
                return;
              }
              notify.ok("已解除");
              setRemoving(null);
            },
            onError: (e) => notify.error(e, "解除失敗"),
          })
        }
      />
    </Card>
  );
}

/** One thing a rule stopped, in the rail. */
function BlockRow({ b }: { b: Block }) {
  return (
    <li className="flex items-start gap-2.5 py-(--row-y)">
      <Ban aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <div className="grid min-w-0 flex-1 gap-0.5 text-[13px]">
        <p className="truncate">
          {b.capability ? <span className="font-mono text-xs">{b.capability}</span> : (b.what ?? "提案")}
          {b.via === "proposal" && <span className="ml-2 text-xs text-muted-foreground">提案作廢</span>}
        </p>
        <p className="truncate text-xs text-muted-foreground" title={b.reason}>
          {fmtTime(b.at)} · {b.rule ? b.rule.text : b.reason}
        </p>
      </div>
    </li>
  );
}

function RecentBlocks() {
  const blocks = useBlocksToday();
  const found = useMemo(() => (blocks.data ? blocksOf(blocks.data) : []), [blocks.data]);
  return (
    <Card aria-label="剛被擋下">
      <CardHeader>
        <CardTitle className="text-[13px]">剛被擋下</CardTitle>
      </CardHeader>
      {blocks.isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : blocks.isError ? (
        <ErrorLine error={blocks.error} onRetry={() => void blocks.refetch()} />
      ) : found.length === 0 ? (
        <EmptyLine>今天還沒有擋下任何動作</EmptyLine>
      ) : (
        <ul className="divide-y divide-line-soft">
          {found.slice(0, 12).map((b) => (
            <BlockRow key={b.id} b={b} />
          ))}
        </ul>
      )}
    </Card>
  );
}

/** The owner's rules: what is in force, who made it, when it ends and what it stopped today. */
export function RulesPage() {
  const [adding, setAdding] = useState(false);
  return (
    <Page rail={<RecentBlocks />}>
      <PageHeader
        title="規則"
        actions={
          <Button writes size="sm" onClick={() => setAdding(true)}>
            <Plus />
            新增規則
          </Button>
        }
      />
      <RulesBlock />
      {adding && <AddRuleDialog onClose={() => setAdding(false)} />}
    </Page>
  );
}
