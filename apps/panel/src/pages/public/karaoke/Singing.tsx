// The singing screen, a karaoke box after the owner's own app, laid out like a stream scene: the
// whole window (over the panel's own frame) is the stage, the song's video (or a still) covers it
// edge to edge, and everything else floats over it in layers, the way the stream overlay composes
// its plates over the picture. Always there while singing: the pitch lane across the upper part,
// the two lyric lines low in the middle over a soft scrim, and one small corner plate with the
// running number (預估) and the time. The title plate, the notes and the bar of controls come on
// demand (`chrome.ts`): before the start and after the end, on pointer movement, an edge, keyboard
// focus, `Esc` or a tap, and go again after a moment. `f` (or the button) asks for real fullscreen.
//
// The backing track plays through Web Audio, the microphone goes through the pitch worklet, and,
// when the session allows, is recorded for the official score. Before the start the key can be
// moved (the Core has the worker render the backing in it; the reference moves here by the same).
// There is no pause: the recording is one stretch of the song. At the song's end (or 「唱完了」)
// the track is encoded and handed on with the recording; nothing is sent while singing.
//
// In a room (`room`, docs/design/karaoke.md 「做了什麼第四步」) the stage is the same, with the
// round's session given, the key the room's, and no start button: the backing starts by itself at
// the room's moment (a countdown before it), there is no restart, and what the room runs beside
// the song (the microphone's stream, the pitch posts) starts with it and ends with it. Its one
// extra plate, under the number, is the singer's trend; there is never a ranking here.

