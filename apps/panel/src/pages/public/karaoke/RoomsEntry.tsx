// 一起唱 on the song list (docs/design/karaoke.md 「做了什麼第四步」): open a room (see the price and
// the balance, then pay; songs are queued inside the room, 「第四步之後的修改:先開房再點歌」), join one
// by its code or link, or go back to the one they are in. A Core without rooms shows nothing here.
// A room is opened in one server (phase 6): their own; someone in several picks which
// (`SpacePicker`, drawn only then), and whether 開一間房 can be pressed is about that server's voice.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { DoorOpen, LogIn, Users } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { KaraokeRooms, KaraokeRoomView } from "@miyoria/contracts/api";
import { describeError } from "@/api/http";
import { useApi } from "@/app/connection";
import { ErrorLine, SkeletonRows } from "@/components/query-state";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SpacePicker, useMemberSpace } from "../member-space";
import { Fact, Refusal } from "./bits";
import { isOff, ROOMS, useRooms } from "./queries";
import { canPay, coins, readRoomCode } from "./room-text";

/** Opening a room: the price against the balance, then pay. Songs are queued inside. */
export function OpenRoomDialog({
  open,
  onClose,
  rooms,
  space = null,
  onOpened,
}: {
  open: boolean;
  onClose: () => void;
  rooms: KaraokeRooms;
  /** The server it opens in; `null`: the Core's default. */
  space?: string | null;
  onOpened: (room: KaraokeRoomView) => void;
}) {
  const api = useApi();
  const client = useQueryClient();
  const { terms, balance } = rooms;
  const affordable = canPay(balance, terms.price);
  const pay = useMutation({
    mutationFn: () => api.rpc.karaokeRooms.open(space ? { query: { space }, body: {} } : { body: {} }),
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
          <DialogDescription className="sr-only">確認價錢後開房,歌在房間裡點</DialogDescription>
        </DialogHeader>
        <div className="grid min-w-0 gap-4">
          <dl className="flex flex-wrap gap-x-8 gap-y-3" aria-label="價錢">
            <Fact label="開房">{coins(terms.price, terms.currency)}</Fact>
            <Fact label="你有">{balance === null ? "—" : coins(balance, terms.currency)}</Fact>
            {balance !== null && affordable && <Fact label="開房後">{coins(balance - terms.price, terms.currency)}</Fact>}
          </dl>
          <p className="text-xs text-muted-foreground">
            最多 {terms.max_singers} 人一起唱,可以唱 {terms.rounds} 輪。贏的人 {coins(terms.prize, terms.currency)},唱完的人各{" "}
            {coins(terms.finish, terms.currency)}。開房後大家在房間裡點歌。
          </p>
          {!affordable && <Refusal>{`${terms.currency}不夠,開房要 ${coins(terms.price, terms.currency)}`}</Refusal>}
          {pay.isError && <Refusal>{describeError(pay.error)}</Refusal>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pay.isPending}>
            取消
          </Button>
          <Button onClick={() => pay.mutate()} busy={pay.isPending} disabled={!affordable}>
            付 {coins(terms.price, terms.currency)}開房
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * What to do about it: the page follows by itself, so the person only has to wait for her (or for
 * karaoke to open). Core's sentence says why; this says that nothing needs reloading.
 */
export function unavailableHint(reason: string | null): string {
  if (reason?.includes("語音")) return "她進語音頻道後,這裡一兩秒內就能按,不用重新整理";
  return "可以開的時候,這裡會自己變成可以按";
}

/** The block on the song list. */
export function RoomsEntry({ onEnter }: { onEnter: (code: string) => void }) {
  const own = useMemberSpace();
  const rooms = useRooms(true, own.space);
  const [opening, setOpening] = useState(false);
  const [text, setText] = useState("");
  const [bad, setBad] = useState(false);
  const id = useId();
  const whyId = useId();
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
            {rooms.data.available ? (
              <Button size="sm" onClick={() => setOpening(true)}>
                <DoorOpen aria-hidden />
                開一間房
              </Button>
            ) : (
              // Disabled says why (a disabled button gets no pointer events: the tooltip is on its box).
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0} className="inline-flex rounded-md">
                    <Button size="sm" disabled aria-describedby={whyId}>
                      <DoorOpen aria-hidden />
                      開一間房
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{rooms.data.reason ?? "現在不能開房"}</TooltipContent>
              </Tooltip>
            )}
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
              <SpacePicker value={own.space} spaces={own.spaces} onChange={own.setSpace} label="在哪個伺服器開房" />
              <dl className="flex flex-wrap gap-x-8 gap-y-3">
                <Fact label="開房">{coins(rooms.data.terms.price, rooms.data.terms.currency)}</Fact>
                <Fact label="你有">
                  {rooms.data.balance === null ? "—" : coins(rooms.data.balance, rooms.data.terms.currency)}
                </Fact>
                <Fact label="一起唱">最多 {rooms.data.terms.max_singers} 人</Fact>
              </dl>
              {!rooms.data.available && (
                <p id={whyId} role="status" className="text-[13px] text-muted-foreground">
                  {rooms.data.reason ?? "現在不能開房"}。{unavailableHint(rooms.data.reason)}
                </p>
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
          rooms={rooms.data}
          space={own.space}
          onOpened={(room) => {
            setOpening(false);
            onEnter(room.code);
          }}
        />
      )}
    </Card>
  );
}
