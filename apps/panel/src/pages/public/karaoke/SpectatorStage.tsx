// Watching a room's round (docs/design/karaoke.md 「做了什麼第四步」): the same full-window scene as
// the singing screen, read only. The song's video or the still, its lyrics and reference lane on
// the room's clock (Core's, a couple of seconds behind so the singers' lines have arrived), each
// singer's pitch line in their colour (from the boards), and the live ranking as a plate. The
// backing is muted by default (her stream in Discord carries the sound); 「聽伴奏」 plays it here on
// the same clock. The song's files come from the room: a spectator of a running round gets signed
// links of their own to watch with (`me.session` while `me.singing` is false), never submitted.
// Once the song is over and Core waits for the last results, a plate says 結算中 and for whom.
// The singers' lines come from the boards and, a few times a second, from `live`. Under the
// controls, the watcher cheers a singer (RoomCheers.tsx) and sees the latest cheers.

import { ArrowLeft, LogOut, Maximize, Minimize, Volume2, VolumeX } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { KaraokeBoardLine, KaraokeRoomView, KaraokeSession } from "@miyoria/contracts/api";
import {
  karaokeReferenceV2,
  shiftKaraokeReference,
  type WorkersKaraokeReference,
  type WorkersKaraokeReferenceV2,
} from "@miyoria/contracts/workers/karaoke";
import { describeError, joinUrl } from "@/api/http";
import { useConnection } from "@/app/connection";
import { Dot } from "@/components/status";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { KaraokeEngine } from "./audio";
import { useReducedMotion } from "./bits";
import { LANE_SECONDS, LANE_SECONDS_NARROW, type LaneView, type MidiRange, midiRange, referenceAt } from "./lane";
import { drawLane, drawSingerLines, type LaneColors, laneColors, type SingerLine } from "./lane-draw";
import { HeardBadge, Lyrics, ReadingToggle } from "./Lyrics";
import { loadReading, type ReadingMode, saveReading } from "./lyric-text";
import { clock, score1 } from "./result-text";
import { contextTimeFor, secondsLeft, songTimeByCore } from "./room-clock";
import { CheerBar, CheerList } from "./RoomCheers";
import {
  type BoardEvent,
  type BoardLines,
  type CheerEvent,
  cheerTargets,
  MOVE_MARK,
  MOVE_WORD,
  memberColor,
  SOURCE_WORDS,
  settlingView,
} from "./room-text";
import { EDGE, LAYOUT, PLATE, SAFE, STAGE_BOX } from "./Singing";
import { StageBackground } from "./StageBackground";
import { referenceCurve } from "./take";

/**
 * The view runs this far behind Core's clock (s), as her stream does: the singers' pitch arrives a
 * few times a second, a moment after they sang it.
 */
export const VIEW_DELAY_S = 2;
const TICK_MS = 100;
/** The ranking plate's width on wide screens. */
const BOARD_W = "15.5rem";

interface Loaded {
  session: KaraokeSession;
  reference: WorkersKaraokeReferenceV2;
  range: MidiRange;
}

/** A colour swatch: filled for colours one to five, a ring for six to eight (their lines are dashed). */
export function Swatch({ color, className }: { color: number; className?: string }) {
  const c = memberColor(color);
  return (
    <span
      aria-hidden
      className={cn("inline-block size-2.5 shrink-0 rounded-full", className)}
      style={c.dashed ? { boxShadow: `inset 0 0 0 2px ${c.css}` } : { background: c.css }}
    />
  );
}

/** The live ranking for spectators: place, colour, name, running total, movement, 預估. */
export function Leaderboard({
  lines,
  compact = false,
  onAir = null,
}: {
  lines: readonly KaraokeBoardLine[];
  compact?: boolean;
  /** The member whose voice is on her stream now (spectators may know it). */
  onAir?: string | null;
}) {
  const sorted = [...lines].sort((a, b) => a.rank - b.rank);
  return (
    <ol aria-label="即時排名" className={cn("grid gap-x-3", compact ? "grid-cols-2 gap-y-0.5" : "gap-y-1")} data-board>
      {sorted.map((l) => (
        <li key={l.member} className="flex min-w-0 items-center gap-2 text-[13px] leading-5" data-member={l.member}>
          <span className="w-4 shrink-0 text-right font-mono text-xs text-muted-foreground tabular-nums">{l.rank}</span>
          <Swatch color={l.color} />
          <span className="min-w-0 flex-1 truncate">{l.name}</span>
          {onAir !== null && l.member === onAir && (
            <span className="shrink-0 rounded-[5px] bg-control px-1 text-[11px] text-primary" data-on-air>
              播出中
            </span>
          )}
          {l.source === "estimate" && (
            <span className="shrink-0 rounded-[5px] bg-control px-1 text-[11px] text-muted-foreground">{SOURCE_WORDS.estimate}</span>
          )}
          <span className="shrink-0 font-mono text-[13px] font-semibold tabular-nums">{score1(l.total)}</span>
          <span
            className={cn("w-3 shrink-0 text-center font-mono text-xs", l.move === "up" ? "text-primary" : "text-secondary-line")}
            aria-label={MOVE_WORD[l.move] || undefined}
          >
            {MOVE_MARK[l.move]}
          </span>
        </li>
      ))}
    </ol>
  );
}

