import { useState } from "react";
import { useNotebook, useNotebookPage } from "@/app/v4-queries";
import { ModuleQuery } from "@/components/module-query";
import { EmptyLine, ErrorLine, SkeletonRows } from "@/components/query-state";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtDateTime, fmtInt, fmtRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

/** `人/Owen` → folder `人`, name `Owen`. */
export function splitPath(path: string): { folder: string | null; name: string } {
  const i = path.lastIndexOf("/");
  return i < 0 ? { folder: null, name: path } : { folder: path.slice(0, i), name: path.slice(i + 1) };
}

function PageBody({ path }: { path: string }) {
  const q = useNotebookPage(path);
  if (q.isPending) return <SkeletonRows count={5} />;
  if (q.isError) return <ErrorLine error={q.error} onRetry={() => void q.refetch()} />;
  const p = q.data;
  return (
    <article aria-label={`筆記 ${p.path}`} className="grid gap-3">
      <header className="grid gap-1">
        <h3 className="text-sm font-semibold break-words">{p.path}</h3>
        <p className="text-xs text-muted-foreground tabular-nums">
          {fmtInt(p.chars)} 字 · 寫於 {fmtDateTime(p.created_at)} · 改於 {fmtDateTime(p.updated_at)}
        </p>
      </header>
      {p.body === "" ? <EmptyLine>這一頁是空的</EmptyLine> : <pre className="max-h-[32rem] overflow-auto rounded-md bg-well px-3 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap break-words">{p.body}</pre>}
    </article>
  );
}

/** Her own notebook pages (the ones she wrote for herself, not the ones tied to a DM or a server). */
export function NotebookTab() {
  const q = useNotebook();
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <Card>
      <CardHeader>
        <CardTitle>她的筆記本</CardTitle>
        {q.data && q.data.pages.length > 0 && <span className="text-[13px] text-muted-foreground tabular-nums">{q.data.pages.length} 頁</span>}
      </CardHeader>
      <ModuleQuery query={q} module="筆記本(memory 模組)" isEmpty={(d) => d.pages.length === 0} empty="她還沒有寫任何自己的筆記">
        {(d) => {
          const current = d.pages.find((p) => p.path === picked)?.path ?? d.pages[0]?.path ?? null;
          return (
            <div className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
              <ul aria-label="筆記索引" className="grid content-start">
                {d.pages.map((p) => {
                  const { folder, name } = splitPath(p.path);
                  return (
                    <li key={p.path} className="border-b border-line-soft last:border-0">
                      <button
                        type="button"
                        aria-current={p.path === current ? "true" : undefined}
                        onClick={() => setPicked(p.path)}
                        className={cn("grid w-full gap-0.5 py-(--row-y) text-left outline-none focus-visible:ring-2 focus-visible:ring-ring", p.path === current ? "text-foreground" : "text-muted-foreground hover:text-foreground")}
                      >
                        <span className={cn("text-[13px] break-words", p.path === current && "font-semibold text-primary")}>
                          {folder && <span className="font-normal text-muted-foreground">{folder} / </span>}
                          {name}
                        </span>
                        <span className="text-xs tabular-nums">
                          {fmtInt(p.chars)} 字 · <time dateTime={p.updated_at}>{fmtRelative(p.updated_at)}</time>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {current && <PageBody path={current} />}
            </div>
          );
        }}
      </ModuleQuery>
    </Card>
  );
}
