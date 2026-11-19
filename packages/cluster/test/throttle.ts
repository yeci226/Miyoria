// A TCP proxy that behaves like a slow home uplink: what the client (hostd) sends is paced at a
// fixed rate and arrives one latency later; what the server (Core) sends only takes the latency.
// The bottleneck holds at most `queueBytes` (a modem's buffer plus the bytes on the wire): past
// that the proxy stops reading the client, so its kernel buffers fill as a real sender's do.
//
// The pacing is computed, not measured: each chunk leaves the bottleneck at
// `max(now, free) + bytes / rate`, so the long-run rate is exact however late timers fire.

import { createServer, connect as netConnect, type Server, type Socket } from "node:net";

export interface ThrottleOptions {
  /** Client → server rate, bytes per second. */
  upBytesPerSec: number;
  /** One-way latency each way, in ms. */
  latencyMs: number;
  /** Bytes the bottleneck holds before the client is no longer read. Default 256 KiB. */
  queueBytes?: number;
  /** The proxy's own port. Default an ephemeral one. */
  listenPort?: number;
}

interface Pending {
  at: number;
  chunk: Buffer;
}

/** One direction: chunks delivered in order at their time. */
class Lane {
  readonly #dst: Socket;
  readonly #src: Socket;
  readonly #rate: number | null;
  readonly #latency: number;
  readonly #limit: number;
  readonly #queue: Pending[] = [];
  #free = 0;
  #held = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #paused = false;
  /** Bytes delivered. */
  delivered = 0;

  constructor(src: Socket, dst: Socket, rate: number | null, latency: number, limit: number) {
    this.#src = src;
    this.#dst = dst;
    this.#rate = rate;
    this.#latency = latency;
    this.#limit = limit;
    src.on("data", (chunk: Buffer) => this.#take(chunk));
  }

  #take(chunk: Buffer): void {
    const now = performance.now();
    const start = Math.max(now, this.#free);
    this.#free = start + (this.#rate === null ? 0 : (chunk.byteLength / this.#rate) * 1000);
    this.#queue.push({ at: this.#free + this.#latency, chunk });
    this.#held += chunk.byteLength;
    if (this.#held > this.#limit && !this.#paused) {
      this.#paused = true;
      this.#src.pause();
    }
    this.#arm();
  }

  #arm(): void {
    if (this.#timer !== null) return;
    const head = this.#queue[0];
    if (head === undefined) return;
    this.#timer = setTimeout(() => this.#flush(), Math.max(0, head.at - performance.now()));
  }

  #flush(): void {
    this.#timer = null;
    const now = performance.now();
    while (this.#queue.length > 0 && (this.#queue[0] as Pending).at <= now) {
      const { chunk } = this.#queue.shift() as Pending;
      this.#held -= chunk.byteLength;
      this.delivered += chunk.byteLength;
      if (!this.#dst.destroyed) this.#dst.write(chunk);
    }
    if (this.#paused && this.#held <= this.#limit / 2) {
      this.#paused = false;
      this.#src.resume();
    }
    this.#arm();
  }

  stop(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#queue.length = 0;
  }
}

/** A throttled path to `127.0.0.1:<target>`; `port` is where clients dial. */
export class Throttle {
  readonly #server: Server;
  readonly #sockets = new Set<Socket>();
  readonly #lanes: Lane[] = [];

  private constructor(server: Server) {
    this.#server = server;
  }

  static async start(targetPort: number, options: ThrottleOptions): Promise<Throttle> {
    const queue = options.queueBytes ?? 256 * 1024;
    let self: Throttle | null = null;
    const server = createServer({ noDelay: true }, (client) => {
      const upstream = netConnect({ host: "127.0.0.1", port: targetPort, noDelay: true });
      const t = self as Throttle;
      t.#sockets.add(client);
      t.#sockets.add(upstream);
      t.#lanes.push(
        new Lane(client, upstream, options.upBytesPerSec, options.latencyMs, queue),
        new Lane(upstream, client, null, options.latencyMs, 64 * 1024 * 1024),
      );
      const close = () => {
        client.destroy();
        upstream.destroy();
      };
      client.on("close", close);
      upstream.on("close", close);
      client.on("error", close);
      upstream.on("error", close);
    });
    self = new Throttle(server);
    await new Promise<void>((resolve) =>
      server.listen(options.listenPort ?? 0, "127.0.0.1", resolve),
    );
    return self;
  }

  get port(): number {
    const addr = this.#server.address();
    if (addr === null || typeof addr === "string") throw new Error("not listening");
    return addr.port;
  }

  /** Bytes delivered client → server so far. */
  get upDelivered(): number {
    let n = 0;
    for (let i = 0; i < this.#lanes.length; i += 2) n += (this.#lanes[i] as Lane).delivered;
    return n;
  }

  async stop(): Promise<void> {
    for (const lane of this.#lanes) lane.stop();
    for (const s of this.#sockets) s.destroy();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }
}
