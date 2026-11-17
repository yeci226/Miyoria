// Symmetric JSON-RPC 2.0 peer: the one copy of the machinery, used by an extension (through the
// SDK), by the host (`@miyoria/plugin-host/ext-host`), and by hostd and Core on the control link.
//
// Both sides may send requests and notifications. Incoming requests run concurrently and get an
// `AbortSignal` that aborts when the caller sends `$/cancelRequest`; every outgoing request has a
// timeout. Messages travel over a transport (`transport.ts`): LSP's `Content-Length` frames over
// two streams (given as `input` and `output`), or any other `RpcTransport` (one JSON text frame
// per message over a WebSocket). On streams the wire is LSP's; the conformance test in
// `@miyoria/plugin-host` reads and writes frames with `vscode-jsonrpc` to keep it so.

import type { Readable, Writable } from "node:stream";
import {
  EXT_CANCEL_METHOD,
  EXT_ERROR_CODE,
  EXT_LIMITS,
  type ExtRpcErrorObject,
} from "@miyoria/contracts/ext";
import { type RpcTransport, type RpcTransportSink, StreamTransport } from "./transport.js";

/** Notification (`{id}`) a caller sends when it stops waiting for a request it sent. */
export const CANCEL_METHOD = EXT_CANCEL_METHOD;

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : String(error);
}

/** A JSON-RPC error object as an exception. `message` is the bare message. */
export class RpcError extends Error {
  override name = "RpcError";
  readonly code: number;
  /** What the other side put in `error.data`; `undefined` when it put nothing. */
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }

  /** The caller's parameters were wrong. */
  static invalidParams(error: unknown): RpcError {
    return new RpcError(EXT_ERROR_CODE.InvalidParams, `invalid params: ${messageOf(error)}`);
  }

  /** The caller lacks a permission. */
  static denied(message: string): RpcError {
    return new RpcError(EXT_ERROR_CODE.PermissionDenied, message);
  }

  /** Whatever a handler threw that was not an `RpcError`. */
  static internal(error: unknown): RpcError {
    return new RpcError(EXT_ERROR_CODE.InternalError, messageOf(error));
  }

  /** Wire form: `{ code, message, data? }`. */
  toJSON(): ExtRpcErrorObject {
    return this.data === undefined || this.data === null
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data };
  }

  override toString(): string {
    return `${this.message} (code ${this.code})`;
  }
}

/**
 * Answers one incoming request. `signal` aborts when the caller stops waiting (it sent
 * `$/cancelRequest`): stop the work, the answer is not read any more.
 */
export type RequestHandler = (method: string, params: unknown, signal: AbortSignal) => unknown;
export type NotificationHandler = (method: string, params: unknown) => unknown;

/** Which side of the protocol a peer is. They differ in a few policies, all listed here. */
export type PeerRole = "host" | "extension";

interface Policy {
  /** Tell the other side (`$/cancelRequest`) when a request is given up on. */
  readonly cancelStale: boolean;
  /** How a timeout is worded: the method between these. */
  readonly quote: string;
  /** A body that is not JSON: answer with a parse error and go on, or end the connection. */
  readonly badJson: "reply" | "close";
  /** A stream that stops in the middle of a frame is an error, or just the end. */
  readonly truncatedIsError: boolean;
  /** Keep writing to a writer that is still open after the connection was closed. */
  readonly writeAfterClose: boolean;
}

const POLICY: Record<PeerRole, Policy> = {
  host: {
    cancelStale: true,
    quote: "`",
    badJson: "reply",
    truncatedIsError: true,
    writeAfterClose: true,
  },
  extension: {
    cancelStale: false,
    quote: '"',
    badJson: "close",
    truncatedIsError: false,
    writeAfterClose: false,
  },
};

/** What every peer takes, whatever carries its messages. */
export interface PeerBaseOptions {
  /** Answers incoming requests. Throw `RpcError` for a specific code. */
  onRequest?: RequestHandler;
  onNotification?: NotificationHandler;
  /** Called once when the connection closes; with the error when it broke. */
  onClose?: (error?: Error) => void;
  /** Default timeout of outgoing requests (ms). */
  timeoutMs?: number;
  /** Default `extension`. */
  role?: PeerRole;
  /** A failure nobody can handle: the writer broke, or a notification handler failed. */
  onError?: (what: "writer" | "notification", error: unknown, method?: string) => void;
}

/** A peer over two byte streams, with `Content-Length` frames. */
export interface StreamPeerOptions extends PeerBaseOptions {
  output: Writable;
  /** Start reading at once (an extension). Without it the peer reads when `serve` is called. */
  input?: Readable;
  transport?: undefined;
}

