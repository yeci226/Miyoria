// JSON-RPC 2.0 over a byte stream with LSP-style `Content-Length` framing.
//
// `Peer` is symmetric: both sides may send requests and notifications. Incoming requests run
// concurrently; every outgoing request has a timeout.

import type { Readable, Writable } from "node:stream";
import { errorMessage, getLogger } from "@miyoria/kernel";
import { isJsonObject, type JsonValue } from "@miyoria/types";

const log = getLogger("ext_host.rpc");

/** Largest accepted frame body. */
export const MAX_FRAME = 16 * 1024 * 1024;

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
/** The extension lacks the permission for this call. */
export const PERMISSION_DENIED = -32001;
/** A request timed out (local to the caller, never sent). */
export const TIMEOUT = -32002;
/** Name already taken by someone else. */
export const CONFLICT = -32003;
/** A host service (tool registry, storage, ...) is not available. */
export const UNAVAILABLE = -32004;
/** The connection is closed (local to the caller, never sent). */
export const CLOSED = -32005;

/**
 * Notification (`{id}`) a caller sends when it stops waiting for its request (aborted or timed
 * out); the other side may abort the handler. LSP's name for the same thing.
 */
export const CANCEL_METHOD = "$/cancelRequest";

/** Bytes queued on the writer beyond which `tryNotify` drops the notification. */
const MAX_QUEUED_BYTES = 8 * 1024 * 1024;

/** A JSON-RPC error object. `message` is the bare message; `toString()` adds the code. */
export class RpcError extends Error {
  override readonly name = "RpcError";

  constructor(
    readonly code: number,
    message: string,
    readonly data: JsonValue | null = null,
  ) {
    super(message);
  }

  static invalidParams(e: unknown): RpcError {
    return new RpcError(INVALID_PARAMS, `invalid params: ${errorMessage(e)}`);
  }

  static denied(message: string): RpcError {
    return new RpcError(PERMISSION_DENIED, message);
  }

  static internal(e: unknown): RpcError {
    return new RpcError(INTERNAL_ERROR, errorMessage(e));
  }

  /** Wire form: `{ code, message, data? }`. */
  toJSON(): { code: number; message: string; data?: JsonValue } {
    return this.data === null
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data };
  }

  override toString(): string {
    return `${this.message} (code ${this.code})`;
  }
}

/** Serves incoming requests and notifications. Request handlers throw `RpcError`. */
export interface RpcHandler {
  request(method: string, params: JsonValue): Promise<JsonValue>;
  notification(method: string, params: JsonValue): Promise<void> | void;
}

/** Thrown for malformed frames. */
export class FrameError extends Error {
  override readonly name = "FrameError";
}

/** Encodes one message as a frame. */
export function encodeFrame(message: JsonValue): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

/**
 * Incremental frame parser. `push` returns every complete frame body; `end` throws if the
 * stream stopped in the middle of a frame.
 */
export class FrameDecoder {
  #buffer: Buffer = Buffer.alloc(0);
  /** `null` while reading headers; body length once the blank line was seen. */
  #length: number | null = null;
  #headerLength: number | null = null;
  #sawHeader = false;

