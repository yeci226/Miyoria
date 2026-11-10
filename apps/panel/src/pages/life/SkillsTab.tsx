import { useState } from "react";
import { useSkill, useSkills } from "@/app/v4-queries";
import { ModuleQuery } from "@/components/module-query";
import { EmptyLine, ErrorLine, SkeletonRows } from "@/components/query-state";
import { StatusBadge } from "@/components/status";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { fmtBytes } from "./labels";

function SkillBody({ name }: { name: string }) {
  const q = useSkill(name);
  if (q.isPending) return <SkeletonRows count={5} />;
  if (q.isError) return <ErrorLine error={q.error} onRetry={() => void q.refetch()} />;
  const s = q.data;
  return (
    <article aria-label={`技能 ${s.name}`} className="grid gap-4">
      <header className="grid gap-1">
        <h3 className="font-mono text-sm font-semibold">{s.name}</h3>
        <p className="text-[13px] text-muted-foreground break-words">{s.description}</p>
      </header>
      {s.body === "" ? <EmptyLine>這個技能沒有內容</EmptyLine> : <pre className="max-h-[32rem] overflow-auto rounded-md bg-well px-3 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap break-words">{s.body}</pre>}
      {s.truncated && <p className="text-xs text-muted-foreground">內容太長,只顯示前面一段</p>}
      {s.files.length > 0 && (
        <ul aria-label="旁邊的檔案" className="grid gap-1.5">
          {s.files.map((f) => (
            <li key={f.path} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
              <span className="min-w-0 font-mono text-xs break-all">{f.path}</span>
              <span className="text-muted-foreground tabular-nums">{fmtBytes(f.size)}</span>
              {f.script === "approved" && <StatusBadge tone="success">審過,能執行</StatusBadge>}
              {f.script === "unapproved" && <StatusBadge tone="warning">沒審過,不會執行</StatusBadge>}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

/** The skill index and a skill's text, read-only. */
export function SkillsTab() {
  const q = useSkills();
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <Card>
      <CardHeader>
        <CardTitle>她的技能</CardTitle>
        {q.data && q.data.skills.length > 0 && <span className="text-[13px] text-muted-foreground tabular-nums">{q.data.skills.length} 個</span>}
      </CardHeader>
      <ModuleQuery query={q} module="技能(sandbox 模組的工作區)" isEmpty={(d) => d.skills.length === 0} empty="她還沒有技能">
        {(d) => {
          const current = d.skills.find((s) => s.name === picked)?.name ?? d.skills[0]?.name ?? null;
          return (
            <div className="grid gap-6 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
              <ul aria-label="技能索引" className="grid content-start">
                {d.skills.map((s) => (
                  <li key={s.name} className="border-b border-line-soft last:border-0">
                    <button
                      type="button"
                      aria-current={s.name === current ? "true" : undefined}
                      onClick={() => setPicked(s.name)}
                      className={cn("grid w-full gap-0.5 py-(--row-y) text-left outline-none focus-visible:ring-2 focus-visible:ring-ring", s.name === current ? "text-foreground" : "text-muted-foreground hover:text-foreground")}
                    >
                      <span className={cn("font-mono text-[13px]", s.name === current && "font-semibold text-primary")}>{s.name}</span>
                      <span className="line-clamp-2 text-[13px] break-words">{s.description}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {current && <SkillBody name={current} />}
            </div>
          );
        }}
      </ModuleQuery>
    </Card>
  );
}
