// The WebSocket server games connect to. One game at a time: the spec describes one game per
// connection, and two games sharing one forced-choice slot would answer each other's questions.
// A second connection is refused (1013, "try again later"), not allowed to push the first out,
// so a stray process cannot take a running game's place. A dead first connection (no pong for
// two ping intervals) is dropped, which frees the slot for a game that restarted.

import { WebSocket, WebSocketServer } from "ws";
import { isLoopback, type NeuroConfig } from "./config.js";
import { MAX_FRAME_BYTES, parseClientMessage, type ServerMessage } from "./protocol.js";
import type { Link, Session } from "./session.js";

export interface ServerLog {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** More messages than this in one second closes the connection. */
const MAX_MESSAGES_PER_SECOND = 100;

export class NeuroServer {
  readonly #cfg: NeuroConfig;
  readonly #session: Session;
  readonly #log: ServerLog;
  #wss: WebSocketServer | null = null;
  #active: WebSocket | null = null;
  #heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(config: NeuroConfig, session: Session, log: ServerLog) {
    this.#cfg = config;
    this.#session = session;
    this.#log = log;
  }

  /** The port actually bound (useful with `port = 0`). */
  get port(): number {
    const address = this.#wss?.address();
    return typeof address === "object" && address !== null ? address.port : this.#cfg.port;
  }

  start(): Promise<void> {
    if (!isLoopback(this.#cfg.host)) {
      this.#log.warn(
        "listening beyond loopback: anything that can reach this port can drive her game interface",
        {
          host: this.#cfg.host,
        },
      );
    }
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({
        host: this.#cfg.host,
        port: this.#cfg.port,
        maxPayload: MAX_FRAME_BYTES,
      });
      const failed = (error: Error) =>
        reject(new Error(`cannot listen on ${this.#cfg.host}:${this.#cfg.port}: ${error.message}`));
      wss.once("error", failed);
      wss.once("listening", () => {
        wss.off("error", failed);
        wss.on("error", (error) => this.#log.error("server error", { error: String(error) }));
        this.#wss = wss;
        this.#log.info("listening for games", { host: this.#cfg.host, port: this.port });
        resolve();
      });
      wss.on("connection", (ws) => this.#accept(ws));
      this.#heartbeat = setInterval(() => this.#ping(), this.#cfg.ping_interval_ms);
      this.#heartbeat.unref?.();
    });
  }

  async close(): Promise<void> {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    const wss = this.#wss;
    this.#wss = null;
    if (!wss) return;
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }

  #alive = new WeakMap<WebSocket, boolean>();

  #ping(): void {
    const ws = this.#active;
    if (!ws) return;
    if (this.#alive.get(ws) === false) {
      this.#log.warn("the game stopped answering pings: dropped");
      ws.terminate();
      return;
    }
    this.#alive.set(ws, false);
    ws.ping();
  }

  #accept(ws: WebSocket): void {
    if (this.#active && this.#active.readyState === WebSocket.OPEN) {
      this.#log.warn("a second game tried to connect: refused");
      ws.close(1013, "another game is already connected");
      return;
    }
    this.#active = ws;
    this.#alive.set(ws, true);
    ws.on("pong", () => this.#alive.set(ws, true));
    const link: Link = {
      send: (message: ServerMessage) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
      },
      close: (code, reason) => ws.close(code, reason),
    };
    this.#session.attach(link);
    let windowStart = Date.now();
    let inWindow = 0;
    ws.on("message", (raw, isBinary) => {
      const now = Date.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        inWindow = 0;
      }
      inWindow += 1;
      if (inWindow > MAX_MESSAGES_PER_SECOND) {
        this.#log.warn("the game sends too fast: dropped");
        ws.close(1008, "too many messages");
        return;
      }
      const frame = parseClientMessage(raw, isBinary);
      if (!frame.ok) {
        // Silently ignored, as the spec says: no reply, no disconnect.
        this.#log.info("a message was ignored", {
          reason: frame.reason,
          command: frame.command ?? null,
        });
        return;
      }
      const message = frame.message;
      if (message.command === "startup" && !this.#gameAllowed(message.game)) {
        this.#log.warn("a game that is not in `games` tried to start: dropped");
        ws.close(1008, "game not allowed");
        return;
      }
      try {
        this.#session.handle(link, message);
      } catch (error) {
        this.#log.error("handling a message failed", {
          command: message.command,
          error: String(error),
        });
      }
    });
    ws.on("close", () => {
      if (this.#active === ws) this.#active = null;
      this.#session.detach(link);
    });
    ws.on("error", (error) => this.#log.warn("connection error", { error: String(error) }));
  }

  #gameAllowed(game: string): boolean {
    const allowed = this.#cfg.games;
    return allowed.length === 0 || allowed.includes(game);
  }
}