/** A peer over a message transport (a WebSocket). It reads from the start; `serve` is not used. */
export interface TransportPeerOptions extends PeerBaseOptions {
  transport: RpcTransport;
  output?: undefined;
  input?: undefined;
}

export type PeerOptions = StreamPeerOptions | TransportPeerOptions;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: RpcError) => void;
}

interface ServeHandlers {
  onRequest?: RequestHandler | undefined;
  onNotification?: NotificationHandler | undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class RpcPeer {
  /** Writes; on streams it also reads when `input` was given. */
  readonly #transport: RpcTransport;
  /** The stream peer's writer, for `serve`; `null` on a message transport. */
  readonly #output: Writable | null;
  readonly #opts: PeerOptions;
  readonly #policy: Policy;
  readonly #pending = new Map<number, Pending>();
  /** Incoming requests being answered, by id (for `$/cancelRequest`). */
  readonly #running = new Map<number | string, AbortController>();
  #nextId = 1;
  #closed = false;
  /** Ends the stream being read: detaches its listeners. */
  #detach: (() => void) | null = null;
  /** Settles the promise `serve` returned. */
  #settle: ((error: Error | null) => void) | null = null;

  constructor(opts: PeerOptions) {
    this.#opts = opts;
    this.#policy = POLICY[opts.role ?? "extension"];
    if (opts.transport !== undefined) {
      this.#output = null;
      this.#transport = opts.transport;
      this.#read(this.#transport, {}, undefined);
      return;
    }
    const output = opts.output;
    this.#output = output;
    this.#transport = this.#streams(output, opts.input);
    // A broken pipe shows up as end of input too; this only keeps it from being an unhandled error.
    output.on("error", (error) => opts.onError?.("writer", error));
    if (opts.input) this.#read(this.#transport, {}, undefined);
  }

  #streams(output: Writable, input: Readable | undefined): StreamTransport {
    return new StreamTransport(output, input, { strictEnd: this.#policy.truncatedIsError });
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Requests waiting for a response. */
  get pendingCount(): number {
    return this.#pending.size;
  }

  /**
   * Sends a request and waits for the response, at most `timeoutMs` (default: the peer's).
   * Rejects with `RpcError`: the other side's error, `Timeout`, or `Closed`. Aborting `signal`
   * rejects with its reason.
   */
  request<T = unknown>(
    method: string,
    params?: unknown,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.#closed) {
      return Promise.reject(new RpcError(EXT_ERROR_CODE.Closed, "connection closed"));
    }
    if (signal?.aborted) return Promise.reject(signal.reason);
    const id = this.#nextId++;
    const ms = timeoutMs ?? this.#opts.timeoutMs ?? 30_000;
    return new Promise<T>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.#pending.delete(id);
      };
      // A caller that gives up tells the other side, so stale work stops there too (a late
      // game action never lands after she was told it failed).
      const cancel = () => {
        if (this.#policy.cancelStale && !this.#closed) this.tryNotify(CANCEL_METHOD, { id });
      };
      const timer = setTimeout(() => {
        done();
        cancel();
        const q = this.#policy.quote;
        reject(
          new RpcError(EXT_ERROR_CODE.Timeout, `${q}${method}${q} timed out after ${ms} ms`),
        );
      }, ms);
      timer.unref?.();
      const onAbort = () => {
        done();
        cancel();
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(id, {
        resolve: (value) => {
          done();
          resolve(value as T);
        },
        reject: (error) => {
          done();
          reject(error);
        },
      });
      if (!this.#write({ jsonrpc: "2.0", id, method, params: params ?? null })) {
        done();
        reject(new RpcError(EXT_ERROR_CODE.Closed, "connection closed"));
      }
    });
  }

  /** Sends a notification. Returns whether it was written (false: the connection is gone). */
  notify(method: string, params?: unknown): boolean {
    return this.#write({ jsonrpc: "2.0", method, params: params ?? null });
  }

  /** Like `notify`, but drops the notification when the outgoing queue is full. */
  tryNotify(method: string, params?: unknown): boolean {
    if (this.#transport.queuedBytes > EXT_LIMITS.MAX_QUEUED_BYTES) return false;
    return this.notify(method, params);
  }

  /**
   * Reads incoming messages from `input` until the stream ends (resolves) or breaks (rejects),
   * dispatching requests and notifications to the handlers (`handlers` over the peer's own) and
   * responses to waiting callers. Pending requests fail with `Closed` when it settles. Aborting
   * `signal` stops reading and resolves. Only for a peer over streams: one over a message
   * transport reads from the start.
   */
  serve(input: Readable, handlers: ServeHandlers = {}, signal?: AbortSignal): Promise<void> {
    const output = this.#output;
    if (output === null) {
      return Promise.reject(new Error("a peer over a message transport reads from the start"));
    }
    return new Promise<void>((resolve, reject) => {
      this.#settle = (error) => (error ? reject(error) : resolve());
      this.#read(this.#streams(output, input), handlers, signal);
    });
  }

  /** Fails every pending request, stops reading and accepting requests, and reports `onClose`. */
  close(error?: Error): void {
    this.#teardown(error ?? null);
  }

  #teardown(error: Error | null): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#detach?.();
    this.#detach = null;
    for (const [, pending] of this.#pending) {
      pending.reject(new RpcError(EXT_ERROR_CODE.Closed, "connection closed"));
    }
    this.#pending.clear();
    this.#settle?.(error);
    this.#settle = null;
    this.#opts.onClose?.(error ?? undefined);
  }

  #read(transport: RpcTransport, handlers: ServeHandlers, signal: AbortSignal | undefined): void {
    const onAbort = () => this.#teardown(null);
    let stop: (() => void) | null = null;
    this.#detach = () => {
      stop?.();
      signal?.removeEventListener("abort", onAbort);
    };
    if (signal?.aborted) {
      this.#teardown(null);
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    const sink: RpcTransportSink = {
      message: (message) => {
        if (!this.#closed) this.#dispatch(message, handlers);
      },
      malformed: (error) => {
        if (!this.#closed) this.#malformed(error);
      },
      end: (error) => this.#teardown(error ?? null),
    };
    stop = transport.listen(sink);
  }

  #write(message: unknown): boolean {
    if (this.#closed && !this.#policy.writeAfterClose) return false;
    return this.#transport.send(message);
  }

  #respond(id: unknown, result: { ok: unknown } | { err: RpcError }): void {
    this.#write(
      "ok" in result
        ? { jsonrpc: "2.0", id, result: result.ok ?? null }
        : { jsonrpc: "2.0", id, error: result.err.toJSON() },
    );
  }

