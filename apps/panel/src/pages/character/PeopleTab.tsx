import { BondRing } from "@miyoria/card-face";
import type { ColumnDef } from "@tanstack/react-table";
import { useDeferredValue, useMemo, useState } from "react";
import type { PersonRow } from "@miyoria/contracts/api";
import { usePeople } from "@/app/queries";
import { SearchInput } from "@/components/controls";
import { DataTable } from "@/components/data-table";
import { Toolbar } from "@/components/page";
import { QueryView } from "@/components/query-state";
import { Meter } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { fmtDateTime, fmtRelative } from "@/lib/format";
import { AffinityTrends } from "./AffinityTrends";
import { tierText } from "./heart";

/** The list's small ring and the bond beside it. */
export function BondMark({ row }: { row: PersonRow }) {
  return (
    <div className="flex items-center gap-2">
      <span aria-hidden className="size-7 shrink-0 [&>svg]:size-full">
        <BondRing {...row.ring} size="mark" title={tierText(row)} />
      </span>
      <span className="w-9 text-right font-mono text-xs tabular-nums">{String(Math.round(row.bond)).replace("-", "−")}</span>
    </div>
  );
}

export function PeopleTab({ onOpen }: { onOpen: (id: string) => void }) {
  const [q, setQ] = useState("");
  const deferred = useDeferredValue(q.trim());
  const people = usePeople({ q: deferred || undefined, limit: 200 });

  const columns = useMemo<ColumnDef<PersonRow>[]>(
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
        cell: ({ row }) => tierText(row.original),
      },
      {
        id: "affinity",
        header: "羈絆",
        meta: { className: "hidden w-28 sm:table-cell" },
        cell: ({ row: { original: p } }) => (p.has_row ? <BondMark row={p} /> : <span className="text-muted-foreground">—</span>),
      },
      {
        id: "trust",
        header: "信任",
        meta: { className: "hidden w-24 md:table-cell" },
        cell: ({ row: { original: p } }) =>
          p.has_row ? <Meter value={p.trust / 100} tone="brand" label={`信任 ${Math.round(p.trust)}`} /> : null,
      },
      {
        id: "familiarity",
        header: "熟悉",
        meta: { className: "hidden w-24 md:table-cell" },
        cell: ({ row: { original: p } }) =>
          p.has_row ? <Meter value={p.familiarity / 100} label={`熟悉 ${Math.round(p.familiarity)}`} /> : null,
      },
      {
        id: "interactions",
        header: "互動",
        meta: { className: "hidden w-16 text-right lg:table-cell" },
        cell: ({ row }) => row.original.interactions,
      },
      {
        id: "last",
        header: "最近",
        meta: { className: "w-24 whitespace-nowrap text-muted-foreground" },
        cell: ({ row: { original: p } }) => {
          const at = p.last_interaction;
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
