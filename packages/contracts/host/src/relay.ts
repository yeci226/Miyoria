// Requests Core sends through a host's control link to a service of that host
// (docs/design/v5-hostd.md §7.1).
//
// One relayed request is one stream with an id Core picks, unique per connection. Core opens it
// with the JSON-RPC request `relay.request`; hostd answers with the status and headers as soon as
// the service's response headers arrive. Bodies travel as binary WebSocket frames on the same
// socket: `[kind: u8][stream: u32 LE][payload]`, chunks of at most `CHUNK_BYTES`.
//
// Flow control is credit based, per stream and per direction: a sender may have at most
// `WINDOW_BYTES` that the receiver has not handed to its consumer yet; the receiver sends credit
// (`CREDIT`, a u32 LE byte count) as its consumer takes data. A frame that breaks these rules, or
// one of a kind the receiver does not take, closes the link with `HOST_RELAY_PROTOCOL_ERROR`; a
// frame for a stream the receiver does not know (it can arrive after an abort) is ignored.
//
// Besides the shapes and constants, this file holds the plain TS both ends share: the frame codec,
// the credit accounting, the receiving end of a body as a `ReadableStream` (`RelayInbound`) and
// the sending end (`pumpRelayBody`). They are not schemas.

import { z } from "zod";

/** The JSON-RPC method that opens a relayed request, Core → hostd. */
export const HOST_RELAY_METHOD = "relay.request";

/** The kind in the first byte of a binary frame of the control link. */
export const HOST_RELAY_FRAME = {
  /** Core → hostd: a piece of the request body. */
  REQUEST_CHUNK: 0x01,
  /** Core → hostd: the request body is complete. No payload. */
  REQUEST_END: 0x02,
  /** hostd → Core: a piece of the response body. */
  RESPONSE_CHUNK: 0x03,
  /** hostd → Core: the response body is complete. No payload. */
  RESPONSE_END: 0x04,
  /** Either way: the stream is given up on. Payload: a short UTF-8 reason. */
  ABORT: 0x05,
  /** Either way: the sender of the frame took this many more bytes of the other's body (u32 LE). */
  CREDIT: 0x06,
} as const;
export type HostRelayFrameKind = (typeof HOST_RELAY_FRAME)[keyof typeof HOST_RELAY_FRAME];

/** The numbers of the relay. Both ends use the same ones; nothing is negotiated. */
export const HOST_RELAY_LIMITS = {
  /** Bytes before the payload of a binary frame: the kind and the stream id. */
  HEADER_BYTES: 5,
  /** Largest payload of a chunk frame. */
  CHUNK_BYTES: 64 * 1024,
  /** Bytes a sender may have in flight per stream and direction before it gets credit. */
  WINDOW_BYTES: 1024 * 1024,
  /** Credit is sent once the consumer has taken this many bytes since the last credit. */
  CREDIT_STEP_BYTES: 256 * 1024,
  /**
   * A sender of a body waits while its socket has more than this many bytes queued. Everything
   * else on the link (JSON-RPC, credit, aborts) is written at once, so this bounds the body bytes
   * queued ahead of a control message in the process; it is local to the sender, not negotiated.
   * (It was 1 MiB until 2026-11-19: over a home upload that is many seconds ahead of `host.info`.)
   */
  SOCKET_HIGH_WATER_BYTES: 128 * 1024,
  /** Largest payload of an abort frame. */
  ABORT_REASON_BYTES: 256,
  /** Streams Core keeps open per host; one more fails at once. */
  MAX_STREAMS: 16,
  /** A request body of a known length up to this size is sent to the service whole. */
  WHOLE_BODY_BYTES: 16 * 1024 * 1024,
  /** Stream ids are unsigned 32-bit integers above zero. */
  STREAM_ID_MAX: 0xffff_ffff,
} as const;

/** The WebSocket close code for a malformed or unexpected binary frame (protocol error). */
export const HOST_RELAY_PROTOCOL_ERROR = 1002;

/**
 * Request headers that do not travel over the link: hop-by-hop ones, and the ones the host sets
 * itself (`host`, `content-length`, and `authorization`, which is the service's own).
 */
export const HOST_RELAY_DROPPED_REQUEST_HEADERS: readonly string[] = [
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "authorization",
];

