// The `StageLink` service: the connection to the Stage node and the requests other modules send.

import { type EventBus, errorMessage, getLogger } from "@miyoria/kernel";
import {
  customEvent,
  type Event,
  type JsonValue,
  type ModuleId,
  newId,
  serviceKey,
} from "@miyoria/types";
import type WebSocket from "ws";
import { z } from "zod";
import {
  CLIP_REASON_MAX,
  CLOSE,
  type CoreMessage,
  defaultStageStatus,
  type GazeTarget,
  type GiftExpression,
  parseStageMessage,
  type SceneTransition,
  type StageMessage,
  type StageStatus,
  type StreamAction,
  sameStatus,
  statusOf,
} from "../protocol.js";
import { type Unsubscribe, Watch } from "../watch.js";
import { Conn, checkHello } from "./conn.js";
import { HighlightsConfigSchema } from "./highlights.js";
import { ScenesConfigSchema } from "./scenes.js";

const log = getLogger("stage.link");

/**
 * Topic of status updates published by `stage.link`
 * (`{connected, vts, obs, scene, streaming, scenes, hotkeys, overlay_url}`).
 */
export const STATUS_TOPIC = "stage.status";
/** Topic of errors reported by the Stage node (`{message}`). */
export const ERROR_TOPIC = "stage.error";
/** Topic of a highlight the Stage node saved (`{reason, path}`; the path is on the streaming PC). */
export const CLIP_TOPIC = "stage.clip";

export const DEFAULT_BIND = "127.0.0.1:7882";

/** `[modules."stage.link"]` config section. */
export const StageLinkConfigSchema = z.object({
  /** Listen address. */
  bind: z.string().default(DEFAULT_BIND),
  /** Shared secret the node sends in `hello`. Required. */
  token: z.string().default(""),
  /** Core → node ping interval. */
  ping_interval_ms: z.number().int().nonnegative().default(15_000),
  /** A node that sends nothing for this long is disconnected. */
  peer_timeout_ms: z.number().int().nonnegative().default(45_000),
  /** Time allowed between connecting and `hello`. */
  hello_timeout_ms: z.number().int().nonnegative().default(5_000),
  /** How long scene / stream / hotkey requests wait for the answer. */
  request_timeout_ms: z.number().int().nonnegative().default(10_000),
  /** Also show replies of text (non-voice) turns as subtitles. */
  subtitle_text_turns: z.boolean().default(false),
  /** Follow the voice node's Go Live: start / stop OBS streaming with it. */
  golive_obs: z.boolean().default(true),
  /**
   * Wait this long after Go Live starts before pressing OBS "Start Streaming": the voice node's
   * ffmpeg has to bind the RTMP listener first. Default 3 000.
   */
  golive_start_delay_ms: z.number().int().nonnegative().default(3_000),
  /** Scene roles, transitions and the scene director (`[modules."stage.link".scenes]`). */
  scenes: ScenesConfigSchema.prefault({}),
  /** Highlights saved from OBS's replay buffer while she streams (`[modules."stage.link".highlights]`). */
  highlights: HighlightsConfigSchema.prefault({}),
});
export type StageLinkConfig = z.output<typeof StageLinkConfigSchema>;

export class StageLinkError extends Error {
  override readonly name = "StageLinkError";
}

interface Timings {
  pingIntervalMs: number;
  peerTimeoutMs: number;
  helloTimeoutMs: number;
  requestTimeoutMs: number;
}

/**
 * Service provided by `stage.link` as `StageLinkKey`: the connection to the Stage node
 * (VTube Studio, OBS, overlay on the streaming PC).
 */
export class StageLink {
  readonly #module: ModuleId;
  readonly #bus: EventBus;
  readonly #timings: Timings;
  readonly #token: string;
  readonly #signal: AbortSignal;
  #conn: Conn | null = null;
  readonly #status = new Watch<StageStatus | null>(null, sameStatus);
  /** Sockets that have not sent their hello yet. */
  readonly #handshaking = new Set<WebSocket>();
  #nextConn = 1;
  #nextRequest = 1;

