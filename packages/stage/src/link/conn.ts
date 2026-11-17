// One Stage connection: hello validation, the per-connection state and its close frame.

import { timingSafeEqual } from "node:crypto";
import { errorMessage } from "@miyoria/runtime/kernel";
import WebSocket from "ws";
import {
  CLOSE,
  type CoreMessage,
  encodeMessage,
  parseStageMessage,
  type StageStatus,
  VERSION,
} from "../protocol.js";

export const MAX_MESSAGE = 1 << 16;
/** Bytes queued on a socket before messages are dropped. */
const MAX_BUFFERED = 1 << 20;

/** Constant-time comparison of the token. */
export function tokenMatches(expected: string, got: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type HelloOutcome =
  | { ok: true; node: string; capabilities: string[] }
  | { ok: false; code: number; reason: string };

/** Validates the first text frame of a connection. */
export function checkHello(text: string, token: string): HelloOutcome {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, code: CLOSE.BAD_HELLO, reason: "invalid JSON" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, code: CLOSE.BAD_HELLO, reason: "expected hello" };
  }
  const v = value as Record<string, unknown>;
  if (v.type !== "hello") return { ok: false, code: CLOSE.BAD_HELLO, reason: "expected hello" };
  // Token first, so an unauthenticated peer learns nothing else.
  const got = typeof v.token === "string" ? v.token : "";
  if (!tokenMatches(token, got)) {
    return { ok: false, code: CLOSE.UNAUTHORIZED, reason: "invalid token" };
  }
  let msg: ReturnType<typeof parseStageMessage>;
  try {
    msg = parseStageMessage(value);
  } catch {
    return { ok: false, code: CLOSE.BAD_HELLO, reason: "malformed hello" };
  }
  if (msg.type !== "hello") return { ok: false, code: CLOSE.BAD_HELLO, reason: "malformed hello" };
  if (msg.version !== VERSION) {
    return { ok: false, code: CLOSE.BAD_HELLO, reason: "unsupported version" };
  }
  return { ok: true, node: msg.node, capabilities: msg.capabilities };
}

export interface Reply {
  resolve(status: StageStatus): void;
  reject(error: Error): void;
}

/** One authenticated Stage connection. */
export class Conn {
  readonly id: number;
  readonly node: string;
  readonly capabilities: string[];
  readonly ws: WebSocket;
  readonly pending = new Map<number, Reply>();
  #closeFrame: [number, string] | null = null;
  #closed = false;

  constructor(id: number, node: string, capabilities: string[], ws: WebSocket) {
    this.id = id;
    this.node = node;
    this.capabilities = capabilities;
    this.ws = ws;
  }

  get closed(): boolean {
    return this.#closed || this.ws.readyState !== WebSocket.OPEN;
  }

  get closeCode(): number | null {
    return this.#closeFrame?.[0] ?? null;
  }

  /** Queues a message; false when closed or the socket is backed up. */
  trySendJson(msg: CoreMessage): boolean {
    if (this.closed || this.ws.bufferedAmount > MAX_BUFFERED) return false;
    try {
      this.ws.send(encodeMessage(msg));
      return true;
    } catch (error) {
      this.shutdown(1006, `write failed: ${errorMessage(error)}`);
      return false;
    }
  }

  /** Closes the connection with `code` (the first call wins). */
  shutdown(code: number, reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeFrame = [code, reason];
    if (code === 1006) {
      this.ws.terminate();
      return;
    }
    try {
      this.ws.close(code, reason);
    } catch {
      this.ws.terminate();
    }
    // A peer that never answers the close handshake is dropped.
    setTimeout(() => this.ws.terminate(), 2_000).unref();
  }

  /** Fails every waiting request. */
  failPending(message: string): void {
    for (const reply of this.pending.values()) reply.reject(new Error(message));
    this.pending.clear();
  }
}
