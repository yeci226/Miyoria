// Symmetric JSON-RPC 2.0 peer over a pair of byte streams.

import type { Readable, Writable } from "node:stream";
import { FrameDecoder, encodeFrame } from "./framing.js";
import { ErrorCode, type RpcErrorObject } from "./types.js";

export class RpcError extends Error {
  override name = "RpcError";
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }

  toJSON(): RpcErrorObject {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data };
  }
}

/**
 * Answers one incoming request. `signal` aborts when the caller stops waiting (it sent
 * `$/cancelRequest`): stop the work, the answer is not read any more.
 */
export type RequestHandler = (method: string, params: unknown, signal: AbortSignal) => unknown;

/** Notification (`{id}`) the host sends when it stops waiting for a request it sent. */
export const CANCEL_METHOD = "$/cancelRequest";
export type NotificationHandler = (method: string, params: unknown) => void;

export interface PeerOptions {
  input: Readable;
  output: Writable;
  /** Answers incoming requests. Throw `RpcError` for a specific code. */
  onRequest?: RequestHandler;
  onNotification?: NotificationHandler;
  /** Called once when the input ends or breaks. */
  onClose?: (error?: Error) => void;
  /** Default timeout of outgoing requests (ms). */
  timeoutMs?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: RpcError) => void;
  timer: NodeJS.Timeout;
}

export class RpcPeer {
  readonly #output: Writable;
  readonly #decoder = new FrameDecoder();
  readonly #pending = new Map<number, Pending>();
  /** Incoming requests being answered, by id (for `$/cancelRequest`). */
  readonly #running = new Map<number | string, AbortController>();
  readonly #opts: PeerOptions;
  #nextId = 1;
  #closed = false;

  constructor(opts: PeerOptions) {
    this.#opts = opts;
    this.#output = opts.output;
    opts.input.on("data", (chunk: Buffer) => {
      let messages: unknown[];
      try {
        messages = this.#decoder.push(chunk);
      } catch (error) {
        this.close(error as Error);
        return;
      }
      for (const message of messages) this.#dispatch(message);
    });
    opts.input.on("end", () => this.close());
    opts.input.on("close", () => this.close());
    opts.input.on("error", (error: Error) => this.close(error));
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Sends a request; rejects with `RpcError` (code `Timeout` after `timeoutMs`). */
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this.#closed) return Promise.reject(new RpcError(ErrorCode.Closed, "connection closed"));
    const id = this.#nextId++;
    const ms = timeoutMs ?? this.#opts.timeoutMs ?? 30_000;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new RpcError(ErrorCode.Timeout, `"${method}" timed out after ${ms} ms`));
      }, ms);
      timer.unref?.();
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.#write({ jsonrpc: "2.0", id, method, params: params ?? null });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.#closed) return;
    this.#write({ jsonrpc: "2.0", method, params: params ?? null });
  }

  /** Fails every pending request and stops accepting new ones. */
  close(error?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(new RpcError(ErrorCode.Closed, "connection closed"));
    }
    this.#pending.clear();
    this.#opts.onClose?.(error);
  }

  #write(message: unknown): void {
    this.#output.write(encodeFrame(message));
  }

  #dispatch(raw: unknown): void {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      this.#write({
        jsonrpc: "2.0",
        id: null,
        error: { code: ErrorCode.InvalidRequest, message: "not an object" },
      });
      return;
    }
    const msg = raw as Record<string, unknown>;
    const id = msg.id as number | string | null | undefined;
    if (typeof msg.method === "string") {
      if (id === undefined || id === null) {
        if (msg.method === CANCEL_METHOD) {
          const target = (msg.params as { id?: unknown } | null)?.id;
          if (typeof target === "number" || typeof target === "string") {
            this.#running.get(target)?.abort(new RpcError(ErrorCode.Cancelled, "cancelled by the host"));
          }
          return;
        }
        try {
          this.#opts.onNotification?.(msg.method, msg.params);
        } catch {
          // Notifications have no response channel.
        }
      } else {
        void this.#answer(id, msg.method, msg.params);
      }
      return;
    }
    if (typeof id !== "number") return;
    const pending = this.#pending.get(id);
    if (!pending) return; // late response after a timeout
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    if (msg.error !== undefined) {
      const e = msg.error as Partial<RpcErrorObject>;
      pending.reject(
        new RpcError(e.code ?? ErrorCode.InternalError, e.message ?? "unknown error", e.data),
      );
    } else {
      pending.resolve(msg.result ?? null);
    }
  }

  async #answer(id: number | string, method: string, params: unknown): Promise<void> {
    const controller = new AbortController();
    this.#running.set(id, controller);
    try {
      const handler = this.#opts.onRequest;
      if (!handler) throw new RpcError(ErrorCode.MethodNotFound, `unknown method "${method}"`);
      const result = await handler(method, params, controller.signal);
      if (!this.#closed) this.#write({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (error) {
      const err =
        error instanceof RpcError
          ? error
          : new RpcError(ErrorCode.InternalError, error instanceof Error ? error.message : String(error));
      if (!this.#closed) this.#write({ jsonrpc: "2.0", id, error: err.toJSON() });
    } finally {
      if (this.#running.get(id) === controller) this.#running.delete(id);
    }
  }
}
