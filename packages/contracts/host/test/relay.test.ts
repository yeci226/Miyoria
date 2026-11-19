// The relay's wire and the machinery both ends share: the frame codec, the credit accounting, the
// receiving end of a body and the pump that sends one.

import { describe, expect, it, vi } from "vitest";
import {
  decodeRelayFrame,
  encodeRelayFrame,
  HOST_RELAY_DROPPED_REQUEST_HEADERS,
  HOST_RELAY_FRAME,
  HOST_RELAY_LIMITS,
  HostRelayClosedError,
  HostRelayFrameError,
  HostRelayLengthError,
  HostRelayRequestSchema,
  HostRelayResponseSchema,
  pumpRelayBody,
  RelayInbound,
  RelayReceiveWindow,
  RelaySendWindow,
  RelaySocketSink,
  relayHeaders,
} from "../src/index.js";

const F = HOST_RELAY_FRAME;
const L = HOST_RELAY_LIMITS;

function bytesOf(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

describe("relay frames", () => {
  it("lays a frame out as kind, stream id (u32 LE), payload", () => {
    const data = bytesOf(9, 8, 7);
    const frame = encodeRelayFrame({ kind: F.RESPONSE_CHUNK, stream: 0x01020304, data });
    expect([...frame]).toEqual([0x03, 0x04, 0x03, 0x02, 0x01, 9, 8, 7]);
    expect([...encodeRelayFrame({ kind: F.REQUEST_END, stream: 1 })]).toEqual([2, 1, 0, 0, 0]);
    expect([...encodeRelayFrame({ kind: F.CREDIT, stream: 2, bytes: 0x10000 })]).toEqual([
      6, 2, 0, 0, 0, 0, 0, 1, 0,
    ]);
  });

  it("round-trips every kind", () => {
    const frames = [
      { kind: F.REQUEST_CHUNK, stream: 1, data: bytesOf(1, 2) },
      { kind: F.REQUEST_END, stream: 2 },
      { kind: F.RESPONSE_CHUNK, stream: L.STREAM_ID_MAX, data: new Uint8Array(L.CHUNK_BYTES) },
      { kind: F.RESPONSE_END, stream: 3 },
      { kind: F.ABORT, stream: 4, reason: "取消 cancelled" },
      { kind: F.CREDIT, stream: 5, bytes: L.WINDOW_BYTES },
    ] as const;
    for (const f of frames) expect(decodeRelayFrame(encodeRelayFrame(f))).toEqual(f);
  });

  it("decodes a chunk as a view, not a copy", () => {
    const frame = encodeRelayFrame({ kind: F.RESPONSE_CHUNK, stream: 1, data: bytesOf(5) });
    const decoded = decodeRelayFrame(frame);
    if (decoded.kind !== F.RESPONSE_CHUNK) throw new Error("wrong kind");
    expect(decoded.data.buffer).toBe(frame.buffer);
  });

  it("cuts a long abort reason at a character boundary", () => {
    const frame = encodeRelayFrame({ kind: F.ABORT, stream: 1, reason: "語".repeat(200) });
    expect(frame.byteLength - L.HEADER_BYTES).toBeLessThanOrEqual(L.ABORT_REASON_BYTES);
    const decoded = decodeRelayFrame(frame);
    if (decoded.kind !== F.ABORT) throw new Error("wrong kind");
    expect(decoded.reason).toBe("語".repeat(85));
  });

  it("refuses to encode what the wire cannot carry", () => {
    const data = new Uint8Array(L.CHUNK_BYTES + 1);
    expect(() => encodeRelayFrame({ kind: F.REQUEST_CHUNK, stream: 1, data })).toThrow(RangeError);
    expect(() => encodeRelayFrame({ kind: F.REQUEST_END, stream: 0 })).toThrow(RangeError);
    expect(() => encodeRelayFrame({ kind: F.CREDIT, stream: 1, bytes: 0 })).toThrow(RangeError);
  });

  it("rejects malformed frames", () => {
    const bad = [
      bytesOf(1, 1, 0, 0), // shorter than the header
      bytesOf(9, 1, 0, 0, 0), // unknown kind
      bytesOf(0, 1, 0, 0, 0),
      bytesOf(1, 0, 0, 0, 0), // stream 0
      bytesOf(2, 1, 0, 0, 0, 7), // end with a payload
      bytesOf(4, 1, 0, 0, 0, 7),
      bytesOf(6, 1, 0, 0, 0, 1, 0), // credit of a wrong size
      bytesOf(6, 1, 0, 0, 0, 0, 0, 0, 0), // credit of 0
      new Uint8Array(L.HEADER_BYTES + L.CHUNK_BYTES + 1).fill(1, 0, 2), // chunk over the limit
      new Uint8Array(L.HEADER_BYTES + L.ABORT_REASON_BYTES + 1).fill(5, 0, 1).fill(1, 1, 2),
    ];
    for (const frame of bad) expect(() => decodeRelayFrame(frame)).toThrow(HostRelayFrameError);
  });
});

describe("relay.request shapes", () => {
  it("parses a request with its defaults and refuses a path that is not one", () => {
    expect(
      HostRelayRequestSchema.parse({ stream: 1, service: "sing", method: "GET", path: "/x?y=1" }),
    ).toEqual({
      stream: 1,
      service: "sing",
      method: "GET",
      path: "/x?y=1",
      headers: {},
      body: false,
    });
    for (const path of ["x", "", "/a b", "http://evil/"]) {
      expect(
        HostRelayRequestSchema.safeParse({ stream: 1, service: "s", method: "GET", path }).success,
      ).toBe(false);
    }
    expect(HostRelayResponseSchema.safeParse({ status: 101 }).success).toBe(false);
  });

  it("drops hop-by-hop headers and the ones the host sets", () => {
    const headers = new Headers({
      "Content-Type": "application/json",
      Authorization: "Bearer caller",
      Connection: "keep-alive",
      "X-Trace": "1",
    });
    expect(relayHeaders(headers, HOST_RELAY_DROPPED_REQUEST_HEADERS)).toEqual({
      "content-type": "application/json",
      "x-trace": "1",
    });
  });
});

describe("credit accounting", () => {
  it("lets a sender have at most the window in flight", () => {
    const rx = new RelayReceiveWindow(100, 25);
    expect(rx.receive(100)).toBe(true);
    expect(rx.receive(1)).toBe(false);
    expect(rx.consume(20)).toBe(0);
    expect(rx.consume(10)).toBe(30);
    expect(rx.receive(30)).toBe(true);
    expect(rx.receive(1)).toBe(false);
    expect(rx.buffered).toBe(100);
  });

  it("makes a sender wait for credit", async () => {
    const tx = new RelaySendWindow(10);
    tx.take(10);
    expect(() => tx.take(1)).toThrow(RangeError);
    let ready = false;
    const waiting = tx.ready().then(() => {
      ready = true;
    });
    await Promise.resolve();
    expect(ready).toBe(false);
    tx.grant(4);
    await waiting;
    expect(tx.available).toBe(4);
    expect(tx.sent).toBe(10);
    const stop = new AbortController();
    tx.take(4);
    const aborted = tx.ready(stop.signal);
    stop.abort(new Error("stop"));
    await expect(aborted).rejects.toThrow("stop");
  });
});

describe("RelayInbound", () => {
  it("hands chunks over in order and sends credit as they are read", async () => {
    const credits: number[] = [];
    const inbound = new RelayInbound({
      window: 8,
      credit: (n) => credits.push(n),
      cancel: () => {},
    });
    expect(inbound.push(bytesOf(1, 2, 3, 4))).toBe(true);
    expect(inbound.push(bytesOf(5, 6, 7, 8))).toBe(true);
    expect(inbound.push(bytesOf(9))).toBe(false); // over the window
    expect(credits).toEqual([]);
    const reader = inbound.readable.getReader();
    expect([...((await reader.read()).value ?? [])]).toEqual([1, 2, 3, 4]);
    // The credit step is min(256 KiB, window): 8 bytes here.
    expect(credits).toEqual([]);
    expect(inbound.buffered).toBe(4);
    expect([...((await reader.read()).value ?? [])]).toEqual([5, 6, 7, 8]);
    expect(credits).toEqual([8]);
    expect(inbound.push(bytesOf(9, 9, 9, 9))).toBe(true);
    expect(inbound.push(bytesOf(9, 9, 9, 9))).toBe(true);
    expect(inbound.end()).toBe(true);
    expect(inbound.push(bytesOf(1))).toBe(false); // after the end
    expect([...((await reader.read()).value ?? [])]).toEqual([9, 9, 9, 9]);
    expect([...((await reader.read()).value ?? [])]).toEqual([9, 9, 9, 9]);
    expect((await reader.read()).done).toBe(true);
    // No credit once the end is in.
    expect(credits).toEqual([8]);
  });

  it("fails the reader with the error, and ignores what arrives after", async () => {
    const inbound = new RelayInbound({ credit: () => {}, cancel: () => {} });
    const reader = inbound.readable.getReader();
    const read = reader.read();
    inbound.fail(new Error("host gone"));
    await expect(read).rejects.toThrow("host gone");
    expect(inbound.push(bytesOf(1))).toBe(true);
  });

  it("tells the owner when the consumer cancels", async () => {
    const reasons: unknown[] = [];
    const inbound = new RelayInbound({ credit: () => {}, cancel: (r) => reasons.push(r) });
    inbound.push(bytesOf(1));
    await inbound.readable.cancel("enough");
    expect(reasons).toEqual(["enough"]);
    expect(inbound.failed).toBe(true);
  });

  it("fails a body that ends at another length than it said, instead of ending it", async () => {
    const read = async (length: number, chunks: Uint8Array[]) => {
      const inbound = new RelayInbound({ credit: () => {}, cancel: () => {} });
      for (const c of chunks) inbound.push(c);
      inbound.end();
      inbound.expect(length);
      const reader = inbound.readable.getReader();
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return got;
        got += value.byteLength;
      }
    };
    expect(await read(3, [bytesOf(1, 2), bytesOf(3)])).toBe(3);
    await expect(read(4, [bytesOf(1, 2), bytesOf(3)])).rejects.toThrow(
      "the body ended after 3 of its 4 bytes",
    );
    await expect(read(2, [bytesOf(1, 2), bytesOf(3)])).rejects.toBeInstanceOf(HostRelayLengthError);
  });

  it("settles on the end or on enough buffered bytes", async () => {
    const a = new RelayInbound({ credit: () => {}, cancel: () => {} });
    const ended = a.settled(10);
    a.push(bytesOf(1, 2));
    a.end();
    expect(await ended).toBe(true);
    const b = new RelayInbound({ credit: () => {}, cancel: () => {} });
    const full = b.settled(2);
    b.push(bytesOf(1, 2));
    expect(await full).toBe(false);
  });
});

