// Overlay HTTP server: `GET /overlay/ws` streams subtitle / emotion / speaking / status /
// activity / karaoke JSON (and takes back what became of each danmaku line, `OverlayReply`),
// `/overlay/` serves the overlay web app, `/overlay/backdrop` the stream's background picture
// (`overlay_backdrop`, for the overlay's backdrop layer) and `/overlay/karaoke/video` the
// background video of the karaoke round on the stream (the one file Core named, while it is shown).

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { type OverlayMessage, OverlayReplySchema } from "@miyoria/contracts/overlay";
import { getLogger } from "@miyoria/runtime/kernel";
import { type DanmakuDone, DanmakuRelay } from "./danmaku.js";
import { type Gift, GiftMerger } from "./gifts.js";
import { closeOnAbort, type ServeResult } from "./lipsync.js";
import { formatAddress, HttpServer } from "./net.js";
import type {
  Activity,
  CoreMessage,
  KaraokeStageLyrics,
  KaraokeStageScene,
  KaraokeStageVoice,
  SpeakingState,
  StageStatus,
} from "./protocol.js";
import { type Touch, TouchThrottle } from "./touch.js";

const log = getLogger("stage.overlay");

/** The text frame of an overlay message. */
function frame(msg: OverlayMessage): string {
  return JSON.stringify(msg);
}

/** Messages an overlay client may lag behind before it is dropped (like a broadcast of 256). */
const MAX_BUFFERED = 1 << 20;

interface Snapshot {
  status: string | null;
  subtitle: string | null;
  emotion: string | null;
  notice: string | null;
  /** The activity shown (not the hidden one), and when it was sent. */
  activity: { activity: Activity; at: number } | null;
  /** The karaoke room on the stream (never one with `room: null`), and when it came. */
  karaoke: { scene: KaraokeStageScene; at: number } | null;
  /** The words, picture and backing of its round, and the key its files are served under. */
  karaokeLyrics: { lyrics: KaraokeStageLyrics; key: string } | null;
}

/** The karaoke round's video and backing under `/overlay/` (with `?r=<room>-<round>`). */
export const KARAOKE_VIDEO_PATH = "karaoke/video";
export const KARAOKE_BACKING_PATH = "karaoke/backing";

/** A scene that ends the karaoke room on the stream (Core went away). */
const NO_KARAOKE: KaraokeStageScene = {
  room: null,
  state: null,
  round: 0,
  rounds_left: 0,
  song: null,
  shift: 0,
  queue: [],
  join_url: null,
  qr_while_singing: false,
  members: [],
  position_ms: null,
  board: [],
  note: null,
  currency: "",
  air: { backing: false, relay: null, delay_ms: 0, backing_gain: 0, voice_gain: 0, duck_gain: 0 },
  settling: null,
  cheers: [],
};

/** Whether `path` may be served as a round's video: an absolute path to an `.mp4` file. */
export function karaokeVideoPath(path: string | null): path is string {
  return path !== null && isAbsolute(path) && extname(path).toLowerCase() === ".mp4";
}

/**
 * Whether `backing` may be served as a round's backing: an absolute path to a `.pcm` or `.m4a`
 * file, its extension the format it says it is.
 */
export function karaokeBackingPath(backing: KaraokeStageLyrics["backing"]): boolean {
  if (backing === null || !isAbsolute(backing.path)) return false;
  return extname(backing.path).toLowerCase() === `.${backing.format}`;
}

/**
 * Fan-out of overlay messages. New clients first get the latest status, subtitle, emotion,
 * notice, activity and karaoke room.
 */
