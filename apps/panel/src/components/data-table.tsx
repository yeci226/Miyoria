import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useState } from "react";
import { EmptyLine } from "@/components/query-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

export type { ColumnDef };

declare module "@tanstack/react-table" {
  interface ColumnMeta<TData, TValue> {
    /** Classes for both the header and the cells of the column. */
    className?: string;
  }
}

/**
 * The panel's one table: TanStack Table with optional global search and sortable headers
 * (`enableSorting` per column).
 */
export function DataTable<T>({
  columns,
  data,
  getRowId,
  filter = "",
  globalFilterFn,
  empty,
  onRowClick,
  label,
  initialSorting = [],
}: {
  columns: ColumnDef<T, any>[];
  data: T[];
  getRowId: (row: T) => string;
  filter?: string;
  globalFilterFn?: (row: T, needle: string) => boolean;
  empty: string;
  onRowClick?: (row: T) => void;
  label?: string;
  initialSorting?: SortingState;
}) {
  const [sorting, setSorting] = useState<SortingState>(initialSorting);
  const table = useReactTable({
    data,
    columns,
    getRowId: (row) => getRowId(row),
    state: { sorting, globalFilter: filter },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    globalFilterFn: (row, _id, value: string) =>
      globalFilterFn ? globalFilterFn(row.original, String(value).trim().toLowerCase()) : true,
    enableSortingRemoval: false,
  });
  const rows = table.getRowModel().rows;

  return (
    <Table aria-label={label}>
      <TableHeader>
        {table.getHeaderGroups().map((group) => (
          <TableRow key={group.id} className="hover:bg-transparent">
            {group.headers.map((header) => {
              const sortable = header.column.getCanSort();
              const dir = header.column.getIsSorted();
              const content = header.isPlaceholder
                ? null
                : flexRender(header.column.columnDef.header, header.getContext());
              return (
                <TableHead
                  key={header.id}
                  className={header.column.columnDef.meta?.className}
                  aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : undefined}
                >
                  {sortable ? (
                    <button
                      type="button"
                      onClick={header.column.getToggleSortingHandler()}
                      className="-mx-1 inline-flex items-center gap-1 rounded px-1 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    >
                      {content}
                      {dir === "asc" ? <ArrowUp className="size-3" /> : dir === "desc" ? <ArrowDown className="size-3" /> : null}
                    </button>
                  ) : (
                    content
                  )}
                </TableHead>
              );
            })}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow className="hover:bg-transparent">
            <TableCell colSpan={columns.length} className="p-0">
              <EmptyLine>{empty}</EmptyLine>
            </TableCell>
          </TableRow>
        ) : (
          rows.map((row) => (
            <TableRow
              key={row.id}
              className={cn(onRowClick && "cursor-pointer")}
              onClick={
                onRowClick
                  ? (e) => {
                      // Clicks on controls inside the row are theirs.
                      if ((e.target as HTMLElement).closest("button,a,input,[role=menuitem]")) return;
                      onRowClick(row.original);
                    }
                  : undefined
              }
            >
              {row.getVisibleCells().map((cell) => (
                <TableCell key={cell.id} className={cell.column.columnDef.meta?.className}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              ))}
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}
