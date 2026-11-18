// One authenticated node connection.

import type { AccountRef, PlaybackState, VoiceParticipant } from "@miyoria/types";
import WebSocket from "ws";
import { type CoreMessage, coreMessageJson } from "../protocol.js";
import type { Watch } from "../util.js";

/** Last Go Live state of one guild. */
export interface GoLiveStatus {
  state: GoLiveState;
  /** Why it failed (`failed`). */
  error: string | null;
  /** Why it ended (`stopped`), e.g. "source ended". */
  reason: string | null;
}

/**
 * Go Live state, as reported by the voice node: `starting` (waiting for the source, connecting
 * to Discord), `live` (frames are being sent), `stopped` (stop request, source ended, left
 * voice), `failed` (could not start, or died; see `GoLiveStatus.error`).
 */
export type GoLiveState = "starting" | "live" | "stopped" | "failed";

/** Her watching of somebody's stream in a guild, as the node last reported it. */
export interface WatchStatus {
  /** Whose stream. */
  user_id: string;
  state: GoLiveState;
  /** Why it failed (`failed`). */
  error: string | null;
  /** Why it ended (`stopped`). */
  reason: string | null;
}

/** A `watch_snapshot` waiting for its picture. */
export interface PendingSnapshot {
  resolve(jpeg: Buffer): void;
  reject(error: Error): void;
}

export interface GuildState {
  channel: string;
  participants: VoiceParticipant[];
}

export interface PendingJoin {
  guild: string;
  resolve(channel: string): void;
  reject(message: string): void;
}

export interface ConnState {
  guilds: Map<string, GuildState>;
  pendingJoins: PendingJoin[];
  /** Playback state reported by the node, per play id. */
  plays: Map<number, Watch<PlaybackState | null>>;
  /** Node stream id → link stream id and guild. */
  streams: Map<number, { id: number; guild: string }>;
  /** Go Live state reported by the node, per guild. */
  golive: Map<string, GoLiveStatus>;
  /** Watch state reported by the node, per guild. */
  watch: Map<string, WatchStatus>;
  /** Snapshots asked for and not answered yet, by request id. */
  snapshots: Map<number, PendingSnapshot>;
}

export function newConnState(): ConnState {
  return {
    guilds: new Map(),
    pendingJoins: [],
    plays: new Map(),
    streams: new Map(),
    golive: new Map(),
    watch: new Map(),
    snapshots: new Map(),
  };
}

export class VoiceLinkError extends Error {
  override name = "VoiceLinkError";
}

const DISCONNECTED = "voice node disconnected";
/** How long a close handshake may take before the socket is dropped. */
const CLOSE_GRACE_MS = 2_000;

export class Conn {
  readonly id: number;
  readonly account: AccountRef;
  state: ConnState = newConnState();
  readonly #ws: WebSocket;
  readonly #closed = new AbortController();
  #closeFrame: { code: number; reason: string } | null = null;
  /** Optional protocol features the node announced in its hello. */
  readonly capabilities: ReadonlySet<string>;

  constructor(id: number, account: AccountRef, ws: WebSocket, capabilities: Iterable<string> = []) {
    this.id = id;
    this.account = account;
    this.capabilities = new Set(capabilities);
    this.#ws = ws;
  }

  /**
   * Aborts once the connection is closing. A listener, not a promise: whoever waits on it many
   * times takes the listener off again (a promise that lives as long as the connection would keep
   * a reaction for every wait).
   */
  get signal(): AbortSignal {
    return this.#closed.signal;
  }

  get isClosed(): boolean {
    return this.#closed.signal.aborted;
  }

  /** Sends a frame; resolves once it is written, rejects once the connection is closing. */
  send(data: string | Uint8Array): Promise<void> {
    if (this.isClosed || this.#ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new VoiceLinkError(DISCONNECTED));
    }
    return new Promise((resolve, reject) => {
      this.#ws.send(data, { binary: typeof data !== "string" }, (error) => {
        if (error) reject(new VoiceLinkError(DISCONNECTED, { cause: error }));
        else resolve();
      });
    });
  }

  sendJson(msg: CoreMessage): Promise<void> {
    return this.send(coreMessageJson(msg));
  }

  /** Queues a message without waiting; dropped when the connection is closing. */
  trySend(msg: CoreMessage): void {
    this.send(coreMessageJson(msg)).catch(() => undefined);
  }

  /** Closes the connection with `code` (the first call wins). */
  shutdown(code: number, reason: string): void {
    if (this.#closeFrame === null) this.#closeFrame = { code, reason };
    if (this.isClosed) return;
    this.#closed.abort();
    closeSocket(this.#ws, this.#closeFrame.code, this.#closeFrame.reason);
  }

  closeCode(): number | null {
    return this.#closeFrame?.code ?? null;
  }
}

/** Starts the close handshake; drops the socket if the peer does not answer in time. */
export function closeSocket(ws: WebSocket, code: number, reason: string): void {
  if (ws.readyState === WebSocket.CLOSED) return;
  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
    try {
      ws.close(code, reason);
    } catch {
      ws.terminate();
      return;
    }
  }
  setTimeout(() => {
    if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
  }, CLOSE_GRACE_MS).unref();
}