  /** A whole message that is not JSON. */
  #malformed(error: Error): void {
    if (this.#policy.badJson === "close") {
      this.#teardown(error);
      return;
    }
    this.#respond(null, { err: new RpcError(EXT_ERROR_CODE.ParseError, messageOf(error)) });
  }

  #dispatch(message: unknown, handlers: ServeHandlers): void {
    if (!isObject(message)) {
      this.#respond(null, { err: new RpcError(EXT_ERROR_CODE.InvalidRequest, "not an object") });
      return;
    }
    const id = message.id ?? null;
    if (typeof message.method === "string") {
      const method = message.method;
      if (id === null) {
        if (method === CANCEL_METHOD) this.#cancel(message.params);
        else this.#notified(method, message.params, handlers);
      } else if (typeof id === "number" || typeof id === "string") {
        void this.#answer(id, method, message.params ?? null, handlers);
      }
      return;
    }
    if (typeof id !== "number") return; // a response to nothing we sent, or malformed
    const pending = this.#pending.get(id);
    if (!pending) return; // a late response after a timeout
    const error = message.error;
    if (error !== undefined && error !== null) {
      if (isObject(error) && typeof error.code === "number" && typeof error.message === "string") {
        pending.reject(new RpcError(error.code, error.message, error.data));
      } else {
        pending.reject(new RpcError(EXT_ERROR_CODE.InternalError, "bad error object"));
      }
      return;
    }
    pending.resolve(message.result ?? null);
  }

  #cancel(params: unknown): void {
    const target = isObject(params) ? params.id : undefined;
    if (typeof target !== "number" && typeof target !== "string") return;
    this.#running
      .get(target)
      ?.abort(new RpcError(EXT_ERROR_CODE.Cancelled, "cancelled by the host"));
  }

  /** Notifications never answer; a failing handler is only reported. */
  #notified(method: string, params: unknown, handlers: ServeHandlers): void {
    const handler = handlers.onNotification ?? this.#opts.onNotification;
    const failed = (error: unknown) => this.#opts.onError?.("notification", error, method);
    try {
      const result = handler?.(method, params ?? null);
      if (result instanceof Promise) result.catch(failed);
    } catch (error) {
      failed(error);
    }
  }

  async #answer(
    id: number | string,
    method: string,
    params: unknown,
    handlers: ServeHandlers,
  ): Promise<void> {
    const controller = new AbortController();
    this.#running.set(id, controller);
    try {
      const handler = handlers.onRequest ?? this.#opts.onRequest;
      if (!handler) {
        throw new RpcError(EXT_ERROR_CODE.MethodNotFound, `unknown method "${method}"`);
      }
      const result = await handler(method, params, controller.signal);
      this.#respond(id, { ok: result });
    } catch (error) {
      this.#respond(id, { err: error instanceof RpcError ? error : RpcError.internal(error) });
    } finally {
      if (this.#running.get(id) === controller) this.#running.delete(id);
    }
  }
}
