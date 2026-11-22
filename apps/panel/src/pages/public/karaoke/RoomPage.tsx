// A karaoke room on the member page (docs/design/karaoke.md 「做了什麼第四步」), at
// `/karaoke/room/<code>`. The room comes from its event stream (`room`, and `board` or `trend`
// while a round is sung, `live` with the singers' latest pitch a few times a second for the people
// watching, and `cheer`s) and Core's clock is learned beside it. What shows follows the room and
// the person in it: joining (sing or watch), the lobby, a singer's stage (the step-3 scene with
// their trend, never a ranking), a spectator's stage (the scene with the live ranking and every
// singer's line), a singer who is done waiting for the others (結算中 and whom Core still waits
// for, once the song is over), the round's ranking, or why the room closed. A singer's take is sent
// from here as a singer alone sends theirs, so it goes on when the stage gives way to the results;
// the stage itself stays until it has handed its take on. Each screen comes in with a short fade.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Eye, Mic, RotateCcw } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { KaraokeOverview, KaraokeResult, KaraokeRoomView } from "@miyoria/contracts/api";
import { describeError, isApiError } from "@/api/http";
import { useConnection } from "@/app/connection";
import { Page } from "@/components/page";
import { SkeletonRows } from "@/components/query-state";
import { Dot } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { KaraokeEngine } from "./audio";
import { ENTER, Fact, Refusal } from "./bits";
import { keyLabel } from "./lyric-text";
import { resultKey, ROOMS } from "./queries";
import { uploadVoice } from "./recorder";
import { voicePollMs } from "./Result";
import { score1, voiceView } from "./result-text";
import { openRoomEvents, postClock, type RoomLink } from "./room-api";
import { CLOCK_EVERY_MS, type ClockOffset, syncClock } from "./room-clock";
import {
  type BoardEvent,
  BoardLines,
  type CheerEvent,
  type HeldStage,
  keepCheers,
  settlingView,
  stageOf,
  type TrendEvent,
  wantsUpload,
} from "./room-text";
import { type RoomActions, RoomLobby, RoomResults } from "./RoomLobby";
import { RoomStage } from "./RoomStage";
import type { Finished } from "./Singing";
import { SpectatorStage } from "./SpectatorStage";

/** The room as it comes: the first answer, then the event stream. */
export function useRoomFeed(code: string) {
  const { api, client } = useConnection();
  const [room, setRoom] = useState<KaraokeRoomView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [trend, setTrend] = useState<TrendEvent | null>(null);
  const [board, setBoard] = useState<BoardEvent | null>(null);
  const [link, setLink] = useState<RoomLink>("connecting");
  const [lines] = useState(() => new BoardLines());
  /** The latest cheers this person may see (with when they came), for a few seconds each. */
  const [cheers, setCheers] = useState<(CheerEvent & { at: number })[]>([]);
  const round = useRef(-1);

  useEffect(() => {
    let alive = true;
    api.rpc.karaokeRooms.room({ params: { code } }).then(
      (r) => alive && setRoom((prev) => prev ?? r),
      (e: unknown) => alive && setError(e),
    );
    return () => {
      alive = false;
    };
  }, [api, code]);

  useEffect(
    () =>
      openRoomEvents(client, code, {
        onLink: setLink,
        onEvent: (e) => {
          if (e.type === "room") {
            setRoom(e.room);
            setError(null);
          } else if (e.type === "board" || e.type === "live") {
            if (e.round !== round.current) {
              lines.clear();
              round.current = e.round;
            }
            lines.take(e.lines);
            if (e.type === "board") setBoard(e);
          } else if (e.type === "cheer") {
            const at = Date.now();
            setCheers((list) => keepCheers(list, { ...e, at }, at));
          } else if (e.type === "trend") {
            setTrend(e);
          }
        },
      }),
    [client, code, lines],
  );

  return { room, setRoom, error, trend, board, lines, link, cheers };
}

