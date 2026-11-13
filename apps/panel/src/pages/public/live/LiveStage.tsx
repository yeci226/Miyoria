import { Hand, LogIn, Mic, MessageSquareText } from "lucide-react";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { isApiError } from "@/api/http";
import type { MemberSession } from "@/api/types";
import { useConnection } from "@/app/connection";
import { Dot, type Tone } from "@/components/status";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  connectLive,
  initialView,
  LIVE_PATH,
  type LivePats,
  type LivePlace,
  type LiveSnapshot,
  type LiveSpot,
  liveReducer,
  PAT_PATH,
  type SourceFactory,
} from "./feed";
import { LivePlayer, type Spot, type TouchMode } from "./LivePlayer";

/** How long a hand stays where she was touched. */
const HAND_MS = 1_400;
/** Touches on the picture at most. */
const MAX_SPOTS = 12;
/** How long a picture that failed is left alone before it is tried again. */
export const RETRY_VIDEO_MS = 20_000;

const PLACE: Record<LivePlace, { label: string; tone: Tone; pulse?: boolean }> = {
  singing: { label: "她在唱歌", tone: "brand", pulse: true },
  playing: { label: "她在玩遊戲", tone: "success" },
  live: { label: "她在直播", tone: "brand", pulse: true },
  in_voice: { label: "她在語音頻道", tone: "success" },
  idle: { label: "她現在閒著", tone: "neutral" },
  offline: { label: "她現在不在", tone: "neutral" },
};

const GAMES: Record<string, string> = { minecraft: "Minecraft" };

export function placeLabel(now: LiveSnapshot): string {
  const { place, game } = now.presence;
  if (place === "playing" && game) return `她在玩 ${GAMES[game] ?? game}`;
  return PLACE[place].label;
}

/** What a pat came back with, in her page's words. */
type PatNote = { tone: "ok" | "wait" | "no"; text: string } | null;

function patError(e: unknown): PatNote {
  if (isApiError(e)) {
    if (e.status === 429) return { tone: "wait", text: "摸太快了,讓她喘口氣再摸" };
    if (e.status === 403) return { tone: "no", text: "摸頭還沒開放" };
    if (e.status === 401) return { tone: "no", text: "登入過期了,重新登入後再摸" };
  }
  return { tone: "no", text: "沒摸到,她現在接收不到" };
}

function useLive(source?: SourceFactory | null) {
  const { client } = useConnection();
  const [view, dispatch] = useReducer(liveReducer, initialView);
  useEffect(() => {
    const ctl = new AbortController();
    connectLive(client.url(LIVE_PATH), dispatch, ctl.signal, source);
    return () => ctl.abort();
  }, [client, source]);
  return view;
}

function PatCount({ pats }: { pats: LivePats }) {
  if (pats.recent === 0) return null;
  return <span className="text-[13px] text-muted-foreground tabular-nums">這一分鐘 {pats.recent} 次摸頭</span>;
}

export interface LiveStageProps {
  /** The person logged in, or `null` for a visitor who only watches. */
  member: MemberSession | null;
  /** Where a visitor logs in to pat her (`null`: no Discord login on this Core). */
  loginUrl?: string | null;
  /** The stream's source; tests pass their own. Default: the browser's `EventSource`. */
  source?: SourceFactory | null;
  /** `page`: the stage is the whole page (`/watch`), so her lines are set larger. */
  size?: "section" | "page";
}

/**
 * 現場: her, and what she is up to. While OBS publishes it is the real picture, which a member
 * touches where she is on it; otherwise (or when the picture will not play) no picture at all.
 * Either way the line she is saying, her state and a button to pat her with. Whether she says
 * anything back is hers, and arrives through the feed like any line.
 */
