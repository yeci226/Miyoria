import type { ClusterEndpoints, ClusterEndpointView } from "@miyoria/contracts/api";
import { Dot } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const VIA = { direct: "直連", link: "經連線" } as const;

function Candidate({ c, used }: { c: ClusterEndpointView; used: boolean }) {
  return (
    <li className={cn("flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px]", !used && "text-muted-foreground")}>
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <Dot tone={c.healthy ? "success" : "warning"} />
        <span className="font-mono">
          {c.host} / {c.service}
        </span>
        <span className="sr-only">{c.healthy ? "健康" : "不健康"}</span>
      </span>
      <Badge variant="outline">{VIA[c.via]}</Badge>
      {!c.healthy && <span className="text-xs text-primary">不健康</span>}
      {c.version && <span className="font-mono text-xs text-muted-foreground">{c.version}</span>}
      {c.url && <span className="truncate font-mono text-xs text-muted-foreground">{c.url}</span>}
      {used && <Badge variant="brand">使用中</Badge>}
    </li>
  );
}

/** Per capability, who answers: the first healthy candidate is the one in use. */
export function EndpointList({ data }: { data: ClusterEndpoints }) {
  return (
    <ul aria-label="誰負責什麼">
      {data.capabilities.map(({ capability, candidates }) => {
        const usedIndex = candidates.findIndex((c) => c.healthy);
        return (
          <li
            key={capability}
            data-capability={capability}
            className="grid gap-x-6 gap-y-1.5 border-b border-line-soft py-3 last:border-0 sm:grid-cols-[8rem_minmax(0,1fr)]"
          >
            <span className="font-mono text-[13px] font-medium">{capability}</span>
            <div className="grid gap-1.5">
              {usedIndex === -1 && (
                <p role="status" className="text-[13px] text-primary">
                  {candidates.length === 0 ? "沒有任何服務提供" : "沒有健康的服務"}
                </p>
              )}
              {candidates.length > 0 && (
                <ol className="grid gap-1.5">
                  {candidates.map((c, i) => (
                    <Candidate key={`${c.host}/${c.service}`} c={c} used={i === usedIndex} />
                  ))}
                </ol>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
