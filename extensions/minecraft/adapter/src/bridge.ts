// WebSocket client of the miyoria-bridge mod (extensions/minecraft/PROTOCOL.md):
// `hello` handshake, request / result correlation, pushed events and
// reconnection with exponential backoff.

import WebSocket from "ws";
import type { Endpoint } from "./config.js";

export interface HelloAck {
  protocol: number;
  mod_version?: string;
  minecraft?: string;
  /** `tasks`: the mod reports task lifecycle (PROTOCOL.md §6.1). */
  capabilities?: { baritone?: boolean; altoclef?: boolean; screenshot?: boolean; tasks?: boolean };
}

/** A failed request: a mod error code (`not_in_game`, ...) or `not_connected` / `timeout`. */
export class BridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

export interface BridgeEvent {
  name: string;
  time?: number;
  data: Record<string, unknown>;
}

export interface BridgeLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface BridgeOptions {
  /** Called before every connection attempt. */
  endpoint: () => Endpoint | Promise<Endpoint>;
  requestTimeoutMs?: number;
  helloTimeoutMs?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  log?: BridgeLogger;
}

interface Pending {
  resolve: (data: Record<string, unknown>) => void;
  reject: (error: BridgeError) => void;
  timer: NodeJS.Timeout;
}

type Listener<T> = (value: T) => void;

/** Keeps one authenticated connection to the mod alive. */
export class BridgeClient {
  readonly #opts: Required<Omit<BridgeOptions, "log">> & { log?: BridgeLogger };
  #ws: WebSocket | undefined;
  #ready = false;
  #hello: HelloAck | undefined;
  #seq = 0;
  readonly #pending = new Map<string, Pending>();
  #closed = true;
  #delay: number;
  #retry: NodeJS.Timeout | undefined;
  #helloTimer: NodeJS.Timeout | undefined;
  readonly #eventListeners = new Set<Listener<BridgeEvent>>();
  readonly #statusListeners = new Set<Listener<HelloAck | undefined>>();

  constructor(opts: BridgeOptions) {
    this.#opts = {
      endpoint: opts.endpoint,
      requestTimeoutMs: opts.requestTimeoutMs ?? 10_000,
      helloTimeoutMs: opts.helloTimeoutMs ?? 5_000,
      reconnectMinMs: opts.reconnectMinMs ?? 1_000,
      reconnectMaxMs: opts.reconnectMaxMs ?? 15_000,
      log: opts.log,
    };
    this.#delay = this.#opts.reconnectMinMs;
  }

  /** Connected and past `hello`. */
  get ready(): boolean {
    return this.#ready;
  }

  /** The last `hello_ack` (undefined while disconnected). */
  get hello(): HelloAck | undefined {
    return this.#ready ? this.#hello : undefined;
  }

  onEvent(listener: Listener<BridgeEvent>): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  /** Called with the `hello_ack` on connect and `undefined` on disconnect. */
  onStatus(listener: Listener<HelloAck | undefined>): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  /** Starts connecting (and reconnecting) in the background. */
  start(): void {
    if (!this.#closed) return;
    this.#closed = false;
    void this.#connect();
  }

  /** Stops for good: closes the socket and fails pending requests. */
  close(): void {
    this.#closed = true;
    clearTimeout(this.#retry);
    clearTimeout(this.#helloTimer);
    const ws = this.#ws;
    this.#ws = undefined;
    ws?.removeAllListeners();
    ws?.on("error", () => {});
    ws?.close();
    this.#lost();
  }

  /** Sends a request and resolves with its `data`; throws `BridgeError`. */
  request(type: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const ws = this.#ws;
    if (!this.#ready || !ws) {
      return Promise.reject(new BridgeError("not_connected", "not connected to the mod"));
    }
    const id = String(++this.#seq);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new BridgeError("timeout", `${type} timed out`));
      }, this.#opts.requestTimeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ ...params, id, type }), (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new BridgeError("not_connected", error.message));
      });
    });
  }

  async #connect(): Promise<void> {
    if (this.#closed) return;
    let endpoint: Endpoint;
    try {
      endpoint = await this.#opts.endpoint();
    } catch (error) {
      this.#opts.log?.warn("cannot resolve the bridge endpoint", { error: String(error) });
      this.#schedule();
      return;
    }
    if (this.#closed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(endpoint.url, { handshakeTimeout: this.#opts.helloTimeoutMs });
    } catch (error) {
      // A malformed `url` throws synchronously; keep retrying (the config may be fixed) instead
      // of crashing the extension with an unhandled rejection.
      this.#opts.log?.warn("invalid bridge url", { url: endpoint.url, error: String(error) });
      this.#schedule();
      return;
    }
    this.#ws = ws;
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "hello", token: endpoint.token, client: "miyoria-adapter" }));
      this.#helloTimer = setTimeout(() => ws.terminate(), this.#opts.helloTimeoutMs);
    });
    ws.on("message", (raw) => this.#onMessage(ws, raw.toString()));
    ws.on("error", () => {}); // `close` follows and schedules the retry
    ws.on("close", (code, reason) => {
      if (this.#ws !== ws) return;
      clearTimeout(this.#helloTimer);
      this.#ws = undefined;
      const wasReady = this.#ready;
      this.#lost();
      if (code === 1008) {
        this.#opts.log?.warn("the mod refused the connection (check the token)", {
          reason: reason.toString(),
        });
      } else if (wasReady) {
        this.#opts.log?.info("disconnected from the mod", { code });
      }
      this.#schedule();
    });
  }

  #onMessage(ws: WebSocket, text: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (msg.type) {
      case "hello_ack": {
        clearTimeout(this.#helloTimer);
        if (this.#ws !== ws) return;
        this.#hello = msg as unknown as HelloAck;
        const first = !this.#ready;
        this.#ready = true;
        this.#delay = this.#opts.reconnectMinMs;
        if (first) {
          this.#opts.log?.info("connected to the mod", {
            minecraft: this.#hello.minecraft,
            capabilities: this.#hello.capabilities,
          });
          for (const l of this.#statusListeners) l(this.#hello);
        }
        return;
      }
      case "result": {
        const id = String(msg.id);
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        if (msg.ok === true) {
          pending.resolve((msg.data as Record<string, unknown> | undefined) ?? {});
        } else {
          const error = (msg.error as { code?: string; message?: string } | undefined) ?? {};
          pending.reject(new BridgeError(error.code ?? "internal", error.message ?? "request failed"));
        }
        return;
      }
      case "event": {
        if (typeof msg.name !== "string") return;
        const event: BridgeEvent = {
          name: msg.name,
          time: typeof msg.time === "number" ? msg.time : undefined,
          data: (msg.data as Record<string, unknown> | undefined) ?? {},
        };
        for (const l of this.#eventListeners) l(event);
        return;
      }
      case "error": {
        const error = (msg.error as { code?: string; message?: string } | undefined) ?? {};
        this.#opts.log?.warn("bridge error", { code: error.code, message: error.message });
        return;
      }
      default:
        return;
    }
  }

  /** Clears connection state and fails pending requests. */
  #lost(): void {
    const wasReady = this.#ready;
    this.#ready = false;
    for (const [id, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(new BridgeError("not_connected", "connection to the mod was lost"));
      this.#pending.delete(id);
    }
    if (wasReady) for (const l of this.#statusListeners) l(undefined);
  }

  #schedule(): void {
    if (this.#closed) return;
    clearTimeout(this.#retry);
    const delay = this.#delay;
    this.#delay = Math.min(this.#delay * 2, this.#opts.reconnectMaxMs);
    this.#retry = setTimeout(() => void this.#connect(), delay);
  }
}
