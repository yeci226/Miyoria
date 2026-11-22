// A room singer's stage (docs/design/karaoke.md 「做了什麼第四步」): the singing screen of step 3
// with the round's session, started by itself at the room's moment of Core's clock, and beside the
// song the microphone's stream (`ChunkScheduler` over the stream worklet), the browser's own pitch
// four times a second (`PitchFeed`), and the MediaRecorder recording kept as before for when the stream
// does not hold. The one plate it adds is the singer's trend (上升中 / 下降中 / 保持, and whether the
// live score is 正式 or 預估): never a rank, never anyone else's score. The corner number is the
// singer's own running total from the trend once one comes (labelled 正式 or 預估), before that
// the browser's own (預估).

import type { KaraokeRoomView, KaraokeSession, KaraokeSongView } from "@miyoria/contracts/api";
import { useMemo, useRef } from "react";
import { useConnection } from "@/app/connection";
import { cn } from "@/lib/utils";
import type { KaraokeEngine, MicStream } from "./audio";
import { useReducedMotion } from "./bits";
import { postAudio, postPitch } from "./room-api";
import { contextTimeFor } from "./room-clock";
import { AirPlate } from "./RoomAir";
import { CheerNote } from "./RoomCheers";
import { ChunkScheduler, PitchFeed } from "./room-stream";
import { type CheerEvent, stageScore, type TrendEvent, trendView } from "./room-text";
import { type Finished, PLATE, Singing, type StageRoom, type StageRun } from "./Singing";

/**
 * The browser's own pitch goes this often, in ms: it is what the people watching and her stream see
 * of this singer (Core relays it a few times a second), and the estimate.
 */
export const PITCH_EVERY_MS = 250;
/** The worklet's last piece arrives a moment after it is told to stop, in ms. */
const LAST_PIECE_MS = 150;

/** The singer's trend: a direction, and where the live score comes from. Nothing else. */
export function TrendPlate({ trend }: { trend: Pick<TrendEvent, "trend" | "source"> | null }) {
  const reduced = useReducedMotion();
  const view = trendView(trend);
  if (view === null) return null;
  return (
    <div
      className={cn(PLATE, "flex items-center gap-2.5 rounded-full py-1.5 pr-3.5 pl-3 [text-shadow:none]")}
      data-trend={trend?.trend}
      role="status"
      aria-label={`${view.word},${view.source}`}
    >
      <span
        key={trend?.trend}
        aria-hidden
        className={cn(
          "font-mono text-base leading-none font-semibold",
          trend?.trend === "rising" ? "text-primary" : trend?.trend === "dropping" ? "text-secondary-line" : "text-muted-foreground",
          !reduced && "animate-in fade-in-0 slide-in-from-bottom-1 duration-200",
        )}
      >
        {view.mark}
      </span>
      <span className="text-[13px] font-medium">{view.word}</span>
      <span className="rounded-[5px] bg-control px-1.5 py-0.5 text-[11px] text-muted-foreground">{view.source}</span>
    </div>
  );
}

/** What runs beside the song: the stream, the pitch posts. */
function startRun(o: {
  engine: KaraokeEngine;
  songTime: (contextTime: number) => number;
  send: ConstructorParameters<typeof ChunkScheduler>[0];
  pitch: (body: { from: number; track: string }) => Promise<void>;
}): StageRun {
  const scheduler = new ChunkScheduler(o.send, o.songTime);
  const feed = new PitchFeed();
  let mic: MicStream | null = null;
  let cancelled = false;
  void o.engine.micStream().then((m) => {
    if (cancelled || m === null) {
      // No stream from this browser: Core scores it from the estimate and the recording.
      if (m === null) scheduler.stop();
      return;
    }
    mic = m;
    m.start((piece) => scheduler.push(piece));
  });
  let posting = false;
  const post = (final: boolean) => {
    if (posting && !final) return;
    const body = feed.take(o.songTime(o.engine.now()), final);
    if (!body) return;
    posting = true;
    o.pitch(body)
      .catch(() => undefined)
      .finally(() => {
        posting = false;
      });
  };
  const timer = window.setInterval(() => post(false), PITCH_EVERY_MS);
  return {
    detect: (t, midi) => feed.push(t, midi),
    finish: async () => {
      window.clearInterval(timer);
      post(true);
      mic?.stop();
      await new Promise((r) => window.setTimeout(r, LAST_PIECE_MS));
      await scheduler.end();
    },
    cancel: () => {
      cancelled = true;
      window.clearInterval(timer);
      mic?.stop();
      scheduler.stop();
    },
  };
}

export function RoomStage({
  room,
  onRoom,
  code,
  session,
  song,
  startAtMs,
  offset,
  trend,
  cheers = [],
  engine,
  latency,
  floor,
  onFinished,
  onQuit,
}: {
  /** Cheers for this singer from the people watching (never anyone else's, never a rank). */
  cheers?: readonly (CheerEvent & { at: number })[];
  /** The room as this singer sees it (for what goes out on her stream). */
  room: KaraokeRoomView;
  onRoom: (room: KaraokeRoomView) => void;
  code: string;
  session: KaraokeSession;
  song: KaraokeSongView;
  startAtMs: number;
  /** Core's clock less this browser's (ms), or `null` until it is known. */
  offset: () => number | null;
  trend: TrendEvent | null;
  engine: () => KaraokeEngine;
  latency: { latency_ms: number; calibrated: boolean };
  floor: number | null;
  onFinished: (f: Finished) => void;
  onQuit: () => void;
}) {
  const { client } = useConnection();
  const offsetRef = useRef(offset);
  offsetRef.current = offset;
  const plate = (
    <>
      <TrendPlate trend={trend} />
      <CheerNote cheers={cheers} />
      {room.me && <AirPlate room={room} me={room.me} onRoom={onRoom} />}
    </>
  );
  const base = useMemo<Omit<StageRoom, "plate">>(
    () => ({
      session,
      schedule: (audio) => {
        const off = offsetRef.current();
        if (off === null) return null;
        return { at: contextTimeFor(startAtMs, off, audio.heard(), Date.now()), offset: 0 };
      },
      begin: ({ engine: audio, songTime }) =>
        startRun({
          engine: audio,
          songTime,
          send: (chunk) => postAudio(client, code, chunk),
          pitch: (body) => postPitch(client, code, body),
        }),
    }),
    [session, startAtMs, client, code],
  );
  return (
    <Singing
      engine={engine}
      song={song}
      latency={latency}
      floor={floor}
      onFinished={onFinished}
      onQuit={onQuit}
      onCalibrate={() => {}}
      room={{ ...base, plate, score: stageScore(trend) }}
    />
  );
}
