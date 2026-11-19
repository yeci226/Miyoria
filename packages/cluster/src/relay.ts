// The relay over the control link, Core's side (docs/design/v5-hostd.md §7.1): `request` for an
// endpoint with `via: "link"` sends the HTTP request through the host's link and gives back a
// standard `Response` whose body streams in as the host sends it.
//
// One request is one stream (contracts `host/relay.ts` has the wire): `relay.request` carries the
// head and is answered with the response head; the bodies travel as binary frames within the
// credit each side gives. The caller's `signal`, a cancelled body, the head timeout and a dropped
// link all end the stream on both sides: nothing waits for a host that went away.

import { EXT_ERROR_CODE } from "@miyoria/contracts/ext";
import {
  decodeRelayFrame,
  encodeRelayFrame,
  HOST_RELAY_DROPPED_REQUEST_HEADERS,
  HOST_RELAY_FRAME,
  HOST_RELAY_LIMITS,
  HOST_RELAY_METHOD,
  type HostRelayFrame,
  HostRelayFrameError,
  type HostRelayRequest,
  HostRelayResponseSchema,
  type HostServiceStatus,
  pumpRelayBody,
  RelayInbound,
  RelaySendWindow,
  type RelaySink,
  relayContentLength,
  relayHeaders,
} from "@miyoria/contracts/host";
import { errorMessage } from "@miyoria/runtime/kernel";
import { RpcError, type RpcPeer } from "@miyoria/sdk";
import type { Endpoint, LinkRelay } from "./registry.js";
import { ClusterError } from "./tables.js";

/** How long a relayed request may wait for the response head, by default. */
export const DEFAULT_RELAY_TIMEOUT_MS = 120_000;

/** Statuses whose response has no body (`new Response` refuses one). */
const NULL_BODY = new Set([204, 205, 304]);

/** The base the caller's path is resolved against; it never leaves this process. */
const RELAY_BASE = "http://relay.invalid";

export interface RelayOptions {
  /** Streams open at once per host. Default `HOST_RELAY_LIMITS.MAX_STREAMS` (16). */
  maxStreams?: number;
  /** How long the response head may take, in ms. Default 120 000; the caller's `signal` rules. */
  timeoutMs?: number;
}

/** A body `fetch` takes that is in memory already (not a stream or an async iterable). */
function inMemory(body: unknown): boolean {
  return (
    typeof body === "string" ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    body instanceof Blob ||
    body instanceof URLSearchParams ||
    body instanceof FormData
  );
}

/** A relayed request failed: refused, timed out, aborted by the host, or the link dropped. */
export class RelayError extends ClusterError {
  override name = "RelayError";
  /** The host's JSON-RPC error code, when it answered with one. */
  readonly code: number | null;
  /**
   * False when nothing was sent to the host: the caller may safely send the request elsewhere.
   * True whenever the service may have received it.
   */
  readonly sent: boolean;

  constructor(message: string, options: { code?: number; cause?: unknown; sent?: boolean } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = options.code ?? null;
    this.sent = options.sent ?? true;
  }
}

interface CoreStream {
  readonly id: number;
  /** The response body as it arrives. */
  readonly inbound: RelayInbound;
  /** Credit for the request body. */
  readonly window: RelaySendWindow;
  /** Ends the stream here: the request body pump and the wait for the head. */
  readonly stop: AbortController;
  /** No longer open: ended, aborted, or the link closed. */
  done: boolean;
  /** The response head arrived. */
  headed: boolean;
  /** Removes the caller's abort listener. */
  unlisten: () => void;
}

export interface RelayChannelOptions {
  /** The host's name, for messages. */
  host: string;
  peer: RpcPeer;
  /** The link's socket. */
  sink: RelaySink;
  /** A frame broke the protocol: the link must close (`HOST_RELAY_PROTOCOL_ERROR`). */
  onProtocolError(reason: string): void;
  maxStreams?: number;
  timeoutMs?: number;
}

/** The relay over one host connection. The link makes one per connection and closes it with it. */
export class RelayChannel {
  readonly #o: RelayChannelOptions;
  readonly #max: number;
  readonly #timeout: number;
  readonly #streams = new Map<number, CoreStream>();
  #next = 1;
  #closed: RelayError | null = null;

  constructor(options: RelayChannelOptions) {
    this.#o = options;
    this.#max = options.maxStreams ?? HOST_RELAY_LIMITS.MAX_STREAMS;
    this.#timeout = options.timeoutMs ?? DEFAULT_RELAY_TIMEOUT_MS;
  }

  /** Streams open now. */
  get open(): number {
    return this.#streams.size;
  }

