// 意識軸 on 總覽: what she heard, thought, said and did on one timeline, from the EventLog
// (`GET /api/facts/events`). Selecting a point loads its causes and effects and writes the
// chain out underneath.

import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { isApiError } from "@/api/http";
import type { LogEvent } from "@/api/types";
import { useFactChain, useFactEffects, useFactWindow } from "@/app/queries";
import { ChartEmpty } from "@/components/charts/charts";
import { ConsciousnessAxis } from "@/components/charts/consciousness-axis";
import { DirectorTrace } from "@/components/director-trace";
import { Facts, JsonView } from "@/components/json-view";
import { ErrorLine, SkeletonRows } from "@/components/query-state";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/misc";
import { Segmented } from "@/components/ui/segmented";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  AXIS_LIMIT,
  AXIS_RANGES,
  type AxisRange,
  buildAxis,
  chainOf,
  describe,
  KIND_LABEL,
  LANES,
  laneOf,
  thoughtBody,
  turnOf,
} from "@/lib/consciousness";
import { contextShort, fmtDateTime, fmtTime } from "@/lib/format";
import { readStorage, writeStorage } from "@/lib/storage";

const RANGE_KEY = "miyoria.panel.axis";
const HEIGHT = 250;
/** Steps listed under the axis; a longer chain says how many are left out. */
const MAX_STEPS = 40;

function useAxisRange(): [AxisRange, (r: AxisRange) => void] {
  const [range, set] = useState<AxisRange>(() => {
    const saved = readStorage(RANGE_KEY);
    return AXIS_RANGES.some((r) => r.range === saved) ? (saved as AxisRange) : "10m";
  });
  return [
    range,
    (r) => {
      writeStorage(RANGE_KEY, r);
      set(r);
    },
  ];
}

/** The director's trace of a `game.director` line, when its body has the shape. */
function directorOf(e: LogEvent) {
  const t = e.source === "game.director" ? thoughtBody(e) : null;
  return t !== null && "trigger" in t ? t : null;
}

