// A room's song queue (docs/design/karaoke.md 「第四步之後的修改:先開房再點歌」): a room opens with
// no song and everyone in it queues songs, in the lobby and after a round. Each entry shows its
// song, who added it, its key and its preparation (a song still being prepared keeps its place, a
// failed one is skipped), and which one the next round plays. Anyone takes their own out; the
// opener (or a panel admin) also orders the queue and takes any out. A song is added from the
// ready list (a search, a key of its own) or by a link or words, which go through Core's song
// request and its daily limit. Every refusal is Core's own sentence.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, ListPlus, Minus, Plus, Search, X } from "lucide-react";
import { type FormEvent, useId, useMemo, useState } from "react";
import type { KaraokeOverview, KaraokeRoomQueueAdd, KaraokeRoomView, KaraokeSongView } from "@miyoria/contracts/api";
import { KARAOKE_MAX_SHIFT } from "@miyoria/contracts/workers/karaoke";
import { describeError } from "@/api/http";
import { useApi } from "@/app/connection";
import { EmptyLine } from "@/components/query-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { cn } from "@/lib/utils";
import { Bar, Refusal } from "./bits";
import { keyLabel } from "./lyric-text";
import { OVERVIEW } from "./queries";
import { clock } from "./result-text";
import { canQueue, entryState, queueBlocked, queueCounts } from "./room-text";
import { filterSongs } from "./SongList";
import { stageWord } from "./stages";

type Entry = KaraokeRoomView["queue"][number];