describe("pumpRelayBody", () => {
  function sink() {
    const frames: Uint8Array[] = [];
    return {
      frames,
      bufferedAmount: 0,
      send(frame: Uint8Array) {
        frames.push(frame);
        return true;
      },
    };
  }

  it("splits into chunks, stops at the window and goes on with credit", async () => {
    const out = sink();
    const window = new RelaySendWindow(L.CHUNK_BYTES * 2);
    const body = new Uint8Array(L.CHUNK_BYTES * 3 + 10).map((_, i) => i % 251);
    const stop = new AbortController();
    const done = pumpRelayBody({
      source: new Blob([body]).stream(),
      sink: out,
      stream: 7,
      kind: F.RESPONSE_CHUNK,
      window,
      signal: stop.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(out.frames.length).toBe(2);
    expect(window.available).toBe(0);
    window.grant(L.CHUNK_BYTES * 2);
    await done;
    const decoded = out.frames.map((f) => decodeRelayFrame(f));
    expect(decoded.map((f) => f.kind)).toEqual([3, 3, 3, 3, 4]);
    const joined = Buffer.concat(
      decoded.flatMap((f) => (f.kind === F.RESPONSE_CHUNK ? [f.data] : [])),
    );
    expect(joined.equals(Buffer.from(body))).toBe(true);
  });

  it("stops and cancels the source when aborted", async () => {
    const out = sink();
    let cancelled: unknown = null;
    const source = new ReadableStream<Uint8Array>({
      pull: () => new Promise(() => {}),
      cancel: (reason) => {
        cancelled = reason;
      },
    });
    const stop = new AbortController();
    const done = pumpRelayBody({
      source,
      sink: out,
      stream: 1,
      kind: F.REQUEST_CHUNK,
      window: new RelaySendWindow(),
      signal: stop.signal,
    });
    stop.abort(new Error("caller gave up"));
    await expect(done).rejects.toThrow("caller gave up");
    expect(cancelled).toBeInstanceOf(Error);
    expect(out.frames).toEqual([]);
  });

  it("waits while the socket's queue is long", async () => {
    const out = sink();
    out.bufferedAmount = L.SOCKET_HIGH_WATER_BYTES + 1;
    const done = pumpRelayBody({
      source: new Blob([bytesOf(1)]).stream(),
      sink: out,
      stream: 1,
      kind: F.REQUEST_CHUNK,
      window: new RelaySendWindow(),
      signal: new AbortController().signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(out.frames).toEqual([]);
    out.bufferedAmount = 0;
    await done;
    expect(out.frames.length).toBe(2);
  });

  it("returns the bytes sent, and never ends a body short of or past its length", async () => {
    const body = new Uint8Array(L.CHUNK_BYTES + 5).fill(3);
    const pump = (length: number) => {
      const out = sink();
      const done = pumpRelayBody({
        source: new Blob([body]).stream(),
        sink: out,
        stream: 1,
        kind: F.RESPONSE_CHUNK,
        window: new RelaySendWindow(),
        signal: new AbortController().signal,
        length,
      });
      return { out, done };
    };
    const whole = pump(body.byteLength);
    expect(await whole.done).toBe(body.byteLength);
    expect(whole.out.frames.map((f) => decodeRelayFrame(f).kind)).toEqual([3, 3, 4]);

    const short = pump(body.byteLength + 1);
    const error = await short.done.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HostRelayLengthError);
    expect((error as HostRelayLengthError).received).toBe(body.byteLength);
    // Every byte went out, the end frame did not: the caller aborts the stream.
    expect(short.out.frames.map((f) => decodeRelayFrame(f).kind)).toEqual([3, 3]);

    const long = pump(body.byteLength - 1);
    await expect(long.done).rejects.toBeInstanceOf(HostRelayLengthError);
    expect(long.out.frames.every((f) => decodeRelayFrame(f).kind === F.RESPONSE_CHUNK)).toBe(true);
  });
});

/**
 * A socket as `ws` is to `RelaySocketSink`: a sent frame stays queued (counted in
 * `bufferedAmount`) until the test writes it out, which runs its callback.
 */
class FakeSocket {
  readyState = 1;
  readonly queue: { frame: Uint8Array; done: (error?: Error) => void }[] = [];
  readonly written: Uint8Array[] = [];

  get bufferedAmount(): number {
    return this.queue.reduce((n, q) => n + q.frame.byteLength, 0);
  }

  send(frame: Uint8Array, done: (error?: Error) => void): void {
    this.queue.push({ frame, done });
  }

  /** Writes queued frames out until at most `left` bytes are queued. */
  writeOut(left = 0): void {
    while (this.queue.length > 0 && this.bufferedAmount > left) {
      const q = this.queue.shift() as (typeof this.queue)[number];
      this.written.push(q.frame);
      q.done();
    }
  }
}

describe("RelaySocketSink", () => {
  async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }

  it("wakes a waiting pump as frames are written out, with no timer", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      const sink = new RelaySocketSink(socket);
      const body = new Uint8Array(L.SOCKET_HIGH_WATER_BYTES * 4).map((_, i) => i % 253);
      let finished = false;
      const done = pumpRelayBody({
        source: new Blob([body]).stream(),
        sink,
        stream: 5,
        kind: F.RESPONSE_CHUNK,
        window: new RelaySendWindow(body.byteLength),
        signal: new AbortController().signal,
      }).then((n) => {
        finished = true;
        return n;
      });
      // Time never moves: the pump goes on only because writes finish.
      for (let i = 0; i < 1000 && !finished; i++) {
        await settle();
        expect(socket.bufferedAmount).toBeLessThanOrEqual(
          L.SOCKET_HIGH_WATER_BYTES + L.CHUNK_BYTES + L.HEADER_BYTES,
        );
        socket.writeOut(L.SOCKET_HIGH_WATER_BYTES / 2);
      }
      expect(await done).toBe(body.byteLength);
      socket.writeOut();
      const frames = socket.written.map((f) => decodeRelayFrame(f));
      expect(frames.at(-1)?.kind).toBe(F.RESPONSE_END);
      const joined = Buffer.concat(
        frames.flatMap((f) => (f.kind === F.RESPONSE_CHUNK ? [f.data] : [])),
      );
      expect(joined.equals(Buffer.from(body))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a control frame overtake every body byte not yet queued", async () => {
    const socket = new FakeSocket();
    const sink = new RelaySocketSink(socket);
    const body = new Uint8Array(4 * 1024 * 1024);
    const stop = new AbortController();
    const done = pumpRelayBody({
      source: new Blob([body]).stream(),
      sink,
      stream: 9,
      kind: F.RESPONSE_CHUNK,
      window: new RelaySendWindow(body.byteLength),
      signal: stop.signal,
    });
    await settle();
    await settle();
    // The pump stopped at the high water: a megabyte body is not ahead of what comes next.
    const ahead = socket.bufferedAmount;
    expect(ahead).toBeGreaterThan(0);
    expect(ahead).toBeLessThanOrEqual(L.SOCKET_HIGH_WATER_BYTES + L.CHUNK_BYTES + L.HEADER_BYTES);
    expect(sink.send(encodeRelayFrame({ kind: F.CREDIT, stream: 9, bytes: 1 }))).toBe(true);
    const kinds = socket.queue.map((q) => decodeRelayFrame(q.frame).kind);
    expect(kinds.at(-1)).toBe(F.CREDIT);
    expect(kinds.filter((k) => k === F.RESPONSE_CHUNK).length).toBeLessThanOrEqual(
      Math.ceil(L.SOCKET_HIGH_WATER_BYTES / L.CHUNK_BYTES) + 1,
    );
    stop.abort(new Error("enough"));
    socket.writeOut();
    await expect(done).rejects.toThrow("enough");
  });

  it("refuses frames once the socket is not open, and a waiting pump then stops", async () => {
    const socket = new FakeSocket();
    const sink = new RelaySocketSink(socket);
    const done = pumpRelayBody({
      source: new Blob([new Uint8Array(L.SOCKET_HIGH_WATER_BYTES * 2)]).stream(),
      sink,
      stream: 2,
      kind: F.RESPONSE_CHUNK,
      window: new RelaySendWindow(),
      signal: new AbortController().signal,
    });
    await settle();
    socket.readyState = 3;
    // The backstop looks again without a write finishing.
    await expect(done).rejects.toBeInstanceOf(HostRelayClosedError);
    expect(sink.send(bytesOf(1, 1, 0, 0, 0))).toBe(false);
  });
});
