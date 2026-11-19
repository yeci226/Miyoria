// The host's half of the relay over the control link (docs/design/v5-hostd.md §7.1): Core sends
// `relay.request` for a service of this machine; the daemon looks the service up with
// `HostApi.target`, calls it with its own authorization, answers with the response head and
// streams the body back as binary frames, within the credit Core gives.
//
// The request can only reach a running service of this machine: the path is appended to the
// service's base URL and the result must keep its origin, and redirects are passed back, never
// followed. Every `fetch` in flight is aborted when Core aborts its stream, cancels the request,
// or the link drops (`close`).

import {
  decodeRelayFrame,
  encodeRelayFrame,
  HOST_ERROR_CODE,
  HOST_RELAY_DROPPED_REQUEST_HEADERS,
  HOST_RELAY_DROPPED_RESPONSE_HEADERS,
  HOST_RELAY_FRAME,
  HOST_RELAY_LIMITS,
  type HostRelayFrame,
  HostRelayFrameError,
  HostRelayLengthError,
  type HostRelayRequest,
  HostRelayRequestSchema,
  type HostRelayResponse,
  pumpRelayBody,
  RelayInbound,
  RelaySendWindow,
  type RelaySink,
  relayContentLength,
  relayHeaders,
} from "@miyoria/contracts/host";
import { RpcError } from "@miyoria/sdk";
import { type HostApi, HostRpcError } from "../api.js";

/** Streams the host keeps open at once; Core's own cap is lower, this is a backstop. */
const MAX_HOST_STREAMS = HOST_RELAY_LIMITS.MAX_STREAMS * 4;

export interface HostRelayLogger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
  debug(fields: object, message: string): void;
}

/** A relayed response at least this long is logged with its size, time and rate. */
const LOGGED_BYTES = 1_000_000;

export interface HostRelayOptions {
  api: HostApi;
  /** The control link's socket. */
  sink: RelaySink;
  /** A frame broke the protocol: the link must close (`HOST_RELAY_PROTOCOL_ERROR`). */
  onProtocolError(reason: string): void;
  logger?: HostRelayLogger;
  /** Default the global `fetch`. */
  fetch?: typeof fetch;
}

