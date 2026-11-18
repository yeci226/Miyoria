// 一起唱 on the song list (docs/design/karaoke.md 「做了什麼第四步」): open a room (pick a ready song
// and a key, see the price and the balance, then pay), join one by its code or link, or go back to
// the one they are in. A Core without rooms shows nothing here.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { DoorOpen, LogIn, Minus, Plus, Search, Users } from "lucide-react";
import { type FormEvent, useId, useMemo, useState } from "react";
import type { KaraokeOverview, KaraokeRooms, KaraokeRoomView, KaraokeSongView } from "@miyoria/contracts/api";
import { KARAOKE_MAX_SHIFT } from "@miyoria/contracts/workers/karaoke";
import { describeError } from "@/api/http";
import { useApi } from "@/app/connection";
import { EmptyLine, ErrorLine, SkeletonRows } from "@/components/query-state";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Fact, Refusal } from "./bits";
import { keyLabel } from "./lyric-text";
import { isOff, ROOMS, useRooms } from "./queries";
import { clock } from "./result-text";
import { canPay, coins, readRoomCode } from "./room-text";
import { filterSongs } from "./SongList";

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

/** − key + for a room's song (the backing is made in that key for everyone). */
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

/** Opening a room: the song and key, then the price against the balance, then pay. */
export function OpenRoomDialog({
  open,
  onClose,
  overview,
  rooms,
  onOpened,
}: {
  open: boolean;
  onClose: () => void;
  overview: KaraokeOverview;
  rooms: KaraokeRooms;
  onOpened: (room: KaraokeRoomView) => void;
}) {
  const api = useApi();
  const client = useQueryClient();
  const [song, setSong] = useState<KaraokeSongView | null>(null);
  const [shift, setShift] = useState(0);
  const { terms, balance } = rooms;
  const affordable = canPay(balance, terms.price);
  const pay = useMutation({
    mutationFn: () => api.rpc.karaokeRooms.open({ body: { song: (song as KaraokeSongView).id, shift } }),
    onSuccess: (room) => {
      void client.invalidateQueries({ queryKey: ROOMS });
      onOpened(room);
    },
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !pay.isPending && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>開一間房</DialogTitle>
          <DialogDescription className="sr-only">選歌和調,確認價錢後開房</DialogDescription>
        </DialogHeader>
        <div className="grid min-w-0 gap-4">
          <SongPicker songs={overview.songs} value={song?.id ?? null} onChange={setSong} />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[13px] text-muted-foreground">調(大家一起)</span>
            <KeyStepper shift={shift} onChange={setShift} />
          </div>
          <dl className="flex flex-wrap gap-x-8 gap-y-3 border-t border-line-soft pt-3" aria-label="價錢">
            <Fact label="開房">{coins(terms.price, terms.currency)}</Fact>
            <Fact label="你有">{balance === null ? "—" : coins(balance, terms.currency)}</Fact>
            {balance !== null && affordable && <Fact label="開房後">{coins(balance - terms.price, terms.currency)}</Fact>}
          </dl>
          <p className="text-xs text-muted-foreground">
            最多 {terms.max_singers} 人一起唱,可以唱 {terms.rounds} 輪。贏的人 {coins(terms.prize, terms.currency)},唱完的人各{" "}
            {coins(terms.finish, terms.currency)}。
          </p>
          {!affordable && <Refusal>{`${terms.currency}不夠,開房要 ${coins(terms.price, terms.currency)}`}</Refusal>}
          {pay.isError && <Refusal>{describeError(pay.error)}</Refusal>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pay.isPending}>
            取消
          </Button>
          <Button onClick={() => pay.mutate()} busy={pay.isPending} disabled={song === null || !affordable}>
            付 {coins(terms.price, terms.currency)}開房
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The block on the song list. */
export function RoomsEntry({ overview, onEnter }: { overview: KaraokeOverview; onEnter: (code: string) => void }) {
  const rooms = useRooms();
  const [opening, setOpening] = useState(false);
  const [text, setText] = useState("");
  const [bad, setBad] = useState(false);
  const id = useId();
  if (rooms.isError && isOff(rooms.error)) return null;

  const join = (e: FormEvent) => {
    e.preventDefault();
    const code = readRoomCode(text);
    setBad(code === null);
    if (code) onEnter(code);
  };

  return (
    <Card aria-label="一起唱">
      <CardHeader>
        <CardTitle>一起唱</CardTitle>
        {rooms.data && !rooms.data.mine && (
          <CardAction>
            <Button size="sm" onClick={() => setOpening(true)} disabled={!rooms.data.available}>
              <DoorOpen aria-hidden />
              開一間房
            </Button>
          </CardAction>
        )}
      </CardHeader>
      {rooms.isPending ? (
        <SkeletonRows count={2} />
      ) : rooms.isError ? (
        <ErrorLine error={rooms.error} onRetry={() => void rooms.refetch()} />
      ) : (
        <div className="grid gap-4">
          {rooms.data.mine ? (
            <div className="flex flex-wrap items-center gap-3">
              <Users aria-hidden className="size-4 text-muted-foreground" />
              <p className="text-sm">
                你在房間 <span className="font-mono tracking-wider">{rooms.data.mine}</span> 裡
              </p>
              <Button size="sm" onClick={() => onEnter(rooms.data.mine as string)}>
                回到房間
              </Button>
            </div>
          ) : (
            <>
              <dl className="flex flex-wrap gap-x-8 gap-y-3">
                <Fact label="開房">{coins(rooms.data.terms.price, rooms.data.terms.currency)}</Fact>
                <Fact label="你有">
                  {rooms.data.balance === null ? "—" : coins(rooms.data.balance, rooms.data.terms.currency)}
                </Fact>
                <Fact label="一起唱">最多 {rooms.data.terms.max_singers} 人</Fact>
              </dl>
              {!rooms.data.available && rooms.data.reason && (
                <p className="text-[13px] text-muted-foreground">{rooms.data.reason}</p>
              )}
            </>
          )}
          <form className="flex flex-wrap items-center gap-2" onSubmit={join}>
            <label htmlFor={id} className="sr-only">
              房號或連結
            </label>
            <Input
              id={id}
              placeholder="房號或連結"
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              className="w-full font-mono sm:w-56"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setBad(false);
              }}
            />
            <Button type="submit" variant="outline" disabled={text.trim() === ""}>
              <LogIn aria-hidden />
              加入
            </Button>
          </form>
          {bad && <Refusal>房號是 6 個英文字母和數字</Refusal>}
        </div>
      )}
      {rooms.data && opening && (
        <OpenRoomDialog
          open
          onClose={() => setOpening(false)}
          overview={overview}
          rooms={rooms.data}
          onOpened={(room) => {
            setOpening(false);
            onEnter(room.code);
          }}
        />
      )}
    </Card>
  );
}
