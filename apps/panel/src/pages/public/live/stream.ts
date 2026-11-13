// Plays the Core's LL-HLS proxy in a <video>. hls.js loads on demand (it is most of a page's
// weight and only a page with a picture needs it); a browser without Media Source Extensions
// (iOS Safari) plays the playlist natively.

/** Network errors tolerated in a row before the picture is given up. */
const NETWORK_RETRIES = 5;
/** Media errors tolerated within one window before the picture is given up. */
const MEDIA_RETRIES = 3;
const MEDIA_WINDOW_MS = 10_000;

/**
 * Starts playing `src` in `video`; returns the teardown. `onFatal` is called once when the stream
 * cannot be brought back (the caller drops the picture for a while).
 */
export function attachStream(video: HTMLVideoElement, src: string, onFatal: () => void): () => void {
  let dead = false;
  let teardown = () => {};
  let failed = false;
  const fatal = () => {
    if (dead || failed) return;
    failed = true;
    onFatal();
  };

  void (async () => {
    let Hls: typeof import("hls.js").default;
    try {
      Hls = (await import("hls.js")).default;
    } catch {
      fatal();
      return;
    }
    if (dead) return;

    if (!Hls.isSupported()) {
      if (!video.canPlayType("application/vnd.apple.mpegurl")) {
        fatal();
        return;
      }
      video.src = src;
      const onError = () => fatal();
      video.addEventListener("error", onError);
      teardown = () => {
        video.removeEventListener("error", onError);
        video.removeAttribute("src");
        video.load();
      };
      return;
    }

    const hls = new Hls({
      lowLatencyMode: true,
      liveSyncDuration: 3,
      liveMaxLatencyDuration: 8,
      backBufferLength: 10,
    });
    let netRetries = 0;
    let mediaFails: number[] = [];
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    hls.on(Hls.Events.FRAG_LOADED, () => {
      netRetries = 0;
    });
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        netRetries += 1;
        if (netRetries > NETWORK_RETRIES) return fatal();
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => hls.startLoad(), 1_000 * netRetries);
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        const at = Date.now();
        mediaFails = [...mediaFails.filter((t) => at - t < MEDIA_WINDOW_MS), at];
        if (mediaFails.length > MEDIA_RETRIES) return fatal();
        // The second one in a window is often a codec the decoder choked on.
        if (mediaFails.length > 1) hls.swapAudioCodec();
        hls.recoverMediaError();
      } else {
        fatal();
      }
    });
    hls.loadSource(src);
    hls.attachMedia(video);
    teardown = () => {
      clearTimeout(retryTimer);
      hls.destroy();
    };
  })();

  return () => {
    dead = true;
    teardown();
  };
}