/** Core's clock less this browser's, learned while in the room and again every ten seconds. */
export function useRoomClock(code: string, on: boolean): () => number | null {
  const { client } = useConnection();
  const best = useRef<ClockOffset | null>(null);
  const tried = useRef(false);
  useEffect(() => {
    if (!on) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      const found = await syncClock((t0) => postClock(client, code, t0));
      if (!alive) return;
      tried.current = true;
      if (found) best.current = found;
      timer = setTimeout(run, CLOCK_EVERY_MS);
    };
    void run();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [client, code, on]);
  // Never answered: this browser's own clock stands in rather than holding the round up.
  return useCallback(() => best.current?.offset ?? (tried.current ? 0 : null), []);
}

/** A singer's take: sent as alone, then the recording when Core wants it (now or on a later look). */
export function useRoundTake() {
  const { api, client: http } = useConnection();
  const qc = useQueryClient();
  const [finished, setFinished] = useState<Finished | null>(null);
  const [round, setRound] = useState<number | null>(null);
  const [uploadFailed, setUploadFailed] = useState(false);
  const voiceSent = useRef<string | null>(null);
  const since = useRef(Date.now());

  const upload = useCallback(
    (f: Finished, r: KaraokeResult) => {
      if (!f.voice || voiceSent.current === f.session || !wantsUpload(r.voice)) return;
      voiceSent.current = f.session;
      uploadVoice(http, f.session, f.voice).then(
        () => {
          since.current = Date.now();
          void qc.invalidateQueries({ queryKey: resultKey(f.session) });
        },
        () => setUploadFailed(true),
      );
    },
    [http, qc],
  );

  const submit = useMutation({
    mutationFn: (f: Finished) => api.rpc.karaoke.submit({ params: { id: f.session }, body: f.body }),
    onSuccess: (r, f) => {
      since.current = Date.now();
      qc.setQueryData(resultKey(f.session), r);
      upload(f, r);
    },
  });

  const session = finished?.session ?? "";
  const result = useQuery({
    queryKey: resultKey(session),
    queryFn: ({ signal }) => api.rpc.karaoke.result({ params: { id: session } }, { signal }),
    enabled: finished !== null && submit.isSuccess,
    refetchInterval: (q) => voicePollMs(q.state.data, since.current, Date.now(), uploadFailed),
    retry: false,
  });

  useEffect(() => {
    if (finished && result.data) upload(finished, result.data);
  }, [finished, result.data, upload]);

  const finish = useCallback(
    (f: Finished, of: number) => {
      setFinished(f);
      setRound(of);
      setUploadFailed(false);
      submit.mutate(f);
    },
    [submit],
  );

  return { finished, round, finish, submit, result: result.data ?? submit.data, uploadFailed };
}

/** How the singer's own take is going, in a line or two (no one else's number). */
function MyTake({ take }: { take: ReturnType<typeof useRoundTake> }) {
  const f = take.finished;
  if (!f) return null;
  const core = take.result;
  const view = core ? voiceView(core, { uploadFailed: take.uploadFailed }) : null;
  return (
    <Card aria-label="你這一輪">
      <CardHeader>
        <CardTitle>你這一輪</CardTitle>
      </CardHeader>
      {take.submit.isError ? (
        <div className="grid justify-items-start gap-2">
          <Refusal>{describeError(take.submit.error)}</Refusal>
          <Button variant="outline" size="sm" busy={take.submit.isPending} onClick={() => take.submit.mutate(f)}>
            <RotateCcw aria-hidden />
            再送一次
          </Button>
        </div>
      ) : (
        <div className="grid gap-2">
          <dl className="flex flex-wrap gap-x-8 gap-y-3">
            <Fact label={view?.label ?? "預估"}>
              {core ? score1(core.total) : f.provisional ? score1(f.provisional.total) : "—"}
            </Fact>
          </dl>
          <p role="status" className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <Dot tone={take.submit.isPending || view?.pending ? "brand" : "neutral"} pulse={take.submit.isPending || view?.pending} />
            {take.submit.isPending ? "送出中" : (view?.note ?? "送出了")}
          </p>
        </div>
      )}
    </Card>
  );
}