export function LiveStage({ member, loginUrl = null, source, size = "section" }: LiveStageProps) {
  const large = size === "page";
  const { client } = useConnection();
  const view = useLive(source);
  const now = view.now;
  const [spots, setSpots] = useState<Spot[]>([]);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [note, setNote] = useState<PatNote>(null);
  const [busy, setBusy] = useState(false);
  const nextSpot = useRef(1);
  const ownPats = useRef(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const all = timers.current;
    return () => {
      for (const t of all) clearTimeout(t);
    };
  }, []);

  const later = useCallback((ms: number, run: () => void) => {
    const t = setTimeout(() => {
      timers.current.delete(t);
      run();
    }, ms);
    timers.current.add(t);
  }, []);

  const videoSrc = now?.video?.on ? now.video.src : null;
  const showVideo = videoSrc !== null && failedSrc !== videoSrc;
  const picture = useRef(showVideo);
  picture.current = showVideo;

  /** A hand on the picture where she was touched (a heart too, for one's own). */
  const touchAt = useCallback(
    (spot: LiveSpot, own: boolean) => {
      const id = nextSpot.current++;
      setSpots((all) => [...all.slice(-(MAX_SPOTS - 1)), { id, x: spot.x, y: spot.y, own }]);
      later(HAND_MS, () => setSpots((all) => all.filter((s) => s.id !== id)));
    },
    [later],
  );

  // Somebody else patted her: over the picture a pat that says where shows a small hand there; one
  // that does not, or one while there is no picture, only shows in the count.
  const seenSeq = useRef(view.patSeq);
  useEffect(() => {
    if (view.patSeq === seenSeq.current) return;
    seenSeq.current = view.patSeq;
    if (ownPats.current > 0) ownPats.current -= 1;
    else if (picture.current && view.patSpot) touchAt(view.patSpot, false);
  }, [view.patSeq, view.patSpot, touchAt]);

  // A picture that failed is given up for a while, then tried again.
  const failVideo = useCallback(() => {
    if (videoSrc === null) return;
    setFailedSrc(videoSrc);
    later(RETRY_VIDEO_MS, () => setFailedSrc((was) => (was === videoSrc ? null : was)));
  }, [videoSrc, later]);

  const pat = useCallback(
    async (spot?: LiveSpot) => {
      if (busy) return;
      if (picture.current) touchAt(spot ?? { x: 0.5, y: 0.5 }, true);
      ownPats.current += 1;
      setBusy(true);
      let next: PatNote;
      try {
        await client.post<{ pats: LivePats }>(PAT_PATH, spot ? { x: spot.x, y: spot.y } : {}, { public: true });
        next = { tone: "ok", text: "她感覺到了" };
      } catch (e) {
        ownPats.current = Math.max(0, ownPats.current - 1);
        next = patError(e);
      }
      setNote(next);
      // The words fade after a while; a newer pat's words stay.
      later(4_000, () => setNote((shown) => (shown === next ? null : shown)));
      // A short breath between pats, so one held key is not a burst.
      later(350, () => setBusy(false));
    },
    [busy, client, touchAt, later],
  );

  const open = now?.pats.open ?? false;
  const line = now?.line ?? null;
  const shownLine = line !== null && line.text !== "" ? line : null;
  const place = now ? PLACE[now.presence.place] : null;
  const activity = now?.activity ?? null;
  const canPat = member !== null && open && view.link === "open";
  const touchMode: TouchMode = canPat ? "touch" : member === null && loginUrl ? "login" : "view";
  const pictureLost = videoSrc !== null && !showVideo;

  const info = (
    <div className="grid min-w-0 content-center gap-4">
      <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted-foreground" data-testid="live-state">
        {now && place ? (
          <>
            <span className="flex items-center gap-1.5 text-foreground">
              <Dot tone={place.tone} pulse={place.pulse} />
              {placeLabel(now)}
            </span>
            {activity && (
              <span className="min-w-0 truncate">
                {activity.label}
                {activity.detail && <span className="text-foreground">〈{activity.detail}〉</span>}
              </span>
            )}
          </>
        ) : view.link === "lost" ? (
          <span>連不上現場,稍後會再試</span>
        ) : (
          <span>連線中…</span>
        )}
        {now && view.link === "lost" && <span>· 重新連線中…</span>}
        {pictureLost && <span>· 直播畫面連不上,稍後再試</span>}
      </p>

      <figure className="grid min-h-[4.5rem] content-center gap-1.5" aria-live="polite" aria-atomic="true">
        {shownLine ? (
          <>
            <blockquote
              className={cn(
                "max-w-[36em] leading-[1.55] font-medium text-pretty break-words",
                large ? "text-[22px]" : "text-[19px]",
                !shownLine.final && "text-foreground/90",
              )}
              data-final={shownLine.final}
            >
              {shownLine.text}
              {!shownLine.final && <span aria-hidden className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[3px] animate-pulse bg-primary motion-reduce:animate-none" />}
            </blockquote>
            <figcaption className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {shownLine.via === "voice" ? <Mic aria-hidden className="size-3.5" /> : <MessageSquareText aria-hidden className="size-3.5" />}
              {shownLine.via === "voice" ? "她在語音裡說" : "她在頻道裡打字"}
            </figcaption>
          </>
        ) : (
          <p className="text-[15px] text-muted-foreground">{now ? "她現在沒在說話" : " "}</p>
        )}
      </figure>

      <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-2">
        {member !== null ? (
          <Button onClick={() => void pat()} disabled={!canPat || busy} aria-describedby="live-pat-note">
            <Hand aria-hidden />
            摸摸頭
          </Button>
        ) : loginUrl ? (
          <Button asChild variant="outline">
            <a href={loginUrl}>
              <LogIn aria-hidden />
              登入後摸摸她
            </a>
          </Button>
        ) : null}
        {now && <PatCount pats={now.pats} />}
        <span id="live-pat-note" role="status" className={cn("text-[13px]", note?.tone === "ok" ? "text-muted-foreground" : "text-primary")}>
          {member !== null && now && !open ? "摸頭還沒開放" : (note?.text ?? "")}
        </span>
      </div>
    </div>
  );

  return (
    <section aria-label="現場" className="grid gap-3">
      <h2 className="text-[15px] font-semibold">現場</h2>
      {showVideo && videoSrc !== null ? (
        <div className="glass-well grid gap-4 rounded-md p-3 sm:p-4">
          <LivePlayer
            src={client.url(videoSrc)}
            mode={touchMode}
            loginUrl={loginUrl}
            spots={spots}
            onTouch={(spot) => void pat(spot)}
            onFail={failVideo}
          />
          <div className="px-1 sm:px-2 sm:pb-1">{info}</div>
        </div>
      ) : (
        <div className={cn("glass-well rounded-md px-4 py-5 sm:px-8", large && "sm:py-8")}>
          {info}
        </div>
      )}
    </section>
  );
}
