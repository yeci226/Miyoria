import type { VoiceE2eLatency } from "@/api/types";
import { BarList } from "@/components/charts/charts";
import { EmptyLine } from "@/components/query-state";
import { E2E_REASON_LABEL, E2E_SEGMENTS, fmtMs } from "@/lib/e2e";

/**
 * Voice response time of one voice channel: speech end to first audio, its median and slowest
 * 10%, then the six segments. `e2e` is absent on a Core older than the measurement.
 */
export function VoiceLatency({ e2e }: { e2e: VoiceE2eLatency | undefined }) {
  if (!e2e) return <EmptyLine>這個 Core 還沒有提供語音回應延遲</EmptyLine>;
  const { total } = e2e;
  const reasons = Object.entries(e2e.incomplete_by_reason).sort((a, b) => b[1] - a[1]);
  if (total.samples === 0 && e2e.incomplete === 0) return <EmptyLine>還沒有量到語音回應</EmptyLine>;
  return (
    <div className="grid gap-3 py-2">
      <dl className="grid grid-cols-3 gap-x-4" aria-label="語音回應延遲">
        <div>
          <dt className="text-xs text-muted-foreground">中位數</dt>
          <dd className="font-mono text-sm font-medium tabular-nums">{total.p50_ms === null ? "—" : fmtMs(total.p50_ms)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">最慢 10%</dt>
          <dd className="font-mono text-sm font-medium tabular-nums">{total.p90_ms === null ? "—" : fmtMs(total.p90_ms)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">量到</dt>
          <dd className="font-mono text-sm font-medium tabular-nums">{e2e.complete} 次</dd>
        </div>
      </dl>
      {total.samples > 0 && (
        <BarList
          label="各段中位數"
          format={fmtMs}
          items={E2E_SEGMENTS.map(({ name, label }) => {
            const s = e2e.segments[name];
            return {
              key: name,
              label,
              value: s.p50_ms ?? 0,
              detail: s.p50_ms === null ? "沒有量到" : `最慢 10%:${s.p90_ms === null ? "—" : fmtMs(s.p90_ms)}(${s.samples} 次)`,
            };
          })}
        />
      )}
      {e2e.incomplete > 0 && (
        <p className="text-xs text-muted-foreground">
          未完成 {e2e.incomplete} 次:{reasons.map(([r, n]) => `${E2E_REASON_LABEL[r] ?? r} ${n}`).join("、")}
        </p>
      )}
    </div>
  );
}
