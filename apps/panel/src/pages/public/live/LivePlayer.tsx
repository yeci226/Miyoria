import { Heart, Hand, Maximize, Minimize, Pause, Play, Volume2, VolumeX } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Dot } from "@/components/status";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { LiveSpot } from "./feed";
import { attachStream } from "./stream";
import { type Box, contentBox, spotAt } from "./touch";

/** A touch to show on the picture: `own` is this viewer's (a hand and a heart), else a small hand. */
export interface Spot extends LiveSpot {
  id: number;
  own: boolean;
}

/**
 * What a click on the picture does. `touch`: a member with pats open, it pats her there. `login`: a
 * visitor, it goes to the login. `view`: nothing (pats closed, or not connected).
 */
export type TouchMode = "touch" | "login" | "view";

const SOUND_KEY = "miyoria.live.sound";
const VOLUME_KEY = "miyoria.live.volume";

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private mode: the choice lasts until the page closes
  }
}

function startVolume(): number {
  const v = Number(stored(VOLUME_KEY));
  return stored(VOLUME_KEY) !== null && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
}

/** Plays `video.play()` without tripping over browsers (and jsdom) that return nothing. */
function play(video: HTMLVideoElement): Promise<void> {
  try {
    return Promise.resolve(video.play()).then(
      () => undefined,
      () => undefined,
    );
  } catch {
    return Promise.resolve();
  }
}

export interface LivePlayerProps {
  /** The playlist's absolute address. */
  src: string;
  mode: TouchMode;
  loginUrl: string | null;
  spots: readonly Spot[];
  /** A member touched the picture at `spot`. */
  onTouch: (spot: LiveSpot) => void;
  /** The stream could not be brought back; the page draws her figure instead. */
  onFail: () => void;
}

/**
 * Her real picture, the OBS output: muted autoplay with a sound button, the live dot, volume and
 * fullscreen under it, and a layer over the picture only (never the controls) that takes a touch.
 */
