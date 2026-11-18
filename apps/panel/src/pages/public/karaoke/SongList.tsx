// Picking a song: the ready songs with a search, the member's own that are being prepared or
// failed, and the rail (ask for a new one, the device's latency, what they sang lately).

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Mic, MicVocal, PencilLine, RotateCcw, Search, Timer } from "lucide-react";
import { type FormEvent, useEffect, useId, useMemo, useState } from "react";
import type { KaraokeOverview, KaraokeResultSummary, KaraokeSongView } from "@miyoria/contracts/api";
import { describeError } from "@/api/http";
import { useApi } from "@/app/connection";
import { EmptyLine } from "@/components/query-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { fmtRelative } from "@/lib/format";
import { notify } from "@/lib/notify";
import { Bar, Fact, Refusal } from "./bits";
import { OVERVIEW, usePreparing } from "./queries";
import { clock, score1 } from "./result-text";
import { stageWord } from "./stages";

/** What each song was asked for with, this visit: a retry posts it again. */
const asked = new Map<string, string>();

/** The words to ask for a failed song again. */
export function retryText(song: KaraokeSongView): string {
  return asked.get(song.id) ?? [song.title, song.artist].filter(Boolean).join(" ");
}

/** Ready songs matching `query` in their title or artist, newest first as the Core sent them. */
export function filterSongs(songs: readonly KaraokeSongView[], query: string): KaraokeSongView[] {
  const q = query.trim().toLocaleLowerCase();
  const ready = songs.filter((s) => s.state === "ready");
  if (q === "") return ready;
  return ready.filter((s) => `${s.title} ${s.artist ?? ""}`.toLocaleLowerCase().includes(q));
}

function useAsk() {
  const api = useApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (text: string) => api.rpc.karaoke.request({ body: { text } }),
    onSuccess: (r, text) => {
      asked.set(r.song.id, text);
      if (r.created) notify.ok("開始準備了");
      else if (r.song.state === "ready") notify.info("這首已經準備好了");
      void client.invalidateQueries({ queryKey: OVERVIEW });
    },
  });
}

function SongMeta({ song }: { song: KaraokeSongView }) {
  return (
    <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground tabular-nums">
      <span className="font-mono">{clock(song.duration_s)}</span>
      <span>{song.lyrics ? (song.lyrics_source === "heard" ? "聽寫的歌詞" : "有歌詞") : "只有旋律"}</span>
      {song.best !== null && (
        <span>
          最好 <span className="font-medium text-foreground">{score1(song.best)}</span>
        </span>
      )}
      {song.sung > 0 && <span>唱過 {song.sung} 次</span>}
    </p>
  );
}

function ReadyRow({
  song,
  onSing,
  onEdit,
  disabled,
}: {
  song: KaraokeSongView;
  onSing: () => void;
  /** A panel admin's way into the reference editor (members never get it). */
  onEdit?: () => void;
  disabled: boolean;
}) {
  return (
    <li className="flex items-center gap-3 py-(--row-y)">
      <div className="grid min-w-0 flex-1 gap-0.5">
        <p className="truncate text-sm">
          <span className="font-medium">{song.title}</span>
          {song.artist && <span className="ml-1.5 text-muted-foreground">{song.artist}</span>}
        </p>
        <SongMeta song={song} />
      </div>
      {onEdit && (
        <Button variant="ghost" size="sm" onClick={onEdit} disabled={disabled} aria-label={`改 ${song.title} 的歌詞和音符`}>
          <PencilLine aria-hidden />改
        </Button>
      )}
      <Button
        variant="outline"
        size="sm"
        onClick={onSing}
        disabled={disabled}
        aria-label={`唱 ${song.title}`}
      >
        <MicVocal aria-hidden />唱
      </Button>
    </li>
  );
}

/** A song of theirs being prepared: its stage, how far, its place in the queue. */
function PreparingRow({ song }: { song: KaraokeSongView }) {
  const client = useQueryClient();
  const live = usePreparing(song);
  const now = live.data ?? song;
  useEffect(() => {
    if (now.state !== "preparing") void client.invalidateQueries({ queryKey: OVERVIEW });
  }, [now.state, client]);
  const ask = useAsk();
  if (now.state === "failed") {
    return (
      <li className="grid gap-1.5 py-(--row-y)">
        <div className="flex items-center gap-3">
          <p className="min-w-0 flex-1 truncate text-sm font-medium">{now.title}</p>
          <Button
            variant="outline"
            size="sm"
            busy={ask.isPending}
            onClick={() => ask.mutate(retryText(now))}
          >
            <RotateCcw aria-hidden />
            再試一次
          </Button>
        </div>
        <Refusal>{now.error ?? "這首沒有準備成功"}</Refusal>
        {ask.isError && <Refusal>{describeError(ask.error)}</Refusal>}
      </li>
    );
  }
  if (now.state !== "preparing") return null;
  return (
    <li className="grid gap-1.5 py-(--row-y)">
      <div className="flex items-baseline gap-3">
        <p className="min-w-0 flex-1 truncate text-sm font-medium">{now.title || "還不知道歌名"}</p>
        <span className="shrink-0 text-xs text-muted-foreground">
          {stageWord(now.stage)}
          {now.position !== null && now.position > 0 && ` · 前面還有 ${now.position} 首`}
        </span>
        <span className="w-10 shrink-0 text-right font-mono text-xs text-muted-foreground">
          {Math.round(now.progress * 100)}%
        </span>
      </div>
      <Bar value={now.progress} label={`${now.title} 準備進度`} />
    </li>
  );
}