  /** Sends one HTTP request to `service` on this host. Rejects as `fetch` does, or `RelayError`. */
  async request(service: string, path: string, init: RequestInit = {}): Promise<Response> {
    const host = this.#o.host;
    const signal = init.signal ?? undefined;
    signal?.throwIfAborted();
    if (this.#closed !== null) throw this.#closed;
    if (this.#streams.size >= this.#max) {
      throw new RelayError(
        `${this.#max} relayed requests to host \`${host}\` are open already; try again later`,
        { sent: false },
      );
    }
    // What `fetch` accepts, normalised: the method, the headers (form data's content type) and
    // the body as bytes.
    const req = new Request(`${RELAY_BASE}/${path.replace(/^\/+/u, "")}`, init);
    const url = new URL(req.url);
    if (url.origin !== RELAY_BASE) throw new RelayError(`\`${path}\` is not a path`);
    let source: ReadableStream<Uint8Array> | null = req.body;
    let length: number | undefined;
    if (source !== null && inMemory(init.body)) {
      // A body that is in memory anyway: its length lets the host send it whole.
      const bytes = new Uint8Array(await req.arrayBuffer());
      length = bytes.byteLength;
      source = new Blob([bytes]).stream();
    }
    signal?.throwIfAborted();
    if (this.#closed !== null) throw this.#closed;
    if (this.#streams.size >= this.#max) {
      throw new RelayError(
        `${this.#max} relayed requests to host \`${host}\` are open already; try again later`,
        { sent: false },
      );
    }

    const stream = this.#open();
    const params: HostRelayRequest = {
      stream: stream.id,
      service,
      method: req.method,
      path: `${url.pathname}${url.search}`,
      headers: relayHeaders(req.headers, HOST_RELAY_DROPPED_REQUEST_HEADERS),
      body: source !== null,
      ...(length === undefined ? {} : { length }),
    };
    if (signal !== undefined) {
      const onAbort = () => this.#end(stream, signal.reason, "aborted by the caller");
      signal.addEventListener("abort", onAbort, { once: true });
      stream.unlisten = () => signal.removeEventListener("abort", onAbort);
    }

    let answer: unknown;
    try {
      const head = this.#o.peer.request(
        HOST_RELAY_METHOD,
        params,
        this.#timeout,
        stream.stop.signal,
      );
      if (source !== null) {
        pumpRelayBody({
          source,
          sink: this.#o.sink,
          stream: stream.id,
          kind: HOST_RELAY_FRAME.REQUEST_CHUNK,
          window: stream.window,
          signal: stream.stop.signal,
          ...(length === undefined ? {} : { length }),
        }).catch((error: unknown) => {
          if (!stream.stop.signal.aborted) {
            this.#end(stream, error, `the request body failed: ${errorMessage(error)}`);
          }
        });
      }
      answer = await head;
      stream.headed = true;
      if (stream.done) stream.stop.abort(new RelayError("the response is complete"));
    } catch (error) {
      const reason = stream.stop.signal.aborted ? stream.stop.signal.reason : error;
      this.#end(stream, reason, "no answer");
      if (signal?.aborted) throw signal.reason;
      throw this.#failure(service, reason);
    }

    const parsed = HostRelayResponseSchema.safeParse(answer);
    if (!parsed.success) {
      const error = new RelayError(`host \`${host}\` answered a relayed request with a bad head`);
      this.#end(stream, error, "bad head");
      throw error;
    }
    const { status, headers } = parsed.data;
    if (NULL_BODY.has(status)) {
      // Nothing to read: let the end frame arrive and free the stream.
      stream.inbound.readable.pipeTo(new WritableStream()).catch(() => {});
      return new Response(null, { status, headers });
    }
    // A body that stops short of its length fails its reader rather than ending: a host before
    // 2026-11-19 ends a body its service broke off early (a closed connection) like a whole one.
    const expected = relayContentLength(headers);
    if (expected !== undefined && req.method !== "HEAD") stream.inbound.expect(expected);
    return new Response(stream.inbound.readable, { status, headers });
  }

  /** One binary frame from the host. */
  frame(bytes: Uint8Array): void {
    let f: HostRelayFrame;
    try {
      f = decodeRelayFrame(bytes);
    } catch (error) {
      this.#o.onProtocolError(
        error instanceof HostRelayFrameError ? error.message : errorMessage(error),
      );
      return;
    }
    const stream = this.#streams.get(f.stream);
    switch (f.kind) {
      case HOST_RELAY_FRAME.RESPONSE_CHUNK:
        if (stream !== undefined && !stream.inbound.push(f.data)) {
          this.#o.onProtocolError(`stream ${f.stream}: response body over its credit`);
        }
        return;
      case HOST_RELAY_FRAME.RESPONSE_END:
        if (stream === undefined) return;
        stream.inbound.end();
        // The body is all here (it may still be read); the request body is not needed any more.
        // Before the head the wait for it goes on; the pump stops once it is here.
        this.#forget(stream);
        if (stream.headed) stream.stop.abort(new RelayError("the response is complete"));
        return;
      case HOST_RELAY_FRAME.CREDIT:
        stream?.window.grant(f.bytes);
        return;
      case HOST_RELAY_FRAME.ABORT:
        if (stream === undefined) return;
        this.#end(
          stream,
          new RelayError(`host \`${this.#o.host}\` aborted the relayed request: ${f.reason}`),
          null,
        );
        return;
      default:
        this.#o.onProtocolError(`a frame of kind ${f.kind} goes the other way`);
    }
  }

  /** The link dropped: every open stream fails with `error`. */
  close(error: RelayError): void {
    this.#closed ??= error;
    for (const stream of [...this.#streams.values()]) this.#end(stream, this.#closed, null);
  }

  #open(): CoreStream {
    let id = this.#next;
    while (this.#streams.has(id)) id = id >= HOST_RELAY_LIMITS.STREAM_ID_MAX ? 1 : id + 1;
    this.#next = id >= HOST_RELAY_LIMITS.STREAM_ID_MAX ? 1 : id + 1;
    const stream: CoreStream = {
      id,
      inbound: new RelayInbound({
        credit: (bytes) => this.#send({ kind: HOST_RELAY_FRAME.CREDIT, stream: id, bytes }),
        cancel: (reason) => this.#end(stream, reason, "the body was cancelled"),
      }),
      window: new RelaySendWindow(),
      stop: new AbortController(),
      done: false,
      headed: false,
      unlisten: () => {},
    };
    this.#streams.set(id, stream);
    return stream;
  }

  #send(f: HostRelayFrame): boolean {
    return this.#o.sink.send(encodeRelayFrame(f));
  }

  #forget(stream: CoreStream): void {
    if (stream.done) return;
    stream.done = true;
    stream.unlisten();
    if (this.#streams.get(stream.id) === stream) this.#streams.delete(stream.id);
  }

  /**
   * Ends a stream here: the head wait and the request body stop, the response body fails with
   * `error`. With an `abort` reason the host is told to stop too.
   */
  #end(stream: CoreStream, error: unknown, abort: string | null): void {
    const live = !stream.done;
    this.#forget(stream);
    stream.stop.abort(error);
    stream.inbound.fail(error);
    if (live && abort !== null && this.#closed === null) {
      this.#send({ kind: HOST_RELAY_FRAME.ABORT, stream: stream.id, reason: abort });
    }
  }

  /** What the caller sees when the head did not come. */
  #failure(service: string, error: unknown): unknown {
    const host = this.#o.host;
    if (error instanceof RelayError) return error;
    if (error instanceof RpcError) {
      if (error.code === EXT_ERROR_CODE.Closed) {
        return this.#closed ?? new RelayError(`the link to host \`${host}\` closed`);
      }
      if (error.code === EXT_ERROR_CODE.Timeout) {
        return new RelayError(
          `\`${service}\` on host \`${host}\` did not answer within ${this.#timeout} ms`,
          { code: error.code, cause: error },
        );
      }
      return new RelayError(`\`${service}\` on host \`${host}\`: ${error.message}`, {
        code: error.code,
        cause: error,
      });
    }
    return error;
  }
}

