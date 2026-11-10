import { isApiError } from "@/api/http";
import { usePersonQuests } from "@/app/v4-queries";
import { ErrorLine, SkeletonRows } from "@/components/query-state";
import { Dot } from "@/components/status";
import { fmtInt } from "@/lib/format";

/** Today's three quests as this person sees them. Nothing when economy 2.0 is not running. */
export function QuestsSection({ personId }: { personId: string }) {
  const q = usePersonQuests(personId);
  if (q.isPending) return <SkeletonRows count={2} />;
  if (q.isError) {
    if (isApiError(q.error) && (q.error.kind === "unavailable" || q.error.kind === "not_provided")) return null;
    return <ErrorLine error={q.error} onRetry={() => void q.refetch()} />;
  }
  const v = q.data;
  return (
    <section className="grid gap-3" aria-label="今天的任務">
      <h3 className="text-sm font-medium">今天的任務</h3>
      {v.quests.length === 0 ? (
        <p className="text-sm text-muted-foreground">她還不認識這個人,沒有任務</p>
      ) : (
        <>
          <ul className="divide-y divide-line-soft">
            {v.quests.map((x) => (
              <li key={x.id} className="flex items-center gap-3 py-2 text-sm">
                <Dot tone={x.done ? "success" : "neutral"} className={x.done ? undefined : "[&>span]:bg-transparent [&>span]:ring-[1.5px] [&>span]:ring-inset [&>span]:ring-muted-foreground/70"} />
                <span className={x.done ? undefined : "text-muted-foreground"}>{x.label}</span>
                <span className="ml-auto text-[13px] text-muted-foreground">{x.done ? "完成" : "還沒"}</span>
              </li>
            ))}
          </ul>
          <p className="text-[13px] text-muted-foreground tabular-nums">
            一個 {fmtInt(v.reward)} {v.currency},三個都完成再加 {fmtInt(v.bonus)}({v.bonus_done ? "已領" : "還沒領"});今天賺了 {fmtInt(v.earned_today)} / {fmtInt(v.cap)}
          </p>
        </>
      )}
    </section>
  );
}