function Notice({ title, children, onBack }: { title: string; children: ReactNode; onBack: () => void }) {
  return (
    <Page className={ENTER}>
      <Card aria-label={title}>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <div className="grid justify-items-start gap-3">
          {children}
          <Button variant="outline" onClick={onBack}>
            <ArrowLeft aria-hidden />
            回到歌單
          </Button>
        </div>
      </Card>
    </Page>
  );
}

/** Not in the room yet: sing (while seats are free and no round runs) or watch. */
function JoinRoom({ room, onRoom, onBack }: { room: KaraokeRoomView; onRoom: (r: KaraokeRoomView) => void; onBack: () => void }) {
  const { api } = useConnection();
  const join = useMutation({
    mutationFn: (as: "singer" | "spectator") => api.rpc.karaokeRooms.join({ params: { code: room.code }, body: { as } }),
    onSuccess: onRoom,
  });
  const running = room.state === "countdown" || room.state === "singing";
  const seats = room.members.filter((m) => m.role === "singer").length < room.terms.max_singers;
  return (
    <Page className={ENTER}>
      <Card aria-label={`加入房間 ${room.code}`}>
        <CardHeader>
          <CardTitle>
            加入房間 <span className="font-mono tracking-[0.15em]">{room.code}</span>
          </CardTitle>
        </CardHeader>
        <div className="grid gap-4">
          <dl className="flex flex-wrap gap-x-8 gap-y-3">
            <Fact label="歌">{room.song ? `${room.song.title} ${room.shift === 0 ? "" : keyLabel(room.shift)}`.trim() : "還沒選"}</Fact>
            <Fact label="人">{room.members.length}</Fact>
          </dl>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => join.mutate("singer")} busy={join.isPending && join.variables === "singer"} disabled={running || !seats || join.isPending}>
              <Mic aria-hidden />
              我要唱
            </Button>
            <Button variant="outline" onClick={() => join.mutate("spectator")} busy={join.isPending && join.variables === "spectator"} disabled={join.isPending}>
              <Eye aria-hidden />
              只看
            </Button>
            <Button variant="ghost" onClick={onBack}>
              回到歌單
            </Button>
          </div>
          {running && <p className="text-[13px] text-muted-foreground">這一輪已經開始了,現在只能看</p>}
          {!running && !seats && <p className="text-[13px] text-muted-foreground">唱的位置滿了,可以先看</p>}
          {join.isError && <Refusal>{describeError(join.error)}</Refusal>}
        </div>
      </Card>
    </Page>
  );
}