/** What the relay needs to know of a connected host. */
export interface RelayHost {
  readonly approved: boolean;
  /** The capabilities the owner approved it for. */
  readonly capabilities: readonly string[];
  /** Its latest report's services; `null` before the first. */
  readonly services: readonly HostServiceStatus[] | null;
  readonly channel: RelayChannel;
}

/**
 * `LinkRelay` for the registry: checks that the host is connected and approved and reports the
 * service, then sends the request over that host's channel. The endpoint's own headers are not
 * sent: the host adds the service's authorization itself.
 */
export class ClusterRelay implements LinkRelay {
  readonly #lookup: (host: string) => RelayHost | null;

  constructor(lookup: (host: string) => RelayHost | null) {
    this.#lookup = lookup;
  }

  async request(endpoint: Endpoint, path: string, init: RequestInit = {}): Promise<Response> {
    init.signal?.throwIfAborted();
    const host = this.#lookup(endpoint.host);
    if (host === null) {
      throw new RelayError(`host \`${endpoint.host}\` is not connected`, { sent: false });
    }
    if (!host.approved || !host.capabilities.includes(endpoint.capability)) {
      throw new RelayError(
        `host \`${endpoint.host}\` is not approved for \`${endpoint.capability}\``,
        { sent: false },
      );
    }
    const service = host.services?.find((s) => s.name === endpoint.service);
    if (service === undefined || !service.provides.includes(endpoint.capability)) {
      throw new RelayError(
        `host \`${endpoint.host}\` reports no service \`${endpoint.service}\` for \`${endpoint.capability}\``,
        { sent: false },
      );
    }
    return host.channel.request(endpoint.service, path, init);
  }
}