  /** @internal Created by `StageLinkModule`. */
  constructor(module: ModuleId, bus: EventBus, config: StageLinkConfig, signal: AbortSignal) {
    this.#module = module;
    this.#bus = bus;
    this.#timings = {
      pingIntervalMs: Math.max(config.ping_interval_ms, 1),
      peerTimeoutMs: Math.max(config.peer_timeout_ms, 1),
      helloTimeoutMs: Math.max(config.hello_timeout_ms, 1),
      requestTimeoutMs: Math.max(config.request_timeout_ms, 1),
    };
    this.#token = config.token.trim();
    this.#signal = signal;
  }

  /** A Stage node is connected and authenticated. */
  isConnected(): boolean {
    return this.#conn !== null;
  }

  /** Name and capabilities the connected node announced. */
  node(): [string, string[]] | null {
    return this.#conn ? [this.#conn.node, [...this.#conn.capabilities]] : null;
  }

  /** Last status reported by the node; `null` while disconnected. */
  status(): StageStatus | null {
    const s = this.#status.get();
    return s ? { ...s } : null;
  }

  /** Watches the status (`null` while disconnected); returns the unsubscribe function. */
  subscribeStatus(listener: (status: StageStatus | null) => void): Unsubscribe {
    return this.#status.subscribe(listener);
  }

  /**
   * Switches the OBS program scene, with `transition` (when given) made OBS's current scene
   * transition first. Returns the status after the switch.
   */
  setScene(name: string, transition: SceneTransition | null = null): Promise<StageStatus> {
    const n = name.trim();
    if (n === "") return Promise.reject(new StageLinkError("scene name is empty"));
    return this.#request((id) => {
      const msg: Extract<CoreMessage, { type: "scene" }> = { type: "scene", name: n, id };
      if (transition !== null) {
        msg.transition = transition.name;
        if (transition.duration_ms !== null) msg.transition_ms = transition.duration_ms;
      }
      return msg;
    });
  }

  /** Starts or stops streaming in OBS. */
  stream(action: StreamAction): Promise<StageStatus> {
    // The node answers once OBS reports the change (`stream_wait_ms`, 15 s by default).
    return this.#request(
      (id) => ({ type: "stream", action, id }),
      this.#timings.requestTimeoutMs * 2,
    );
  }

  /** Triggers a VTube Studio hotkey by name (or id). */
  hotkey(name: string): Promise<StageStatus> {
    return this.#request((id) => ({ type: "avatar_hotkey", name: name.trim(), id }));
  }

  /**
   * Shows a gift expression on her for `seconds`, then lets her own expression come back. Resolves
   * once the node has it on; rejects when no node is connected or VTube Studio refuses.
   */
  expression(expression: GiftExpression, seconds: number): Promise<StageStatus> {
    return this.#request((id) => ({ type: "avatar_expression", expression, seconds, id }));
  }

  /**
   * Saves a highlight (OBS's replay buffer) with `reason` noted next to it. Resolves once saved
   * (the file arrives as a `CLIP_TOPIC` event); rejects when OBS saved nothing.
   */
  clip(reason: string): Promise<StageStatus> {
    const text = [...reason.trim()].slice(0, CLIP_REASON_MAX).join("");
    // OBS writes the file in the background; the node waits up to 10 s for it.
    return this.#request(
      (id) => ({ type: "clip", reason: text, id }),
      this.#timings.requestTimeoutMs * 2,
    );
  }

  /** Asks the node for a fresh status. */
  refreshStatus(): Promise<StageStatus> {
    return this.#request((id) => ({ type: "status_request", id }));
  }

  /** Makes her look at `target`. Fire and forget; throws when no node is connected. */
  gaze(target: GazeTarget): void {
    if (!this.send({ type: "gaze", target })) {
      throw new StageLinkError("stage node not connected");
    }
  }

  /** @internal Queues a message for the node; false when none is connected or it is backed up. */
  send(msg: CoreMessage): boolean {
    return this.#conn?.trySendJson(msg) ?? false;
  }

  #request(
    build: (id: number) => CoreMessage,
    timeoutMs = this.#timings.requestTimeoutMs,
  ): Promise<StageStatus> {
    const conn = this.#conn;
    if (!conn) return Promise.reject(new StageLinkError("stage node not connected"));
    const id = this.#nextRequest;
    this.#nextRequest = (this.#nextRequest + 1) >>> 0 || 1;
    return new Promise<StageStatus>((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(new StageLinkError("stage node did not answer in time"));
      }, timeoutMs);
      conn.pending.set(id, {
        resolve: (status) => {
          clearTimeout(timer);
          resolve(status);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error instanceof StageLinkError ? error : new StageLinkError(error.message));
        },
      });
      if (conn.closed || !conn.trySendJson(build(id))) {
        clearTimeout(timer);
        conn.pending.delete(id);
        reject(new StageLinkError("stage node disconnected"));
      }
    });
  }

  #setStatus(status: StageStatus | null): void {
    if (!this.#status.set(status ? { ...status } : null)) return;
    const payload: JsonValue = status
      ? {
          connected: true,
          vts: status.vts,
          obs: status.obs,
          scene: status.scene,
          streaming: status.streaming,
          scenes: [...status.scenes],
          hotkeys: [...status.hotkeys],
          overlay_url: status.overlay_url,
        }
      : { connected: false };
    this.#publish(customEvent(STATUS_TOPIC, payload));
  }

  #publish(event: Event): void {
    this.#bus.publish(this.#module, event);
  }

  /** Closes the connection (module stop). */
  closeAll(): void {
    this.#conn?.shutdown(CLOSE.GOING_AWAY, "core shutting down");
    for (const ws of this.#handshaking) ws.close(CLOSE.GOING_AWAY, "core shutting down");
  }

  /** @internal Serves one WebSocket connection from accept to close. */
  serve(ws: WebSocket): void {
    if (this.#signal.aborted) {
      ws.close(CLOSE.GOING_AWAY, "core shutting down");
      return;
    }
    this.#handshaking.add(ws);
    const reject = (code: number, reason: string) => {
      log.warn({ code, reason }, "rejected stage node");
      ws.close(code, reason);
      setTimeout(() => ws.terminate(), 2_000).unref();
    };
    const timer = setTimeout(() => {
      done();
      reject(CLOSE.BAD_HELLO, "no hello in time");
    }, this.#timings.helloTimeoutMs);
    const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
      done();
      if (isBinary) {
        reject(CLOSE.BAD_HELLO, "expected hello");
        return;
      }
      const hello = checkHello(data.toString(), this.#token);
      if (!hello.ok) {
        reject(hello.code, hello.reason);
        return;
      }
      this.#accept(ws, hello.node, hello.capabilities);
    };
    const onGone = () => done();
    const done = () => {
      clearTimeout(timer);
      this.#handshaking.delete(ws);
      ws.off("message", onMessage);
      ws.off("close", onGone);
    };
    ws.on("error", (error) => log.debug({ err: error.message }, "stage link socket error"));
    ws.on("message", onMessage);
    ws.on("close", onGone);
  }

  #accept(ws: WebSocket, node: string, capabilities: string[]): void {
    const conn = new Conn(this.#nextConn++, node, capabilities, ws);
    const session = newId();
    // Welcome goes out before anything else on this connection.
    conn.trySendJson({ type: "welcome", session });

    const old = this.#conn;
    this.#conn = conn;
    if (old) {
      log.info("stage node replaced by a new connection");
      old.shutdown(CLOSE.REPLACED, "replaced by a newer connection");
    }
    log.info({ node, capabilities, session }, "stage node connected");
    // Until the node reports, everything is assumed down.
    this.#setStatus(defaultStageStatus());

    let deadline: ReturnType<typeof setTimeout>;
    const resetDeadline = () => {
      clearTimeout(deadline);
      deadline = setTimeout(() => {
        log.warn("stage node timed out");
        conn.shutdown(CLOSE.TIMEOUT, "heartbeat timeout");
      }, this.#timings.peerTimeoutMs);
    };
    resetDeadline();
    const ping = setInterval(
      () => conn.trySendJson({ type: "ping" }),
      this.#timings.pingIntervalMs,
    );
    const onAbort = () => conn.shutdown(CLOSE.GOING_AWAY, "core shutting down");
    this.#signal.addEventListener("abort", onAbort, { once: true });

    ws.on("message", (data, isBinary) => {
      resetDeadline();
      if (isBinary) return;
      let msg: StageMessage;
      try {
        msg = parseStageMessage(JSON.parse(data.toString()));
      } catch (error) {
        log.warn({ err: errorMessage(error) }, "invalid message from stage node");
        return;
      }
      this.#handle(conn, msg);
    });
    ws.on("ping", resetDeadline);
    ws.on("pong", resetDeadline);
    ws.on("close", () => {
      clearTimeout(deadline);
      clearInterval(ping);
      this.#signal.removeEventListener("abort", onAbort);
      conn.shutdown(1000, "");
      this.#cleanup(conn);
    });
  }

  #isCurrent(conn: Conn): boolean {
    return this.#conn?.id === conn.id;
  }

  #handle(conn: Conn, msg: StageMessage): void {
    switch (msg.type) {
      case "hello":
        log.warn("duplicate hello from stage node");
        return;
      case "ping":
        conn.trySendJson({ type: "pong" });
        return;
      case "pong":
        return;
      case "status": {
        const status = statusOf(msg);
        if (this.#isCurrent(conn)) this.#setStatus(status);
        if (msg.id !== undefined) {
          const reply = conn.pending.get(msg.id);
          conn.pending.delete(msg.id);
          reply?.resolve(status);
        }
        return;
      }
      case "clip_saved":
        log.info({ reason: msg.reason, path: msg.path }, "highlight saved");
        this.#publish(customEvent(CLIP_TOPIC, { reason: msg.reason, path: msg.path }));
        return;
      case "error": {
        log.warn({ message: msg.message, id: msg.id ?? null }, "stage node error");
        if (msg.id !== undefined) {
          const reply = conn.pending.get(msg.id);
          conn.pending.delete(msg.id);
          reply?.reject(new StageLinkError(msg.message));
        }
        this.#publish(customEvent(ERROR_TOPIC, { message: msg.message }));
        return;
      }
    }
  }

  /** Forgets a closed connection; its pending requests fail. */
  #cleanup(conn: Conn): void {
    const current = this.#isCurrent(conn);
    if (current) this.#conn = null;
    conn.failPending("stage node disconnected");
    if (current) this.#setStatus(null);
    log.info({ code: conn.closeCode }, "stage node disconnected");
  }
}

/** Service key of the `StageLink` (Rust `Arc<StageLink>`). */
export const StageLinkKey = serviceKey<StageLink>("StageLink");