import {
  ArrowLeft,
  Check,
  LogOut,
  Maximize,
  Minimize,
  Minus,
  Play,
  Plus,
  RotateCcw,
  Timer,
} from "lucide-react";
import { type CSSProperties, type PointerEvent, type ReactNode, useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { KaraokeSession, KaraokeSongView, KaraokeSubmit } from "@miyoria/contracts/api";
import {
  KARAOKE_MAX_SHIFT,
  karaokeReferenceV2,
  shiftKaraokeReference,
  type WorkersKaraokeReference,
  type WorkersKaraokeReferenceV2,
} from "@miyoria/contracts/workers/karaoke";
import type { ScoreResult } from "@miyoria/play/karaoke/score";
import { describeError, joinUrl } from "@/api/http";
import { useConnection } from "@/app/connection";
import { ConfirmDialog } from "@/components/confirm";
import { Dot } from "@/components/status";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { KaraokeEngine } from "./audio";
import { HeadphonesLine, PrivacyLine, useReducedMotion } from "./bits";
import { CHROME_START, chromeHidesIn, chromeReduce, chromeShown, nearEdge } from "./chrome";
import { SongClock } from "./clock";
import { LANE_SECONDS, LANE_SECONDS_NARROW, type LaneView, type MidiRange, midiRange } from "./lane";
import { drawLane, type LaneColors, laneColors } from "./lane-draw";
import { noiseFloor } from "./latency";
import { HeardBadge, Lyrics, ReadingToggle } from "./Lyrics";
import { keyLabel, loadKey, loadReading, type ReadingMode, saveKey, saveReading } from "./lyric-text";
import type { RecorderState, VoiceRecorder, VoiceTake } from "./recorder";
import { clock, score1 } from "./result-text";
import { secondsLeft } from "./room-clock";
import { SOURCE_WORDS, type StageScore } from "./room-text";
import { StageBackground } from "./StageBackground";
import { browserName, micError } from "./support";
import { finishTake, phrasesOf, referenceCurve, Take } from "./take";

/** What a finished singing hands on: to be sent, and the number shown until Core answers. */
export interface Finished {
  session: string;
  song: { id: string; title: string; artist: string | null };
  body: KaraokeSubmit;
  provisional: ScoreResult | null;
  /** The lyric lines' words, for the phrases of the number shown meanwhile. */
  lines: string[];
  /** The recording of the singer, sent once after the result; `null` without one. */
  voice: VoiceTake | null;
}

type Phase =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready" }
  | { kind: "playing" }
  | { kind: "finishing" };

interface Loaded {
  session: KaraokeSession;
  /** In version 2's shape, moved to the session's key. */
  reference: WorkersKaraokeReferenceV2;
  duration: number;
  range: MidiRange;
  /** Records the singer for the official score; `null` when the session or the browser does not. */
  recorder: VoiceRecorder | null;
}

/** How often the words and numbers on the stage are refreshed. */
const TICK_MS = 100;
/** How long the end of a room's stream is waited for before the result goes, in ms. */
const RUN_FINISH_WAIT_MS = 3_000;
/**
 * The song's end is looked for this often by a timer, besides every frame: a page that draws no
 * frames (a tab in the background, a window covered by another, a phone's screen off) still plays
 * the backing, and its timers still run (once a second at worst), so the take is still sent.
 */
export const END_CHECK_MS = 250;
/** The end is this long after the backing's last moment, in seconds. */
const END_PAST_S = 0.3;

/** What a room adds to the stage: the round's session, the shared start, and one plate. */
export interface StageRoom {
  /** The round's session (signed links), as a singer alone gets from starting a song. */
  session: KaraokeSession;
  /**
   * The context time the backing must start at and the song time there, worked out on the
   * engine's clock; `null` while Core's clock is not known yet (asked again shortly).
   */
  schedule: (engine: KaraokeEngine) => { at: number; offset: number } | null;
  /** The song is scheduled: what runs beside it until the end. `songTime` reads any context time. */
  begin: (o: { engine: KaraokeEngine; songTime: (contextTime: number) => number }) => StageRun;
  /** The plate under the number: the singer's trend. */
  plate?: ReactNode;
  /**
   * The singer's own running total from Core (正式 from the stream, 預估 from the browser's pitch),
   * shown instead of the browser's own number once there is one.
   */
  score?: StageScore | null;
}

/** What a room runs beside the song. */
export interface StageRun {
  /** A detection at song time `t`. */
  detect(t: number, midi: number | null): void;
  /** The song ended (or 唱完了): the last of it goes. */
  finish(): Promise<void>;
  /** They left: everything stops, nothing more goes. */
  cancel(): void;
}

/**
 * The stage: the whole window, over the panel's frame (dialogs stay above it). It is a size
 * container, so the lane and the lyrics are sized by its width and its height (a phone held
 * sideways is short).
 */
export const STAGE_BOX =
  "fixed inset-0 z-40 isolate overflow-hidden bg-black text-white [container-type:size] [text-shadow:0_1px_3px_rgba(0,0,0,0.9)]";

/** The safe area (a notch, rounded corners) plus a margin, as CSS. */
export const SAFE = {
  top: "env(safe-area-inset-top, 0px)",
  right: "env(safe-area-inset-right, 0px)",
  bottom: "env(safe-area-inset-bottom, 0px)",
  left: "env(safe-area-inset-left, 0px)",
};
export const EDGE = "max(12px, 2.2cqmin)";

/** Where each layer sits over the picture. */
export const LAYOUT: Record<"title" | "score" | "lane" | "lyrics" | "bar", CSSProperties> = {
  title: { top: `calc(${SAFE.top} + ${EDGE})`, left: `calc(${SAFE.left} + ${EDGE})`, maxWidth: "min(26rem, 58cqw)" },
  score: { top: `calc(${SAFE.top} + ${EDGE})`, right: `calc(${SAFE.right} + ${EDGE})` },
  lane: {
    top: `calc(${SAFE.top} + max(60px, 15cqh))`,
    left: `calc(${SAFE.left} + max(16px, 5cqw))`,
    right: `calc(${SAFE.right} + max(16px, 5cqw))`,
    height: "clamp(64px, 24cqh, 240px)",
  },
  lyrics: {
    bottom: `calc(${SAFE.bottom} + max(64px, 11cqh))`,
    left: `calc(${SAFE.left} + max(12px, 5cqw))`,
    right: `calc(${SAFE.right} + max(12px, 5cqw))`,
  },
  bar: {
    bottom: `calc(${SAFE.bottom} + ${EDGE})`,
    left: `calc(${SAFE.left} + 12px)`,
    right: `calc(${SAFE.right} + 12px)`,
  },
};

/** A plate over the picture: the overlay's floating glass, in the panel's colours. */
export const PLATE = "glass-float rounded-[14px]";

/** Fades a layer that comes on demand; under reduced motion it just shows or goes. */
function onDemand(shown: boolean): string {
  return cn(
    "transition-[opacity,translate] duration-200 ease-out motion-reduce:transition-none",
    shown ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-1.5 opacity-0",
  );
}

/** Whether a key press came from something that takes typing or its own keys. */
function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(el?.closest?.("input, textarea, select, [contenteditable=true], [role=slider], [role=radio]"));
}

