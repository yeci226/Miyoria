// A room before a round, and between rounds (docs/design/karaoke.md 「做了什麼第四步」): its code and
// link, who is in it (their colour, singing or watching, ready or not), the song and key (the
// opener picks them), what it pays, and each person's own controls: sing or watch, ready (with the
// device's latency), leave; the opener's start and close. The results of a round are here too.

import { useMutation } from "@tanstack/react-query";
import { Check, Copy, Crown, DoorClosed, ListMusic, LogOut, Mic, Play, Timer, Trophy, Users } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { KaraokeOverview, KaraokeRoomPlace, KaraokeRoomView, KaraokeSongView } from "@miyoria/contracts/api";
import { describeError } from "@/api/http";
import { useApi } from "@/app/connection";
import { ConfirmDialog } from "@/components/confirm";
import { Page } from "@/components/page";
import { EmptyLine } from "@/components/query-state";
import { Dot } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Segmented } from "@/components/ui/segmented";
import { cn } from "@/lib/utils";
import { Fact, Refusal } from "./bits";
import { keyLabel } from "./lyric-text";
import { roomPage } from "./path";
import { CHECK_LINES, PART_NAMES, score1 } from "./result-text";
import { coins, roleWord, SOURCE_WORDS, STATE_WORDS } from "./room-text";
import { KeyStepper, SongPicker } from "./RoomsEntry";
import { AirCard, CutVoice } from "./RoomAir";
import { Swatch } from "./SpectatorStage";

type Me = NonNullable<KaraokeRoomView["me"]>;

/** What the room page does for the lobby. */
export interface RoomActions {
  /** A new view of the room (a route's answer). */
  onRoom: (room: KaraokeRoomView) => void;
  /** Ready or not: opens the microphone first and sends the device's latency. */
  onReady: (ready: boolean) => Promise<void>;
  onCalibrate: () => void;
  onLeave: () => void;
}

/** The opener's choice of song and key. */
function SongDialog({
  room,
  overview,
  onClose,
  onRoom,
}: {
  room: KaraokeRoomView;
  overview: KaraokeOverview;
  onClose: () => void;
  onRoom: (room: KaraokeRoomView) => void;
}) {
  const api = useApi();
  const [song, setSong] = useState<KaraokeSongView | null>(
    () => overview.songs.find((s) => s.id === room.song?.id && s.state === "ready") ?? null,
  );
  const [shift, setShift] = useState(room.shift);
  const pick = useMutation({
    mutationFn: () => api.rpc.karaokeRooms.song({ params: { code: room.code }, body: { song: (song as KaraokeSongView).id, shift } }),
    onSuccess: (r) => {
      onRoom(r);
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && !pick.isPending && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>選歌</DialogTitle>
          <DialogDescription className="sr-only">這一輪大家一起唱的歌和調</DialogDescription>
        </DialogHeader>
        <div className="grid min-w-0 gap-4">
          <SongPicker songs={overview.songs} value={song?.id ?? null} onChange={setSong} />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[13px] text-muted-foreground">調(大家一起)</span>
            <KeyStepper shift={shift} onChange={setShift} />
          </div>
          {pick.isError && <Refusal>{describeError(pick.error)}</Refusal>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pick.isPending}>
            取消
          </Button>
          <Button onClick={() => pick.mutate()} busy={pick.isPending} disabled={song === null}>
            用這首
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Code, link, copy. */
function RoomCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const url = typeof window === "undefined" ? roomPage(code) : `${window.location.origin}${roomPage(code)}`;
  const copy = () => {
    void navigator.clipboard?.writeText(url).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1_500);
      },
      () => undefined,
    );
  };
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <span className="font-mono text-lg font-semibold tracking-[0.2em]" aria-label={`房號 ${code.split("").join(" ")}`}>
        {code}
      </span>
      <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{url}</span>
      <Button variant="outline" size="sm" onClick={copy} aria-label="複製連結">
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
        {copied ? "已複製" : "複製連結"}
      </Button>
    </div>
  );
}

