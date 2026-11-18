// What the system page's card grid and a module's own page share: the state line, the card's facts,
// its next thing or last error, and its quick actions.

import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import type { ModuleCard, ModuleCategory, ModuleInfo, ModuleStateKind } from "@miyoria/contracts/api";
import { useCardAction } from "@/app/queries";
import { ConfirmDialog } from "@/components/confirm";
import { Dot, STATE_LABEL, STATE_TONE } from "@/components/status";
import { Button } from "@/components/ui/button";
import { moduleIcon } from "@/lib/module-icons";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";

/** The sections of the grid, in the order they are shown. */
export const CATEGORIES: { id: ModuleCategory; label: string }[] = [
  { id: "her", label: "她" },
  { id: "play", label: "玩" },
  { id: "platform", label: "平台" },
  { id: "system", label: "系統" },
];

/** The guards a save may wait for, in words. */
export const GUARD_LABEL: Record<string, string> = { singing: "她唱完", live: "直播結束" };
export const guardWords = (guard: string) => GUARD_LABEL[guard] ?? guard;

const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];

/** `11/23(六)20:00`, in this browser's time. */
export function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAY[d.getDay()]})${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const fmtValue = (v: string | number) => (typeof v === "number" ? v.toLocaleString("zh-TW") : v);

/** The state as a dot and its word. */
export function StateLine({ state, className }: { state: ModuleStateKind; className?: string }) {
  const tone = STATE_TONE[state];
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 text-[13px]", className)}>
      <Dot tone={tone} pulse={state === "starting" || state === "stopping"} />
      <span className={tone === "danger" ? "text-primary" : "text-muted-foreground"}>{STATE_LABEL[state]}</span>
    </span>
  );
}

/** The card's facts: label over value, at 14, never a big number. */
export function Facts({ facts, className }: { facts: ModuleCard["facts"]; className?: string }) {
  if (facts.length === 0) return null;
  return (
    <dl className={cn("grid grid-cols-2 gap-x-4 gap-y-2.5", className)}>
      {facts.map((f) => (
        <div key={f.label} className="min-w-0">
          <dt className="truncate text-xs text-muted-foreground">{f.label}</dt>
          <dd className="truncate text-sm tabular-nums" title={`${f.value}${f.unit ? ` ${f.unit}` : ""}`}>
            {fmtValue(f.value)}
            {f.unit && <span className="ml-1 text-xs text-muted-foreground">{f.unit}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * One line under the facts: what waits, else what went wrong (the card's last error, else why the
 * supervisor says it is not running), else the next scheduled thing.
 */
export function NoteLine({ module: m, className }: { module: ModuleInfo; className?: string }) {
  const card = m.card ?? null;
  let text: string | null = null;
  let alert = false;
  if (m.pending) text = `已存,${guardWords(m.pending)}後重新啟動套用`;
  else if (card?.last_error) {
    text = `${fmtWhen(card.last_error.at)} ${card.last_error.message}`;
    alert = true;
  } else if (m.reason && m.state !== "running") {
    text = m.reason;
    alert = m.state === "failed";
  } else if (card?.next) text = `${card.next.label} · ${fmtWhen(card.next.at)}`;
  if (text === null) return null;
  return (
    <p
      role={alert ? "alert" : undefined}
      className={cn("line-clamp-2 text-[13px]", alert ? "text-primary" : "text-muted-foreground", className)}
      title={text}
    >
      {text}
    </p>
  );
}

/** A card's quick actions, each behind its confirm when it has one. */
export function CardActions({ id, actions }: { id: string; actions: NonNullable<ModuleCard["actions"]> }) {
  const run = useCardAction();
  const [asking, setAsking] = useState<(typeof actions)[number] | null>(null);
  const go = (a: (typeof actions)[number]) =>
    run.mutate(
      { id, action: a.id },
      {
        onSuccess: (r) => {
          notify.ok(r.text || a.label);
          setAsking(null);
        },
        onError: (e) => notify.error(e, `${a.label}失敗`),
      },
    );
  return (
    <>
      {actions.map((a) => (
        <Button
          key={a.id}
          size="sm"
          variant="outline"
          writes
          busy={run.isPending && run.variables?.action === a.id && asking === null}
          onClick={() => (a.confirm ? setAsking(a) : go(a))}
        >
          {a.label}
        </Button>
      ))}
      <ConfirmDialog
        open={asking !== null}
        title={asking?.confirm ?? ""}
        confirmLabel={asking?.label ?? ""}
        busy={run.isPending}
        onClose={() => setAsking(null)}
        onConfirm={() => asking && go(asking)}
      />
    </>
  );
}

/** The module's icon in a small neutral square. */
export function ModuleIcon({ name, className }: { name: string | null | undefined; className?: string }) {
  const Icon = moduleIcon(name);
  return (
    <span aria-hidden className={cn("grid size-7 shrink-0 place-items-center rounded-md bg-control text-foreground/90", className)}>
      <Icon className="size-4" />
    </span>
  );
}

/**
 * One subsystem on the grid: a card on the panel's glass (the owner's one exception to "no boxed
 * cards", 2026-11-17), with no blur of its own, since a nested backdrop filter would only see the
 * sheet. Off modules dim and keep only 啟用.
 */
export function ModuleTile({
  module: m,
  canToggle,
  onEnable,
}: {
  module: ModuleInfo;
  canToggle: boolean;
  onEnable: () => void;
}) {
  const card = m.card ?? null;
  const off = !m.enabled;
  return (
    <article
      aria-label={m.name}
      className={cn(
        "glass-well flex min-w-0 flex-col gap-3 rounded-[10px] border border-border p-4 transition-colors",
        "hover:border-line-strong focus-within:border-line-strong",
      )}
    >
      <header className="flex min-w-0 items-center gap-2.5">
        <ModuleIcon name={m.icon} className={off ? "opacity-55" : undefined} />
        <div className="grid min-w-0 flex-1">
          <Link
            to="/system/$id"
            params={{ id: m.id }}
            className={cn(
              "truncate text-[15px] font-semibold tracking-[-0.01em] outline-none hover:underline focus-visible:underline",
              off && "text-muted-foreground",
            )}
          >
            {m.name}
          </Link>
          <span className="truncate font-mono text-[11px] text-muted-foreground">{m.id}</span>
        </div>
        <StateLine state={m.state} />
      </header>
      {!off && card && card.facts.length > 0 && <Facts facts={card.facts} />}
      <NoteLine module={m} />
      <footer className="mt-auto flex flex-wrap items-center gap-2 pt-1">
        <Link
          to="/system/$id"
          params={{ id: m.id }}
          className="inline-flex items-center gap-0.5 rounded-sm text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
        >
          {m.settings ? "設定" : "詳情"}
          <ChevronRight className="size-3.5" />
        </Link>
        <span className="flex-1" />
        {off
          ? canToggle && (
              <Button size="sm" variant="outline" writes onClick={onEnable}>
                啟用
              </Button>
            )
          : card?.actions && card.actions.length > 0 && <CardActions id={m.id} actions={card.actions} />}
      </footer>
    </article>
  );
}
