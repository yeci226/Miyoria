import { Eraser, Pause, Play } from "lucide-react";
import { memo, useMemo, useState } from "react";
import type { Envelope } from "@/api/types";
import { useEventStore, useEvents } from "@/app/events-store";
import { Toolbar } from "@/components/page";
import { EmptyLine } from "@/components/query-state";
import { Dot, type Tone } from "@/components/status";
import { Facts, JsonView } from "@/components/json-view";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { matchesAny, parseTopics, summarize, type Tone as EventTone, topicGroup, topicOf } from "@/lib/events";
import { fmtDateTime, fmtInt, fmtTime } from "@/lib/format";
import { cn } from "@/lib/utils";

const PRESETS = ["platform.*", "agent.*", "voice.*", "action.*", "system.*", "llm.*"];

const GROUP_TONE: Record<string, Tone> = { agent: "brand", voice: "success", system: "warning", llm: "warning" };

export const TEXT_TONE: Record<EventTone, string> = {
  neutral: "text-foreground/90",
  accent: "text-primary",
  ok: "text-foreground",
  warn: "text-primary",
  danger: "text-primary",
};

const EventRow = memo(function EventRow({ env, onSelect }: { env: Envelope; onSelect: (env: Envelope) => void }) {
  const topic = topicOf(env.event);
  const { text, tone } = summarize(env);
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(env)}
        className="grid w-full grid-cols-[4.5rem_minmax(0,11rem)_minmax(0,1fr)] items-baseline gap-3 py-(--row-y) text-left text-sm outline-none hover:bg-hover focus-visible:bg-hover max-sm:grid-cols-[4rem_minmax(0,1fr)] max-sm:[&>*:last-child]:col-span-2"
      >
        <time dateTime={env.ts} className="font-mono text-xs text-muted-foreground tabular-nums">
          {fmtTime(env.ts)}
        </time>
        <span className="flex min-w-0 items-center gap-2 font-mono text-xs text-muted-foreground">
          <Dot tone={GROUP_TONE[topicGroup(topic)] ?? "neutral"} className="size-1.5 [&>span]:size-1.5" />
          <span className="truncate">{topic}</span>
        </span>
        <span className={cn("min-w-0 truncate", TEXT_TONE[tone])}>{text || <span className="text-muted-foreground">{env.source}</span>}</span>
      </button>
    </li>
  );
});

export function EventSheet({ env, onClose }: { env: Envelope | null; onClose: () => void }) {
  return (
    <Sheet open={env !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent>
        {env && (
          <>
            <SheetHeader>
              <SheetTitle className="font-mono text-sm">{topicOf(env.event)}</SheetTitle>
            </SheetHeader>
            <SheetBody className="grid content-start gap-5">
              {summarize(env).text && <p className="text-sm">{summarize(env).text}</p>}
              <Facts
                items={{
                  "時間": fmtDateTime(env.ts),
                  "來源": <span className="font-mono">{env.source}</span>,
                  "事件": <span className="font-mono text-xs">{env.id}</span>,
                  "回合": <span className="font-mono text-xs">{env.correlation ?? "—"}</span>,
                  "起因": <span className="font-mono text-xs">{env.causation ?? "—"}</span>,
                }}
              />
              <JsonView value={env} label="Envelope" />
            </SheetBody>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

export function EventsTab() {
  const store = useEventStore();
  const { events, status, received } = useEvents();
  const [raw, setRaw] = useState("");
  const [paused, setPaused] = useState<{ events: Envelope[]; received: number } | null>(null);
  const [selected, setSelected] = useState<Envelope | null>(null);

  const topics = useMemo(() => parseTopics(raw), [raw]);
  const source = paused?.events ?? events;
  const visible = useMemo(() => source.filter((e) => matchesAny(topics, topicOf(e.event))), [source, topics]);
  const missed = paused ? received - paused.received : 0;

  const togglePreset = (p: string) => {
    const set = new Set(topics);
    if (set.has(p)) set.delete(p);
    else set.add(p);
    setRaw([...set].join(", "));
  };

  const emptyText =
    events.length === 0
      ? status.state === "closed" && status.error
        ? status.error
        : status.state === "open"
          ? "等待事件"
          : "尚未連線"
      : "沒有符合篩選的事件";

  return (
    <div className="grid gap-4">
      <Toolbar>
        <Input
          className="font-mono text-[13px] sm:w-72"
          placeholder="agent.*, voice.utterance"
          aria-label="主題篩選"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          spellCheck={false}
        />
        <div className="flex flex-wrap gap-1" role="group" aria-label="常用主題">
          {PRESETS.map((p) => {
            const on = topics.includes(p);
            return (
              <Button
                key={p}
                size="sm"
                variant={on ? "secondary" : "ghost"}
                aria-pressed={on}
                className={cn("font-mono text-xs", !on && "text-muted-foreground")}
                onClick={() => togglePreset(p)}
              >
                {p}
              </Button>
            );
          })}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {paused && missed > 0 && <Badge variant="brand">暫停期間 +{fmtInt(missed)}</Badge>}
          <Button
            size="sm"
            variant="outline"
            aria-pressed={paused !== null}
            onClick={() => setPaused(paused ? null : { events, received })}
          >
            {paused ? <Play /> : <Pause />}
            {paused ? "繼續" : "暫停"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              store.clear();
              if (paused) setPaused({ events: [], received });
            }}
          >
            <Eraser />
            清除
          </Button>
        </div>
      </Toolbar>
      <Card>
        {visible.length === 0 ? (
          <EmptyLine>{emptyText}</EmptyLine>
        ) : (
          <ul className="max-h-[calc(100dvh-16rem)] min-h-64 divide-y divide-line-soft overflow-y-auto" aria-label="事件列表">
            {visible.map((env) => (
              <EventRow key={env.id} env={env} onSelect={setSelected} />
            ))}
          </ul>
        )}
      </Card>
      <EventSheet env={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
