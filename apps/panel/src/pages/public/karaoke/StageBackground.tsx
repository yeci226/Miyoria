// What is behind the stage: the song's video, muted and kept on the backing track's clock
// (`video-sync.ts`), or a still: the picture this browser chose as the panel's background. The
// still shows without a video, before the video can show a frame, when it fails or stops moving,
// and always under reduced motion (no moving picture then). The video never holds up singing:
// nothing waits on it, and it only ever follows the song.

import { type CSSProperties, useEffect, useRef, useState } from "react";
import { BACKGROUNDS, DEFAULT_LOOK, useLook, useUserImage } from "@/app/appearance";
import { cn } from "@/lib/utils";
import { type SongNow, StallWatch, VIDEO_CHECK_MS, type VideoNow, videoStep } from "./video-sync";

/** The background this browser chose, as the still behind the stage. */
function useStill(): CSSProperties {
  const { background } = useLook();
  const image = useUserImage();
  if (background === "user" && image) return { backgroundImage: `url("${image}")` };
  const css =
    BACKGROUNDS.find((b) => b.id === background)?.css ?? BACKGROUNDS.find((b) => b.id === DEFAULT_LOOK.background)?.css;
  return css ? { background: css } : {};
}

/** Plays, quietly: a refusal only means it does not move, which the stall check sees. */
function play(el: HTMLVideoElement): void {
  try {
    const p = el.play() as Promise<void> | undefined;
    p?.catch(() => undefined);
  } catch {
    // Not playable here.
  }
}

function readVideo(el: HTMLVideoElement): VideoNow {
  return {
    time: el.currentTime,
    paused: el.paused,
    rate: el.playbackRate,
    duration: el.duration,
    seeking: el.seeking,
  };
}

export function StageBackground({
  url,
  song,
  reduced,
}: {
  /** The signed video link, or `null` without one. */
  url: string | null;
  /** The song's time and whether it plays, read on each check. */
  song: () => SongNow;
  reduced: boolean;
}) {
  const still = useStill();
  const video = useRef<HTMLVideoElement | null>(null);
  const [shown, setShown] = useState(false);
  const [failed, setFailed] = useState(false);
  const songRef = useRef(song);
  songRef.current = song;
  const use = url !== null && !reduced && !failed;

  // A new link: try again.
  useEffect(() => {
    setFailed(false);
    setShown(false);
  }, [url]);

  // Four times a second: follow the song; give up on a video that stops moving.
  useEffect(() => {
    if (!use) return;
    const el = video.current;
    if (!el) return;
    el.disablePictureInPicture = true;
    const watch = new StallWatch();
    const check = () => {
      const s = songRef.current();
      const v = readVideo(el);
      const step = videoStep(v, s);
      const now = performance.now() / 1000;
      if (step.seek !== undefined) {
        el.currentTime = step.seek;
        watch.reset(now);
      }
      if (step.rate !== undefined) el.playbackRate = step.rate;
      if (step.pause) el.pause();
      if (step.play) play(el);
      const shouldPlay = s.playing && s.time >= 0 && !(v.duration > 0 && s.time >= v.duration);
      if (watch.check(now, el.currentTime, shouldPlay)) setFailed(true);
    };
    check();
    const timer = window.setInterval(check, VIDEO_CHECK_MS);
    return () => {
      window.clearInterval(timer);
      el.pause();
    };
  }, [use]);

  return (
    <div aria-hidden className="absolute inset-0 -z-10 overflow-hidden bg-[#06070b]">
      <div
        data-stage-still
        className="absolute inset-0 bg-cover bg-center bg-no-repeat brightness-[0.62]"
        style={still}
      />
      {use && (
        <video
          ref={video}
          src={url}
          muted
          playsInline
          preload="auto"
          disablePictureInPicture
          disableRemotePlayback
          controls={false}
          controlsList="nodownload nofullscreen noremoteplayback noplaybackrate"
          tabIndex={-1}
          onContextMenu={(e) => e.preventDefault()}
          onLoadedData={() => setShown(true)}
          onError={() => setFailed(true)}
          className={cn(
            // Edge to edge in any shape of window or phone, upright or sideways: cropped, never letterboxed.
            "absolute inset-0 size-full bg-[#06070b] object-cover transition-opacity duration-300 motion-reduce:transition-none",
            shown ? "opacity-100" : "opacity-0",
          )}
        />
      )}
    </div>
  );
}
