import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import type { E2eRecord, LogEvent, TurnOutcomeRecord } from "@/api/types";
import { useTurnE2e, useTurnEvents, useTurnOutcomes } from "@/app/queries";
import { BarList } from "@/components/charts/charts";
import { LogEventSheet } from "@/components/consciousness";
import { EmptyLine, ErrorLine, QueryView, SkeletonRows } from "@/components/query-state";
import { StatusBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { describe, KIND_LABEL } from "@/lib/consciousness";
import { E2E_REASON_LABEL, E2E_SEGMENTS, fmtMs } from "@/lib/e2e";
import { contextShort, fmtRelative, fmtTime } from "@/lib/format";
import { type LineEnd, turnE2e, turnFacts, ulidTime } from "@/lib/turn-events";
import { OUTCOME_KIND_LABEL, OUTCOME_TONE, outcomeText } from "./labels";
import { OutcomeFacts, PromptSection } from "./TurnDetail";

const route = getRouteApi("/activity");

/** Lines of a turn are read from this long before its id's time to this long after its outcome. */
const AFTER_MS = 60_000;
const NO_OUTCOME_MS = 10 * 60_000;
const EVENT_LIMIT = 500;

const CHANNEL = { voice: "語音", text: "文字" } as const;

const END_LABEL: Record<Exclude<LineEnd["state"], "delivered" | "pending">, string> = {
  interrupted: "被打斷",
  failed: "沒送到",
  cancelled: "沒送出",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-2" aria-label={title}>
      <h3 className="text-sm font-medium">{title}</h3>
      {children}
    </section>
  );
}