/** One event in full: its facts and its whole body. */
export function LogEventSheet({ event, onClose }: { event: LogEvent | null; onClose: () => void }) {
  const trace = event ? directorOf(event) : null;
  return (
    <Sheet open={event !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent>
        {event && (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                <span>{KIND_LABEL[event.kind]}</span>
                <span className="font-mono text-xs text-muted-foreground">{event.source}</span>
              </SheetTitle>
            </SheetHeader>
            <SheetBody className="grid content-start gap-5">
              <p className="text-sm break-words">{describe(event).title}</p>
              {trace && <DirectorTrace body={trace} />}
              <Facts
                items={{
                  "時間": fmtDateTime(event.at),
                  "事件": <span className="font-mono text-xs">{event.id}</span>,
                  "起因": <span className="font-mono text-xs">{event.cause ?? "—"}</span>,
                  "情境": event.context ? contextShort(event.context) : "—",
                  "人": event.person ?? "—",
                  "回合": <span className="font-mono text-xs">{turnOf(event) ?? "—"}</span>,
                }}
              />
              <JsonView value={event} label="事件" />
            </SheetBody>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

/** The steps of one chain, oldest first. */
export function ChainSteps({ steps, selected, onOpen }: { steps: LogEvent[]; selected: string; onOpen: (e: LogEvent) => void }) {
  const shown = steps.slice(0, MAX_STEPS);
  return (
    <div className="grid gap-3">
      <ol aria-label="這條因果鏈" className="grid gap-x-6 gap-y-4 sm:grid-cols-2 xl:grid-cols-4">
        {shown.map((e) => {
          const d = describe(e);
          const turn = turnOf(e);
          const here = e.id === selected;
          return (
            <li key={e.id} aria-current={here ? "true" : undefined} className="min-w-0 border-t border-line-soft pt-2">
              <p className="flex items-baseline gap-2 text-[13px]">
                <span className={here ? "font-semibold text-primary" : "font-semibold"}>{LANES[laneOf(e)]}</span>
                <span className="text-muted-foreground">{KIND_LABEL[e.kind]}</span>
                <time dateTime={e.at} className="ml-auto font-mono text-[11px] text-muted-foreground tabular-nums">
                  {fmtTime(e.at)}
                </time>
              </p>
              <p className="mt-1 text-[13px] break-words">{d.title}</p>
              {d.detail && <p className="mt-0.5 font-mono text-xs break-words text-muted-foreground">{d.detail}</p>}
              <p className="mt-1.5 flex items-center gap-3 text-xs">
                <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => onOpen(e)}>
                  詳情
                </Button>
                {turn && (
                  <Link to="/activity" search={{ tab: "turns", turn }} className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                    回合
                  </Link>
                )}
              </p>
            </li>
          );
        })}
      </ol>
      {steps.length > shown.length && <p className="text-xs text-muted-foreground">另有 {steps.length - shown.length} 筆沒有列出</p>}
    </div>
  );
}

export function ConsciousnessBlock() {
  const [range, setRange] = useAxisRange();
  const ms = AXIS_RANGES.find((r) => r.range === range)?.ms ?? 600_000;
  const win = useFactWindow(ms, AXIS_LIMIT);
  const [selected, setSelected] = useState<string | null>(null);
  const [open, setOpen] = useState<LogEvent | null>(null);
  const causes = useFactChain(selected);
  const effects = useFactEffects(selected);

  const t1 = useMemo(() => (win.dataUpdatedAt > 0 ? win.dataUpdatedAt : Date.now()), [win.dataUpdatedAt]);
  const t0 = t1 - ms;

  const picked = useMemo(() => {
    if (selected === null) return null;
    const own = causes.data?.events.find((e) => e.id === selected) ?? win.data?.find((e) => e.id === selected);
    if (!own || !causes.data || effects.isPending) return null;
    return chainOf(own, causes.data.events, effects.data ?? []);
  }, [selected, causes.data, effects.data, effects.isPending, win.data]);

  const chain = useMemo(() => new Set(picked?.map((e) => e.id) ?? []), [picked]);
  const model = useMemo(() => buildAxis([...(win.data ?? []), ...(picked ?? [])], t0, t1, chain), [win.data, picked, t0, t1, chain]);

  const missing = win.isError && isApiError(win.error) && (win.error.kind === "not_found" || win.error.kind === "not_provided");
  const truncated = (win.data?.length ?? 0) >= AXIS_LIMIT;

  let plot: React.ReactNode;
  if (win.isPending) plot = <Skeleton className="w-full" style={{ height: HEIGHT }} />;
  else if (missing) plot = <ChartEmpty height={HEIGHT}>這個 Core 還沒有事件紀錄</ChartEmpty>;
  else if (win.isError && !win.data) plot = <ErrorLine error={win.error} onRetry={() => void win.refetch()} />;
  else if (model.nodes.length === 0) {
    plot = (
      <ChartEmpty height={HEIGHT}>
        {model.hidden > 0 ? `這段時間沒有對話或動作,只有 ${model.hidden} 筆背景觀察` : "這段時間沒有事件"}
      </ChartEmpty>
    );
  } else {
    plot = (
      <div className="rounded-md bg-well px-3 py-2">
        <ConsciousnessAxis model={model} t0={t0} t1={t1} chain={chain} selected={selected} onSelect={setSelected} />
      </div>
    );
  }

  return (
    <Card aria-label="意識軸" className="gap-3">
      <CardHeader>
        <CardTitle>意識軸</CardTitle>
        <CardAction>
          <Segmented
            label="意識軸時間範圍"
            value={range}
            onChange={setRange}
            options={AXIS_RANGES.map((r) => ({ value: r.range, label: r.label }))}
          />
        </CardAction>
      </CardHeader>
      {plot}
      {win.isError && win.data && !missing && <ErrorLine error={win.error} onRetry={() => void win.refetch()} />}
      {model.nodes.length > 0 && (model.hidden > 0 || truncated) && (
        <p className="text-xs text-muted-foreground">
          {[model.hidden > 0 ? `${model.hidden} 筆背景觀察沒有畫出` : null, truncated ? `只讀了最新的 ${AXIS_LIMIT} 筆` : null].filter(Boolean).join(" · ")}
        </p>
      )}
      {selected !== null &&
        (causes.isError ? (
          <ErrorLine error={causes.error} onRetry={() => void causes.refetch()} />
        ) : effects.isError ? (
          <ErrorLine error={effects.error} onRetry={() => void effects.refetch()} />
        ) : picked === null ? (
          <SkeletonRows count={2} />
        ) : (
          <div className="grid gap-2">
            <ChainSteps steps={picked} selected={selected} onOpen={setOpen} />
            {causes.data && !causes.data.complete && <p className="text-xs text-muted-foreground">更早的起因已經不在紀錄裡</p>}
          </div>
        ))}
      <LogEventSheet event={open} onClose={() => setOpen(null)} />
    </Card>
  );
}