export function RoomPage({
  code,
  overview,
  engine,
  latency,
  floor,
  prepareMic,
  onCalibrate,
  onExit,
}: {
  code: string;
  overview: KaraokeOverview;
  engine: () => KaraokeEngine;
  /** This device's latency, or `null` while the microphone has not been opened here. */
  latency: { latency_ms: number; calibrated: boolean } | null;
  floor: number | null;
  /** Opens the microphone (asks the first time): the latency to send with 準備好了. */
  prepareMic: () => Promise<{ latency_ms: number; calibrated: boolean }>;
  onCalibrate: () => void;
  onExit: () => void;
}) {
  const { api } = useConnection();
  const qc = useQueryClient();
  const feed = useRoomFeed(code);
  const { room, setRoom } = feed;
  const inRoom = room?.me != null && room.state !== "closed";
  const offset = useRoomClock(code, inRoom);
  const take = useRoundTake();
  // The stage this singer is on, kept until their take is handed on: a later view of the room
  // (the song over, 結算中) must not take it away before it has sent what was sung.
  const held = useRef<HeldStage | null>(null);

  const leave = useCallback(() => {
    void api.rpc.karaokeRooms
      .leave({ params: { code } })
      .catch(() => undefined)
      .finally(() => {
        void qc.invalidateQueries({ queryKey: ROOMS });
        onExit();
      });
  }, [api, code, onExit, qc]);

  const actions: RoomActions = {
    onRoom: setRoom,
    onReady: async (ready) => {
      const body = ready ? { ready, ...(await prepareMic()) } : { ready };
      setRoom(await api.rpc.karaokeRooms.ready({ params: { code }, body }));
    },
    onCalibrate,
    onLeave: leave,
  };
  const back = () => {
    void qc.invalidateQueries({ queryKey: ROOMS });
    onExit();
  };

  if (!room) {
    if (feed.error) {
      const gone = isApiError(feed.error) && (feed.error.status === 404 || feed.error.kind === "not_found");
      return (
        <Notice title={gone ? "找不到這個房間" : "房間"} onBack={back}>
          <p className="text-[13px] text-muted-foreground">{gone ? `沒有房號 ${code} 的房間,可能已經關了` : describeError(feed.error)}</p>
        </Notice>
      );
    }
    return (
      <Page>
        <SkeletonRows count={4} />
      </Page>
    );
  }

  if (room.state === "closed") {
    return (
      <Notice title="這間房關了" onBack={back}>
        <p className="text-[13px] text-muted-foreground">{room.closed_reason ?? "房間已經關了"}</p>
      </Notice>
    );
  }

  const me = room.me;
  if (me === null) return <JoinRoom room={room} onRoom={setRoom} onBack={back} />;

  const running = room.state === "countdown" || room.state === "singing";
  const trend = feed.trend !== null && feed.trend.round === room.round ? feed.trend : null;
  const settling = room.settling;
  const stage = stageOf(room, held);
  const handedIn = take.finished !== null && take.round === room.round;

  if (stage !== null && !(handedIn && take.finished?.session === stage.session.session)) {
    return (
      <RoomStage
        key={stage.session.session}
        room={room}
        onRoom={setRoom}
        code={code}
        session={stage.session}
        song={stage.session.song}
        startAtMs={stage.startAt}
        offset={offset}
        trend={trend}
        cheers={feed.cheers.filter((c) => c.round === room.round && c.member === room.me?.id)}
        engine={engine}
        latency={latency ?? { latency_ms: 0, calibrated: false }}
        floor={floor}
        onFinished={(f) => take.finish(f, stage.round)}
        onQuit={leave}
      />
    );
  }

  if (running && handedIn) {
    // Done before the round is: their own take only; the ranking comes when the round is settled.
    const s = settling === null ? null : settlingView(settling);
    return (
      <Page className={ENTER}>
        <Card aria-label={`房間 ${room.code}`}>
          <CardHeader>
            <CardTitle>你唱完了</CardTitle>
          </CardHeader>
          <p
            key={s === null ? "others" : "settling"}
            className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted-foreground", ENTER)}
            role="status"
            data-settling={s === null ? undefined : ""}
          >
            <Dot tone="brand" pulse />
            {s === null ? (
              "等其他人唱完,名次會在這裡出來"
            ) : (
              <>
                <span className="font-medium text-foreground">{s.title}</span>
                <span>{s.detail}</span>
              </>
            )}
          </p>
        </Card>
        <MyTake take={take} />
      </Page>
    );
  }

  if (running) {
    return (
      <SpectatorStage
        key={room.round}
        room={room}
        board={feed.board !== null && feed.board.round === room.round ? feed.board : null}
        lines={feed.lines}
        cheers={feed.cheers.filter((c) => c.round === room.round)}
        offset={offset}
        engine={engine}
        onLeave={leave}
      />
    );
  }

  if (room.state === "results") {
    return (
      <RoomResults
        room={room}
        me={me}
        overview={overview}
        latency={latency}
        actions={actions}
        mine={handedIn ? <MyTake take={take} /> : undefined}
      />
    );
  }

  return <RoomLobby room={room} me={me} overview={overview} latency={latency} actions={actions} />;
}
