// How a JSON-RPC peer moves whole messages (docs/design/v5-hostd.md §5): `RpcPeer` deals in
// messages and leaves bytes to a transport. Two are here: LSP's `Content-Length` frames over a
// readable and a writable stream (extensions over stdio), and one JSON text frame per message
// over a WebSocket (the control link between hostd and Core). The WebSocket is taken by its
// shape (`WebSocketLike`): the SDK has no WebSocket package, and `ws` sockets and browser ones
// both fit.

import type { Readable, Writable } from "node:stream";
import { EXT_LIMITS } from "@miyoria/contracts/ext";
import { encodeFrame, FrameBodyDecoder, FramingError } from "./framing.js";

/** Where a transport delivers what it reads. */
export interface RpcTransportSink {
  /** One parsed message. */
  message(message: unknown): void;
  /** One whole message that is not JSON; the peer answers or ends the connection, by its role. */
  malformed(error: Error): void;
  /** The connection ended: cleanly, or with the error that broke it. Called at most once. */
  end(error?: Error): void;
}

/** A connection that carries whole JSON-RPC messages. */
export interface RpcTransport {
  /** Queues one message. Returns false when the connection can no longer be written. */
  send(message: unknown): boolean;
  /** Bytes queued and not yet written, for the peer's queue limit. */
  readonly queuedBytes: number;
  /** Starts delivering incoming messages to `sink`. Returns what stops it. */
  listen(sink: RpcTransportSink): () => void;
}

function parse(text: string, sink: RpcTransportSink): void {
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch (error) {
    sink.malformed(error as Error);
    return;
  }
  sink.message(message);
}

export interface StreamTransportOptions {
  /** A stream that stops in the middle of a frame is an error (`true`), or just the end. */
  strictEnd?: boolean;
}

/**
 * `Content-Length` frames over two byte streams. Reading needs `input`; a transport made without
 * one can only write.
 */
export class StreamTransport implements RpcTransport {
  readonly #output: Writable;
  readonly #input: Readable | null;
  readonly #strictEnd: boolean;

  constructor(output: Writable, input?: Readable | null, options: StreamTransportOptions = {}) {
    this.#output = output;
    this.#input = input ?? null;
    this.#strictEnd = options.strictEnd ?? false;
  }

  get queuedBytes(): number {
    return this.#output.writableLength;
  }

  send(message: unknown): boolean {
    if (this.#output.destroyed || this.#output.writableEnded) return false;
    this.#output.write(encodeFrame(message));
    return true;
  }

  listen(sink: RpcTransportSink): () => void {
    const input = this.#input;
    if (input === null) throw new Error("this stream transport has no input to read");
    const decoder = new FrameBodyDecoder();
    let ended = false;
    const end = (error?: Error) => {
      if (ended) return;
      ended = true;
      sink.end(error);
    };
    const onData = (chunk: Buffer | string) => {
      if (ended) return;
      let bodies: Buffer[];
      try {
        bodies = decoder.push(chunk);
      } catch (error) {
        end(error as Error);
        return;
      }
      for (const body of bodies) {
        if (ended) return;
        parse(body.toString("utf8"), sink);
      }
    };
    const onEnd = () => {
      if (!this.#strictEnd) {
        end();
        return;
      }
      try {
        decoder.end();
        end();
      } catch (error) {
        end(error as Error);
      }
    };
    const onError = (error: Error) => end(error);
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("close", onEnd);
    input.on("error", onError);
    return () => {
      ended = true;
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("close", onEnd);
      input.off("error", onError);
    };
  }
}

/** What a WebSocket event carries, as far as the transport reads it. */
export interface WebSocketEventLike {
  /** `message`: a string for a text frame. */
  data?: unknown;
  /** `close`. */
  code?: number;
  reason?: string;
  /** `error`. */
  error?: unknown;
  message?: string;
}

/**
 * The part of a WebSocket the transport uses: a `ws` socket and a browser one both fit. Binary
 * frames are not JSON-RPC: the transport leaves them to whoever else listens on the socket (the
 * relay of v5-hostd §7.1 will use them).
 */
export interface WebSocketLike {
  /** `1` is open. */
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  addEventListener(
    type: "message" | "close" | "error",
    listener: (event: WebSocketEventLike) => void,
  ): void;
  removeEventListener(
    type: "message" | "close" | "error",
    listener: (event: WebSocketEventLike) => void,
  ): void;
}

const WS_OPEN = 1;
const WS_CLOSED = 3;

/** Largest accepted text frame, in bytes: the same cap as a stream frame. */
export const MAX_MESSAGE_BYTES = EXT_LIMITS.MAX_FRAME_BYTES;

/**
 * One JSON text frame per message over a WebSocket. The socket's owner opens and closes it
 * (with its own close codes); the peer only reads and writes. A text frame over
 * `MAX_MESSAGE_BYTES` ends the connection as an oversized stream frame does.
 */
export class WebSocketTransport implements RpcTransport {
  readonly #socket: WebSocketLike;

  constructor(socket: WebSocketLike) {
    this.#socket = socket;
  }

  get queuedBytes(): number {
    return this.#socket.bufferedAmount;
  }

  send(message: unknown): boolean {
    if (this.#socket.readyState !== WS_OPEN) return false;
    try {
      this.#socket.send(JSON.stringify(message));
    } catch {
      return false;
    }
    return true;
  }

  listen(sink: RpcTransportSink): () => void {
    const socket = this.#socket;
    let ended = false;
    let failure: Error | undefined;
    const end = (error?: Error) => {
      if (ended) return;
      ended = true;
      detach();
      sink.end(error);
    };
    const onMessage = (event: WebSocketEventLike) => {
      if (ended || typeof event.data !== "string") return;
      if (Buffer.byteLength(event.data, "utf8") > MAX_MESSAGE_BYTES) {
        end(new FramingError(`message of more than ${MAX_MESSAGE_BYTES} bytes is too large`));
        return;
      }
      parse(event.data, sink);
    };
    const onError = (event: WebSocketEventLike) => {
      const cause = event.error;
      failure ??=
        cause instanceof Error ? cause : new Error(event.message ?? "WebSocket error", { cause });
    };
    const onClose = () => end(failure);
    const detach = () => {
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
    if (socket.readyState === WS_CLOSED) queueMicrotask(() => end());
    return () => {
      ended = true;
      detach();
    };
  }
}
