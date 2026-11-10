import { ListX, Music, Play, Plus, SkipForward } from "lucide-react";
import { useId, useState } from "react";
import type { SongView } from "@/api/types";
import { useSongMutations, useSongs } from "@/app/queries";
import { READ_ONLY_HINT, useCanWrite } from "@/app/session";
import { ConfirmDialog } from "@/components/confirm";
import { QueryView, SkeletonRows } from "@/components/query-state";
import { Dot, StatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fmtDateTime, fmtRelative } from "@/lib/format";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";

const STAGE: Record<string, string> = {
  queued: "排隊中",
  waiting: "等 GPU",
  download: "下載中",
  separate: "分離人聲",
  convert: "轉成她的聲音",
  mix: "混音",
  lyrics: "對歌詞",
};

const KEYS = [-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6];
const keyLabel = (k: number) => (k === 0 ? "原調" : k > 0 ? `升 ${k}` : `降 ${-k}`);
const duration = (s: number | null) => (s === null ? null : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`);

function Title({ s }: { s: SongView }) {
  return (
    <div className="min-w-0 flex-1">
      <p className="truncate text-sm font-medium" title={s.query}>
        {s.title ?? s.query}
        {s.artist && <span className="ml-1.5 font-normal text-muted-foreground">{s.artist}</span>}
      </p>
      <p className="truncate text-xs text-muted-foreground">
        #{s.no} · {s.requester_name}
        {s.key !== 0 && ` · ${keyLabel(s.key)}`}
        {duration(s.duration_s) && ` · ${duration(s.duration_s)}`}
      </p>
    </div>
  );
}

function SongRow({ s, playing }: { s: SongView; playing: boolean }) {
  const { play } = useSongMutations();
  return (
    <li className={cn("flex items-center gap-3 py-(--row-y)", playing && "font-medium")}>
      <span className="flex size-4 shrink-0 items-center justify-center">
        {playing ? <Dot tone="brand" pulse /> : s.state === "ready" ? <Dot tone="success" /> : s.state === "failed" ? <Dot tone="danger" /> : <Dot />}
      </span>
      <Title s={s} />
      {s.state === "preparing" && (
        <div className="grid w-28 shrink-0 gap-1 sm:w-36" title={`${Math.round(s.progress * 100)}%`}>
          <span className="flex justify-between text-xs text-muted-foreground">
            {STAGE[s.stage] ?? s.stage ?? "準備中"}
            <span className="tabular-nums">{Math.round(s.progress * 100)}%</span>
          </span>
          <span
            role="progressbar"
            aria-label={`#${s.no} 準備進度`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(s.progress * 100)}
            className="h-1 overflow-hidden rounded-[2px] bg-muted"
          >
            <span className="block h-full rounded-[2px] bg-secondary-line transition-[width] duration-500" style={{ width: `${Math.max(3, s.progress * 100)}%` }} />
          </span>
        </div>
      )}
      {s.state === "ready" && (
        <Button
          writes
          size="sm"
          variant="outline"
          busy={play.isPending && play.variables === s.no}
          disabled={play.isPending}
          onClick={() => play.mutate(s.no, { onSuccess: () => notify.ok(`她準備開始唱 #${s.no}`), onError: (e) => notify.error(e, "開唱失敗") })}
        >
          <Play />
          唱這首
        </Button>
      )}
      {playing && <StatusBadge tone="brand">唱歌中</StatusBadge>}
      {s.state === "failed" && (
        <span className="max-w-40 truncate text-xs text-primary" title={s.error ?? undefined}>
          {s.error ?? "失敗"}
        </span>
      )}
    </li>
  );
}