/** Response headers that do not travel over the link: hop-by-hop ones. */
export const HOST_RELAY_DROPPED_RESPONSE_HEADERS: readonly string[] = [
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

/** `relay.request` params, Core → hostd. */
export const HostRelayRequestSchema = z
  .object({
    /** The stream the bodies of this request travel on. */
    stream: z.number().int().min(1).max(HOST_RELAY_LIMITS.STREAM_ID_MAX),
    /** A service of the host, by name. */
    service: z.string().min(1),
    method: z.string().regex(/^[A-Za-z]{1,32}$/),
    /** Path and query, appended to the service's base URL on the host. */
    path: z.string().regex(/^\/\S*$/),
    /** Lower-case names; without the ones in `HOST_RELAY_DROPPED_REQUEST_HEADERS`. */
    headers: z.record(z.string(), z.string()).default({}),
    /** A request body follows as `REQUEST_CHUNK` frames and one `REQUEST_END`. */
    body: z.boolean().default(false),
    /** The body's length in bytes, when Core knows it. */
    length: z.number().int().nonnegative().optional(),
  })
  .meta({ id: "HostRelayRequest" });
export type HostRelayRequest = z.output<typeof HostRelayRequestSchema>;

/** `relay.request` result: the service's response head. The body follows as frames. */
export const HostRelayResponseSchema = z
  .object({
    status: z.number().int().min(200).max(599),
    /** Lower-case names; without the ones in `HOST_RELAY_DROPPED_RESPONSE_HEADERS`. */
    headers: z.record(z.string(), z.string()).default({}),
  })
  .meta({ id: "HostRelayResponse" });
export type HostRelayResponse = z.output<typeof HostRelayResponseSchema>;

/** The headers that travel over the link, as a record of lower-case names. */
export function relayHeaders(
  headers: Iterable<[string, string]>,
  dropped: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of headers) {
    const key = name.toLowerCase();
    if (!dropped.includes(key)) out[key] = value;
  }
  return out;
}

// ---- frames ------------------------------------------------------------------------------------

type ChunkKind = typeof HOST_RELAY_FRAME.REQUEST_CHUNK | typeof HOST_RELAY_FRAME.RESPONSE_CHUNK;
type EndKind = typeof HOST_RELAY_FRAME.REQUEST_END | typeof HOST_RELAY_FRAME.RESPONSE_END;

/** One binary frame of the relay, decoded. */
export type HostRelayFrame =
  | { kind: ChunkKind; stream: number; data: Uint8Array }
  | { kind: EndKind; stream: number }
  | { kind: typeof HOST_RELAY_FRAME.ABORT; stream: number; reason: string }
  | { kind: typeof HOST_RELAY_FRAME.CREDIT; stream: number; bytes: number };

/** A binary frame that breaks the relay's rules. The link closes with a protocol error. */
export class HostRelayFrameError extends Error {
  override name = "HostRelayFrameError";
}

const H = HOST_RELAY_LIMITS.HEADER_BYTES;
const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

function isStreamId(stream: number): boolean {
  return Number.isInteger(stream) && stream >= 1 && stream <= HOST_RELAY_LIMITS.STREAM_ID_MAX;
}

function frame(kind: number, stream: number, payloadBytes: number): Uint8Array {
  if (!isStreamId(stream)) throw new RangeError(`stream id ${stream} is out of range`);
  const out = new Uint8Array(H + payloadBytes);
  out[0] = kind;
  new DataView(out.buffer, out.byteOffset, out.byteLength).setUint32(1, stream, true);
  return out;
}

