import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { useBlocksToday, useDirectives } from "@/app/queries";
import { ChartBlock } from "@/components/charts/charts";
import { EmptyLine } from "@/components/query-state";
import { Skeleton } from "@/components/ui/misc";
import { AUTHORITY_LABEL, blocksOf, blocksPerRule, enforced, expiryLabel, inForce } from "@/lib/rules";

/** The rules in force, short, for the right rail of 總覽. */
export function RulesRail() {
  const directives = useDirectives(false);
  const blocks = useBlocksToday();
  const now = Date.now();
  const live = useMemo(() => (directives.data?.directives ?? []).filter((r) => inForce(r, now)), [directives.data, now]);
  const counts = useMemo(() => (blocks.data ? blocksPerRule(live, blocksOf(blocks.data)) : null), [live, blocks.data]);
  return (
    <ChartBlock
      title="主人規則"
      action={
        <Link to="/rules" className="text-[13px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
          管理
        </Link>
      }
    >
      {directives.isPending ? (
        <Skeleton className="h-12 w-full" />
      ) : directives.isError ? (
        <EmptyLine>讀不到規則</EmptyLine>
      ) : live.length === 0 ? (
        <EmptyLine>沒有生效中的規則</EmptyLine>
      ) : (
        <ul className="divide-y divide-line-soft" aria-label="生效中的規則">
          {live.slice(0, 4).map((r) => {
            const n = counts?.get(r.id);
            return (
              <li key={r.id} className="grid gap-0.5 py-(--row-y) text-[13px]">
                <p className="truncate font-medium" title={r.text}>
                  {r.text}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {AUTHORITY_LABEL[r.authority]} · {expiryLabel(r)}
                  {enforced(r.effect) && n !== undefined && ` · 今天擋下 ${n} 次`}
                </p>
              </li>
            );
          })}
          {live.length > 4 && <li className="py-(--row-y) text-xs text-muted-foreground">還有 {live.length - 4} 條</li>}
        </ul>
      )}
    </ChartBlock>
  );
}
