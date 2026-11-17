// The host's view of the extension JSON-RPC connection. The machinery (framing, correlation,
// cancellation, timeouts, backpressure) is the SDK's `RpcPeer` in its `host` role: one copy for
// both sides. This file gives it the host's names and JSON typing.
//
// `Peer` is symmetric: both sides may send requests and notifications. Incoming requests run
// concurrently; every outgoing request has a timeout.

import type { Readable, Writable } from "node:stream";
import { EXT_ERROR_CODE, EXT_LIMITS } from "@miyoria/contracts/ext";
import { getLogger } from "@miyoria/runtime/kernel";
import {
  CANCEL_METHOD,
  encodeFrame,
  FrameBodyDecoder,
  FramingError,
  RpcError,
  RpcPeer,
} from "@miyoria/sdk";
import type { JsonValue } from "@miyoria/types";

const log = getLogger("ext_host.rpc");

/** Largest accepted frame body. */
export const MAX_FRAME: number = EXT_LIMITS.MAX_FRAME_BYTES;

export const PARSE_ERROR: number = EXT_ERROR_CODE.ParseError;
export const INVALID_REQUEST: number = EXT_ERROR_CODE.InvalidRequest;
export const METHOD_NOT_FOUND: number = EXT_ERROR_CODE.MethodNotFound;
export const INVALID_PARAMS: number = EXT_ERROR_CODE.InvalidParams;
export const INTERNAL_ERROR: number = EXT_ERROR_CODE.InternalError;
/** The extension lacks the permission for this call. */
export const PERMISSION_DENIED: number = EXT_ERROR_CODE.PermissionDenied;
/** A request timed out (local to the caller, never sent). */
export const TIMEOUT: number = EXT_ERROR_CODE.Timeout;
/** Name already taken by someone else. */
export const CONFLICT: number = EXT_ERROR_CODE.Conflict;
/** A host service (tool registry, storage, ...) is not available. */
export const UNAVAILABLE: number = EXT_ERROR_CODE.Unavailable;
/** The connection is closed (local to the caller, never sent). */
export const CLOSED: number = EXT_ERROR_CODE.Closed;

export { CANCEL_METHOD, encodeFrame, RpcError };

/** Thrown for malformed frames. */
export const FrameError = FramingError;
export type FrameError = FramingError;

/** Incremental frame parser: `push` returns every complete frame body; `end` throws mid-frame. */
export const FrameDecoder = FrameBodyDecoder;
export type FrameDecoder = FrameBodyDecoder;

/** Serves incoming requests and notifications. Request handlers throw `RpcError`. */
export interface RpcHandler {
  request(method: string, params: JsonValue): Promise<JsonValue>;
  notification(method: string, params: JsonValue): Promise<void> | void;
}

/** One side of a JSON-RPC connection, the host's. */
export class Peer {
  readonly #rpc: RpcPeer;

  /** Creates a peer writing to `writer`. Write errors (broken pipes) surface as EOF on the reader. */
  constructor(writer: Writable) {
    this.#rpc = new RpcPeer({
      output: writer,
      role: "host",
      onError: (what, err, method) => {
        if (what === "writer") log.debug({ err }, "rpc writer failed");
        else log.debug({ err, method }, "notification handler failed");
      },
    });
  }

  get isClosed(): boolean {
    return this.#rpc.closed;
  }

  /** @internal Requests waiting for a response (for tests). */
  get pendingCount(): number {
    return this.#rpc.pendingCount;
  }

  /** Sends a request and waits for the response, at most `timeoutMs`. Rejects with `RpcError`. */
  request(
    method: string,
    params: JsonValue,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    return this.#rpc.request<JsonValue>(method, params, timeoutMs, signal);
  }

  /** Sends a notification. Rejects with `CLOSED` when the writer is gone. */
  async notify(method: string, params: JsonValue): Promise<void> {
    if (!this.#rpc.notify(method, params)) throw new RpcError(CLOSED, "connection closed");
  }

  /** Sends a notification unless the outgoing queue is full. Returns whether it was queued. */
  tryNotify(method: string, params: JsonValue): boolean {
    return this.#rpc.tryNotify(method, params);
  }

  /**
   * Reads incoming messages until the stream ends (resolves) or a frame is malformed (rejects),
   * dispatching requests and notifications to `handler` and responses to waiting callers.
   * Pending requests fail with `CLOSED` when it settles. Aborting `signal` stops reading and
   * resolves.
   */
  serve(reader: Readable, handler: RpcHandler, signal?: AbortSignal): Promise<void> {
    return this.#rpc.serve(
      reader,
      {
        onRequest: async (method, params) => handler.request(method, params as JsonValue),
        onNotification: (method, params) => handler.notification(method, params as JsonValue),
      },
      signal,
    );
  }
}