export function LivePlayer({ src, mode, loginUrl, spots, onTouch, onFail }: LivePlayerProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(true);
  const [volume, setVolume] = useState(startVolume);
  const [playing, setPlaying] = useState(false);
  const [paused, setPaused] = useState(false);
  const [full, setFull] = useState(false);
  const [box, setBox] = useState<Box | null>(null);
  const failRef = useRef(onFail);
  failRef.current = onFail;

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    setPlaying(false);
    const stop = attachStream(v, src, () => failRef.current());
    // A viewer who turned the sound on gets it back; a browser that refuses it plays muted.
    v.muted = true;
    void play(v).then(() => {
      if (stored(SOUND_KEY) !== "on") return;
      v.muted = false;
      void play(v).then(() => {
        if (v.paused) {
          v.muted = true;
          void play(v);
        }
      });
    });
    return stop;
  }, [src]);

  // The picture's rectangle inside the element, for the touch layer's hands and hearts.
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    const measure = () => setBox(contentBox(v.clientWidth, v.clientHeight, v.videoWidth, v.videoHeight));
    measure();
    v.addEventListener("loadedmetadata", measure);
    v.addEventListener("resize", measure);
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(v);
    return () => {
      v.removeEventListener("loadedmetadata", measure);
      v.removeEventListener("resize", measure);
      ro?.disconnect();
    };
  }, [src]);

  useEffect(() => {
    const onChange = () => setFull(document.fullscreenElement === wrap.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleMute = useCallback(() => {
    const v = video.current;
    if (!v) return;
    const next = !v.muted;
    v.muted = next;
    if (!next && v.volume === 0) v.volume = 1;
    setMuted(next);
    setVolume(v.volume);
    remember(SOUND_KEY, next ? "off" : "on");
    if (!next) void play(v);
  }, []);

  const changeVolume = (value: number) => {
    const v = video.current;
    if (!v) return;
    v.volume = value;
    v.muted = value === 0;
    setVolume(value);
    setMuted(value === 0);
    remember(VOLUME_KEY, String(value));
    remember(SOUND_KEY, value === 0 ? "off" : "on");
  };

  const toggleFull = () => {
    const el = wrap.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen?.();
    else void el.requestFullscreen?.();
  };

  const touch = (clientX: number, clientY: number) => {
    const v = video.current;
    if (!v || mode !== "touch") return;
    const r = v.getBoundingClientRect();
    const spot = spotAt(clientX - r.left, clientY - r.top, r.width, r.height, v.videoWidth, v.videoHeight);
    if (spot) onTouch(spot);
  };

  const layer = "absolute inset-0 block outline-none";
  return (
    <div
      ref={wrap}
      className="grid gap-2 [&:fullscreen]:grid-rows-[minmax(0,1fr)_auto] [&:fullscreen]:bg-black [&:fullscreen]:p-3"
      data-testid="live-player"
    >
      <div className="relative aspect-video overflow-hidden rounded-md bg-black [:fullscreen_&]:aspect-auto [:fullscreen_&]:min-h-0">
        <video
          ref={video}
          muted
          autoPlay
          playsInline
          aria-label="她的直播畫面"
          className="absolute inset-0 size-full object-contain"
          onPlaying={() => {
            setPlaying(true);
            setPaused(false);
          }}
          onPause={() => setPaused(true)}
          onWaiting={() => setPlaying(false)}
          onVolumeChange={(e) => setMuted(e.currentTarget.muted)}
        />

        {/* Hands and hearts sit on the picture itself, so they stay put in a letterboxed box. */}
        {box && (
          <div
            aria-hidden
            className="pointer-events-none absolute"
            style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
          >
            {spots.map((s) => (
              <span
                key={s.id}
                className="absolute"
                style={{ left: `${s.x * 100}%`, top: `${s.y * 100}%`, "--dx": `${((s.id * 7) % 5) * 4 - 8}px` } as React.CSSProperties}
                data-spot={s.own ? "own" : "other"}
              >
                <Hand className={cn("spot-hand absolute text-white drop-shadow-[0_1px_3px_rgba(0,0,0,0.8)]", s.own ? "size-9" : "size-6 opacity-80")} />
                {s.own && <Heart className="spot-heart absolute size-5 fill-primary text-primary drop-shadow-[0_1px_3px_rgba(0,0,0,0.6)]" data-heart />}
              </span>
            ))}
          </div>
        )}

        {mode === "touch" && (
          <button
            type="button"
            tabIndex={-1}
            aria-hidden
            data-testid="touch-layer"
            className={cn(layer, "cursor-pointer")}
            onClick={(e) => touch(e.clientX, e.clientY)}
          />
        )}
        {mode === "login" && loginUrl && (
          <a
            href={loginUrl}
            data-testid="touch-login"
            aria-label="登入後摸摸她"
            className={cn(layer, "group cursor-pointer focus-visible:ring-2 focus-visible:ring-ring")}
          >
            <span className="absolute top-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-black/60 px-3 py-1 text-xs text-white opacity-0 backdrop-blur-sm transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100">
              <Hand aria-hidden className="size-3.5" />
              登入後摸摸她
            </span>
          </a>
        )}
      </div>

      <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="flex items-center gap-1.5 text-[13px]">
          <Dot tone={playing ? "brand" : "neutral"} pulse={playing} />
          {playing ? "直播中" : paused ? "已暫停" : "連接中"}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label={paused ? "播放" : "暫停"}
            onClick={() => {
              const v = video.current;
              if (v) void (v.paused ? play(v) : Promise.resolve(v.pause()));
            }}
          >
            {paused ? <Play aria-hidden /> : <Pause aria-hidden />}
          </Button>
          {muted ? (
            <Button variant="outline" onClick={toggleMute}>
              <VolumeX aria-hidden />
              開啟聲音
            </Button>
          ) : (
            <Button variant="ghost" size="icon" aria-label="靜音" onClick={toggleMute}>
              <Volume2 aria-hidden />
            </Button>
          )}
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            aria-label="音量"
            onChange={(e) => changeVolume(Number(e.target.value))}
            className="h-8 w-20 cursor-pointer accent-primary sm:w-24"
          />
          <Button variant="ghost" size="icon" aria-label={full ? "離開全螢幕" : "全螢幕"} onClick={toggleFull}>
            {full ? <Minimize aria-hidden /> : <Maximize aria-hidden />}
          </Button>
        </div>
      </div>
    </div>
  );
}
