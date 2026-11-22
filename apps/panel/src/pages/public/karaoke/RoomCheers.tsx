// Cheers in a room (「卡拉 OK 第二次實測留下的」): someone watching a round picks a singer and cheers
// them with a word (加油、好聽、太強了、安可); it shows on her stream beside that singer's lane, on
// every spectator's screen, and to that singer (to nobody else who sings). Core limits how often:
// after one, the buttons wait the time Core answers with, and say so; a refusal is Core's sentence.

import { useEffect, useState } from "react";
import { describeError } from "@/api/http";
import { useApi } from "@/app/connection";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CHEER_ORDER, CHEER_SHOW_MS, CHEER_WORDS, type CheerEvent } from "./room-text";
import { Swatch } from "./SpectatorStage";

type Target = { member: string; name: string; color: number };

/** Re-renders when `until` (ms since the epoch) is reached; whether it is still ahead. */
function useUntil(until: number): boolean {
  const [, tick] = useState(0);
  const ahead = until > Date.now();
  useEffect(() => {
    if (!ahead) return;
    const t = window.setTimeout(() => tick((n) => n + 1), until - Date.now() + 10);
    return () => window.clearTimeout(t);
  }, [ahead, until]);
  return ahead;
}

/** A spectator's cheering: whom (the round's singers), then a word. */
export function CheerBar({ code, singers }: { code: string; singers: readonly Target[] }) {
  const api = useApi();
  const [to, setTo] = useState<string | null>(null);
  const [until, setUntil] = useState(0);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const waiting = useUntil(until);
  const target = singers.find((s) => s.member === to) ?? singers[0] ?? null;
  if (target === null) return null;
  const send = (kind: CheerEvent["kind"]) => {
    setBusy(true);
    setProblem(null);
    api.rpc.karaokeRooms
      .cheer({ params: { code }, body: { member: target.member, kind } })
      .then(
        (r) => setUntil(Date.now() + r.wait_ms),
        (e: unknown) => setProblem(describeError(e)),
      )
      .finally(() => setBusy(false));
  };
  const why = waiting ? "等一下才能再加油" : undefined;
  return (
    <div role="group" aria-label="幫唱的人加油" className="flex max-w-full flex-wrap items-center justify-center gap-1">
      {singers.length > 1 && (
        <div role="radiogroup" aria-label="幫誰加油" className="flex flex-wrap items-center gap-1">
          {singers.map((s) => (
            <button
              key={s.member}
              type="button"
              role="radio"
              aria-checked={s.member === target.member}
              onClick={() => setTo(s.member)}
              className={cn(
                "flex h-7 max-w-[9rem] items-center gap-1.5 rounded-full px-2.5 text-[13px] transition-colors",
                s.member === target.member ? "bg-control-hover text-foreground" : "text-muted-foreground hover:bg-hover",
              )}
            >
              <Swatch color={s.color} />
              <span className="truncate">{s.name}</span>
            </button>
          ))}
        </div>
      )}
      <div className="flex items-center gap-1" title={why}>
        {CHEER_ORDER.map((kind) => (
          <Button
            key={kind}
            variant="ghost"
            size="sm"
            disabled={waiting || busy}
            aria-label={`幫 ${target.name} 喊${CHEER_WORDS[kind]}`}
            aria-describedby={waiting ? "cheer-wait" : undefined}
            onClick={() => send(kind)}
          >
            {CHEER_WORDS[kind]}
          </Button>
        ))}
      </div>
      {waiting && (
        <span id="cheer-wait" className="sr-only">
          {why}
        </span>
      )}
      {problem && (
        <p role="alert" className="w-full text-center text-xs text-primary">
          {problem}
        </p>
      )}
    </div>
  );
}

/** The latest cheers on a spectator's screen: who cheered whom with what, each for a few seconds. */
export function CheerList({ cheers, singers }: { cheers: readonly (CheerEvent & { at: number })[]; singers: readonly Target[] }) {
  const [, tick] = useState(0);
  const shown = cheers.filter((c) => Date.now() - c.at < CHEER_SHOW_MS);
  const next = shown[0];
  useEffect(() => {
    if (next === undefined) return;
    const t = window.setTimeout(() => tick((n) => n + 1), CHEER_SHOW_MS - (Date.now() - next.at) + 10);
    return () => window.clearTimeout(t);
  }, [next]);
  if (shown.length === 0) return null;
  return (
    <ul aria-label="大家的加油" className="grid justify-items-start gap-1 border-t border-border pt-2">
      {shown.map((c) => {
        const to = singers.find((s) => s.member === c.member);
        return (
          <li
            key={c.id}
            className="flex max-w-full min-w-0 items-center gap-1.5 text-[13px] animate-in fade-in-0 slide-in-from-bottom-1 duration-200 ease-out motion-reduce:animate-none"
          >
            <Swatch color={c.by.color} />
            <span className="max-w-[7rem] truncate text-muted-foreground">{c.by.name}</span>
            {to && (
              <>
                <span className="text-muted-foreground">幫</span>
                <span className="max-w-[7rem] truncate">{to.name}</span>
              </>
            )}
            <span className="shrink-0 font-semibold text-primary">{CHEER_WORDS[c.kind]}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** A singer's stage: the latest cheer for them, for a few seconds (no ranking in it). */
export function CheerNote({ cheers }: { cheers: readonly (CheerEvent & { at: number })[] }) {
  const [, tick] = useState(0);
  const last = cheers.at(-1);
  const shown = last !== undefined && Date.now() - last.at < CHEER_SHOW_MS ? last : null;
  useEffect(() => {
    if (shown === null) return;
    const t = window.setTimeout(() => tick((n) => n + 1), CHEER_SHOW_MS - (Date.now() - shown.at) + 10);
    return () => window.clearTimeout(t);
  }, [shown]);
  if (shown === null) return null;
  return (
    <div
      key={shown.id}
      role="status"
      className="glass-float flex items-center gap-1.5 rounded-full py-1.5 pr-3.5 pl-3 text-[13px] [text-shadow:none] animate-in fade-in-0 slide-in-from-bottom-1 duration-200 ease-out motion-reduce:animate-none"
    >
      <Swatch color={shown.by.color} />
      <span className="max-w-[8rem] truncate text-muted-foreground">{shown.by.name}</span>
      <span>幫你喊</span>
      <span className="font-semibold text-primary">{CHEER_WORDS[shown.kind]}</span>
    </div>
  );
}
