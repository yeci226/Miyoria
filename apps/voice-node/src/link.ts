// WebSocket client for the Voice Link protocol (node -> Core).
//
// Reconnects forever with exponential backoff, except for close codes that mean retrying is
// pointless (bad token, version mismatch, replaced by another node). Never blocks the event loop:
// audio is dropped (not queued) when the socket's send buffer is backed up.
import { EventEmitter } from "node:events";
import WebSocket, { type RawData } from "ws";
import type { Logger } from "./log.js";
import { noopLogger } from "./log.js";
import {
  CLOSE_BAD_TOKEN,
  CLOSE_REPLACED,
  CLOSE_VERSION_MISMATCH,
  type CoreMessage,
  decodeBinaryFrame,
  encodeNodeMessage,
  FRAME_LEVELS,
  FRAME_PLAYBACK,
  NODE_CAPABILITIES,
  type NodeMessage,
  parseCoreMessage,
  PROTOCOL_VERSION,
} from "./protocol.js";

/** What the voice side needs from the link (and what tests fake). */
export interface LinkSink {
  /** Sends a JSON message. Returns false (and drops it) if the link is not ready. */
  send(msg: NodeMessage): boolean;
  /** Sends a binary audio frame. Returns false (and drops it) if not ready or backed up. */
  sendAudio(frame: Buffer): boolean;
}

export interface CoreLinkOptions {
  url: string;
  token: string;
  selfAccountId: string;
  log?: Logger;
  /** Initial reconnect delay (ms). */
  backoffMinMs?: number;
  backoffMaxMs?: number;
  /** Drop outgoing audio once this many bytes are waiting in the socket send buffer. */
  maxBufferedBytes?: number;
  /** Treat the link as dead after this long without any frame from Core (Core pings every 15 s). */
  idleTimeoutMs?: number;
  /** Max time to wait for `welcome` after sending `hello`. */
  helloTimeoutMs?: number;
}

export interface CoreLinkEvents {
  /** `welcome` received: the link is ready. */
  ready: [session: string];
  /** The link went down (will retry unless a fatal event follows). */
  down: [info: { code: number; reason: string }];
  message: [msg: CoreMessage];
  /** Binary playback audio from Core. `pcm` is a view into the received buffer. */
  playbackAudio: [play: number, pcm: Buffer];
  /** Binary levels track of a play (what lip sync follows). */
  playbackLevels: [play: number, pcm: Buffer];
  /** Retrying is pointless; the process should shut down. */
  fatal: [error: Error];
}

export class CoreLink extends EventEmitter<CoreLinkEvents> implements LinkSink {
  private readonly o: Required<Omit<CoreLinkOptions, "log">>;
  private readonly log: Logger;
  private ws: WebSocket | undefined;
  private ready = false;
  private stopped = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private helloTimer: ReturnType<typeof setTimeout> | undefined;
  private connectedAt = 0;

  constructor(opts: CoreLinkOptions) {
    super();
    this.log = opts.log ?? noopLogger;
    this.o = {
      url: opts.url,
      token: opts.token,
      selfAccountId: opts.selfAccountId,
      backoffMinMs: opts.backoffMinMs ?? 1000,
      backoffMaxMs: opts.backoffMaxMs ?? 30_000,
      maxBufferedBytes: opts.maxBufferedBytes ?? 512 * 1024,
      idleTimeoutMs: opts.idleTimeoutMs ?? 60_000,
      helloTimeoutMs: opts.helloTimeoutMs ?? 10_000,
    };
  }

