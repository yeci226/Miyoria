import { useEffect, useMemo, useState } from "react";
import type { ContextKey, DecisionRecord } from "@/api/types";
import { useDecisions } from "@/app/queries";
import { ChartBlock, type Column, ColumnChart } from "@/components/charts/charts";
import { SearchInput } from "@/components/controls";
import { Facts } from "@/components/json-view";
import { Toolbar } from "@/components/page";
import { EmptyLine, QueryView } from "@/components/query-state";
import { Meter } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { contextKeyString, contextKindLabel, contextShort, fmtDateTime, fmtRelative, fmtScore } from "@/lib/format";
import { TurnDetail } from "./TurnDetail";

type Outcome = "all" | "respond" | "ignore";
const LIMITS = ["50", "200", "1000"] as const;
const ALL = "__all";

function DecisionSheet({ record, onClose }: { record: DecisionRecord | null; onClose: () => void }) {
  const t = record?.trace;
  return (
    <Sheet open={record !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent>
        {record && t && (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                <Badge variant={t.respond ? "brand" : "outline"}>{t.respond ? "回應" : "略過"}</Badge>
                <span className="tabular-nums">{fmtScore(t.score)}</span>
              </SheetTitle>
            </SheetHeader>
            <SheetBody className="grid content-start gap-6">
              {t.reasons.length > 0 && (
                <ol className="grid list-decimal gap-2 pl-5 text-sm marker:text-muted-foreground">
                  {t.reasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ol>
              )}
              <Facts
                items={{
                  "情境": <span className="font-mono text-xs">{contextKeyString(t.context)}</span>,
                  "類型": contextKindLabel(t.context),
                  "伺服器": <span className="font-mono text-xs">{t.context.scope ?? "私訊"}</span>,
                  "頻道": <span className="font-mono text-xs">{t.context.channel}</span>,
                  "回合": <span className="font-mono text-xs">{t.turn}</span>,
                  "時間": fmtDateTime(record.ts),
                }}
              />
              <TurnDetail turn={t.turn} />
            </SheetBody>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

const BUCKETS = [5, 15, 30, 60, 180, 360, 1440].map((m) => m * 60_000);
const DECIDED = [
  { key: "respond", label: "回應", color: "var(--chart-1)" },
  { key: "ignore", label: "略過", color: "var(--chart-quiet)" },
];

/** Replied and skipped messages over the span of the loaded decisions. */
function DecisionChart({ records }: { records: DecisionRecord[] }) {
  const { columns, bucketMs, rate } = useMemo(() => {
    const ts = records.map((r) => Date.parse(r.ts));
    const lo = Math.min(...ts);
    const hi = Math.max(...ts);
    const bucketMs = BUCKETS.find((b) => (hi - lo) / b <= 30) ?? (BUCKETS[BUCKETS.length - 1] as number);
    const start = Math.floor(lo / bucketMs) * bucketMs;
    const columns: Column[] = [];
    for (let t = start; t <= hi; t += bucketMs) columns.push({ t, values: { respond: 0, ignore: 0 } });
    records.forEach((r, i) => {
      const col = columns[Math.floor(((ts[i] as number) - start) / bucketMs)];
      if (col) col.values[r.trace.respond ? "respond" : "ignore"] = (col.values[r.trace.respond ? "respond" : "ignore"] ?? 0) + 1;
    });
    const rate = records.filter((r) => r.trace.respond).length / records.length;
    return { columns, bucketMs, rate };
  }, [records]);
  return (
    <ChartBlock title="要不要回" value={`${Math.round(rate * 100)}%`} aside={`回應了 ${records.length} 則中的 ${Math.round(rate * records.length)} 則`}>
      <ColumnChart label="每段時間的決策" columns={columns} series={DECIDED} bucketMs={bucketMs} height={150} totalLabel="合計" />
    </ChartBlock>
  );
}

export function DecisionsTab() {
  const [outcome, setOutcome] = useState<Outcome>("all");
  const [limit, setLimit] = useState<(typeof LIMITS)[number]>("50");
  const [contextKey, setContextKey] = useState(ALL);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<DecisionRecord | null>(null);

  // Contexts seen so far, so the server-side filter can be picked from a list.
  const [known, setKnown] = useState<Map<string, ContextKey>>(new Map());
  const context = contextKey !== ALL ? known.get(contextKey) : undefined;
  const decisions = useDecisions({ limit: Number(limit), context });

  const data = decisions.data;
  useEffect(() => {
    if (!data) return;
    setKnown((prev) => {
      let next: Map<string, ContextKey> | undefined;
      for (const d of data) {
        const k = contextKeyString(d.trace.context);
        if (!prev.has(k) && !next?.has(k)) {
          next ??= new Map(prev);
          next.set(k, d.trace.context);
        }
      }
      return next ?? prev;
    });
  }, [data]);

  const counts = useMemo(() => {
    const list = data ?? [];
    const respond = list.filter((d) => d.trace.respond).length;
    return { all: list.length, respond, ignore: list.length - respond };
  }, [data]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data ?? []).filter((d) => {
      if (outcome === "respond" && !d.trace.respond) return false;
      if (outcome === "ignore" && d.trace.respond) return false;
      return !needle || d.trace.reasons.some((r) => r.toLowerCase().includes(needle));
    });
  }, [data, outcome, q]);

  return (
    <div className="grid gap-4">
      <Toolbar>
        <SearchInput value={q} onChange={setQ} placeholder="搜尋原因" label="搜尋原因" />
        <Select value={outcome} onValueChange={(v) => setOutcome(v as Outcome)}>
          <SelectTrigger aria-label="結果" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部 · {counts.all}</SelectItem>
            <SelectItem value="respond">回應 · {counts.respond}</SelectItem>
            <SelectItem value="ignore">略過 · {counts.ignore}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={contextKey} onValueChange={setContextKey}>
          <SelectTrigger aria-label="情境" className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>所有情境</SelectItem>
            {[...known.entries()].map(([k, c]) => (
              <SelectItem key={k} value={k}>
                {contextShort(c)} · {c.platform}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={limit} onValueChange={(v) => setLimit(v as (typeof LIMITS)[number])}>
          <SelectTrigger aria-label="筆數" className="ml-auto w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LIMITS.map((l) => (
              <SelectItem key={l} value={l}>
                最近 {l} 筆
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Toolbar>
      {data && data.length > 1 && <DecisionChart records={data} />}
      <Card>
        <QueryView query={decisions} isEmpty={(d) => d.length === 0} empty="還沒有決策紀錄">
          {() =>
            visible.length === 0 ? (
              <EmptyLine>沒有符合的決策</EmptyLine>
            ) : (
              <ul className="divide-y divide-line-soft" aria-label="決策列表">
                {visible.map((d) => (
                  <li key={d.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(d)}
                      className="flex w-full items-center gap-3 py-(--row-y) text-left text-sm outline-none hover:bg-hover focus-visible:bg-hover"
                    >
                      <Badge variant={d.trace.respond ? "brand" : "outline"} className="w-10">
                        {d.trace.respond ? "回應" : "略過"}
                      </Badge>
                      <span className="min-w-0 flex-1 truncate">
                        {d.trace.reasons[0] ?? <span className="text-muted-foreground">—</span>}
                      </span>
                      <span className="hidden w-28 truncate text-[13px] text-muted-foreground sm:block">
                        {contextShort(d.trace.context)}
                      </span>
                      <span className="hidden w-16 sm:block">
                        <Meter value={d.trace.score} tone={d.trace.respond ? "brand" : "neutral"} label="分數" />
                      </span>
                      <span className="w-10 text-right font-mono text-xs tabular-nums">{fmtScore(d.trace.score)}</span>
                      <time dateTime={d.ts} title={fmtDateTime(d.ts)} className="w-20 text-right text-[13px] text-muted-foreground">
                        {fmtRelative(d.ts)}
                      </time>
                    </button>
                  </li>
                ))}
              </ul>
            )
          }
        </QueryView>
      </Card>
      <DecisionSheet record={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
