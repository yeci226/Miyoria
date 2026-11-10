// Her picture and what a touch on it lands on (docs/design/v4-plan.md §9.2 items 2 and 4).
//
// `classify` turns a spot on the video frame into a part of her from the configured rects.
// `VideoWatch` asks MediaMTX whether OBS is publishing and says so only when that changes: the
// page shows the video whenever OBS is on, whatever Discord's Go Live is doing.

import type { LivePart, LiveSpot, LiveVideo } from "@miyoria/types";
import type { LiveVideoConfig } from "./config.js";

/** Where the api serves the playlist of her picture. */
export const VIDEO_SRC = "/api/public/live/video/index.m3u8";

export const VIDEO_OFF: LiveVideo = { on: false, src: null };
export const VIDEO_ON: LiveVideo = { on: true, src: VIDEO_SRC };

function inside(rect: readonly number[], spot: LiveSpot): boolean {
  if (rect.length !== 4) return false;
  const [x0, y0, x1, y1] = rect as [number, number, number, number];
  return spot.x >= x0 && spot.x <= x1 && spot.y >= y0 && spot.y <= y1;
}

/** Face first, then head, then body, else the screen. */
export function classify(
  spot: LiveSpot,
  rects: Pick<LiveVideoConfig, "head" | "face" | "body">,
): LivePart {
  if (inside(rects.face, spot)) return "face";
  if (inside(rects.head, spot)) return "head";
  if (inside(rects.body, spot)) return "body";
  return "screen";
}

export interface VideoWatchOptions {
  config: Pick<LiveVideoConfig, "api" | "path" | "poll_ms">;
  fetch?: typeof fetch;
  /** The state changed. */
  changed: (video: LiveVideo) => void;
  /** Told once per change, not per failed poll. */
  note?: (on: boolean, reason: string) => void;
}

/** One poll of MediaMTX's control API per `poll()`; says only when OBS started or stopped. */
export class VideoWatch {
  readonly #options: VideoWatchOptions;
  readonly #url: string;
  #on = false;

  constructor(options: VideoWatchOptions) {
    this.#options = options;
    const base = options.config.api.replace(/\/+$/, "");
    this.#url = `${base}/v3/paths/get/${encodeURIComponent(options.config.path)}`;
  }

  get on(): boolean {
    return this.#on;
  }

  async poll(parent?: AbortSignal): Promise<void> {
    const timeout = AbortSignal.timeout(this.#options.config.poll_ms);
    const signal = parent ? AbortSignal.any([parent, timeout]) : timeout;
    let on = false;
    let reason: string;
    try {
      const res = await (this.#options.fetch ?? fetch)(this.#url, { signal, redirect: "manual" });
      if (res.status === 404) {
        reason = "no publisher";
        await res.body?.cancel().catch(() => undefined);
      } else if (!res.ok) {
        reason = `MediaMTX answered ${res.status}`;
        await res.body?.cancel().catch(() => undefined);
      } else {
        const body = (await res.json()) as { ready?: unknown } | null;
        on = body?.ready === true;
        reason = on ? "publishing" : "path not ready";
      }
    } catch (error) {
      if (parent?.aborted) return;
      reason = `MediaMTX unreachable (${error instanceof Error ? error.name : "error"})`;
    }
    if (on === this.#on) return;
    this.#on = on;
    this.#options.note?.(on, reason);
    this.#options.changed(on ? { ...VIDEO_ON } : { ...VIDEO_OFF });
  }
}