/** Whether keyboard focus (not a click) is on one of the controls under `root`. */
function keyboardOnChrome(root: HTMLElement | null): boolean {
  if (!root) return false;
  try {
    return root.querySelector("[data-chrome] :focus-visible") !== null;
  } catch {
    return false;
  }
}

export function Singing({
  engine,
  song,
  latency,
  floor: knownFloor,
  onFinished,
  onQuit,
  onCalibrate,
  room,
}: {
  engine: () => KaraokeEngine;
  song: KaraokeSongView;
  latency: { latency_ms: number; calibrated: boolean };
  /** The room's level from the calibration, when there is one. */
  floor: number | null;
  onFinished: (f: Finished) => void;
  onQuit: () => void;
  onCalibrate: () => void;
  /** A room's round: its session, its start and its plate (`StageRoom`). */
  room?: StageRoom;
}) {
  const { api, config } = useConnection();
  const reduced = useReducedMotion();
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [tick, setTick] = useState<{ now: number; score: number; rec: RecorderState }>({
    now: 0,
    score: 0,
    rec: "idle",
  });
  const [quitting, setQuitting] = useState(false);
  const [shift, setShift] = useState(() => (room ? room.session.shift : loadKey(song.id, KARAOKE_MAX_SHIFT)));
  const roomRef = useRef(room);
  roomRef.current = room;
  const roomSession = room?.session ?? null;
  const runRef = useRef<StageRun | null>(null);
  const [reading, setReading] = useState<ReadingMode>(() => loadReading());
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const clockRef = useRef(new SongClock());
  const take = useRef<Take | null>(null);
  const alive = useRef(true);
  const recWait = useRef<number>(0);
  /** The key a session was started for, and which load is the latest. */
  const started = useRef<number | null>(null);
  const loadToken = useRef(0);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;

  // Load once per key: the session's signed links, the reference, the backing track. Meanwhile the
  // room is listened to for its level.
  useEffect(() => {
    alive.current = true;
    if (started.current === shift) return () => void (alive.current = false);
    started.current = shift;
    const token = ++loadToken.current;
    const audio = engine();
    const levels: number[] = [];
    const off = audio.onDetection((d) => levels.push(d.level));
    const link = (u: string) => (/^https?:/.test(u) ? u : joinUrl(config.baseUrl, u));
    void (async () => {
      try {
        // A room's singer may not have opened the microphone here yet (it is opened with 準備好了).
        if (roomSession) {
          try {
            await audio.openMic();
          } catch (e) {
            throw new Error(micError(e));
          }
        }
        const session = roomSession ?? (await api.rpc.karaoke.start({ params: { id: song.id }, body: { shift } }));
        const res = await fetch(link(session.reference_url), { credentials: "same-origin" });
        if (!res.ok) throw new Error("這首歌的旋律拿不到");
        // Version 1 or 2, in version 2's shape, moved to the key the backing is in.
        const reference = shiftKaraokeReference(
          karaokeReferenceV2((await res.json()) as WorkersKaraokeReference),
          session.shift,
        );
        const duration = await audio.loadBacking(link(session.backing_url));
        if (token !== loadToken.current) return;
        off();
        const measured = levels.length >= 40 ? noiseFloor(levels) : null;
        audio.setFloor(Math.min(measured ?? Number.POSITIVE_INFINITY, knownFloor ?? measured ?? 0.002));
        take.current = new Take(referenceCurve(reference), {
          tolerance_cents: session.tolerance_cents,
          latency_ms: latency.latency_ms,
          calibrated: latency.calibrated,
          phrases: phrasesOf(reference),
        });
        const range = midiRange(reference.pitch.midi, reference.notes);
        if (!alive.current || token !== loadToken.current) return;
        loadedRef.current?.recorder?.cancel();
        // The recording is placed by the same clock as the pitch track: the context's.
        const recorder = session.recording
          ? audio.recorder(session.recording, () => clockRef.current.songTime(audio.now()))
          : null;
        const linked = { ...session, video_url: session.video_url === null ? null : link(session.video_url) };
        setLoaded({ session: linked, reference, duration: Math.max(duration, 1), range, recorder });
        setPhase({ kind: "ready" });
      } catch (e) {
        off();
        if (alive.current && token === loadToken.current) setPhase({ kind: "error", message: describeError(e) });
      }
    })();
    return () => void (alive.current = false);
  }, [api, config.baseUrl, engine, song.id, latency.latency_ms, latency.calibrated, knownFloor, shift, roomSession]);

  /** Another key, before the start: a new session with the backing in it. */
  const moveKey = (by: number) => {
    const next = Math.max(-KARAOKE_MAX_SHIFT, Math.min(KARAOKE_MAX_SHIFT, shift + by));
    if (next === shift || phase.kind !== "ready") return;
    saveKey(song.id, next);
    setLoaded(null);
    setPhase({ kind: "loading" });
    setShift(next);
  };
  const chooseReading = (m: ReadingMode) => {
    saveReading(m);
    setReading(m);
  };

  // Detections go to the take by the moment they were captured.
  useEffect(() => {
    if (!loaded) return;
    return engine().onDetection((d) => {
      if (phaseRef.current.kind !== "playing") return;
      const t = clockRef.current.songTimeAt(d.t);
      if (t === null || t < 0) return;
      take.current?.push(t, d.midi);
      runRef.current?.detect(t, d.midi);
    });
  }, [engine, loaded]);

  // Leaving the screen: the backing stops, a recording is thrown away, a room's stream stops.
  useEffect(
    () => () => {
      window.clearTimeout(recWait.current);
      loadedRef.current?.recorder?.cancel();
      runRef.current?.cancel();
      runRef.current = null;
      engine().stop();
    },
    [engine],
  );

  /** The recorder starts when the backing does (context time `at`), anew on a restart. */
  const recordFrom = (at: number) => {
    const r = loaded?.recorder;
    window.clearTimeout(recWait.current);
    if (!r) return;
    recWait.current = window.setTimeout(() => r.start(), Math.max(0, (at - engine().now()) * 1000));
  };

  // Once per take: the frame, the timer and 唱完了 may all ask in the same moment, before the
  // phase they set has been rendered.
  const finishing = useRef(false);
  const finish = useCallback(async () => {
    const t = take.current;
    if (!loaded || !t || finishing.current || phaseRef.current.kind !== "playing") return;
    finishing.current = true;
    const audio = engine();
    clockRef.current.pause(audio.now());
    audio.stop();
    window.clearTimeout(recWait.current);
    phaseRef.current = { kind: "finishing" };
    setPhase({ kind: "finishing" });
    try {
      // A room's stream ends with its last chunk (waited on a little, so Core knows before the result).
      const run = runRef.current;
      runRef.current = null;
      const ended = run
        ? Promise.race([run.finish().catch(() => undefined), new Promise((r) => window.setTimeout(r, RUN_FINISH_WAIT_MS))])
        : Promise.resolve();
      const stopped = loaded.recorder ? loaded.recorder.stop().catch(() => null) : Promise.resolve(null);
      const [voice] = await Promise.all([stopped, ended]);
      const done = await finishTake(t, {
        calibrated: latency.calibrated,
        phrases: phrasesOf(loaded.reference),
        tolerance_cents: loaded.session.tolerance_cents,
        browser: browserName(navigator.userAgent),
      });
      const { id, title, artist } = loaded.session.song;
      const lines = (loaded.reference.lyrics?.lines ?? []).map((l) => l.text);
      onFinished({
        session: loaded.session.session,
        song: { id, title, artist },
        lines,
        body: { ...done.body, recording: voice !== null },
        provisional: done.provisional,
        voice,
      });
    } catch (e) {
      // Never silently stuck on 「唱完了」: say what went wrong.
      if (alive.current) setPhase({ kind: "error", message: `這次唱的沒有送出:${describeError(e)}` });
    }
  }, [engine, loaded, latency.calibrated, onFinished]);
  const finishRef = useRef(finish);
  finishRef.current = finish;

  // The song's end by a timer as well as by the frames (`END_CHECK_MS`).
  const isPlaying = phase.kind === "playing";
  useEffect(() => {
    if (!isPlaying || !loaded) return;
    const audio = engine();
    const timer = window.setInterval(() => {
      if (clockRef.current.songTime(audio.heard()) >= loaded.duration + END_PAST_S) void finishRef.current();
    }, END_CHECK_MS);
    return () => window.clearInterval(timer);
  }, [isPlaying, loaded, engine]);

  const start = () => {
    if (phase.kind !== "ready" || roomRef.current) return;
    const at = engine().play(0);
    clockRef.current.start(at, 0);
    recordFrom(at);
    setPhase({ kind: "playing" });
  };
  const restart = () => {
    if (!take.current || phase.kind !== "playing" || roomRef.current) return;
    const audio = engine();
    audio.stop();
    take.current.restart();
    const at = audio.play(0);
    clockRef.current.start(at, 0);
    recordFrom(at);
  };
  const startRef = useRef(start);
  startRef.current = start;

  // A room's round starts by itself at the room's moment, once Core's clock is known.
  const ready = phase.kind === "ready";
  useEffect(() => {
    if (!ready || !roomRef.current) return;
    const audio = engine();
    let timer = 0;
    const tryStart = () => {
      const r = roomRef.current;
      if (!r || phaseRef.current.kind !== "ready") return;
      const when = r.schedule(audio);
      if (when === null) {
        timer = window.setTimeout(tryStart, 200);
        return;
      }
      const started = audio.playAt(when.at, when.offset);
      clockRef.current.start(started.at, started.offset);
      recordFrom(started.at);
      runRef.current = r.begin({ engine: audio, songTime: (t) => clockRef.current.songTime(t) });
      setPhase({ kind: "playing" });
    };
    tryStart();
    return () => window.clearTimeout(timer);
    // `recordFrom` reads `loaded`, which is set before the phase is ready.
  }, [ready, engine]);

  // ---- the controls on demand, and fullscreen ----

  const root = useRef<HTMLElement | null>(null);
  const [chrome, sendChrome] = useReducer(chromeReduce, CHROME_START);
  const [pointerHold, setPointerHold] = useState(false);
  const [focusHold, setFocusHold] = useState(false);
  const [full, setFull] = useState(false);
  const [, look] = useReducer((n: number) => n + 1, 0);
  const canFull = typeof document !== "undefined" && document.fullscreenEnabled === true;
  const hold = {
    idle: phase.kind !== "playing",
    focus: pointerHold || focusHold,
    dialog: quitting,
  };
  const nowMs = performance.now();
  const shown = chromeShown(chrome, hold, nowMs);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const hidesIn = chromeHidesIn(chrome, hold, nowMs);

  // Look again when they are due to go.
  useEffect(() => {
    if (hidesIn === null) return;
    const t = window.setTimeout(look, hidesIn + 20);
    return () => window.clearTimeout(t);
  }, [hidesIn]);

  const toggleFull = useCallback(() => {
    if (!canFull) return;
    // The whole document, so dialogs (in the page's body) stay above the stage.
    const req = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
    req?.catch(() => undefined);
  }, [canFull]);

  useEffect(() => {
    const onChange = () => {
      setFull(document.fullscreenElement !== null && document.fullscreenElement !== undefined);
      sendChrome({ type: "activity", at: performance.now() });
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => undefined);
    };
  }, []);

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

  // Keys: any key shows the controls; Space starts; `f` fullscreen; `Esc` shows them (the browser
  // leaves fullscreen on its own).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      sendChrome({ type: "activity", at: performance.now() });
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "Escape") {
        if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => undefined);
        return;
      }
      if (typing(e.target)) return;
      if ((e.key === "f" || e.key === "F") && !(e.target as HTMLElement | null)?.closest?.("button")) {
        e.preventDefault();
        toggleFull();
        return;
      }
      if (e.code === "Space" && phaseRef.current.kind === "ready") {
        if ((e.target as HTMLElement | null)?.closest?.("button")) return;
        e.preventDefault();
        startRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleFull]);

  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    if (e.pointerType === "touch") return;
    sendChrome({ type: "activity", at: performance.now() });
    const rect = e.currentTarget.getBoundingClientRect();
    const onControl = (e.target as HTMLElement).closest?.("[data-chrome]") !== null;
    setPointerHold(onControl || nearEdge(e.clientY - rect.top, rect.height));
  };
  const onPointerUp = (e: PointerEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest?.("[data-chrome]")) return;
    if (e.pointerType === "touch") sendChrome({ type: "tap", at: performance.now(), shown: shownRef.current });
    else sendChrome({ type: "activity", at: performance.now() });
  };
  const onFocusChange = () => {
    // After the focus has moved.
    queueMicrotask(() => setFocusHold(keyboardOnChrome(root.current)));
  };

  // The lane, every frame; the words and numbers on the stage, ten times a second.
  useEffect(() => {
    if (!loaded) return;
    const el = canvas.current;
    const holder = box.current;
    const ctx = el?.getContext("2d") ?? null;
    const audio = engine();
    const colors: LaneColors | null = el ? laneColors(el) : null;
    const curve = referenceCurve(loaded.reference);
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
      const now = clockRef.current.songTime(audio.heard());
      if (ctx && colors && width > 0 && height > 0) {
        const view: LaneView = { width, height, now, span, ...loaded.range };
        drawLane(ctx, {
          view,
          reference: curve,
          notes: loaded.reference.notes,
          trail: take.current?.trail ?? [],
          tolerance: loaded.session.tolerance_cents,
          colors,
          dpr,
        });
      }
      if (ms - last >= TICK_MS) {
        last = ms;
        setTick({ now, score: take.current?.running.score ?? 0, rec: loaded.recorder?.state ?? "idle" });
      }
      if (phaseRef.current.kind === "playing" && now >= loaded.duration + END_PAST_S) void finishRef.current();
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, [engine, loaded]);

  /** What the video follows: the song's time as heard, and whether it plays. */
  const songNow = useCallback(
    () => ({ time: clockRef.current.songTime(engine().heard()), playing: phaseRef.current.kind === "playing" }),
    [engine],
  );

  const duration = loaded?.duration ?? song.duration_s ?? 0;
  const playing = phase.kind === "playing";
  const lyrics = loaded?.reference.lyrics ?? null;
  const recordable = (loaded?.session.recording ?? null) !== null;
  const recording = (loaded?.recorder ?? null) !== null;
  const progress = duration > 0 ? Math.min(1, Math.max(0, tick.now) / duration) : 0;
  // The title shows with the controls, and on its own for the song's first seconds.
  const titleShown = shown || (playing && tick.now < 5);

  const leave = () => {
    window.clearTimeout(recWait.current);
    loaded?.recorder?.cancel();
    runRef.current?.cancel();
    runRef.current = null;
    engine().stop();
    onQuit();
  };
  const inRoom = room !== undefined;
  const waiting = inRoom && playing ? secondsLeft(tick.now) : 0;
  // The corner number: Core's own total for this singer when a room gives one, else the browser's.
  const core = room?.score ?? null;
  const sung = phase.kind === "playing" || phase.kind === "finishing";
  const scoreLabel = core ? SOURCE_WORDS[core.source] : SOURCE_WORDS.estimate;
  const scoreText = core && sung ? score1(core.total) : sung ? String(tick.score) : "—";

  return (
    <section
      ref={root}
      aria-label={`唱 ${song.title}`}
      data-stage
      data-chrome-shown={shown ? "" : undefined}
      className={cn(STAGE_BOX, !shown && "cursor-none")}
      onPointerMove={onPointerMove}
      onPointerLeave={() => setPointerHold(false)}
      onPointerUp={onPointerUp}
      onFocus={onFocusChange}
      onBlur={onFocusChange}
    >
      {/* Layer 1, the picture: the video or the still, a light dim, a scrim under the lane and the lyrics. */}
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

      {/* Layer 2, always there: the lane and the lyrics. */}
      <div ref={box} className="absolute" style={LAYOUT.lane}>
        <canvas
          ref={canvas}
          className="absolute inset-0 size-full"
          role="img"
          aria-label="音高跑道:原唱的旋律和你唱的線"
        />
      </div>
      <div className="absolute" style={LAYOUT.lyrics}>
        <Lyrics lyrics={lyrics} now={tick.now} loaded={loaded !== null} mode={reading} reduced={reduced} />
      </div>
      {phase.kind === "loading" && (
        <p className="absolute inset-0 grid place-items-center text-[15px]">準備伴唱帶中,先不要出聲</p>
      )}
      {inRoom && phase.kind === "ready" && (
        <p className="absolute inset-0 grid place-items-center text-[15px]">對時中,馬上開始</p>
      )}
      {waiting > 0 && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center pb-[22cqh]" data-countdown>
          <p className="grid justify-items-center gap-1" role="timer" aria-live="off">
            <span
              key={waiting}
              className="animate-in fade-in-0 zoom-in-90 font-mono text-[clamp(40px,12cqmin,96px)] font-semibold tabular-nums duration-300 ease-out motion-reduce:animate-none"
            >
              {waiting}
            </span>
            <span className="text-[13px] text-muted-foreground">秒後一起開始</span>
          </p>
        </div>
      )}
      {phase.kind === "error" && (
        <div className="absolute inset-0 grid place-items-center p-4">
          <div className={cn(PLATE, "grid max-w-md gap-3 p-5 [text-shadow:none]")}>
            <p className="text-[15px] font-semibold">{song.title}</p>
            <p role="alert" className="text-[13px] text-primary">
              {phase.message}
            </p>
            <div>
              <Button variant="outline" size="sm" onClick={onQuit}>
                <ArrowLeft aria-hidden />
                回到歌單
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Layer 3, corner plates: the title (on demand), the number and the time (always). */}
      {/* On a narrow phone the number's plate takes the top row, so the title goes under it. */}
      <div data-chrome className={cn("absolute max-sm:mt-12", onDemand(titleShown))} style={LAYOUT.title}>
        <div className={cn(PLATE, "grid gap-1 px-3.5 py-2.5 [text-shadow:none]")}>
          <h2 className="flex min-w-0 items-center gap-2 text-[15px] font-semibold tracking-[-0.01em]">
            <span className="truncate">{song.title}</span>
            <HeardBadge lyrics={lyrics} />
          </h2>
          {song.artist && <p className="truncate text-[13px] text-muted-foreground">{song.artist}</p>}
          {shown && (
            <div className="mt-1.5 grid gap-1 border-t border-line-soft pt-2 text-xs [&_p]:text-xs [&_svg]:size-3.5">
              <HeadphonesLine />
              {inRoom ? (
                <p className="text-muted-foreground">唱的時候麥克風的聲音會即時送去算分,算完不保存</p>
              ) : (
                <PrivacyLine recording={recording} />
              )}
              {recordable && loaded !== null && !recording && (
                <p className="text-muted-foreground">這個瀏覽器不能錄音,這次只有預估分數</p>
              )}
              <p className="flex items-center gap-3 pt-0.5 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <i className="h-1 w-3.5 rounded-full bg-white/85" />
                  原唱
                </span>
                <span className="flex items-center gap-1.5">
                  <i className="h-1 w-3.5 rounded-full bg-primary" />你
                </span>
              </p>
            </div>
          )}
        </div>
      </div>

      {phase.kind !== "error" && (
        <div
          className={cn(PLATE, "absolute flex items-center gap-4 rounded-full py-1.5 pr-4 pl-3.5 [text-shadow:none]")}
          style={LAYOUT.score}
          data-score
        >
          {playing && recording && tick.rec === "recording" && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground" title="錄音中">
              <Dot tone="brand" pulse={!reduced} />
              <span className="max-sm:sr-only">錄音中</span>
            </span>
          )}
          <dl className="flex items-center gap-4">
            <div className="flex items-baseline gap-2" data-score-source={core?.source ?? "browser"}>
              <dt className="text-xs text-muted-foreground">{scoreLabel}</dt>
              <dd className="min-w-[2ch] font-mono text-lg font-semibold tabular-nums" aria-live="off">
                {scoreText}
              </dd>
            </div>
            <div className="flex items-baseline">
              <dt className="sr-only">時間</dt>
              <dd className="font-mono text-xs text-muted-foreground tabular-nums">
                {clock(Math.max(0, tick.now))} / {clock(duration)}
              </dd>
            </div>
          </dl>
        </div>
      )}
      {(room?.plate || tick.rec === "over") && phase.kind !== "error" && (
        <div
          className="absolute grid justify-items-end gap-2"
          style={{ ...LAYOUT.score, top: `calc(${SAFE.top} + ${EDGE} + 44px)` }}
        >
          {room?.plate}
          {tick.rec === "over" && (
            <p className={cn(PLATE, "rounded-full px-3 py-1 text-xs [text-shadow:none]")}>
              錄音超過上限,這次只有預估分數
            </p>
          )}
        </div>
      )}

      {/* Layer 4, on demand: the bar of controls, bottom centre. */}
      {phase.kind !== "error" && (
        <div className="absolute flex justify-center" style={LAYOUT.bar}>
          <div
            role="toolbar"
            aria-label="唱歌的控制"
            data-chrome
            className={cn(
              PLATE,
              "flex max-w-full flex-wrap items-center justify-center gap-1 px-2 py-1.5 [text-shadow:none]",
              onDemand(shown),
            )}
          >
            {inRoom && (phase.kind === "ready" || phase.kind === "loading") ? null : phase.kind === "ready" ||
              phase.kind === "loading" ? (
              <Button size="sm" onClick={start} disabled={phase.kind !== "ready"}>
                <Play aria-hidden />
                開始
              </Button>
            ) : (
              <>
                {!inRoom && (
                  <Button variant="ghost" size="sm" onClick={restart} disabled={!playing} aria-label="從頭開始">
                    <RotateCcw aria-hidden />
                    <Label>從頭開始</Label>
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void finish()}
                  disabled={!playing || waiting > 0}
                  busy={phase.kind === "finishing"}
                >
                  <Check aria-hidden />
                  唱完了
                </Button>
              </>
            )}
            <Divider />
            {inRoom ? (
              <span className="px-2 font-mono text-[13px] text-muted-foreground tabular-nums" title="房間的調">
                {keyLabel(shift)}
              </span>
            ) : (
              <KeyControl
                shift={shift}
                can={phase.kind === "ready"}
                busy={phase.kind === "loading" && started.current !== null && loaded === null}
                onMove={moveKey}
              />
            )}
            <ReadingToggle lyrics={lyrics} mode={reading} onMode={chooseReading} />
            <Divider />
            {phase.kind === "ready" && !inRoom && (
              <Button variant="ghost" size="sm" onClick={onCalibrate} aria-label="校正延遲" title="校正延遲">
                <Timer aria-hidden />
                <Label>校正延遲</Label>
              </Button>
            )}
            {canFull && (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={toggleFull}
                aria-label={full ? "離開全螢幕" : "全螢幕"}
                title={full ? "離開全螢幕(F)" : "全螢幕(F)"}
              >
                {full ? <Minimize aria-hidden /> : <Maximize aria-hidden />}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => (playing ? setQuitting(true) : leave())}
              disabled={phase.kind === "finishing"}
              aria-label="離開"
              title="離開"
            >
              <LogOut aria-hidden />
              <Label>離開</Label>
            </Button>
          </div>
        </div>
      )}

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

      <ConfirmDialog
        open={quitting}
        title={inRoom ? "離開房間" : "離開這首歌"}
        confirmLabel="離開"
        onConfirm={() => {
          setQuitting(false);
          leave();
        }}
        onClose={() => setQuitting(false)}
      >
        {inRoom ? "這次唱的不會送出,也不會記分;你會離開這個房間。" : "這次唱的不會送出,也不會記分。"}
      </ConfirmDialog>
    </section>
  );
}

/** A button's words: kept for assistive technology, shown from `sm` on. */
function Label({ children }: { children: ReactNode }) {
  return <span className="max-sm:sr-only">{children}</span>;
}

function Divider() {
  return <span aria-hidden className="mx-0.5 h-5 w-px bg-line-strong max-sm:hidden" />;
}

/** − key + : before the start only (the backing is made again for each key). */
function KeyControl({
  shift,
  can,
  busy,
  onMove,
}: {
  shift: number;
  can: boolean;
  busy: boolean;
  onMove: (by: number) => void;
}) {
  const why = can ? undefined : "開始前才能換調";
  return (
    <div role="group" aria-label="升降調" className="flex items-center gap-1">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="降半音"
        title={why ?? "降半音"}
        disabled={!can || shift <= -KARAOKE_MAX_SHIFT}
        onClick={() => onMove(-1)}
      >
        <Minus aria-hidden />
      </Button>
      <span
        aria-live="polite"
        className={cn("w-10 text-center font-mono text-[13px] tabular-nums", busy && "text-muted-foreground")}
      >
        {keyLabel(shift)}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="升半音"
        title={why ?? "升半音"}
        disabled={!can || shift >= KARAOKE_MAX_SHIFT}
        onClick={() => onMove(1)}
      >
        <Plus aria-hidden />
      </Button>
    </div>
  );
}