export class OverlayHub {
  readonly #listeners = new Set<(text: string) => void>();
  readonly #snapshot: Snapshot = {
    status: null,
    subtitle: null,
    emotion: null,
    notice: null,
    activity: null,
    karaoke: null,
    karaokeLyrics: null,
  };
  readonly #now: () => number;
  readonly #gifts = new GiftMerger();
  readonly #touches = new TouchThrottle();
  readonly #danmaku: DanmakuRelay;
  #nextPage = 0;
  #giftTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * `now`: the clock a song's `elapsed_ms` and a karaoke round's `position_ms` are moved on with
   * for new clients (ms).
   */
  constructor(now: () => number = Date.now) {
    this.#now = now;
    this.#danmaku = new DanmakuRelay(now);
  }

  #send(text: string): void {
    for (const listener of [...this.#listeners]) listener(text);
  }

  subtitle(turn: string, text: string, isFinal: boolean): void {
    const v = frame({ type: "subtitle", turn, text, final: isFinal });
    this.#snapshot.subtitle = v;
    this.#send(v);
  }

  emotion(name: string, intensity: number): void {
    const v = frame({ type: "emotion", name, intensity });
    this.#snapshot.emotion = v;
    this.#send(v);
  }

  /** A status line (`""` clears it). */
  notice(text: string): void {
    const v = frame({ type: "notice", text });
    this.#snapshot.notice = text === "" ? null : v;
    this.#send(v);
  }

  /**
   * What she is doing (`kind: null` hides it). A client that connects later gets it again with
   * a song's `elapsed_ms` moved on to that moment.
   */
  activity(activity: Activity): void {
    this.#snapshot.activity = activity.kind === null ? null : { activity, at: this.#now() };
    this.#send(frame({ type: "activity", ...activity }));
  }

  /** Hides the activity line and the notice if they show anything (Core went away). */
  clearActivity(): void {
    if (this.#snapshot.notice !== null) this.notice("");
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

  // ---- karaoke ------------------------------------------------------------------------------

  /**
   * The frame of the karaoke scene as of now: its song moved on since it came. Nothing is taken
   * off for the lip-sync latency: the scene plays the round's sound itself, in the stream's own
   * audio with its picture.
   */
  #karaokeFrame(scene: KaraokeStageScene, at: number): string {
    const position =
      scene.position_ms === null
        ? null
        : Math.round(scene.position_ms + Math.max(this.#now() - at, 0));
    return frame({ type: "karaoke", ...scene, position_ms: position });
  }

  /**
   * The frame of a round's words, its video and backing as this server's URLs for them (or
   * `null`).
   */
  #lyricsFrame(lyrics: KaraokeStageLyrics, key: string): string {
    const r = `?r=${encodeURIComponent(key)}`;
    const video = karaokeVideoPath(lyrics.video) ? `${KARAOKE_VIDEO_PATH}${r}` : null;
    const backing =
      lyrics.backing !== null && karaokeBackingPath(lyrics.backing)
        ? { ...lyrics.backing, path: `${KARAOKE_BACKING_PATH}${r}` }
        : null;
    return frame({ type: "karaoke_lyrics", ...lyrics, video, backing });
  }

  /**
   * A piece of the relayed singer's voice: passed on to the pages as it is, never kept (a page
   * that connects later gets none) and never logged.
   */
  karaokeVoice(voice: KaraokeStageVoice): void {
    if (this.#listeners.size === 0) return;
    this.#send(frame({ type: "karaoke_voice", ...voice }));
  }

  /**
   * The karaoke room on the stream (`room: null` ends it, and forgets its round's words). A page
   * that connects later gets it with the song moved on to that moment.
   */
  karaoke(scene: KaraokeStageScene): void {
    const at = this.#now();
    if (scene.room === null) {
      this.#snapshot.karaoke = null;
      this.#snapshot.karaokeLyrics = null;
    } else {
      this.#snapshot.karaoke = { scene, at };
      if (this.#snapshot.karaokeLyrics?.lyrics.room !== scene.room) {
        this.#snapshot.karaokeLyrics = null;
      }
    }
    this.#send(this.#karaokeFrame(scene, at));
  }

  /** The words and picture of a karaoke round; its video is served while they are the latest. */
  karaokeLyrics(lyrics: KaraokeStageLyrics): void {
    const key = `${lyrics.room}-${lyrics.round}`;
    this.#snapshot.karaokeLyrics = { lyrics, key };
    this.#send(this.#lyricsFrame(lyrics, key));
  }

  /** Ends the karaoke scene if one shows (Core went away). */
  clearKaraoke(): void {
    if (this.#snapshot.karaoke === null && this.#snapshot.karaokeLyrics === null) return;
    this.karaoke(NO_KARAOKE);
  }

  /** The file of the round's video served under `key` (`<room>-<round>`), while it is current. */
  karaokeVideo(key: string | null): string | null {
    const current = this.#snapshot.karaokeLyrics;
    if (key === null || current === null || current.key !== key) return null;
    return karaokeVideoPath(current.lyrics.video) ? current.lyrics.video : null;
  }

  /** The round's backing served under `key`, while it is current: its file and media type. */
  karaokeBacking(key: string | null): { path: string; type: string } | null {
    const current = this.#snapshot.karaokeLyrics;
    if (key === null || current === null || current.key !== key) return null;
    const backing = current.lyrics.backing;
    if (backing === null || !karaokeBackingPath(backing)) return null;
    return {
      path: backing.path,
      type: backing.format === "m4a" ? "audio/mp4" : "application/octet-stream",
    };
  }

  /**
   * Someone fed her something. Gifts close together are one line (see gifts.ts) that shows for a
   * few seconds after the latest one; `text: ""` clears it.
   */
  gift(gift: Gift): void {
    const line = this.#gifts.add(gift, this.#now());
    if (line === null) return;
    this.#send(frame({ type: "gift", text: line }));
    clearTimeout(this.#giftTimer);
    const wait = Math.max((this.#gifts.deadline() ?? this.#now()) - this.#now(), 0);
    // No newer gift reset this timer: the line is due.
    this.#giftTimer = setTimeout(() => {
      this.#gifts.expire(this.#now());
      this.#gifts.endLine();
      this.#send(frame({ type: "gift", text: "" }));
    }, wait);
    this.#giftTimer.unref?.();
  }

  /**
   * A paid message, passed on as it is: the overlay queues them. Not kept for new
   * clients (a card that was due while nobody watched is not worth showing late).
   */
  screen(card: Extract<CoreMessage, { type: "screen" }>): void {
    const { name, text } = card;
    this.#send(frame({ type: "screen", name, text }));
  }

  // ---- danmaku ------------------------------------------------------------------------------

  /** Called with how each danmaku line ended (for Core); set by the stage. */
  onDanmakuDone: ((done: DanmakuDone) => void) | null = null;

  #ended(done: readonly DanmakuDone[]): void {
    for (const d of done) this.onDanmakuDone?.(d);
  }

  /**
   * A danmaku line: passed on to every page, and waited for from the pages that show danmaku
   * (ended at once when there is none). Not kept for new clients.
   */
  danmaku(line: Extract<CoreMessage, { type: "danmaku" }>): void {
    const { send, done } = this.#danmaku.line(line.id, line.max_wait_ms);
    this.#ended(done);
    if (!send) return;
    const { id, name, text, max_on_screen, queue_max, max_wait_ms } = line;
    this.#send(frame({ type: "danmaku", id, name, text, max_on_screen, queue_max, max_wait_ms }));
  }

  /** Every danmaku line off the pages; the waiting ones come back as dropped (`cleared`). */
  danmakuClear(): void {
    this.#send(frame({ type: "danmaku_clear" }));
  }

  /** Lines no page answered in time: lost. */
  expireDanmaku(): void {
    this.#ended(this.#danmaku.expire());
  }

  /** A page connected; its id for `reply` and `leave`. */
  join(): number {
    this.#nextPage += 1;
    return this.#nextPage;
  }

  /** A frame page `page` sent (`OverlayReply`); anything else is ignored. */
  reply(page: number, text: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return;
    }
    const parsed = OverlayReplySchema.safeParse(raw);
    if (!parsed.success) return;
    const msg = parsed.data;
    if (msg.type === "danmaku_ready") this.#danmaku.ready(page);
    else if (msg.type === "danmaku_shown") this.#ended(this.#danmaku.shown(page, msg.id));
    else this.#ended(this.#danmaku.dropped(page, msg.id, msg.reason));
  }

  /** Page `page` went away: the lines only it was showing are lost. */
  leave(page: number): void {
    this.#ended(this.#danmaku.leave(page));
  }

  /** A viewer's touch, passed on (at most a few a second; the rest are dropped). Not kept for new clients. */
  touch(touch: Touch): void {
    if (this.#listeners.size === 0 || !this.#touches.allow(this.#now())) return;
    const { x, y, part } = touch;
    this.#send(frame({ type: "touch", x, y, part }));
  }

  speaking(state: SpeakingState): void {
    this.#send(frame({ type: "speaking", state }));
  }

  /**
   * Her voice level as viewers hear it (`rms` 0..1, the lip-sync `bands`), once per avatar frame
   * while there is audio and once with `rms: 0` when it stops. Not kept for new clients.
   */
  levels(rms: number, bands: readonly number[] | null): void {
    if (this.#listeners.size === 0) return;
    const round = (v: number) => Math.round(v * 1e4) / 1e4;
    const v: OverlayMessage = { type: "levels", rms: round(rms) };
    if (bands !== null && bands.length > 0) v.bands = bands.map(round);
    this.#send(frame(v));
  }

  /** `core`: the Stage is connected to Core. */
  status(status: StageStatus, core: boolean): void {
    const v = frame({
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

  /**
   * The snapshot for a new client: status, emotion, subtitle, notice, activity, the karaoke scene
   * and its round's words (those that exist).
   */
  initial(): string[] {
    const s = this.#snapshot;
    const out = [s.status, s.emotion, s.subtitle, s.notice].filter((v): v is string => v !== null);
    const gift = this.#gifts.current(this.#now());
    if (gift !== null) out.push(frame({ type: "gift", text: gift }));
    if (s.activity !== null) {
      const { activity, at } = s.activity;
      const elapsed =
        activity.elapsed_ms === null
          ? null
          : Math.round(activity.elapsed_ms + Math.max(this.#now() - at, 0));
      out.push(frame({ type: "activity", ...activity, elapsed_ms: elapsed }));
    }
    if (s.karaoke !== null) out.push(this.#karaokeFrame(s.karaoke.scene, s.karaoke.at));
    if (s.karaokeLyrics !== null) {
      out.push(this.#lyricsFrame(s.karaokeLyrics.lyrics, s.karaokeLyrics.key));
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
 * The one byte range a `Range` header asks of a file of `size` bytes: `{start, end}` (inclusive),
 * `"unsatisfiable"` when it lies past the end, or `null` to send the whole file (no header, or one
 * this server does not take: another unit, several ranges, a malformed one).
 */
export function byteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | "unsatisfiable" | null {
  const m = header?.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") {
    // The last N bytes.
    const suffix = Number(m[2]);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(size - suffix, 0), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size) return "unsatisfiable";
  if (end < start) return null;
  return { start, end };
}

/**
 * Sends a karaoke round's file (its video or backing, of media type `type`) with byte ranges (the
 * page's `<video>` seeks in the video), never cached; 404 when it is not a file. The caller has
 * checked that `path` is the one Core named for the round shown.
 */
async function sendMedia(
  path: string,
  type: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path);
  } catch {
    return notFound(res);
  }
  if (!info.isFile()) return notFound(res);
  const size = info.size;
  const headers = {
    "content-type": type,
    "accept-ranges": "bytes",
    "cache-control": "no-store",
  };
  const range = byteRange(req.headers.range, size);
  if (range === "unsatisfiable") {
    res.writeHead(416, { ...headers, "content-range": `bytes */${size}` }).end();
    return;
  }
  if (range === null) {
    res.writeHead(200, { ...headers, "content-length": String(size) });
  } else {
    res.writeHead(206, {
      ...headers,
      "content-range": `bytes ${range.start}-${range.end}/${size}`,
      "content-length": String(range.end - range.start + 1),
    });
  }
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(path, range === null ? {} : range)
    .on("error", () => res.destroy())
    .pipe(res);
}

/**
 * `/overlay/<rest>` → a file under `root` (with `index.html` for directories), the backdrop
 * picture (the owner's config, wherever it is) at `/overlay/backdrop`, or the karaoke round's
 * video and backing at `/overlay/karaoke/video?r=<key>` and `/overlay/karaoke/backing?r=<key>`
 * (`karaoke` names the file of a key, `null`: none).
 */
async function serveFile(
  root: string,
  backdrop: string | null,
  karaoke: Pick<OverlayHub, "karaokeVideo" | "karaokeBacking">,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" }).end();
    return;
  }
  const [rawPath = "/", query = ""] = (req.url ?? "/").split("?", 2);
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
  if (rel === KARAOKE_VIDEO_PATH) {
    const path = karaoke.karaokeVideo(new URLSearchParams(query).get("r"));
    return path === null ? notFound(res) : sendMedia(path, "video/mp4", req, res);
  }
  if (rel === KARAOKE_BACKING_PATH) {
    const file = karaoke.karaokeBacking(new URLSearchParams(query).get("r"));
    return file === null ? notFound(res) : sendMedia(file.path, file.type, req, res);
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
      serveFile(root, picture, hub, req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
        else res.destroy();
      });
    },
    ws: [
      {
        path: "/overlay/ws",
        onConnection(ws) {
          for (const text of hub.initial()) ws.send(text);
          const page = hub.join();
          const unsubscribe = hub.listen((text) => {
            if (ws.bufferedAmount > MAX_BUFFERED) {
              log.debug("overlay client lagged");
              return;
            }
            ws.send(text);
          });
          // What became of the danmaku lines it was given (and whether it shows them at all).
          ws.on("message", (data, isBinary) => {
            if (!isBinary) hub.reply(page, data.toString());
          });
          let gone = false;
          const leave = () => {
            if (gone) return;
            gone = true;
            unsubscribe();
            hub.leave(page);
          };
          ws.on("close", leave);
          ws.on("error", leave);
        },
      },
    ],
  });
  log.info(`overlay at http://${formatAddress(server.address)}/overlay/`);
  return { addr: server.address, done: closeOnAbort(server, signal) };
}