  get isReady(): boolean {
    return this.ready;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  /** Closes the socket and stops reconnecting. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = undefined;
    this.ready = false;
    if (!ws) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        ws.terminate();
        resolve();
      }, 1500);
      ws.once("close", () => {
        clearTimeout(t);
        resolve();
      });
      try {
        ws.close(1000, "shutdown");
      } catch {
        clearTimeout(t);
        resolve();
      }
    });
  }

  send(msg: NodeMessage): boolean {
    const ws = this.ws;
    if (!this.ready || !ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(encodeNodeMessage(msg));
      return true;
    } catch (err) {
      this.log.warn("send failed:", err);
      return false;
    }
  }

  sendAudio(frame: Buffer): boolean {
    const ws = this.ws;
    if (!this.ready || !ws || ws.readyState !== WebSocket.OPEN) return false;
    if (ws.bufferedAmount > this.o.maxBufferedBytes) return false;
    try {
      ws.send(frame, { binary: true });
      return true;
    } catch (err) {
      this.log.warn("audio send failed:", err);
      return false;
    }
  }

  // ── connection management ────────────────────────────────────────────────

  private connect(): void {
    if (this.stopped) return;
    this.log.info(`connecting to ${this.o.url} (attempt ${this.attempt + 1})`);
    const ws = new WebSocket(this.o.url, { maxPayload: 8 * 1024 * 1024, perMessageDeflate: false });
    this.ws = ws;
    this.ready = false;

    ws.on("open", () => {
      this.connectedAt = Date.now();
      this.log.debug("socket open, sending hello");
      // Raw send: `send()` refuses until welcome.
      ws.send(
        encodeNodeMessage({
          type: "hello",
          version: PROTOCOL_VERSION,
          token: this.o.token,
          node: "voice-node",
          self_account: { platform: "discord", id: this.o.selfAccountId },
          capabilities: [...NODE_CAPABILITIES],
        }),
      );
      this.helloTimer = setTimeout(() => {
        this.log.warn("no welcome from Core in time, reconnecting");
        ws.terminate();
      }, this.o.helloTimeoutMs);
      this.bumpIdle();
    });

    ws.on("message", (data: RawData, isBinary: boolean) => {
      this.bumpIdle();
      if (isBinary) this.onBinary(data);
      else this.onText(data.toString());
    });

    ws.on("error", (err: Error) => {
      // 'close' follows; just record why.
      this.log.warn("socket error:", err.message);
    });

    ws.on("close", (code: number, reasonBuf: Buffer) => {
      if (this.ws !== ws) return; // superseded / stopped
      this.ws = undefined;
      const wasReady = this.ready;
      this.ready = false;
      this.clearTimers();
      const reason = reasonBuf.toString();
      if (wasReady) this.emit("down", { code, reason });
      this.onClosed(code, reason);
    });
  }

  private onClosed(code: number, reason: string): void {
    if (this.stopped) return;
    if (code === CLOSE_BAD_TOKEN) {
      this.log.error("Core rejected our token (close 4401): bad token. Check VOICE_LINK_TOKEN. Not retrying.");
      this.stopped = true;
      this.emit("fatal", new Error("bad token"));
      return;
    }
    if (code === CLOSE_VERSION_MISMATCH) {
      this.log.error(`Core does not speak voice-link v${PROTOCOL_VERSION} (close 4400). Not retrying.`);
      this.stopped = true;
      this.emit("fatal", new Error("protocol version mismatch"));
      return;
    }
    if (code === CLOSE_REPLACED) {
      this.log.error("Replaced by a newer voice-node connection for the same self account (close 4409). Not retrying.");
      this.stopped = true;
      this.emit("fatal", new Error("replaced by another connection"));
      return;
    }
    // A connection that stayed healthy for a while resets the backoff.
    if (Date.now() - this.connectedAt > 30_000) this.attempt = 0;
    const base = Math.min(this.o.backoffMaxMs, this.o.backoffMinMs * 2 ** this.attempt);
    const delay = Math.round(base * (0.75 + Math.random() * 0.5));
    this.attempt++;
    this.log.warn(`link closed (code ${code}${reason ? `, ${reason}` : ""}); reconnecting in ${delay} ms`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.connect();
    }, delay);
  }

  private onText(text: string): void {
    const parsed = parseCoreMessage(text);
    if (!parsed.ok) {
      if (parsed.ignorable) this.log.debug("ignoring message:", parsed.error);
      else this.log.warn("bad message from Core:", parsed.error);
      return;
    }
    const msg = parsed.value;
    switch (msg.type) {
      case "welcome":
        if (this.helloTimer) clearTimeout(this.helloTimer);
        this.helloTimer = undefined;
        this.ready = true;
        this.attempt = 0;
        this.log.info(`link ready (session ${msg.session})`);
        this.emit("ready", msg.session);
        return;
      case "ping":
        this.send({ type: "pong" });
        return;
      default:
        if (!this.ready) {
          this.log.warn(`got ${msg.type} before welcome, ignoring`);
          return;
        }
        this.emit("message", msg);
    }
  }

  private onBinary(data: RawData): void {
    if (!this.ready) return;
    const buf = Array.isArray(data)
      ? Buffer.concat(data)
      : data instanceof ArrayBuffer
        ? Buffer.from(data)
        : data;
    const frame = decodeBinaryFrame(buf);
    if (!frame.ok) {
      this.log.debug("bad binary frame:", frame.error);
      return;
    }
    if (frame.value.kind === FRAME_PLAYBACK) this.emit("playbackAudio", frame.value.id, frame.value.pcm);
    else if (frame.value.kind === FRAME_LEVELS) this.emit("playbackLevels", frame.value.id, frame.value.pcm);
    else this.log.debug("ignoring capture-direction frame from Core");
  }

  private bumpIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const ws = this.ws;
    this.idleTimer = setTimeout(() => {
      this.log.warn(`no traffic from Core for ${this.o.idleTimeoutMs} ms, reconnecting`);
      ws?.terminate();
    }, this.o.idleTimeoutMs);
  }

  private clearTimers(): void {
    for (const t of [this.retryTimer, this.idleTimer, this.helloTimer]) if (t) clearTimeout(t);
    this.retryTimer = undefined;
    this.idleTimer = undefined;
    this.helloTimer = undefined;
  }
}
