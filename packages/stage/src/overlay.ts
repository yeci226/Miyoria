// Overlay HTTP server: `GET /overlay/ws` streams subtitle / emotion / speaking / status /
// activity JSON, `/overlay/` serves the overlay web app and `/overlay/backdrop` the stream's
// background picture (`overlay_backdrop`, for the overlay's backdrop layer).

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { getLogger } from "@miyoria/kernel";
import { type Gift, GiftMerger } from "./gifts.js";
import { closeOnAbort, type ServeResult } from "./lipsync.js";
import { formatAddress, HttpServer } from "./net.js";
import type { Activity, CoreMessage, SpeakingState, StageStatus } from "./protocol.js";

const log = getLogger("stage.overlay");

/** Messages an overlay client may lag behind before it is dropped (like a broadcast of 256). */
const MAX_BUFFERED = 1 << 20;

interface Snapshot {
  status: string | null;
  subtitle: string | null;
  emotion: string | null;
  notice: string | null;
  /** The activity shown (not the hidden one), and when it was sent. */
  activity: { activity: Activity; at: number } | null;
}

/**
 * Fan-out of overlay messages. New clients first get the latest status, subtitle, emotion,
 * notice and activity.
 */
export class OverlayHub {
  readonly #listeners = new Set<(text: string) => void>();
  readonly #snapshot: Snapshot = {
    status: null,
    subtitle: null,
    emotion: null,
    notice: null,
    activity: null,
  };
  readonly #now: () => number;
  readonly #gifts = new GiftMerger();
  #giftTimer: ReturnType<typeof setTimeout> | undefined;

  /** `now`: the clock a song's `elapsed_ms` is moved on with for new clients (ms). */
  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  #send(text: string): void {
    for (const listener of [...this.#listeners]) listener(text);
  }

  subtitle(turn: string, text: string, isFinal: boolean): void {
    const v = JSON.stringify({ type: "subtitle", turn, text, final: isFinal });
    this.#snapshot.subtitle = v;
    this.#send(v);
  }

  emotion(name: string, intensity: number): void {
    const v = JSON.stringify({ type: "emotion", name, intensity });
    this.#snapshot.emotion = v;
    this.#send(v);
  }

  /** A status line (`""` clears it). */
  notice(text: string): void {
    const v = JSON.stringify({ type: "notice", text });
    this.#snapshot.notice = text === "" ? null : v;
    this.#send(v);
  }

  /**
   * What she is doing (`kind: null` hides it). A client that connects later gets it again with
   * a song's `elapsed_ms` moved on to that moment.
   */
  activity(activity: Activity): void {
    this.#snapshot.activity = activity.kind === null ? null : { activity, at: this.#now() };
    this.#send(JSON.stringify({ type: "activity", ...activity }));
  }

  /** Hides the activity line if it shows anything (Core went away). */
  clearActivity(): void {
    if (this.#snapshot.activity === null) return;
    this.activity({
      kind: null,
      label: "",
      detail: null,
      progress: null,
      elapsed_ms: null,
      duration_ms: null,
    });
  }

  /**
   * Someone fed her something. Gifts close together are one line (see gifts.ts) that shows for a
   * few seconds after the latest one; `text: ""` clears it.
   */
  gift(gift: Gift): void {
    const line = this.#gifts.add(gift, this.#now());
    if (line === null) return;
    this.#send(JSON.stringify({ type: "gift", text: line }));
    clearTimeout(this.#giftTimer);
    const wait = Math.max((this.#gifts.deadline() ?? this.#now()) - this.#now(), 0);
    // No newer gift reset this timer: the line is due.
    this.#giftTimer = setTimeout(() => {
      this.#gifts.expire(this.#now());
      this.#gifts.endLine();
      this.#send(JSON.stringify({ type: "gift", text: "" }));
    }, wait);
    this.#giftTimer.unref?.();
  }

  /**
   * A paid message or dedication, passed on as it is: the overlay queues them. Not kept for new
   * clients (a card that was due while nobody watched is not worth showing late).
   */
  screen(card: Extract<CoreMessage, { type: "screen" }>): void {
    const { kind, name, text, song } = card;
    this.#send(JSON.stringify({ type: "screen", kind, name, text, song }));
  }

  speaking(state: SpeakingState): void {
    this.#send(JSON.stringify({ type: "speaking", state }));
  }

  /**
   * Her voice level as viewers hear it (`rms` 0..1, the lip-sync `bands`), once per avatar frame
   * while there is audio and once with `rms: 0` when it stops. Not kept for new clients.
   */
  levels(rms: number, bands: readonly number[] | null): void {
    if (this.#listeners.size === 0) return;
    const round = (v: number) => Math.round(v * 1e4) / 1e4;
    const v: Record<string, unknown> = { type: "levels", rms: round(rms) };
    if (bands !== null && bands.length > 0) v.bands = bands.map(round);
    this.#send(JSON.stringify(v));
  }

  /** `core`: the Stage is connected to Core. */
  status(status: StageStatus, core: boolean): void {
    const v = JSON.stringify({
      type: "status",
      core,
      vts: status.vts,
      obs: status.obs,
      scene: status.scene,
      streaming: status.streaming,
    });
    this.#snapshot.status = v;
    this.#send(v);
  }

  /** The snapshot for a new client: status, emotion, subtitle, notice, activity (those that exist). */
  initial(): string[] {
    const s = this.#snapshot;
    const out = [s.status, s.emotion, s.subtitle, s.notice].filter((v): v is string => v !== null);
    const gift = this.#gifts.current(this.#now());
    if (gift !== null) out.push(JSON.stringify({ type: "gift", text: gift }));
    if (s.activity !== null) {
      const { activity, at } = s.activity;
      const elapsed =
        activity.elapsed_ms === null
          ? null
          : Math.round(activity.elapsed_ms + Math.max(this.#now() - at, 0));
      out.push(JSON.stringify({ type: "activity", ...activity, elapsed_ms: elapsed }));
    }
    return out;
  }

  /** Receives every message from now on; returns the unsubscribe function. */
  listen(listener: (text: string) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { "content-type": "text/plain" }).end("Not Found");
}

/** The background picture's path under `/overlay/`. */
export const BACKDROP_PATH = "backdrop";

/** Sends the file at `path` (404 when it is not one). */
async function sendFile(path: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path);
  } catch {
    return notFound(res);
  }
  if (!info.isFile()) return notFound(res);
  res.writeHead(200, {
    "content-type": CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
    "content-length": String(info.size),
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(path)
    .on("error", () => res.destroy())
    .pipe(res);
}

/**
 * `/overlay/<rest>` → a file under `root` (with `index.html` for directories), or the backdrop
 * picture (the owner's config, wherever it is) at `/overlay/backdrop`.
 */
async function serveFile(
  root: string,
  backdrop: string | null,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" }).end();
    return;
  }
  const rawPath = (req.url ?? "/").split("?")[0] ?? "/";
  if (rawPath === "/overlay") {
    res.writeHead(308, { location: "/overlay/" }).end();
    return;
  }
  if (!rawPath.startsWith("/overlay/")) return notFound(res);
  let rel: string;
  try {
    rel = decodeURIComponent(rawPath.slice("/overlay/".length));
  } catch {
    return notFound(res);
  }
  if (rel.includes("\0")) return notFound(res);
  if (rel === BACKDROP_PATH) {
    return backdrop === null ? notFound(res) : sendFile(backdrop, req, res);
  }
  let path = resolve(root, normalize(rel));
  if (path !== root && !path.startsWith(root + sep)) return notFound(res);
  if (await isDir(path)) path = join(path, "index.html");
  return sendFile(path, req, res);
}

/** Serves the overlay on `bind` until `signal` aborts. */
export async function serveOverlay(
  bind: string,
  dir: string,
  hub: OverlayHub,
  signal: AbortSignal,
  backdrop: string | null = null,
): Promise<ServeResult> {
  const root = resolve(dir);
  const picture = backdrop === null ? null : resolve(backdrop);
  if (!(await isDir(root))) {
    log.warn({ dir }, "overlay directory not found; only /overlay/ws is served");
  }
  const server = await HttpServer.listen(bind, "the overlay server", {
    onRequest(req, res) {
      serveFile(root, picture, req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
        else res.destroy();
      });
    },
    ws: [
      {
        path: "/overlay/ws",
        onConnection(ws) {
          for (const text of hub.initial()) ws.send(text);
          const unsubscribe = hub.listen((text) => {
            if (ws.bufferedAmount > MAX_BUFFERED) {
              log.debug("overlay client lagged");
              return;
            }
            ws.send(text);
          });
          ws.on("close", unsubscribe);
          ws.on("error", unsubscribe);
        },
      },
    ],
  });
  log.info(`overlay at http://${formatAddress(server.address)}/overlay/`);
  return { addr: server.address, done: closeOnAbort(server, signal) };
}