/** The ready songs to pick one from, with a search; the picked one is marked. */
export function SongPicker({
  songs,
  value,
  onChange,
}: {
  songs: readonly KaraokeSongView[];
  value: string | null;
  onChange: (song: KaraokeSongView) => void;
}) {
  const [query, setQuery] = useState("");
  const id = useId();
  const ready = useMemo(() => filterSongs(songs, query), [songs, query]);
  const any = songs.some((s) => s.state === "ready");
  if (!any) return <EmptyLine>還沒有準備好的歌</EmptyLine>;
  return (
    <div className="grid min-w-0 gap-2">
      <label htmlFor={id} className="sr-only">
        找歌名或歌手
      </label>
      <div className="relative">
        <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input id={id} type="search" placeholder="找歌名或歌手" className="pl-8" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div role="radiogroup" aria-label="歌" className="max-h-56 divide-y divide-line-soft overflow-y-auto rounded-md border border-border">
        {ready.length === 0 ? (
          <p className="px-3 py-2 text-[13px] text-muted-foreground">沒有符合的歌</p>
        ) : (
          ready.map((s) => {
            const on = s.id === value;
            return (
              <button
                key={s.id}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => onChange(s)}
                className={cn(
                  "flex w-full min-w-0 items-center gap-2.5 px-3 py-2 text-left outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                  on && "bg-control",
                )}
              >
                <span aria-hidden className={cn("size-2 shrink-0 rounded-full border", on ? "border-primary bg-primary" : "border-line-strong")} />
                <span className="min-w-0 flex-1 truncate text-sm">
                  {s.title}
                  {s.artist && <span className="text-muted-foreground"> · {s.artist}</span>}
                </span>
                <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">{clock(s.duration_s)}</span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

/** − key + for a queued song (its backing is made in that key for everyone). */
export function KeyStepper({ shift, onChange }: { shift: number; onChange: (shift: number) => void }) {
  return (
    <div role="group" aria-label="升降調" className="flex items-center gap-1">
      <Button variant="ghost" size="icon-sm" aria-label="降半音" disabled={shift <= -KARAOKE_MAX_SHIFT} onClick={() => onChange(shift - 1)}>
        <Minus aria-hidden />
      </Button>
      <span aria-live="polite" className="w-10 text-center font-mono text-[13px] tabular-nums">
        {keyLabel(shift)}
      </span>
      <Button variant="ghost" size="icon-sm" aria-label="升半音" disabled={shift >= KARAOKE_MAX_SHIFT} onClick={() => onChange(shift + 1)}>
        <Plus aria-hidden />
      </Button>
    </div>
  );
}

/** A song's name for buttons and lines (a song being prepared may not have one yet). */
const titleOf = (e: Entry) => e.song.title || "還不知道歌名";

function QueueRow({
  entry,
  place,
  last,
  next,
  canOrder,
  busy,
  onMove,
  onRemove,
}: {
  entry: Entry;
  place: number;
  last: boolean;
  next: boolean;
  /** The opener or a panel admin: up / down, and remove anyone's. */
  canOrder: boolean;
  busy: boolean;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  const s = entry.song;
  const state = entryState(s, stageWord);
  const title = titleOf(entry);
  return (
    <li className="grid gap-1.5 py-(--row-y)" data-entry={entry.id} data-state={s.state}>
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="w-5 shrink-0 text-right font-mono text-xs text-muted-foreground tabular-nums">{place + 1}</span>
        <div className="grid min-w-0 flex-1 gap-0.5">
          <p className={cn("truncate text-sm", state?.failed && "text-muted-foreground")}>
            <span className="font-medium">{title}</span>
            {s.artist && <span className="ml-1.5 text-muted-foreground">{s.artist}</span>}
          </p>
          <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <span className="max-w-full truncate">
              {entry.by.name}
              {entry.mine && "(你)"}
            </span>
            <span className="font-mono tabular-nums">{keyLabel(entry.shift)}</span>
            {s.duration_s !== null && <span className="font-mono tabular-nums">{clock(s.duration_s)}</span>}
            {state && <span className={cn(state.failed && "text-primary")}>{state.word}</span>}
          </p>
        </div>
        {next && <Badge variant="brand">下一首</Badge>}
        <div className="flex shrink-0 items-center">
          {canOrder && (
            <>
              <Button variant="ghost" size="icon-sm" aria-label={`往前移 ${title}`} disabled={busy || place === 0} onClick={() => onMove(place - 1)}>
                <ChevronUp aria-hidden />
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label={`往後移 ${title}`} disabled={busy || last} onClick={() => onMove(place + 1)}>
                <ChevronDown aria-hidden />
              </Button>
            </>
          )}
          {(canOrder || entry.mine) && (
            <Button variant="ghost" size="icon-sm" aria-label={`拿掉 ${title}`} disabled={busy} onClick={onRemove}>
              <X aria-hidden />
            </Button>
          )}
        </div>
      </div>
      {state && !state.failed && state.progress !== null && (
        <div className="pl-[1.875rem]">
          <Bar value={state.progress} label={`${title} 準備進度`} />
        </div>
      )}
    </li>
  );
}

type From = "list" | "link";

/** Adding a song: from the ready list or by a link or words, in a key of its own. */
function AddSong({
  room,
  overview,
  onRoom,
}: {
  room: KaraokeRoomView;
  overview: KaraokeOverview;
  onRoom: (room: KaraokeRoomView) => void;
}) {
  const api = useApi();
  const client = useQueryClient();
  const id = useId();
  const [from, setFrom] = useState<From>("list");
  const [song, setSong] = useState<KaraokeSongView | null>(null);
  const [text, setText] = useState("");
  const [shift, setShift] = useState(0);
  const add = useMutation({
    mutationFn: (body: KaraokeRoomQueueAdd) => api.rpc.karaokeRooms.queueAdd({ params: { code: room.code }, body }),
    onSuccess: (r, body) => {
      onRoom(r);
      setSong(null);
      setText("");
      setShift(0);
      // A link or words may have started a new song: the song list shows it.
      if (body.text !== undefined) void client.invalidateQueries({ queryKey: OVERVIEW });
    },
  });
  const blocked = queueBlocked(room);
  const linkOpen = overview.preparing;
  const body: KaraokeRoomQueueAdd | null =
    from === "list" ? (song === null ? null : { song: song.id, shift }) : text.trim() === "" || !linkOpen ? null : { text: text.trim(), shift };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (body !== null && blocked === null && !add.isPending) add.mutate(body);
  };
  const { used, daily, max_minutes: minutes } = overview.limits;
  return (
    <form className="grid min-w-0 gap-3 border-t border-line-soft pt-3" aria-label="點一首" onSubmit={submit}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented<From>
          label="從哪裡點"
          value={from}
          onChange={(v) => {
            setFrom(v);
            add.reset();
          }}
          options={[
            { value: "list", label: "歌單" },
            { value: "link", label: "連結或歌名" },
          ]}
        />
        <div className="flex items-center gap-1.5">
          <span className="text-[13px] text-muted-foreground">調</span>
          <KeyStepper shift={shift} onChange={setShift} />
        </div>
      </div>
      {from === "list" ? (
        <SongPicker songs={overview.songs} value={song?.id ?? null} onChange={setSong} />
      ) : linkOpen ? (
        <div className="grid gap-1.5">
          <label htmlFor={id} className="sr-only">
            貼連結或打歌名
          </label>
          <Input id={id} placeholder="貼連結或打歌名" maxLength={500} value={text} onChange={(e) => setText(e.target.value)} />
          <p className="text-xs text-muted-foreground tabular-nums">
            沒準備過的歌會先準備,算進你今天的 {used} / {daily} 首 · 一首最長 {minutes} 分鐘
          </p>
        </div>
      ) : (
        <p className="text-[13px] text-muted-foreground">現在沒辦法準備新的歌,歌單上的歌還是可以點</p>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button type="submit" variant="secondary" busy={add.isPending} disabled={body === null || blocked !== null}>
          <ListPlus aria-hidden />
          點這首
        </Button>
        {blocked !== null && <p className="text-xs text-muted-foreground">{blocked}</p>}
      </div>
      {add.isError && <Refusal>{describeError(add.error)}</Refusal>}
    </form>
  );
}

/** The queue, and adding to it while the room is between rounds. */
export function RoomQueue({
  room,
  overview,
  onRoom,
}: {
  room: KaraokeRoomView;
  overview: KaraokeOverview;
  onRoom: (room: KaraokeRoomView) => void;
}) {
  const api = useApi();
  const canOrder = room.me?.opener === true || overview.admin;
  const { waiting } = queueCounts(room);
  const limits = room.queue_limits;
  const act = useMutation({
    mutationFn: (a: { entry: string; to?: number }) =>
      a.to === undefined
        ? api.rpc.karaokeRooms.queueRemove({ params: { code: room.code, entry: a.entry } })
        : api.rpc.karaokeRooms.queueMove({ params: { code: room.code, entry: a.entry }, body: { to: a.to } }),
    onSuccess: onRoom,
  });
  return (
    <Card aria-label="點歌清單">
      <CardHeader>
        <CardTitle>點歌清單</CardTitle>
        <CardAction>
          <span className="text-xs text-muted-foreground tabular-nums">
            {waiting} / {limits.max} 首 · 每人 {limits.per_person} 首
          </span>
        </CardAction>
      </CardHeader>
      {room.queue.length === 0 ? (
        <EmptyLine>還沒有人點歌</EmptyLine>
      ) : (
        <ol className="divide-y divide-line-soft" aria-label="等著唱的歌">
          {room.queue.map((e, i) => (
            <QueueRow
              key={e.id}
              entry={e}
              place={i}
              last={i === room.queue.length - 1}
              next={e.id === room.next}
              canOrder={canOrder}
              busy={act.isPending}
              onMove={(to) => act.mutate({ entry: e.id, to })}
              onRemove={() => act.mutate({ entry: e.id })}
            />
          ))}
        </ol>
      )}
      {act.isError && <Refusal>{describeError(act.error)}</Refusal>}
      {canQueue(room) && room.me !== null && <AddSong room={room} overview={overview} onRoom={onRoom} />}
    </Card>
  );
}