/** The ready songs, with a search box. */
export function SongList({
  overview,
  onSing,
  onEdit,
  busy,
}: {
  overview: KaraokeOverview;
  onSing: (song: KaraokeSongView) => void;
  /** Panel admins: open a song's reference editor. */
  onEdit?: (song: KaraokeSongView) => void;
  /** A song is being opened: the other buttons wait. */
  busy: boolean;
}) {
  const [query, setQuery] = useState("");
  const searchId = useId();
  const ready = useMemo(() => filterSongs(overview.songs, query), [overview.songs, query]);
  const mine = overview.songs.filter((s) => s.mine && s.state !== "ready");
  const anyReady = overview.songs.some((s) => s.state === "ready");
  return (
    <>
      {mine.length > 0 && (
        <Card aria-label="準備中的歌">
          <CardHeader>
            <CardTitle>準備中的歌</CardTitle>
          </CardHeader>
          <ul className="divide-y divide-line-soft">
            {mine.map((s) => (
              <PreparingRow key={s.id} song={s} />
            ))}
          </ul>
        </Card>
      )}
      <Card aria-label="可以唱的歌">
        <CardHeader>
          <CardTitle>可以唱的歌</CardTitle>
          {anyReady && (
            <CardAction className="w-full sm:w-64">
              <label htmlFor={searchId} className="sr-only">
                找歌名或歌手
              </label>
              <div className="relative w-full">
                <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id={searchId}
                  type="search"
                  placeholder="找歌名或歌手"
                  className="pl-8"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
            </CardAction>
          )}
        </CardHeader>
        {!anyReady ? (
          <EmptyLine>還沒有準備好的歌</EmptyLine>
        ) : ready.length === 0 ? (
          <EmptyLine>沒有符合的歌</EmptyLine>
        ) : (
          <ul className="divide-y divide-line-soft">
            {ready.map((s) => (
              <ReadyRow key={s.id} song={s} onSing={() => onSing(s)} onEdit={onEdit && (() => onEdit(s))} disabled={busy} />
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

/** The rail's 點歌: a link or a song's name, and the day's limit. */
export function AskForSong({ overview }: { overview: KaraokeOverview }) {
  const [text, setText] = useState("");
  const id = useId();
  const ask = useAsk();
  // Not disabled at the limit: a song already known costs nothing, and the Core says when it will not.
  const { used, daily, max_minutes: minutes } = overview.limits;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (t === "") return;
    ask.mutate(t, { onSuccess: () => setText("") });
  };
  return (
    <Card aria-label="點歌">
      <CardHeader>
        <CardTitle>點歌</CardTitle>
      </CardHeader>
      {overview.preparing ? (
        <form className="grid gap-2" onSubmit={submit}>
          <label htmlFor={id} className="sr-only">
            貼連結或打歌名
          </label>
          <Input
            id={id}
            placeholder="貼連結或打歌名"
            maxLength={500}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <Button type="submit" busy={ask.isPending} disabled={text.trim() === ""}>
            準備這首
          </Button>
          <p className="text-xs text-muted-foreground tabular-nums">
            今天 {used} / {daily} 首 · 一首最長 {minutes} 分鐘
          </p>
          {ask.isError && <Refusal>{describeError(ask.error)}</Refusal>}
        </form>
      ) : (
        <p className="text-[13px] text-muted-foreground">現在沒辦法準備新的歌,準備好的歌還是可以唱</p>
      )}
    </Card>
  );
}

/** The rail's 延遲: what this device has, and the way to measure it. */
export function LatencyBlock({
  latency,
  onCalibrate,
}: {
  latency: { latency_ms: number; calibrated: boolean } | null;
  onCalibrate: () => void;
}) {
  return (
    <Card aria-label="延遲">
      <CardHeader>
        <CardTitle>延遲</CardTitle>
      </CardHeader>
      <dl className="flex flex-wrap gap-x-8 gap-y-3">
        <Fact label="這台裝置">{latency ? `${latency.latency_ms} ms` : "—"}</Fact>
        <Fact label="狀態">{latency?.calibrated ? "校正過" : "還沒校正"}</Fact>
      </dl>
      <Button variant="outline" onClick={onCalibrate}>
        <Timer aria-hidden />
        校正延遲
      </Button>
    </Card>
  );
}

/** The rail's 最近唱的: their own results, newest first. */
export function RecentResults({
  recent,
  onOpen,
}: {
  recent: readonly KaraokeResultSummary[];
  onOpen: (r: KaraokeResultSummary) => void;
}) {
  return (
    <Card aria-label="最近唱的">
      <CardHeader>
        <CardTitle>最近唱的</CardTitle>
      </CardHeader>
      {recent.length === 0 ? (
        <EmptyLine>還沒有唱過</EmptyLine>
      ) : (
        <ul className="divide-y divide-line-soft">
          {recent.map((r) => (
            <li key={r.session}>
              <button
                type="button"
                onClick={() => onOpen(r)}
                className="flex w-full items-center gap-2.5 py-(--row-y) text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Mic aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm">{r.title}</span>
                {r.unranked && <Badge>沒有驗證</Badge>}
                <span className="shrink-0 font-mono text-xs tabular-nums">{score1(r.total)}</span>
                <span className="w-16 shrink-0 text-right text-xs text-muted-foreground">{fmtRelative(r.at)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
