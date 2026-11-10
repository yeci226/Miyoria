import type { ColumnDef } from "@tanstack/react-table";
import { useDeferredValue, useMemo, useState } from "react";
import type { PersonSummary } from "@/api/types";
import { usePeople } from "@/app/queries";
import { SearchInput } from "@/components/controls";
import { DataTable } from "@/components/data-table";
import { Toolbar } from "@/components/page";
import { QueryView } from "@/components/query-state";
import { Bipolar, Meter } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { fmtDateTime, fmtRelative } from "@/lib/format";
import { AffinityTrends } from "./AffinityTrends";

export function PeopleTab({ onOpen }: { onOpen: (id: string) => void }) {
  const [q, setQ] = useState("");
  const deferred = useDeferredValue(q.trim());
  const people = usePeople({ q: deferred || undefined, limit: 200 });

  const columns = useMemo<ColumnDef<PersonSummary>[]>(
    () => [
      {
        id: "name",
        header: "名稱",
        cell: ({ row: { original: p } }) => (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onOpen(p.person.id)}
              className="truncate rounded-sm font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              {p.person.display_name}
            </button>
            {[...new Set(p.person.accounts.map((a) => a.account.platform))].map((pl) => (
              <Badge key={pl} variant="outline">
                {pl}
              </Badge>
            ))}
            {p.blocked && <Badge variant="destructive">已封鎖</Badge>}
          </div>
        ),
      },
      {
        id: "label",
        header: "關係",
        meta: { className: "whitespace-nowrap" },
        cell: ({ row }) => row.original.label ?? <span className="text-muted-foreground">—</span>,
      },
      {
        id: "affinity",
        header: "好感",
        meta: { className: "hidden w-36 sm:table-cell" },
        cell: ({ row: { original: p } }) =>
          p.relationship ? (
            <div className="flex items-center gap-2">
              <Bipolar value={p.relationship.affinity} label={`好感 ${Math.round(p.relationship.affinity)}`} />
              <span className="w-8 text-right font-mono text-xs">{Math.round(p.relationship.affinity)}</span>
            </div>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "trust",
        header: "信任",
        meta: { className: "hidden w-24 md:table-cell" },
        cell: ({ row: { original: p } }) =>
          p.relationship ? <Meter value={p.relationship.trust / 100} tone="brand" label={`信任 ${Math.round(p.relationship.trust)}`} /> : null,
      },
      {
        id: "familiarity",
        header: "熟悉",
        meta: { className: "hidden w-24 md:table-cell" },
        cell: ({ row: { original: p } }) =>
          p.relationship ? <Meter value={p.relationship.familiarity / 100} label={`熟悉 ${Math.round(p.relationship.familiarity)}`} /> : null,
      },
      {
        id: "interactions",
        header: "互動",
        meta: { className: "hidden w-16 text-right lg:table-cell" },
        cell: ({ row }) => row.original.relationship?.interactions ?? 0,
      },
      {
        id: "last",
        header: "最近",
        meta: { className: "w-24 whitespace-nowrap text-muted-foreground" },
        cell: ({ row: { original: p } }) => {
          const at = p.relationship?.last_interaction;
          return at ? (
            <time dateTime={at} title={fmtDateTime(at)}>
              {fmtRelative(at)}
            </time>
          ) : (
            "—"
          );
        },
      },
    ],
    [onOpen],
  );

  return (
    <div className="grid gap-4">
      {!deferred && people.data && <AffinityTrends people={people.data.items} />}
      <Toolbar>
        <SearchInput value={q} onChange={setQ} placeholder="名稱或帳號 id" label="搜尋人" />
      </Toolbar>
      <Card>
        <QueryView query={people}>
          {(page) => (
            <DataTable
              label="人"
              columns={columns}
              data={page.items}
              getRowId={(p) => p.person.id}
              empty={deferred ? "找不到這個人" : "還不認識任何人"}
              onRowClick={(p) => onOpen(p.person.id)}
            />
          )}
        </QueryView>
      </Card>
    </div>
  );
}