function RequestForm() {
  const { request } = useSongMutations();
  const canWrite = useCanWrite();
  const id = useId();
  const [query, setQuery] = useState("");
  const [key, setKey] = useState("0");
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    request.mutate(
      { query: q, key: Number(key) || undefined },
      {
        onSuccess: () => {
          notify.ok(`已點歌:${q}`);
          setQuery("");
          setKey("0");
        },
        onError: (err) => notify.error(err, "點歌失敗"),
      },
    );
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2 pb-2">
      <label htmlFor={`${id}-q`} className="sr-only">
        歌名
      </label>
      <Input
        id={`${id}-q`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        maxLength={300}
        disabled={!canWrite}
        title={canWrite ? undefined : READ_ONLY_HINT}
        placeholder="歌名、歌手或 YouTube / bilibili 連結"
        className="h-8 min-w-0 flex-1 basis-48"
      />
      <Select value={key} onValueChange={setKey} disabled={!canWrite}>
        <SelectTrigger size="sm" className="w-24" aria-label="升降 Key">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {KEYS.map((k) => (
            <SelectItem key={k} value={String(k)}>
              {keyLabel(k)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button writes type="submit" size="sm" variant="secondary" busy={request.isPending} disabled={!query.trim()}>
        <Plus />
        點歌
      </Button>
    </form>
  );
}

/** Her set list: request, sing, stop; songs being prepared show the worker's progress. */
export function SongsCard() {
  const songs = useSongs();
  const { stop } = useSongMutations();
  const [confirmAll, setConfirmAll] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const data = songs.data;
  const open = data?.songs.filter((s) => s.state === "playing" || s.state === "ready" || s.state === "preparing" || s.state === "failed") ?? [];
  const order = { playing: 0, ready: 1, preparing: 2, failed: 3 } as Record<string, number>;
  open.sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9) || a.no - b.no);
  const finished = data?.songs.filter((s) => s.state === "done" || s.state === "cancelled").reverse() ?? [];
  const waiting = open.filter((s) => s.state !== "failed" && s.state !== "playing").length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          歌單
          {waiting > 0 && <span className="font-normal text-muted-foreground tabular-nums">{waiting}</span>}
        </CardTitle>
        {data && (
          <CardAction>
            {data.paused && <StatusBadge tone="warning">GPU 忙碌,她暫時不說話</StatusBadge>}
            <Button
              writes
              size="sm"
              variant="outline"
              disabled={data.playing === null || stop.isPending}
              busy={stop.isPending && stop.variables === false}
              onClick={() => stop.mutate(false, { onSuccess: () => notify.ok("已停止這首"), onError: (e) => notify.error(e, "停止失敗") })}
            >
              <SkipForward />
              停止這首
            </Button>
            <Button
              writes
              size="icon-sm"
              variant="ghost"
              aria-label="取消全部"
              title="停止並取消歌單上全部的歌"
              disabled={waiting === 0 && data.playing === null}
              onClick={() => setConfirmAll(true)}
            >
              <ListX />
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <QueryView query={songs} skeleton={<SkeletonRows count={3} />}>
        {() => (
          <>
            <RequestForm />
            {open.length === 0 ? (
              <p className="flex items-center gap-2 py-3 text-[13px] text-muted-foreground">
                <Music className="size-4" aria-hidden />
                歌單是空的
              </p>
            ) : (
              <ul className="divide-y divide-line-soft" aria-label="歌單">
                {open.map((s) => (
                  <SongRow key={s.no} s={s} playing={s.no === data?.playing} />
                ))}
              </ul>
            )}
            {finished.length > 0 && (
              <div className="border-t">
                <button
                  type="button"
                  aria-expanded={showDone}
                  onClick={() => setShowDone((v) => !v)}
                  className="w-full py-(--row-y) text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  {showDone ? "收起" : `唱過 / 取消的 ${finished.length} 首`}
                </button>
                {showDone && (
                  <ul className="divide-y divide-line-soft border-t text-muted-foreground" aria-label="唱過的歌">
                    {finished.map((s) => (
                      <li key={s.no} className="flex items-center gap-3 py-(--row-y) text-sm">
                        <span className="min-w-0 flex-1 truncate">{s.title ?? s.query}</span>
                        <span className="text-xs">{s.state === "cancelled" ? "取消" : "唱完"}</span>
                        <time className="text-xs" dateTime={s.created_at} title={fmtDateTime(s.created_at)}>
                          {fmtRelative(s.created_at)}
                        </time>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
      </QueryView>
      <ConfirmDialog
        open={confirmAll}
        title="取消全部的歌?"
        confirmLabel="全部取消"
        busy={stop.isPending}
        onClose={() => setConfirmAll(false)}
        onConfirm={() =>
          stop.mutate(true, {
            onSuccess: () => {
              notify.ok("已停止並清空歌單");
              setConfirmAll(false);
            },
            onError: (e) => notify.error(e),
          })
        }
      >
        正在唱的會停下來,準備中和準備好的歌都會取消。
      </ConfirmDialog>
    </Card>
  );
}