  push(chunk: Buffer): Buffer[] {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    const out: Buffer[] = [];
    for (;;) {
      if (this.#length === null) {
        const nl = this.#buffer.indexOf(0x0a);
        if (nl < 0) return out;
        const line = this.#buffer
          .subarray(0, nl + 1)
          .toString("utf8")
          .replace(/[\r\n]+$/u, "");
        this.#buffer = this.#buffer.subarray(nl + 1);
        this.#sawHeader = true;
        if (line === "") {
          if (this.#headerLength === null) throw new FrameError("missing Content-Length");
          if (this.#headerLength > MAX_FRAME) {
            throw new FrameError(`frame of ${this.#headerLength} bytes is too large`);
          }
          this.#length = this.#headerLength;
          this.#headerLength = null;
          continue;
        }
        const colon = line.indexOf(":");
        if (colon < 0) throw new FrameError(`malformed header \`${line}\``);
        if (line.slice(0, colon).trim().toLowerCase() === "content-length") {
          const value = line.slice(colon + 1).trim();
          if (!/^\d+$/u.test(value)) throw new FrameError(`bad Content-Length \`${value}\``);
          this.#headerLength = Number(value);
        }
        continue;
      }
      if (this.#buffer.length < this.#length) return out;
      out.push(Buffer.from(this.#buffer.subarray(0, this.#length)));
      this.#buffer = this.#buffer.subarray(this.#length);
      this.#length = null;
      this.#sawHeader = false;
    }
  }

  /** Call at end of stream. Throws when a frame is incomplete. */
  end(): void {
    if (this.#sawHeader || this.#length !== null || this.#buffer.length > 0) {
      throw new FrameError("unexpected end of stream");
    }
  }
}

interface Pending {
  resolve(value: JsonValue): void;
  reject(error: RpcError): void;
}

/** One side of a JSON-RPC connection. */
export class Peer {
  readonly #out: Writable;
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;
  #closed = false;

  /** Creates a peer writing to `writer`. Write errors (broken pipes) surface as EOF on the reader. */
  constructor(writer: Writable) {
    this.#out = writer;
    writer.on("error", (err) => log.debug({ err }, "rpc writer failed"));
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  /** @internal Requests waiting for a response (for tests). */
  get pendingCount(): number {
    return this.#pending.size;
  }

  #write(message: JsonValue): boolean {
    if (this.#out.destroyed || this.#out.writableEnded) return false;
    this.#out.write(encodeFrame(message));
    return true;
  }

  /** Sends a request and waits for the response, at most `timeoutMs`. Rejects with `RpcError`. */
  request(
    method: string,
    params: JsonValue,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    if (this.#closed) return Promise.reject(new RpcError(CLOSED, "connection closed"));
    if (signal?.aborted) return Promise.reject(signal.reason);
    const id = this.#nextId++;
    return new Promise<JsonValue>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.#pending.delete(id);
      };
      // A caller that gives up tells the other side, so stale work stops there too (a late
      // game action never lands after she was told it failed).
      const cancel = () => {
        if (!this.#closed) this.tryNotify(CANCEL_METHOD, { id });
      };
      const timer = setTimeout(() => {
        done();
        cancel();
        reject(new RpcError(TIMEOUT, `\`${method}\` timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      const onAbort = () => {
        done();
        cancel();
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(id, {
        resolve: (v) => {
          done();
          resolve(v);
        },
        reject: (e) => {
          done();
          reject(e);
        },
      });
      if (!this.#write({ jsonrpc: "2.0", id, method, params })) {
        done();
        reject(new RpcError(CLOSED, "connection closed"));
      }
    });
  }

  /** Sends a notification. Rejects with `CLOSED` when the writer is gone. */
  async notify(method: string, params: JsonValue): Promise<void> {
    if (!this.#write({ jsonrpc: "2.0", method, params })) {
      throw new RpcError(CLOSED, "connection closed");
    }
  }

  /** Sends a notification unless the outgoing queue is full. Returns whether it was queued. */
  tryNotify(method: string, params: JsonValue): boolean {
    if (this.#out.writableLength > MAX_QUEUED_BYTES) return false;
    return this.#write({ jsonrpc: "2.0", method, params });
  }

  #respond(id: JsonValue, result: { ok: JsonValue } | { err: RpcError }): void {
    const message: JsonValue =
      "ok" in result
        ? { jsonrpc: "2.0", id, result: result.ok }
        : { jsonrpc: "2.0", id, error: result.err.toJSON() };
    this.#write(message);
  }

  /**
   * Reads incoming messages until the stream ends (resolves) or a frame is malformed (rejects),
   * dispatching requests and notifications to `handler` and responses to waiting callers.
   * Pending requests fail with `CLOSED` when it settles. Aborting `signal` stops reading and
   * resolves.
   */
  serve(reader: Readable, handler: RpcHandler, signal?: AbortSignal): Promise<void> {
    const decoder = new FrameDecoder();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error: Error | null) => {
        if (settled) return;
        settled = true;
        reader.off("data", onData);
        reader.off("end", onEnd);
        reader.off("close", onEnd);
        reader.off("error", onError);
        signal?.removeEventListener("abort", onAbort);
        this.#closed = true;
        for (const [, p] of this.#pending) p.reject(new RpcError(CLOSED, "connection closed"));
        this.#pending.clear();
        if (error) reject(error);
        else resolve();
      };
      const onData = (chunk: Buffer | string) => {
        if (settled) return;
        let bodies: Buffer[];
        try {
          bodies = decoder.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        } catch (error) {
          finish(error as Error);
          return;
        }
        for (const body of bodies) this.#onBody(body, handler);
      };
      const onEnd = () => {
        try {
          decoder.end();
          finish(null);
        } catch (error) {
          finish(error as Error);
        }
      };
      const onError = (error: Error) => finish(error);
      const onAbort = () => finish(null);
      if (signal?.aborted) {
        finish(null);
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      reader.on("data", onData);
      reader.on("end", onEnd);
      reader.on("close", onEnd);
      reader.on("error", onError);
    });
  }

  #onBody(body: Buffer, handler: RpcHandler): void {
    let message: unknown;
    try {
      message = JSON.parse(body.toString("utf8"));
    } catch (error) {
      this.#respond(null, { err: new RpcError(PARSE_ERROR, errorMessage(error)) });
      return;
    }
    this.#dispatch(message, handler);
  }

  #dispatch(message: unknown, handler: RpcHandler): void {
    if (!isJsonObject(message)) {
      this.#respond(null, { err: new RpcError(INVALID_REQUEST, "not an object") });
      return;
    }
    const id = message.id ?? null;
    if (typeof message.method === "string") {
      const method = message.method;
      const params = message.params ?? null;
      if (id !== null) {
        void (async () => {
          try {
            this.#respond(id, { ok: await handler.request(method, params) });
          } catch (error) {
            this.#respond(id, {
              err: error instanceof RpcError ? error : RpcError.internal(error),
            });
          }
        })();
      } else {
        // Notifications never answer; a failing handler is only logged.
        void (async () => handler.notification(method, params))().catch((err: unknown) =>
          log.debug({ err, method }, "notification handler failed"),
        );
      }
      return;
    }
    if (typeof id !== "number") return; // response to nothing we sent, or malformed
    const pending = this.#pending.get(id);
    if (!pending) return; // late response after a timeout
    if (message.error !== undefined && message.error !== null) {
      const e = message.error;
      if (isJsonObject(e) && typeof e.code === "number" && typeof e.message === "string") {
        pending.reject(new RpcError(e.code, e.message, e.data ?? null));
      } else {
        pending.reject(new RpcError(INTERNAL_ERROR, "bad error object"));
      }
      return;
    }
    pending.resolve(message.result ?? null);
  }
}
