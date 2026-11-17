// WebSocket client for the Stage's levels endpoint (ws://127.0.0.1:7883/levels).
// Sends `{"t": <ms>, "rms": 0..1, "bands": [..]}` text frames (`bands` only when measured).
// The Stage being absent is normal: reconnect
// quietly (one warning per outage) and drop points while disconnected.
import type { LevelFrame } from "@miyoria/contracts/stage-link";
import WebSocket from "ws";
import type { Logger } from "../log.js";
import { noopLogger } from "../log.js";
import type { LevelSink } from "./publisher.js";
import type { LevelPoint } from "./rms.js";

export interface LevelsClientOptions {
  url: string;
  log?: Logger;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  /** Drop points while this many bytes are waiting in the socket buffer. */
  maxBufferedBytes?: number;
}

// The frame is `LevelFrame` in `@miyoria/contracts/stage-link`. A point must be one: if the
// contract changes a field in a way a point no longer fits, this stops compiling.
type PointIsALevelFrame = LevelPoint extends LevelFrame ? true : never;
const _pointIsALevelFrame: PointIsALevelFrame = true;
void _pointIsALevelFrame;

/**
 * The wire text of one `LevelFrame`. Built by hand on purpose, not with `JSON.stringify`: this runs
 * many times a second, and the stringified object would carry full-precision floats (`rms` to 15+
 * digits, `t` unrounded) that the Stage does not need, which makes every frame
 * noticeably larger. Outgoing frames are not validated against the schema for the same reason; the type
 * above is the check. The bytes are pinned in test/levels-encode.test.ts.
 */
export function encodeLevel(p: LevelPoint): string {
  // 4 decimals is far below what a mouth shape can show; keeps the frames small.
  const head = `{"t":${Math.round(p.t)},"rms":${Math.round(p.rms * 10_000) / 10_000}`;
  if (!p.bands || p.bands.length === 0) return `${head}}`;
  // Bands are compared on a log scale: keep 3 significant digits instead of fixed decimals.
  return `${head},"bands":[${p.bands.map((b) => Number(b.toPrecision(3))).join(",")}]}`;
}

export class LevelsClient implements LevelSink {
  private readonly url: string;
  private readonly log: Logger;
  private readonly minMs: number;
  private readonly maxMs: number;
  private readonly maxBuffered: number;
  private ws: WebSocket | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private stopped = true;
  private warned = false;

  constructor(opts: LevelsClientOptions) {
    this.url = opts.url;
    this.log = opts.log ?? noopLogger;
    this.minMs = opts.backoffMinMs ?? 500;
    this.maxMs = opts.backoffMaxMs ?? 5000;
    this.maxBuffered = opts.maxBufferedBytes ?? 64 * 1024;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const ws = this.ws;
    this.ws = undefined;
    try {
      ws?.terminate();
    } catch {
      // already closed
    }
  }

  send(point: LevelPoint): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > this.maxBuffered) return;
    try {
      ws.send(encodeLevel(point));
    } catch {
      // closing; the close handler reconnects
    }
  }

  private connect(): void {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url, { perMessageDeflate: false, handshakeTimeout: 3000 });
    } catch (err) {
      this.log.warn(`levels: bad STAGE_LEVELS_URL: ${err instanceof Error ? err.message : String(err)}`);
      this.stopped = true;
      return;
    }
    this.ws = ws;
    ws.on("open", () => {
      this.attempt = 0;
      this.warned = false;
      this.log.info(`levels: connected to ${this.url}`);
    });
    // 'close' always follows an error; nothing else to do here (and it must not throw).
    ws.on("error", (err: Error) => this.log.debug(`levels: ${err.message}`));
    ws.on("close", () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      if (this.stopped) return;
      if (!this.warned) {
        this.warned = true;
        this.log.warn(`levels: ${this.url} is not reachable; lip-sync is off until the Stage is up (retrying quietly)`);
      }
      const delay = Math.min(this.maxMs, this.minMs * 2 ** this.attempt);
      this.attempt++;
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.connect();
      }, delay);
      this.timer.unref?.();
    });
  }
}