function Members({ room, canCut, onRoom }: { room: KaraokeRoomView; canCut: boolean; onRoom: (room: KaraokeRoomView) => void }) {
  const singers = room.members.filter((m) => m.role === "singer").length;
  return (
    <Card aria-label="成員">
      <CardHeader>
        <CardTitle>成員</CardTitle>
        <CardAction>
          <span className="text-xs text-muted-foreground tabular-nums">
            唱 {singers} / {room.terms.max_singers}
          </span>
        </CardAction>
      </CardHeader>
      {room.members.length === 0 ? (
        <EmptyLine>還沒有人</EmptyLine>
      ) : (
        <ul className="divide-y divide-line-soft">
          {room.members.map((m) => (
            <li key={m.id} className="flex min-w-0 items-center gap-2.5 py-(--row-y)" data-member={m.id}>
              <Swatch color={m.color} />
              <span className="min-w-0 flex-1 truncate text-sm">
                {m.name}
                {m.id === room.me?.id && <span className="text-muted-foreground">(你)</span>}
              </span>
              {m.opener && <Crown aria-label="房主" className="size-3.5 shrink-0 text-muted-foreground" />}
              {canCut && <CutVoice room={room} member={m} onRoom={onRoom} />}
              <span className="w-14 shrink-0 text-xs text-muted-foreground">{roleWord({ ...m, opener: false })}</span>
              {m.role === "singer" ? (
                <span className="flex w-16 shrink-0 items-center gap-1.5 text-xs">
                  <Dot tone={m.ready ? "brand" : "neutral"} />
                  {m.ready ? "準備好" : "還沒好"}
                </span>
              ) : (
                <span className="w-16 shrink-0" />
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** The person's own part: sing or watch, ready, the device's latency, leave. */
function MyPart({
  room,
  me,
  latency,
  actions,
}: {
  room: KaraokeRoomView;
  me: Me;
  latency: { latency_ms: number; calibrated: boolean } | null;
  actions: RoomActions;
}) {
  const api = useApi();
  const mine = room.members.find((m) => m.id === me.id);
  const ready = mine?.ready ?? false;
  const role = useMutation({
    mutationFn: (as: "singer" | "spectator") => api.rpc.karaokeRooms.join({ params: { code: room.code }, body: { as } }),
    onSuccess: actions.onRoom,
  });
  const toggle = useMutation({ mutationFn: (next: boolean) => actions.onReady(next) });
  const between = room.state === "lobby" || room.state === "results";
  return (
    <Card aria-label="你">
      <CardHeader>
        <CardTitle>你</CardTitle>
      </CardHeader>
      <div className="grid gap-3">
        <Segmented<"singer" | "spectator">
          label="唱或看"
          value={me.role}
          disabled={!between || role.isPending}
          onChange={(v) => v !== me.role && role.mutate(v)}
          options={[
            { value: "singer", label: "我要唱" },
            { value: "spectator", label: "只看" },
          ]}
        />
        {me.role === "singer" && between && (
          <Button
            variant={ready ? "outline" : "default"}
            busy={toggle.isPending}
            onClick={() => toggle.mutate(!ready)}
            aria-pressed={ready}
          >
            {ready ? <Check aria-hidden /> : <Mic aria-hidden />}
            {ready ? "準備好了,取消" : "準備好了"}
          </Button>
        )}
        {me.role === "singer" && (
          <>
            <dl className="flex flex-wrap gap-x-8 gap-y-3">
              <Fact label="延遲">{latency ? `${latency.latency_ms} ms` : "—"}</Fact>
              <Fact label="狀態">{latency?.calibrated ? "校正過" : "還沒校正"}</Fact>
            </dl>
            <Button variant="outline" size="sm" onClick={actions.onCalibrate} className="justify-self-start">
              <Timer aria-hidden />
              校正延遲
            </Button>
            <p className="text-xs text-muted-foreground">請戴耳機。唱的時候麥克風的聲音會即時送去算分,算完不保存。</p>
          </>
        )}
        {role.isError && <Refusal>{describeError(role.error)}</Refusal>}
        {toggle.isError && <Refusal>{describeError(toggle.error)}</Refusal>}
      </div>
    </Card>
  );
}

/** The opener's part: the song, start, close. Everyone else sees who decides. */
function OpenerPart({
  room,
  me,
  overview,
  actions,
  children,
}: {
  room: KaraokeRoomView;
  me: Me;
  overview: KaraokeOverview;
  actions: RoomActions;
  children?: ReactNode;
}) {
  const api = useApi();
  const [picking, setPicking] = useState(false);
  const [closing, setClosing] = useState(false);
  const start = useMutation({
    mutationFn: () => api.rpc.karaokeRooms.start({ params: { code: room.code } }),
    onSuccess: actions.onRoom,
  });
  const close = useMutation({
    mutationFn: () => api.rpc.karaokeRooms.close({ params: { code: room.code } }),
    onSuccess: (r) => {
      setClosing(false);
      actions.onRoom(r);
    },
  });
  const singers = room.members.filter((m) => m.role === "singer");
  const allReady = singers.length > 0 && singers.every((m) => m.ready);
  const inLobby = room.state === "lobby";
  return (
    <div className="grid gap-3">
      {children}
      {me.opener ? (
        <div className="flex flex-wrap items-center gap-2">
          {inLobby && (
            <Button onClick={() => start.mutate()} busy={start.isPending} disabled={room.song === null || singers.length === 0 || room.rounds_left <= 0}>
              <Play aria-hidden />
              開始
            </Button>
          )}
          <Button variant="outline" onClick={() => setPicking(true)} disabled={room.rounds_left <= 0}>
            <ListMusic aria-hidden />
            {room.state === "results" ? "選下一首" : room.song ? "換歌" : "選歌"}
          </Button>
          <Button variant="ghost" onClick={() => setClosing(true)}>
            <DoorClosed aria-hidden />
            關房
          </Button>
        </div>
      ) : (
        <p className="text-[13px] text-muted-foreground">
          {room.state === "results" ? "等房主選下一首" : "等房主開始"}
        </p>
      )}
      {me.opener && inLobby && singers.length > 0 && !allReady && (
        <p className="text-xs text-muted-foreground">還有人沒準備好</p>
      )}
      {room.rounds_left <= 0 && <p className="text-xs text-muted-foreground">這間房的輪數用完了</p>}
      {start.isError && <Refusal>{describeError(start.error)}</Refusal>}
      {picking && <SongDialog room={room} overview={overview} onClose={() => setPicking(false)} onRoom={actions.onRoom} />}
      <ConfirmDialog
        open={closing}
        title="關掉這間房"
        confirmLabel="關房"
        busy={close.isPending}
        onConfirm={() => close.mutate()}
        onClose={() => setClosing(false)}
      >
        {close.isError ? describeError(close.error) : "大家都會離開。這一輪還沒唱完的話不會記分。"}
      </ConfirmDialog>
    </div>
  );
}

function Terms({ room }: { room: KaraokeRoomView }) {
  const t = room.terms;
  return (
    <dl className="flex flex-wrap gap-x-8 gap-y-3" aria-label="這間房">
      <Fact label="開房">{coins(t.price, t.currency)}</Fact>
      <Fact label="贏的人">{coins(t.prize, t.currency)}</Fact>
      <Fact label="唱完的人">{coins(t.finish, t.currency)}</Fact>
      <Fact label="還能唱">{room.rounds_left} 輪</Fact>
    </dl>
  );
}

/** The song picked for the next round. */
function SongLine({ room }: { room: KaraokeRoomView }) {
  if (!room.song) return <p className="text-sm text-muted-foreground">還沒選歌</p>;
  return (
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
      <span className="min-w-0 truncate text-[15px] font-semibold">{room.song.title}</span>
      {room.song.artist && <span className="truncate text-[13px] text-muted-foreground">{room.song.artist}</span>}
      <span className="font-mono text-xs text-muted-foreground">{keyLabel(room.shift)}</span>
    </div>
  );
}

function LeaveButton({ onLeave }: { onLeave: () => void }) {
  return (
    <Button variant="ghost" size="sm" onClick={onLeave}>
      <LogOut aria-hidden />
      離開房間
    </Button>
  );
}

export function RoomLobby({
  room,
  me,
  overview,
  latency,
  actions,
}: {
  room: KaraokeRoomView;
  me: Me;
  overview: KaraokeOverview;
  latency: { latency_ms: number; calibrated: boolean } | null;
  actions: RoomActions;
}) {
  return (
    <Page
      rail={
        <>
          <MyPart room={room} me={me} latency={latency} actions={actions} />
          <AirCard room={room} me={me} onRoom={actions.onRoom} />
          <Card aria-label="這間房">
            <CardHeader>
              <CardTitle>這間房</CardTitle>
            </CardHeader>
            <Terms room={room} />
          </Card>
        </>
      }
    >
      <Card aria-label={`房間 ${room.code}`}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users aria-hidden className="size-4 text-muted-foreground" />
            房間
            <Badge>{STATE_WORDS[room.state]}</Badge>
          </CardTitle>
          <CardAction>
            <LeaveButton onLeave={actions.onLeave} />
          </CardAction>
        </CardHeader>
        <div className="grid gap-4">
          <RoomCode code={room.code} />
          <OpenerPart room={room} me={me} overview={overview} actions={actions}>
            <SongLine room={room} />
          </OpenerPart>
        </div>
      </Card>
      <Members room={room} canCut={me.opener || overview.admin} onRoom={actions.onRoom} />
      <Ranking room={room} />
    </Page>
  );
}

// ---- after a round ---------------------------------------------------------------------------

function PlaceRow({ p, mine, currency }: { p: KaraokeRoomPlace; mine: boolean; currency: string }) {
  const parts = (["pitch", "stability", "rhythm", "expression"] as const)
    .map((k) => (p[k] === null ? null : `${PART_NAMES[k]} ${score1(p[k] as number)}`))
    .filter(Boolean);
  return (
    <li className={cn("grid gap-1 py-(--row-y)", mine && "text-foreground")} data-place={p.member}>
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="w-6 shrink-0 text-right font-mono text-sm font-semibold tabular-nums">{p.rank ?? "—"}</span>
        <Swatch color={p.color} />
        <span className="min-w-0 flex-1 truncate text-sm">
          {p.name}
          {mine && <span className="text-muted-foreground">(你)</span>}
        </span>
        {p.winner && (
          <Badge variant="brand">
            <Trophy aria-hidden />
            贏了
          </Badge>
        )}
        {p.source === "estimate" && <Badge>{SOURCE_WORDS.estimate}</Badge>}
        <span className="w-12 shrink-0 text-right font-mono text-sm font-semibold tabular-nums">
          {p.total === null ? "—" : score1(p.total)}
        </span>
      </div>
      <div className="flex min-w-0 flex-wrap gap-x-4 gap-y-0.5 pl-[3.25rem] text-xs text-muted-foreground">
        {parts.length > 0 ? <span className="font-mono tabular-nums">{parts.join(" · ")}</span> : <span>{p.finished ? "沒有分數" : "沒有唱完"}</span>}
        {p.coins > 0 && <span className="tabular-nums">+{coins(p.coins, currency)}</span>}
      </div>
      {p.checks.map((c) => (
        <p key={c} className="pl-[3.25rem] text-xs text-muted-foreground" data-check>
          {CHECK_LINES[c]}
        </p>
      ))}
      {p.note && <p className="pl-[3.25rem] text-xs text-muted-foreground">{p.note}</p>}
    </li>
  );
}

/** The round's final ranking, for everyone. */
export function Ranking({ room }: { room: KaraokeRoomView }) {
  const r = room.result;
  if (!r) return null;
  const currency = room.terms.currency;
  return (
    <Card aria-label="這一輪的名次">
      <CardHeader>
        <CardTitle>
          第 {r.round} 輪 · {r.song.title}
        </CardTitle>
      </CardHeader>
      {r.settling && (
        <p role="status" className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Dot tone="brand" pulse />
          還在等正式分數,名次可能會變
        </p>
      )}
      {r.places.length === 0 ? (
        <EmptyLine>這一輪沒有人唱完</EmptyLine>
      ) : (
        <ol className="divide-y divide-line-soft">
          {[...r.places]
            .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))
            .map((p) => (
              <PlaceRow key={p.member} p={p} mine={p.member === room.me?.id} currency={currency} />
            ))}
        </ol>
      )}
      {r.note && <p className="text-[13px] text-muted-foreground">{r.note}</p>}
    </Card>
  );
}

export function RoomResults({
  room,
  me,
  overview,
  latency,
  actions,
  mine,
}: {
  room: KaraokeRoomView;
  me: Me | null;
  overview: KaraokeOverview;
  latency: { latency_ms: number; calibrated: boolean } | null;
  actions: RoomActions;
  /** The singer's own submission, while it is still going. */
  mine?: ReactNode;
}) {
  return (
    <Page
      rail={
        me ? (
          <>
            <MyPart room={room} me={me} latency={latency} actions={actions} />
            <AirCard room={room} me={me} onRoom={actions.onRoom} />
            <Card aria-label="這間房">
              <CardHeader>
                <CardTitle>這間房</CardTitle>
              </CardHeader>
              <Terms room={room} />
            </Card>
          </>
        ) : undefined
      }
    >
      <Card aria-label={`房間 ${room.code}`}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users aria-hidden className="size-4 text-muted-foreground" />
            房間 <span className="font-mono tracking-[0.15em]">{room.code}</span>
            <Badge>{STATE_WORDS[room.state]}</Badge>
          </CardTitle>
          <CardAction>
            <LeaveButton onLeave={actions.onLeave} />
          </CardAction>
        </CardHeader>
        {me && (
          <OpenerPart room={room} me={me} overview={overview} actions={actions}>
            {room.state === "lobby" && <SongLine room={room} />}
          </OpenerPart>
        )}
      </Card>
      {mine}
      <Ranking room={room} />
    </Page>
  );
}