const NARROW = "(max-width: 639px)";

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(NARROW).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const q = window.matchMedia(NARROW);
    const on = () => setNarrow(q.matches);
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  return narrow;
}

export function SpectatorStage({
  room,
  board,
  lines,
  cheers = [],
  offset,
  engine,
  onLeave,
}: {
  room: KaraokeRoomView;
  board: BoardEvent | null;
  lines: BoardLines;
  /** The round's latest cheers (with when they came). */
  cheers?: readonly (CheerEvent & { at: number })[];
  /** Core's clock less this browser's (ms), or `null` until it is known. */
  offset: () => number | null;
  engine: () => KaraokeEngine;
  onLeave: () => void;
}) {
  const { config } = useConnection();
  const reduced = useReducedMotion();
  const narrow = useNarrow();
  const song = room.song;
  const startAt = room.start_at_ms;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [now, setNow] = useState(-VIEW_DELAY_S);
  const [listen, setListen] = useState(false);
  const [reading, setReading] = useState<ReadingMode>(() => loadReading());
  const [full, setFull] = useState(false);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const backing = useRef<Promise<number> | null>(null);
  const offsetRef = useRef(offset);
  offsetRef.current = offset;
  const boardRef = useRef(board);
  boardRef.current = board;

  const link = useCallback((u: string) => (/^https?:/.test(u) ? u : joinUrl(config.baseUrl, u)), [config.baseUrl]);

  /** The song time shown now. */
  const viewTime = useCallback(() => {
    if (startAt === null) return -VIEW_DELAY_S;
    return songTimeByCore(startAt, offsetRef.current() ?? 0, Date.now()) - VIEW_DELAY_S;
  }, [startAt]);

  // The song's files: the reference for the lane and the lyrics, the video, the backing on demand,
  // through the files the room gives a spectator of the round (`me.session`, never submitted).
  const watch = room.me?.session ?? null;
  const watchId = watch?.session ?? null;
  // The watch session's id stands for its links (they stay the same while it does); `watch` itself
  // is a new object on every view of the room.
  useEffect(() => {
    if (watch === null || watchId === null) return;
    let alive = true;
    void (async () => {
      try {
        const session = watch;
        const res = await fetch(link(session.reference_url), { credentials: "same-origin" });
        if (!res.ok) throw new Error("這首歌的旋律拿不到");
        const reference = shiftKaraokeReference(karaokeReferenceV2((await res.json()) as WorkersKaraokeReference), session.shift);
        if (!alive) return;
        const linked = { ...session, video_url: session.video_url === null ? null : link(session.video_url) };
        setLoaded({ session: linked, reference, range: midiRange(reference.pitch.midi, reference.notes) });
      } catch (e) {
        if (alive) setProblem(describeError(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [link, watchId]);

  // The backing, when asked for: on the same clock as the view.
  useEffect(() => {
    if (!listen || !loaded || startAt === null) return;
    const audio = engine();
    let alive = true;
    backing.current ??= audio.loadBacking(link(loaded.session.backing_url));
    void backing.current.then(
      () => {
        if (!alive) return;
        const off = offsetRef.current() ?? 0;
        audio.playAt(contextTimeFor(startAt + VIEW_DELAY_S * 1000, off, audio.heard(), Date.now()), 0);
      },
      (e) => {
        backing.current = null;
        if (alive) {
          setListen(false);
          setProblem(describeError(e));
        }
      },
    );
    return () => {
      alive = false;
      audio.stop();
    };
  }, [listen, loaded, startAt, engine, link]);

  // Nothing of the page behind scrolls while the stage is up.
  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const before = [html.style.overflow, body.style.overflow];
    html.style.overflow = "hidden";
    body.style.overflow = "hidden";
    return () => {
      html.style.overflow = before[0] ?? "";
      body.style.overflow = before[1] ?? "";
    };
  }, []);

  useEffect(() => {
    const onChange = () => setFull(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => undefined);
    };
  }, []);

  // The lane every frame (the reference, then each singer's line), the words ten times a second.
  useEffect(() => {
    const el = canvas.current;
    const holder = box.current;
    const ctx = el?.getContext("2d") ?? null;
    const colors: LaneColors | null = el ? laneColors(el) : null;
    const curve = loaded ? referenceCurve(loaded.reference) : null;
    const range = loaded?.range ?? { lo: 48, hi: 72 };
    const swatches = new Map<number, string>();
    const colorOf = (i: number) => {
      const known = swatches.get(i);
      if (known) return known;
      const v = el ? getComputedStyle(el).getPropertyValue(memberColor(i).color).trim() : "";
      const c = v || "#d9609a";
      swatches.set(i, c);
      return c;
    };
    let width = 0;
    let height = 0;
    let dpr = 1;
    let span = LANE_SECONDS;
    const size = () => {
      if (!el || !holder) return;
      width = holder.clientWidth;
      height = holder.clientHeight;
      dpr = Math.min(2, window.devicePixelRatio || 1);
      span = width < 560 ? LANE_SECONDS_NARROW : LANE_SECONDS;
      el.width = Math.round(width * dpr);
      el.height = Math.round(height * dpr);
    };
    size();
    const ro = typeof ResizeObserver === "function" && holder ? new ResizeObserver(size) : null;
    if (holder) ro?.observe(holder);
    let raf = 0;
    let last = 0;
    const frame = (ms: number) => {
      raf = requestAnimationFrame(frame);
      const t = viewTime();
      if (ctx && colors && width > 0 && height > 0) {
        const view: LaneView = { width, height, now: t, span, ...range };
        drawLane(ctx, {
          view,
          reference: curve ?? { hz: 50, start: 0, midi: [] },
          notes: loaded?.reference.notes ?? [],
          trail: [],
          tolerance: loaded?.session.tolerance_cents ?? 50,
          colors,
          dpr,
        });
        const ref = (x: number) => (curve ? referenceAt(curve, x) : null);
        const singers: SingerLine[] = (boardRef.current?.lines ?? []).map((l) => ({
          points: lines.line(l.member, t - span, t + 0.1, ref),
          color: colorOf(l.color),
          dashed: memberColor(l.color).dashed,
        }));
        drawSingerLines(ctx, view, singers, dpr);
      }
      if (ms - last >= TICK_MS) {
        last = ms;
        setNow(t);
      }
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, [loaded, lines, viewTime]);

  const songNow = useCallback(() => ({ time: viewTime(), playing: startAt !== null && viewTime() >= 0 }), [viewTime, startAt]);
  const duration = loaded?.reference.duration_s ?? song?.duration_s ?? 0;
  const progress = duration > 0 ? Math.min(1, Math.max(0, now) / duration) : 0;
  const lyrics = loaded?.reference.lyrics ?? null;
  const waiting = secondsLeft(now);
  // The song is over and Core waits for the last results.
  const settle = room.settling === null ? null : settlingView(room.settling);
  const boardLines = board?.lines ?? [];
  const targets = cheerTargets(boardLines, room.members);
  const canFull = typeof document !== "undefined" && document.fullscreenEnabled === true;
  const toggleFull = () => {
    const req = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
    req?.catch(() => undefined);
  };

  // On a phone the ranking is a strip across the top and the lane goes under it; wider, it stands
  // at the right and the lane stops before it.
  const compact = narrow && boardLines.length > 4;
  const rows = Math.max(1, compact ? Math.ceil(boardLines.length / 2) : boardLines.length);
  const laneStyle = narrow
    ? { ...LAYOUT.lane, top: `calc(${SAFE.top} + ${EDGE} + ${rows * 24 + 44}px)` }
    : { ...LAYOUT.lane, right: `calc(${SAFE.right} + ${EDGE} + ${BOARD_W} + 16px)` };
  const boardStyle = narrow
    ? { top: `calc(${SAFE.top} + ${EDGE})`, left: `calc(${SAFE.left} + 12px)`, right: `calc(${SAFE.right} + 12px)` }
    : { ...LAYOUT.score, width: BOARD_W };

  return (
    <section aria-label={`看 ${song?.title ?? "這一輪"}`} data-stage data-spectator className={STAGE_BOX}>
      <StageBackground url={loaded?.session.video_url ?? null} song={songNow} reduced={reduced} />
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-black/20" />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[45%] bg-[linear-gradient(180deg,rgba(0,0,0,0.5),rgba(0,0,0,0))]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-[55%] bg-[linear-gradient(0deg,rgba(0,0,0,0.78)_0%,rgba(0,0,0,0.5)_45%,rgba(0,0,0,0))]"
      />

      <div ref={box} className="absolute" style={laneStyle}>
        <canvas ref={canvas} className="absolute inset-0 size-full" role="img" aria-label="音高跑道:原唱的旋律和每個人唱的線" />
      </div>
      <div className="absolute" style={LAYOUT.lyrics}>
        <Lyrics lyrics={lyrics} now={now} loaded={loaded !== null} mode={reading} reduced={reduced} />
      </div>
      {waiting > 0 && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <p className="grid justify-items-center gap-1" role="timer" aria-live="off">
            <span
              key={waiting}
              className="animate-in fade-in-0 zoom-in-90 font-mono text-[clamp(40px,12cqmin,96px)] font-semibold tabular-nums duration-300 ease-out motion-reduce:animate-none"
            >
              {waiting}
            </span>
            <span className="text-[13px] text-muted-foreground">秒後開始</span>
          </p>
        </div>
      )}
      {settle !== null && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center p-4 pb-[22cqh]">
          <div
            className={cn(PLATE, "grid max-w-md justify-items-center gap-1 px-5 py-3 text-center [text-shadow:none]")}
            role="status"
            data-settling
          >
            <p className="flex items-center gap-2 text-[15px] font-semibold">
              <Dot tone="brand" pulse={!reduced} />
              {settle.title}
            </p>
            <p className="text-[13px] text-muted-foreground">{settle.detail}</p>
          </div>
        </div>
      )}

      {!narrow && (
        <div className="absolute" style={LAYOUT.title}>
          <div className={cn(PLATE, "grid gap-1 px-3.5 py-2.5 [text-shadow:none]")}>
            <h2 className="flex min-w-0 items-center gap-2 text-[15px] font-semibold tracking-[-0.01em]">
              <span className="truncate">{song?.title ?? "—"}</span>
              <HeardBadge lyrics={lyrics} />
            </h2>
            <p className="truncate text-[13px] text-muted-foreground">
              {[song?.artist, `房間 ${room.code}`, "觀看中"].filter(Boolean).join(" · ")}
            </p>
            {problem && (
              <p role="alert" className="text-xs text-primary">
                {problem}
              </p>
            )}
          </div>
        </div>
      )}

      <div className="absolute" style={boardStyle}>
        <div className={cn(PLATE, "grid gap-2 px-3 py-2 [text-shadow:none]")}>
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-[13px] font-medium">即時排名</h3>
            <span className="font-mono text-xs text-muted-foreground tabular-nums">
              {clock(Math.max(0, now))} / {clock(duration)}
            </span>
          </div>
          {boardLines.length === 0 ? (
            <p className="text-xs text-muted-foreground">開始唱之後會出現</p>
          ) : (
            <Leaderboard lines={boardLines} compact={compact} onAir={room.air.relay.member} />
          )}
          <CheerList cheers={cheers} singers={targets} />
        </div>
      </div>

      <div className="absolute flex justify-center" style={LAYOUT.bar}>
        <div role="toolbar" aria-label="觀看的控制" className={cn(PLATE, "flex max-w-full flex-wrap items-center justify-center gap-1 px-2 py-1.5 [text-shadow:none]")}>
          {settle === null && (
            <>
              <CheerBar code={room.code} singers={targets} />
              <span aria-hidden className="mx-1 h-4 w-px bg-border max-sm:hidden" />
            </>
          )}
          <Button
            variant={listen ? "outline" : "ghost"}
            size="sm"
            aria-pressed={listen}
            onClick={() => setListen((v) => !v)}
            disabled={!loaded || startAt === null}
          >
            {listen ? <Volume2 aria-hidden /> : <VolumeX aria-hidden />}
            聽伴奏
          </Button>
          <ReadingToggle
            lyrics={lyrics}
            mode={reading}
            onMode={(m) => {
              saveReading(m);
              setReading(m);
            }}
          />
          {canFull && (
            <Button variant="ghost" size="icon-sm" onClick={toggleFull} aria-label={full ? "離開全螢幕" : "全螢幕"}>
              {full ? <Minimize aria-hidden /> : <Maximize aria-hidden />}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onLeave} aria-label="離開房間" title="離開房間">
            {narrow ? <ArrowLeft aria-hidden /> : <LogOut aria-hidden />}
            <span className="max-sm:sr-only">離開</span>
          </Button>
        </div>
      </div>

      <div
        role="meter"
        aria-label="歌曲進度"
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={Number(progress.toFixed(2))}
        className="absolute inset-x-0 bottom-0 h-[3px] bg-white/12"
      >
        <div className="h-full bg-white/70" style={{ width: `${progress * 100}%` }} />
      </div>
    </section>
  );
}