/** Encodes one frame. A chunk over `CHUNK_BYTES` or credit outside 1..2^32-1 is a `RangeError`. */
export function encodeRelayFrame(f: HostRelayFrame): Uint8Array {
  switch (f.kind) {
    case HOST_RELAY_FRAME.REQUEST_CHUNK:
    case HOST_RELAY_FRAME.RESPONSE_CHUNK: {
      if (f.data.byteLength > HOST_RELAY_LIMITS.CHUNK_BYTES) {
        throw new RangeError(`a chunk of ${f.data.byteLength} bytes is over the limit`);
      }
      const out = frame(f.kind, f.stream, f.data.byteLength);
      out.set(f.data, H);
      return out;
    }
    case HOST_RELAY_FRAME.REQUEST_END:
    case HOST_RELAY_FRAME.RESPONSE_END:
      return frame(f.kind, f.stream, 0);
    case HOST_RELAY_FRAME.ABORT: {
      let reason = utf8.encode(f.reason);
      if (reason.byteLength > HOST_RELAY_LIMITS.ABORT_REASON_BYTES) {
        // Cut at a character boundary: never in the middle of a UTF-8 sequence.
        let end = HOST_RELAY_LIMITS.ABORT_REASON_BYTES;
        while (end > 0 && ((reason[end] as number) & 0xc0) === 0x80) end--;
        reason = reason.subarray(0, end);
      }
      const out = frame(f.kind, f.stream, reason.byteLength);
      out.set(reason, H);
      return out;
    }
    case HOST_RELAY_FRAME.CREDIT: {
      if (!Number.isInteger(f.bytes) || f.bytes < 1 || f.bytes > 0xffff_ffff) {
        throw new RangeError(`credit of ${f.bytes} bytes is out of range`);
      }
      const out = frame(f.kind, f.stream, 4);
      new DataView(out.buffer, out.byteOffset, out.byteLength).setUint32(H, f.bytes, true);
      return out;
    }
  }
}

/**
 * Decodes one frame. A chunk's `data` is a view into `bytes`, not a copy. Throws
 * `HostRelayFrameError` for a frame that is too short, of an unknown kind, for stream 0, or with
 * a payload its kind does not allow.
 */