interface HostStream {
  readonly id: number;
  /** The request body as it arrives; `null` without one. */
  readonly inbound: RelayInbound | null;
  /** Credit for the response body. */
  readonly window: RelaySendWindow;
  /** Aborts the `fetch` and the pump. */
  readonly stop: AbortController;
  done: boolean;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The message with its causes: `fetch` reports a broken body as just `terminated`, and why (the
 * service closed the connection, a reset, a timeout) is in `cause`.
 */
function messageWithCause(error: unknown): string {
  let out = messageOf(error);
  let cause = error instanceof Error ? error.cause : undefined;
  for (let depth = 0; cause !== undefined && cause !== null && depth < 3; depth++) {
    const code =
      typeof cause === "object" && "code" in cause && typeof cause.code === "string"
        ? ` [${cause.code}]`
        : "";
    out += ` (${messageOf(cause)}${code})`;
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return out;
}

/** `base` + `path` with one slash between them, or `null` when it would leave `base`'s origin. */
export function relayUrl(base: string, path: string): URL | null {
  let url: URL;
  let origin: string;
  try {
    origin = new URL(base).origin;
    url = new URL(`${base.replace(/\/+$/u, "")}/${path.replace(/^\/+/u, "")}`);
  } catch {
    return null;
  }
  return url.origin === origin ? url : null;
}

/** The host's end of the relay on one connection. */
export class HostRelay {
  readonly #o: HostRelayOptions;
  readonly #fetch: typeof fetch;
  readonly #streams = new Map<number, HostStream>();
  #closed = false;

  constructor(options: HostRelayOptions) {
    this.#o = options;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /** Streams open now. */
  get open(): number {
    return this.#streams.size;
  }

  /**
   * Serves one `relay.request`. The stream is registered before this returns, so body frames
   * that follow the request on the socket find it. Throws `RpcError` / `HostRpcError`.
   */
  handle(params: unknown, signal: AbortSignal): Promise<HostRelayResponse> {
    const parsed = HostRelayRequestSchema.safeParse(params);
    if (!parsed.success) return Promise.reject(RpcError.invalidParams(parsed.error.message));
    const req = parsed.data;
    if (this.#closed) return Promise.reject(new Error("the control link closed"));
    if (this.#streams.has(req.stream)) {
      return Promise.reject(RpcError.invalidParams(`stream ${req.stream} is open already`));
    }
    if (this.#streams.size >= MAX_HOST_STREAMS) {
      return Promise.reject(
        new HostRpcError(HOST_ERROR_CODE.Busy, `${MAX_HOST_STREAMS} relayed requests are open`),
      );
    }
    const stream: HostStream = {
      id: req.stream,
      inbound: req.body
        ? new RelayInbound({
            credit: (bytes) =>
              this.#send({ kind: HOST_RELAY_FRAME.CREDIT, stream: req.stream, bytes }),
            // `fetch` stopped reading the request body (the service answered early, or the call
            // failed, which ends the stream on its own): later chunks are dropped, and Core's
            // sender stops when the stream ends.
            cancel: (reason) =>
              this.#o.logger?.debug(
                { stream: req.stream, reason: messageOf(reason) },
                "the service stopped reading a relayed request body",
              ),
          })
        : null,
      window: new RelaySendWindow(),
      stop: new AbortController(),
      done: false,
    };
    this.#streams.set(stream.id, stream);
    return this.#run(stream, req, signal);
  }

  /** One binary frame from Core. */
  frame(bytes: Uint8Array): void {
    let f: HostRelayFrame;
    try {
      f = decodeRelayFrame(bytes);
    } catch (error) {
      this.#protocolError(error instanceof HostRelayFrameError ? error.message : messageOf(error));
      return;
    }
    const stream = this.#streams.get(f.stream);
    switch (f.kind) {
      case HOST_RELAY_FRAME.REQUEST_CHUNK:
        if (stream === undefined) return;
        if (stream.inbound === null || !stream.inbound.push(f.data)) {
          this.#protocolError(`stream ${f.stream}: request body over its credit or unexpected`);
        }
        return;
      case HOST_RELAY_FRAME.REQUEST_END:
        if (stream === undefined) return;
        if (stream.inbound === null || !stream.inbound.end()) {
          this.#protocolError(`stream ${f.stream}: unexpected end of the request body`);
        }
        return;
      case HOST_RELAY_FRAME.CREDIT:
        stream?.window.grant(f.bytes);
        return;
      case HOST_RELAY_FRAME.ABORT:
        if (stream !== undefined) {
          this.#o.logger?.debug({ stream: f.stream, reason: f.reason }, "Core aborted a relay");
          this.#finish(stream, null, new Error(`aborted by Core: ${f.reason}`));
        }
        return;
      default:
        this.#protocolError(`a frame of kind ${f.kind} goes the other way`);
    }
  }

  /** The link dropped: every `fetch` in flight is aborted. */
  close(): void {
    this.#closed = true;
    for (const stream of [...this.#streams.values()]) {
      this.#finish(stream, null, new Error("the control link closed"));
    }
  }

  #protocolError(reason: string): void {
    this.#o.logger?.debug({ reason }, "a relay frame broke the protocol");
    this.#o.onProtocolError(reason);
  }

  #send(f: HostRelayFrame): boolean {
    return this.#o.sink.send(encodeRelayFrame(f));
  }

  /** Ends a stream once: aborts its work, sends an abort frame when `reason` is a string. */
  #finish(stream: HostStream, reason: string | null, error?: Error): void {
    if (stream.done) return;
    stream.done = true;
    if (this.#streams.get(stream.id) === stream) this.#streams.delete(stream.id);
    const why = error ?? new Error(reason ?? "the stream ended");
    stream.stop.abort(why);
    stream.inbound?.fail(why);
    if (reason !== null) this.#send({ kind: HOST_RELAY_FRAME.ABORT, stream: stream.id, reason });
  }

  async #run(
    stream: HostStream,
    req: HostRelayRequest,
    signal: AbortSignal,
  ): Promise<HostRelayResponse> {
    // `$/cancelRequest` before the head is back: same as an abort frame.
    const onCancel = () => this.#finish(stream, null, new Error("cancelled by Core"));
    signal.addEventListener("abort", onCancel, { once: true });
    try {
      const target = this.#o.api.target(req.service);
      if (target === null) {
        const known = this.#o.api
          .report({ withTokens: false })
          .services.some((s) => s.name === req.service);
        throw new HostRpcError(
          HOST_ERROR_CODE.UnknownService,
          known
            ? `\`${req.service}\` is not running on this host`
            : `no service \`${req.service}\` on this host`,
        );
      }
      const url = relayUrl(target.url, req.path);
      if (url === null)
        throw RpcError.invalidParams(`\`${req.path}\` is not a path of the service`);
      const headers = new Headers(
        relayHeaders(Object.entries(req.headers), HOST_RELAY_DROPPED_REQUEST_HEADERS),
      );
      for (const [name, value] of Object.entries(target.headers)) headers.set(name, value);
      const body = await this.#requestBody(stream, req);
      stream.stop.signal.throwIfAborted();
      const response = await this.#fetch(url, {
        method: req.method,
        headers,
        body,
        redirect: "manual",
        signal: stream.stop.signal,
        ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
      } as RequestInit);
      const dropped = response.headers.has("content-encoding")
        ? // `fetch` decoded the body: its encoding and length are not the bytes that follow.
          [...HOST_RELAY_DROPPED_RESPONSE_HEADERS, "content-encoding", "content-length"]
        : HOST_RELAY_DROPPED_RESPONSE_HEADERS;
      const head: HostRelayResponse = {
        status: response.status,
        headers: relayHeaders(response.headers, dropped),
      };
      // A decoded body's length is not the header's; HEAD has no body.
      const length =
        req.method === "HEAD" || response.headers.has("content-encoding")
          ? undefined
          : relayContentLength(head.headers);
      // The head goes out first; the body frames follow it.
      setImmediate(() => this.#respond(stream, response.body, { req, length }));
      return head;
    } catch (error) {
      const aborted = stream.stop.signal.aborted;
      this.#finish(stream, null, error instanceof Error ? error : new Error(messageOf(error)));
      if (error instanceof RpcError || error instanceof HostRpcError) throw error;
      if (aborted) throw new Error(`the relayed request was aborted: ${messageOf(error)}`);
      throw new Error(`\`${req.service}\` did not answer: ${messageOf(error)}`);
    } finally {
      signal.removeEventListener("abort", onCancel);
    }
  }

