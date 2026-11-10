import { useMemo, useState } from "react";
import { useWorkspace } from "@/app/v4-queries";
import { SearchInput } from "@/components/controls";
import { ModuleQuery } from "@/components/module-query";
import { EmptyLine } from "@/components/query-state";
import { Meter } from "@/components/status";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtInt } from "@/lib/format";
import { fmtBytes } from "./labels";

function Usage({ label, used, max, format }: { label: string; used: number; max: number; format: (n: number) => string }) {
  const ratio = max > 0 ? used / max : 0;
  return (
    <div className="grid min-w-44 flex-1 gap-1.5">
      <div className="flex items-baseline justify-between gap-3 text-[13px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums">
          {format(used)} <span className="text-muted-foreground">/ {format(max)}</span>
        </span>
      </div>
      <Meter value={ratio} tone={ratio >= 0.9 ? "brand" : "neutral"} label={label} />
    </div>
  );
}

/** The files in her persistent workspace with their sizes, and how full it is. */
export function WorkspaceTab() {
  const q = useWorkspace();
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const files = useMemo(() => (q.data?.files ?? []).filter((f) => needle === "" || f.path.toLowerCase().includes(needle)), [q.data, needle]);
  return (
    <Card>
      <CardHeader>
        <CardTitle>她的工作區</CardTitle>
        {q.data && q.data.files.length > 0 && <SearchInput className="ml-auto" value={filter} onChange={setFilter} placeholder="找檔案" label="找檔案" />}
      </CardHeader>
      <ModuleQuery query={q} module="工作區(sandbox 模組)">
        {(w) => (
          <div className="grid gap-4">
            <div className="flex flex-wrap gap-x-10 gap-y-3">
              <Usage label="空間" used={w.usage.bytes} max={w.limits.max_bytes} format={fmtBytes} />
              <Usage label="檔案數" used={w.usage.files} max={w.limits.max_files} format={fmtInt} />
            </div>
            {w.usage.overflow && <p className="text-[13px] text-primary">檔案太多,沒有全部計入,視為已滿</p>}
            {w.files.length === 0 ? (
              <EmptyLine>工作區是空的</EmptyLine>
            ) : files.length === 0 ? (
              <EmptyLine>沒有符合的檔案</EmptyLine>
            ) : (
              <Table aria-label="工作區的檔案">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>路徑</TableHead>
                    <TableHead className="w-28 text-right">大小</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {files.map((f) => (
                    <TableRow key={f.path}>
                      <TableCell className="font-mono text-xs break-all whitespace-normal">{f.path}</TableCell>
                      <TableCell className="text-right text-muted-foreground tabular-nums">{fmtBytes(f.size)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {w.truncated && <p className="text-xs text-muted-foreground">檔案太多,只列出前 {fmtInt(w.files.length)} 個</p>}
          </div>
        )}
      </ModuleQuery>
    </Card>
  );
}