export function decodeRelayFrame(bytes: Uint8Array): HostRelayFrame {
  if (bytes.byteLength < H) {
    throw new HostRelayFrameError(
      `a frame of ${bytes.byteLength} bytes is shorter than its header`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kind = bytes[0] as number;
  const stream = view.getUint32(1, true);
  if (stream === 0) throw new HostRelayFrameError("a frame for stream 0");
  const payload = bytes.subarray(H);
  switch (kind) {
    case HOST_RELAY_FRAME.REQUEST_CHUNK:
    case HOST_RELAY_FRAME.RESPONSE_CHUNK:
      if (payload.byteLength > HOST_RELAY_LIMITS.CHUNK_BYTES) {
        throw new HostRelayFrameError(`a chunk of ${payload.byteLength} bytes is over the limit`);
      }
      return { kind, stream, data: payload };
    case HOST_RELAY_FRAME.REQUEST_END:
    case HOST_RELAY_FRAME.RESPONSE_END:
      if (payload.byteLength !== 0) throw new HostRelayFrameError("an end frame with a payload");
      return { kind, stream };
    case HOST_RELAY_FRAME.ABORT:
      if (payload.byteLength > HOST_RELAY_LIMITS.ABORT_REASON_BYTES) {
        throw new HostRelayFrameError("an abort reason over the limit");
      }
      return { kind, stream, reason: fromUtf8.decode(payload) };
    case HOST_RELAY_FRAME.CREDIT: {
      if (payload.byteLength !== 4) throw new HostRelayFrameError("a credit frame of a wrong size");
      const credit = view.getUint32(H, true);
      if (credit === 0) throw new HostRelayFrameError("a credit of 0 bytes");
      return { kind, stream, bytes: credit };
    }
    default:
      throw new HostRelayFrameError(`a frame of unknown kind ${kind}`);
  }
}

// ---- credit accounting -------------------------------------------------------------------------

/**
 * The receiving end's accounting of one body. The sender starts with `window` bytes of credit;
 * `consume` returns the credit to send once the consumer has taken `step` bytes since the last.
 */
export class RelayReceiveWindow {
  readonly window: number;
  readonly #step: number;
  #received = 0;
  #consumed = 0;
  /** Total bytes the sender may have sent: the window plus every credit sent. */
  #allowed: number;
  #ungranted = 0;

  constructor(
    window: number = HOST_RELAY_LIMITS.WINDOW_BYTES,
    step: number = Math.min(HOST_RELAY_LIMITS.CREDIT_STEP_BYTES, window),
  ) {
    this.window = window;
    this.#step = step;
    this.#allowed = window;
  }

  /** Bytes received and not yet handed to the consumer. */
  get buffered(): number {
    return this.#received - this.#consumed;
  }

  get received(): number {
    return this.#received;
  }

  /** Records an arriving chunk. False when it overruns the credit (a protocol error). */
  receive(bytes: number): boolean {
    if (this.#received + bytes > this.#allowed) return false;
    this.#received += bytes;
    return true;
  }

  /** Records bytes handed to the consumer. Returns the credit to send now; 0 for none yet. */
  consume(bytes: number): number {
    this.#consumed += bytes;
    this.#ungranted += bytes;
    if (this.#ungranted < this.#step) return 0;
    const credit = this.#ungranted;
    this.#ungranted = 0;
    this.#allowed += credit;
    return credit;
  }
}

/** The sending end's accounting of one body: how much it may still send. */
export class RelaySendWindow {
  #available: number;
  #sent = 0;
  #waiters = new Set<() => void>();

  constructor(window: number = HOST_RELAY_LIMITS.WINDOW_BYTES) {
    this.#available = window;
  }

  /** Bytes that may be sent now. */
  get available(): number {
    return this.#available;
  }

  /** Bytes sent so far. */
  get sent(): number {
    return this.#sent;
  }

  /** Records `bytes` sent; never more than `available`. */
  take(bytes: number): void {
    if (bytes > this.#available) {
      throw new RangeError(`${bytes} bytes is more than the ${this.#available} available`);
    }
    this.#available -= bytes;
    this.#sent += bytes;
  }

  /** Credit arrived. */
  grant(bytes: number): void {
    this.#available += bytes;
    for (const wake of [...this.#waiters]) wake();
  }

  /** Resolves once something may be sent; rejects with the reason when `signal` aborts. */
  ready(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.#available > 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const done = () => {
        this.#waiters.delete(wake);
        signal?.removeEventListener("abort", onAbort);
      };
      const wake = () => {
        if (this.#available <= 0) return;
        done();
        resolve();
      };
      const onAbort = () => {
        done();
        reject(signal?.reason);
      };
      this.#waiters.add(wake);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

// ---- the two ends of a body --------------------------------------------------------------------

/** Where an end of the relay writes its frames: the control link's socket. */
export interface RelaySink {
  /** Sends one binary frame. False when the socket can no longer be written. */
  send(frame: Uint8Array): boolean;
  /** Bytes the socket has queued and not yet written. */
  readonly bufferedAmount: number;
  /**
   * Resolves once at most `bytes` are queued; rejects with the reason when `signal` aborts. A sink
   * without it is polled.
   */
  below?(bytes: number, signal: AbortSignal): Promise<void>;
}

/** The part of a `ws` WebSocket `RelaySocketSink` uses. */
export interface RelayWebSocketLike {
  /** `1` is open. */
  readonly readyState: number;
  readonly bufferedAmount: number;
  /** `callback` runs once the frame is written to the socket, or failed. */
  send(data: Uint8Array, callback: (error?: Error) => void): void;
}

/** While a sender waits for the queue, it looks again this often even without a write finishing. */
const BELOW_BACKSTOP_MS = 50;

/**
 * The control link's socket as a `RelaySink`: a sender waiting for the queue to shrink wakes as
 * each frame is written out, not on a timer (a 2 ms poll is a 16 ms one on Windows).
 */
export class RelaySocketSink implements RelaySink {
  readonly #socket: RelayWebSocketLike;
  readonly #waiters = new Set<() => void>();
  readonly #written = () => {
    for (const wake of [...this.#waiters]) wake();
  };

  constructor(socket: RelayWebSocketLike) {
    this.#socket = socket;
  }

  get bufferedAmount(): number {
    return this.#socket.bufferedAmount;
  }

  send(frame: Uint8Array): boolean {
    if (this.#socket.readyState !== 1) return false;
    try {
      this.#socket.send(frame, this.#written);
    } catch {
      return false;
    }
    return true;
  }

  below(bytes: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.#socket.bufferedAmount <= bytes) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      // Text frames are written without a callback here, and a closed socket stops calling back:
      // the backstop looks anyway.
      const backstop = setInterval(() => check(), BELOW_BACKSTOP_MS);
      const done = () => {
        clearInterval(backstop);
        this.#waiters.delete(check);
        signal.removeEventListener("abort", onAbort);
      };
      const check = () => {
        if (this.#socket.bufferedAmount > bytes && this.#socket.readyState === 1) return;
        done();
        resolve();
      };
      const onAbort = () => {
        done();
        reject(signal.reason);
      };
      this.#waiters.add(check);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

export interface RelayInboundOptions {
  /** Sends credit for this many more bytes. */
  credit(bytes: number): void;
  /** The consumer cancelled the body before its end. */
  cancel(reason: unknown): void;
  /** Default `WINDOW_BYTES`. */
  window?: number;
}

/**
 * The receiving end of one body: chunks arrive with `push`, the consumer reads `readable`. A
 * chunk counts as taken when the consumer reads it; credit follows from that, so at most
 * `window` bytes ever wait here.
 */
export class RelayInbound {
  readonly readable: ReadableStream<Uint8Array>;
  readonly #o: RelayInboundOptions;
  readonly #window: RelayReceiveWindow;
  readonly #queue: Uint8Array[] = [];
  #state: "open" | "ended" | "failed" = "open";
  #controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  #expected: number | null = null;
  #wake: (() => void) | null = null;
  readonly #watchers = new Set<() => void>();

  constructor(options: RelayInboundOptions) {
    this.#o = options;
    this.#window = new RelayReceiveWindow(options.window);
    this.readable = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          this.#controller = controller;
        },
        pull: (controller) => this.#pull(controller),
        cancel: (reason) => {
          if (this.#state !== "open") {
            this.#state = "failed";
            return;
          }
          this.#state = "failed";
          this.#queue.length = 0;
          this.#notify();
          this.#o.cancel(reason);
        },
      },
      { highWaterMark: 0 },
    );
  }

  /** Bytes received and not yet read. */
  get buffered(): number {
    return this.#window.buffered;
  }

  /** Bytes received in all. */
  get received(): number {
    return this.#window.received;
  }

  /** The end arrived (the body may still be being read). */
  get ended(): boolean {
    return this.#state === "ended";
  }

  /** The body failed or the consumer cancelled it. */
  get failed(): boolean {
    return this.#state === "failed";
  }

  /**
   * One chunk arrived. False when it breaks the protocol: over the credit, or after the end.
   * Ignored (true) once the body failed: frames in flight still arrive.
   */
  push(data: Uint8Array): boolean {
    if (this.#state === "failed") return true;
    if (this.#state === "ended") return false;
    if (!this.#window.receive(data.byteLength)) return false;
    if (data.byteLength > 0) this.#queue.push(data);
    this.#notify();
    return true;
  }

  /**
   * The body's stated length (`content-length`): a body that ends at another length fails its
   * reader with `HostRelayLengthError` instead of closing, whatever the sender did.
   */
  expect(length: number): void {
    this.#expected = length;
  }

  /** The end arrived. False when it had already. */
  end(): boolean {
    if (this.#state === "failed") return true;
    if (this.#state === "ended") return false;
    this.#state = "ended";
    this.#notify();
    return true;
  }

  /** Fails the body: the consumer's next read rejects with `error`. */
  fail(error: unknown): void {
    if (this.#state === "failed") return;
    this.#state = "failed";
    this.#queue.length = 0;
    try {
      this.#controller?.error(error);
    } catch {
      // Already closed: the consumer read everything.
    }
    this.#notify();
  }

  /**
   * Resolves `true` once the end arrived, `false` once `bytes` are waiting; rejects once the
   * body failed.
   */
  settled(bytes: number): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      const check = () => {
        if (this.#state === "ended") resolve(true);
        else if (this.#state === "failed") reject(new Error("the body failed"));
        else if (this.buffered >= bytes) resolve(false);
        else return;
        this.#watchers.delete(check);
      };
      this.#watchers.add(check);
      check();
    });
  }

  #notify(): void {
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
    for (const watcher of [...this.#watchers]) watcher();
  }

  async #pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    for (;;) {
      if (this.#state === "failed") return;
      const chunk = this.#queue.shift();
      if (chunk !== undefined) {
        controller.enqueue(chunk);
        const credit = this.#window.consume(chunk.byteLength);
        if (credit > 0 && this.#state === "open") this.#o.credit(credit);
        return;
      }
      if (this.#state === "ended") {
        const expected = this.#expected;
        if (expected !== null && this.received !== expected) {
          this.fail(new HostRelayLengthError(this.received, expected));
          return;
        }
        controller.close();
        return;
      }
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }
}

export interface PumpRelayBodyOptions {
  /** The body to send. */
  source: ReadableStream<Uint8Array>;
  sink: RelaySink;
  stream: number;
  /** `REQUEST_CHUNK` (Core) or `RESPONSE_CHUNK` (hostd); the end frame is the one after it. */
  kind: ChunkKind;
  /** Credit from the other end feeds it. */
  window: RelaySendWindow;
  /** Stops the pump: it cancels the source and rejects with the reason. */
  signal: AbortSignal;
  /**
   * The body's length when its sender said it (`content-length`): a source that ends before it,
   * or runs past it, is a `HostRelayLengthError` and no end frame is sent.
   */
  length?: number;
}

/** A body that ended short of its stated length, or ran past it. */
export class HostRelayLengthError extends Error {
  override name = "HostRelayLengthError";
  readonly received: number;
  readonly expected: number;

  constructor(received: number, expected: number) {
    super(
      received < expected
        ? `the body ended after ${received} of its ${expected} bytes`
        : `the body ran past its ${expected} bytes`,
    );
    this.received = received;
    this.expected = expected;
  }
}

/** The `content-length` of a head, or `undefined` without a usable one. */
export function relayContentLength(headers: Record<string, string>): number | undefined {
  const value = headers["content-length"];
  if (value === undefined || !/^\d{1,15}$/u.test(value.trim())) return undefined;
  return Number(value.trim());
}

function socketDrained(sink: RelaySink, signal: AbortSignal): Promise<void> {
  if (sink.bufferedAmount <= HOST_RELAY_LIMITS.SOCKET_HIGH_WATER_BYTES) return Promise.resolve();
  if (sink.below !== undefined)
    return sink.below(HOST_RELAY_LIMITS.SOCKET_HIGH_WATER_BYTES, signal);
  return new Promise<void>((resolve, reject) => {
    const poll = () => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      if (sink.bufferedAmount <= HOST_RELAY_LIMITS.SOCKET_HIGH_WATER_BYTES) resolve();
      else setTimeout(poll, 2);
    };
    setTimeout(poll, 2);
  });
}

/** The socket went away under a pump. */
export class HostRelayClosedError extends Error {
  override name = "HostRelayClosedError";
}

/**
 * Sends `source` as chunk frames and an end frame, never more than the credit allows and only
 * while the socket's queue is short. Resolves with the bytes sent after the end frame; rejects
 * with the source's error, the signal's reason, `HostRelayLengthError` or `HostRelayClosedError`.
 * The caller sends the abort frame.
 */
export async function pumpRelayBody(options: PumpRelayBodyOptions): Promise<number> {
  const { sink, stream, kind, window, signal, length } = options;
  const end = (kind + 1) as EndKind;
  const reader = options.source.getReader();
  const onAbort = () => {
    reader.cancel(signal.reason).catch(() => {});
  };
  signal.throwIfAborted();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new TypeError("a body chunk is not bytes");
      if (length !== undefined && window.sent + value.byteLength > length) {
        throw new HostRelayLengthError(window.sent + value.byteLength, length);
      }
      let offset = 0;
      while (offset < value.byteLength) {
        await window.ready(signal);
        await socketDrained(sink, signal);
        const n = Math.min(
          HOST_RELAY_LIMITS.CHUNK_BYTES,
          window.available,
          value.byteLength - offset,
        );
        window.take(n);
        const data = value.subarray(offset, offset + n);
        if (!sink.send(encodeRelayFrame({ kind, stream, data }))) {
          throw new HostRelayClosedError("the control link closed");
        }
        offset += n;
      }
    }
    // A short body never ends normally: the receiver would take it for the whole.
    if (length !== undefined && window.sent !== length) {
      throw new HostRelayLengthError(window.sent, length);
    }
    if (!sink.send(encodeRelayFrame({ kind: end, stream }))) {
      throw new HostRelayClosedError("the control link closed");
    }
    return window.sent;
  } catch (error) {
    reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}