  /**
   * The body to give `fetch`: the bytes whole when Core said how many there are (so the service
   * sees a `content-length`), else the stream as it arrives.
   */
  async #requestBody(
    stream: HostStream,
    req: HostRelayRequest,
  ): Promise<Uint8Array | ReadableStream<Uint8Array> | undefined> {
    const inbound = stream.inbound;
    if (inbound === null) return undefined;
    if (req.length === undefined || req.length > HOST_RELAY_LIMITS.WHOLE_BODY_BYTES) {
      return inbound.readable;
    }
    const whole = new Uint8Array(req.length);
    let at = 0;
    const reader = inbound.readable.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (at + value.byteLength > whole.byteLength) {
          throw RpcError.invalidParams(`the request body is longer than ${req.length} bytes`);
        }
        whole.set(value, at);
        at += value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
    if (at !== whole.byteLength) {
      throw RpcError.invalidParams(`the request body is ${at} bytes, not ${req.length}`);
    }
    return whole;
  }

  /**
   * Streams the response body to Core, then ends the stream. A body that breaks off or ends short
   * of its `content-length` is aborted, never ended: Core would take it for the whole.
   */
  #respond(
    stream: HostStream,
    body: ReadableStream<Uint8Array> | null,
    about: { req: HostRelayRequest; length: number | undefined },
  ): void {
    if (stream.done) {
      body?.cancel().catch(() => {});
      return;
    }
    const sink = this.#o.sink;
    const sent =
      body === null
        ? Promise.resolve().then(() => {
            if (!this.#send({ kind: HOST_RELAY_FRAME.RESPONSE_END, stream: stream.id })) {
              throw new Error("the control link closed");
            }
            return 0;
          })
        : pumpRelayBody({
            source: body,
            sink,
            stream: stream.id,
            kind: HOST_RELAY_FRAME.RESPONSE_CHUNK,
            window: stream.window,
            signal: stream.stop.signal,
            ...(about.length === undefined ? {} : { length: about.length }),
          });
    const t0 = performance.now();
    const what = {
      stream: stream.id,
      service: about.req.service,
      path: about.req.path.replace(/\?.*$/su, ""),
    };
    sent.then(
      (bytes) => {
        // The request body (if `fetch` still holds it) is not needed any more either.
        stream.done = true;
        if (this.#streams.get(stream.id) === stream) this.#streams.delete(stream.id);
        stream.inbound?.fail(new Error("the response is complete"));
        if (bytes >= LOGGED_BYTES) {
          const seconds = (performance.now() - t0) / 1000;
          this.#o.logger?.info(
            {
              ...what,
              bytes,
              seconds: Math.round(seconds * 100) / 100,
              mb_per_s: Math.round((bytes / 1e6 / Math.max(seconds, 0.001)) * 100) / 100,
            },
            "relayed a response",
          );
        }
      },
      (error: unknown) => {
        if (stream.done) return;
        const why = messageWithCause(error);
        if (error instanceof HostRelayLengthError) {
          this.#o.logger?.warn(
            { ...what, bytes: error.received, length: error.expected },
            error.received < error.expected
              ? "a relayed response ended short of its content-length"
              : "a relayed response ran past its content-length",
          );
        } else {
          this.#o.logger?.warn(
            {
              ...what,
              bytes: stream.window.sent,
              ...(about.length === undefined ? {} : { length: about.length }),
              seconds: Math.round((performance.now() - t0) / 10) / 100,
              err: why,
            },
            "a relayed response broke",
          );
        }
        this.#finish(stream, `the service's response broke: ${why}`);
      },
    );
  }
}