/** Six segments of one reply, from its `voice.latency` line of the log or the event this panel saw. */
function SegmentsOf({ record }: { record: E2eRecord }) {
  if (!record.complete) {
    return <EmptyLine>沒有量完:{E2E_REASON_LABEL[record.reason ?? "unknown"] ?? record.reason}</EmptyLine>;
  }
  const unattributed = record.unattributed_ms ?? 0;
  return (
    <div className="grid gap-3">
      <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="font-mono font-medium tabular-nums">{record.total_ms === null ? "—" : fmtMs(record.total_ms)}</span>
        <span className="text-[13px] text-muted-foreground">說完到第一個聲音</span>
      </p>
      <BarList
        label="各段延遲"
        format={fmtMs}
        items={E2E_SEGMENTS.map(({ name, label }) => ({
          key: name,
          label,
          value: record.segments[name] ?? 0,
          detail: record.segments[name] === null ? "沒有量到" : undefined,
        }))}
      />
      {(unattributed > 0 || record.prefetched || record.provider) && (
        <p className="text-xs text-muted-foreground">
          {[
            unattributed > 0 ? `沒歸到任何一段 ${fmtMs(unattributed)}` : null,
            record.prefetched ? "第一句是預先合成的" : null,
            record.provider,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}
    </div>
  );
}

function EndBadge({ end, from }: { end: LineEnd; from: string }) {
  if (end.state === "pending") return <StatusBadge tone="neutral">沒有送達紀錄</StatusBadge>;
  if (end.state === "delivered") {
    const took = Date.parse(end.at) - Date.parse(from);
    return (
      <span className="flex items-center gap-2">
        <StatusBadge tone="success">已送達</StatusBadge>
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          {fmtTime(end.at)}
          {Number.isFinite(took) && took >= 0 ? ` · ${fmtMs(took)}` : ""}
        </span>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2">
      <StatusBadge tone="warning">{END_LABEL[end.state]}</StatusBadge>
      <span className="text-xs text-muted-foreground">{end.reason ?? fmtTime(end.at)}</span>
    </span>
  );
}

function EventRows({ events, label, onOpen }: { events: LogEvent[]; label: string; onOpen: (e: LogEvent) => void }) {
  return (
    <ul aria-label={label} className="divide-y divide-line-soft">
      {events.map((e) => {
        const d = describe(e);
        return (
          <li key={e.id} className="flex items-baseline gap-3 py-(--row-y) text-[13px]">
            <time dateTime={e.at} className="w-16 shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
              {fmtTime(e.at)}
            </time>
            <span className="w-14 shrink-0 text-muted-foreground">{KIND_LABEL[e.kind]}</span>
            <span className="min-w-0 flex-1 break-words">
              {d.title}
              {d.detail && <span className="ml-2 font-mono text-xs text-muted-foreground">{d.detail}</span>}
            </span>
            <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => onOpen(e)}>
              詳情
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

/** One turn: how it ended, what she was given, said, did and how it arrived, and how long it took. */
export function TurnView({ turn }: { turn: string }) {
  const outcomes = useTurnOutcomes({ limit: EVENT_LIMIT });
  const record = outcomes.data?.find((r) => r.turn === turn) ?? null;
  const live = useTurnE2e(turn);
  const [open, setOpen] = useState<LogEvent | null>(null);

  const start = ulidTime(turn) ?? (record ? Date.parse(record.at) - NO_OUTCOME_MS : null);
  // Only a Core without the `turn` filter is read by this window.
  const range = useMemo(() => {
    if (start === null) return null;
    const end = record ? Date.parse(record.at) + AFTER_MS : start + NO_OUTCOME_MS;
    return { since: new Date(start - 1000).toISOString(), until: new Date(end).toISOString() };
  }, [start, record]);
  const log = useTurnEvents(turn, range, EVENT_LIMIT, !outcomes.isPending);
  const facts = useMemo(() => turnFacts(log.data ?? [], turn), [log.data, turn]);
  const e2e = useMemo(() => turnE2e(log.data ?? [], turn) ?? live.data ?? null, [log.data, turn, live.data]);

  const noLog = log.isError ? (
    <ErrorLine error={log.error} onRetry={() => void log.refetch()} />
  ) : log.isPending || outcomes.isPending ? (
    <SkeletonRows count={2} />
  ) : null;

  return (
    <div className="grid gap-6">
      <Section title="結果">
        {record ? (
          <OutcomeFacts record={record} />
        ) : outcomes.isPending ? (
          <SkeletonRows count={2} />
        ) : (
          <EmptyLine>沒有這回合的結果紀錄</EmptyLine>
        )}
      </Section>
      <PromptSection turn={turn} />
      <Section title="輸出">
        {noLog ??
          (facts.lines.length === 0 ? (
            <EmptyLine>這回合沒有說出任何話</EmptyLine>
          ) : (
            <ol aria-label="她說的話" className="divide-y divide-line-soft">
              {facts.lines.map((l, i) => (
                <li key={l.line.id} className="grid gap-1 py-(--row-y)">
                  <p className="flex items-center gap-2 text-xs text-muted-foreground">
                    第 {i + 1} 句{l.channel && <Badge variant="outline">{CHANNEL[l.channel]}</Badge>}
                  </p>
                  <p className="text-sm break-words whitespace-pre-wrap">{l.said || <span className="text-muted-foreground">(空白)</span>}</p>
                </li>
              ))}
            </ol>
          ))}
      </Section>
      <Section title="動作">
        {noLog ??
          (facts.actions.length === 0 ? (
            <EmptyLine>這回合沒有動作</EmptyLine>
          ) : (
            <EventRows events={facts.actions} label="這回合的動作" onOpen={setOpen} />
          ))}
      </Section>
      <Section title="送達">
        {noLog ??
          (facts.lines.length === 0 ? (
            <EmptyLine>沒有要送達的話</EmptyLine>
          ) : (
            <ol aria-label="送達狀況" className="divide-y divide-line-soft">
              {facts.lines.map((l, i) => (
                <li key={l.line.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-(--row-y) text-[13px]">
                  <span className="w-12 text-muted-foreground">第 {i + 1} 句</span>
                  <EndBadge end={l.end} from={l.line.at} />
                </li>
              ))}
            </ol>
          ))}
      </Section>
      <Section title="延遲">
        {e2e ? <SegmentsOf record={e2e} /> : <EmptyLine>沒有這回合的語音延遲</EmptyLine>}
      </Section>
      <LogEventSheet event={open} onClose={() => setOpen(null)} />
    </div>
  );
}

function Row({ record, onOpen }: { record: TurnOutcomeRecord; onOpen: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-3 py-(--row-y) text-left text-sm outline-none hover:bg-hover focus-visible:bg-hover"
      >
        <time dateTime={record.at} className="w-16 shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
          {fmtTime(record.at)}
        </time>
        <span className="w-24 shrink-0">
          <StatusBadge tone={OUTCOME_TONE[record.outcome.type]}>{OUTCOME_KIND_LABEL[record.outcome.type]}</StatusBadge>
        </span>
        <span className="min-w-0 flex-1 truncate">
          {record.addressed_by.length > 0 && <span className="text-muted-foreground">{record.addressed_by.join("、")} · </span>}
          {outcomeText(record.outcome)}
        </span>
        <span className="hidden w-28 truncate text-[13px] text-muted-foreground sm:block">{contextShort(record.context)}</span>
        <span className="hidden w-20 text-right font-mono text-xs text-muted-foreground tabular-nums md:block">
          {record.latency_ms === null ? "—" : fmtMs(record.latency_ms)}
        </span>
        <span className="hidden w-20 text-right text-[13px] text-muted-foreground lg:block">{fmtRelative(record.at)}</span>
      </button>
    </li>
  );
}

/** Her recent turns; one opens in a sheet (`?turn=`). */
export function TurnsTab() {
  const search = route.useSearch();
  const navigate = useNavigate();
  const outcomes = useTurnOutcomes({ limit: 60 });
  const turn = search.turn ?? null;
  const open = (t: string | undefined) => void navigate({ to: "/activity", search: { tab: "turns", turn: t }, replace: t === undefined });
  return (
    <div className="grid gap-4">
      <Card>
        <QueryView query={outcomes} isEmpty={(d) => d.length === 0} empty="還沒有回合">
          {(rows) => (
            <ul aria-label="回合列表" className="divide-y divide-line-soft">
              {rows.map((r) => (
                <Row key={r.turn} record={r} onOpen={() => open(r.turn)} />
              ))}
            </ul>
          )}
        </QueryView>
      </Card>
      <Sheet open={turn !== null} onOpenChange={(o) => !o && open(undefined)}>
        <SheetContent className="sm:max-w-3xl">
          {turn && (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2">
                  <span>回合</span>
                  <span className="font-mono text-xs text-muted-foreground">{turn}</span>
                </SheetTitle>
              </SheetHeader>
              <SheetBody className="grid content-start gap-6">
                <TurnView turn={turn} />
              </SheetBody>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
