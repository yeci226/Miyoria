// File transfers from the song worker (2026-11-19): bounded by progress, not by a total. A real
// HTTP server on an ephemeral port sends a song's audio at a pace the test sets; the client must
// finish a slow transfer that keeps moving, give up one that stops, resume a broken one from its
// part, and start over when the file changed or the range is refused. No assertion on how fast
// anything runs: the gaps the server leaves are far inside the stall time, or never end.

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpSingWorker, SingWorkerError } from "../src/index.js";
import { FakeEndpoints } from "./endpoints.js";

const SIZE = 200_000;
const BODY = Buffer.alloc(SIZE);
for (let i = 0; i < SIZE; i++) BODY[i] = (i * 7) & 0xff;

interface Plan {
  /** Bytes per write. */
  chunk: number;
  /** ms between writes. */
  gapMs: number;
  /** Stop sending after this many bytes of the body (the connection stays open). */
  stallAt: number | null;
  /** Close the connection after this many bytes (a cut link). */
  cutAt: number | null;
  etag: string;
  /** Answer ranges at all. */
  ranges: boolean;
  /** Answer 416 to a range. */
  refuse: boolean;
}

class Worker {
  plan: Plan = defaultPlan();
  readonly seen: { range: string | null; ifRange: string | null }[] = [];
  readonly #server: Server;
  readonly #open = new Set<ServerResponse>();
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();

  private constructor(server: Server) {
    this.#server = server;
  }

  static async start(): Promise<Worker> {
    let w: Worker | null = null;
    const server = createServer((req, res) => w?.handle(req, res));
    w = new Worker(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return w;
  }

  get url(): string {
    return `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  handle(req: IncomingMessage, res: ServerResponse): void {
    const p = this.plan;
    const range = req.headers.range ?? null;
    const ifRange = (req.headers["if-range"] as string | undefined) ?? null;
    this.seen.push({ range, ifRange });
    let from = 0;
    if (p.ranges && range !== null && (ifRange === null || ifRange === p.etag)) {
      if (p.refuse) {
        res.writeHead(416, { "content-range": `bytes */${SIZE}` }).end();
        return;
      }
      from = Number(/^bytes=(\d+)-$/.exec(range)?.[1] ?? 0);
      res.writeHead(206, {
        "content-type": "audio/L16",
        "content-length": String(SIZE - from),
        "content-range": `bytes ${from}-${SIZE - 1}/${SIZE}`,
        etag: p.etag,
      });
    } else {
      res.writeHead(200, {
        "content-type": "audio/L16",
        "content-length": String(SIZE),
        etag: p.etag,
      });
    }
    this.#open.add(res);
    res.on("close", () => this.#open.delete(res));
    let at = from;
    let sent = 0;
    const step = () => {
      if (res.destroyed) return;
      if (p.cutAt !== null && sent >= p.cutAt) {
        res.socket?.destroy();
        return;
      }
      if (p.stallAt !== null && sent >= p.stallAt) return; // silence, connection open
      if (at >= SIZE) {
        res.end();
        return;
      }
      let n = Math.min(p.chunk, SIZE - at);
      if (p.stallAt !== null) n = Math.min(n, p.stallAt - sent);
      if (p.cutAt !== null) n = Math.min(n, p.cutAt - sent);
      res.write(BODY.subarray(at, at + n));
      at += n;
      sent += n;
      const t = setTimeout(step, p.gapMs);
      this.#timers.add(t);
    };
    step();
  }

  async stop(): Promise<void> {
    for (const t of this.#timers) clearTimeout(t);
    for (const res of this.#open) res.destroy();
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }
}

function defaultPlan(): Plan {
  return {
    chunk: 16_384,
    gapMs: 0,
    stallAt: null,
    cutAt: null,
    etag: '"e1"',
    ranges: true,
    refuse: false,
  };
}

let worker: Worker;
let dir: string;

beforeEach(async () => {
  worker = await Worker.start();
  dir = await mkdtemp(join(tmpdir(), "sing-transfer-"));
});

afterEach(async () => {
  await worker.stop();
  await rm(dir, { recursive: true, force: true });
});

/** A client of `worker` with a 100 ms request timeout and the given stall time. */
function client(stallMs: number): HttpSingWorker {
  const endpoints = new FakeEndpoints([{ name: "sing", url: worker.url }]);
  const endpoint = endpoints.pick("sing");
  if (endpoint === null) throw new Error("no endpoint");
  return new HttpSingWorker(endpoint, 100, endpoints, { stallMs });
}

const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (error) {
    return error;
  }
  throw new Error("it did not fail");
}

describe("song worker file transfers", () => {
  it("finishes a slow file that keeps coming, long past what a total would allow", async () => {
    // 25 writes 40 ms apart: about a second, ten times the request timeout, never a gap near
    // the stall time.
    worker.plan = { ...defaultPlan(), chunk: 8_192, gapMs: 40 };
    const dest = join(dir, "s1", "play_mix.pcm");
    await client(2_000).download("s1", "play_mix.pcm", dest);
    expect(hash(await readFile(dest))).toBe(hash(BODY));
    // Nothing left behind.
    await expect(stat(`${dest}.part`)).rejects.toThrow();
    await expect(stat(`${dest}.part.tag`)).rejects.toThrow();
  });

  it("reads the audio into memory as samples", async () => {
    const pcm = await client(2_000).audio("s1", "play_mix.pcm");
    expect(pcm.length).toBe(SIZE / 2);
    expect(pcm[1]).toBe(BODY.readInt16LE(2));
    expect(pcm[SIZE / 2 - 1]).toBe(BODY.readInt16LE(SIZE - 2));
  });

  it("gives up a file that stopped arriving, and says how far it got", async () => {
    worker.plan = { ...defaultPlan(), stallAt: 65_536 };
    const error = await rejection(
      client(300).download("s1", "play_mix.pcm", join(dir, "s1", "play_mix.pcm")),
    );
    expect(error).toBeInstanceOf(SingWorkerError);
    const e = error as SingWorkerError;
    expect(e.unreachable).toBe(true);
    expect(e.message).toMatch(/s1\/play_mix\.pcm stopped arriving/);
    expect(e.message).toContain("65536 bytes");
  });

  it("gives up the memory read of a stalled file too", async () => {
    worker.plan = { ...defaultPlan(), stallAt: 32_768 };
    const error = await rejection(client(300).audio("s1", "play_mix.pcm"));
    expect((error as SingWorkerError).message).toMatch(/stopped arriving/);
  });

  it("resumes a broken transfer from its part, with the file's validator", async () => {
    const dest = join(dir, "s1", "play_mix.pcm");
    worker.plan = { ...defaultPlan(), cutAt: 81_920 };
    await rejection(client(2_000).download("s1", "play_mix.pcm", dest));
    expect((await stat(`${dest}.part`)).size).toBe(81_920);
    expect(await readFile(`${dest}.part.tag`, "utf8")).toBe('"e1"');
    worker.plan = defaultPlan();
    await client(2_000).download("s1", "play_mix.pcm", dest);
    expect(worker.seen.at(-1)).toEqual({ range: "bytes=81920-", ifRange: '"e1"' });
    expect(hash(await readFile(dest))).toBe(hash(BODY));
  });

  it("starts over when the file changed since the part, or the range is refused", async () => {
    const dest = join(dir, "s1", "play_mix.pcm");
    // A part of another version of the file: the worker answers it whole.
    await mkdir(join(dir, "s1"), { recursive: true });
    await writeFile(`${dest}.part`, Buffer.alloc(50_000, 1));
    await writeFile(`${dest}.part.tag`, '"old"');
    await client(2_000).download("s1", "play_mix.pcm", dest);
    expect(worker.seen.at(-1)).toEqual({ range: "bytes=50000-", ifRange: '"old"' });
    expect(hash(await readFile(dest))).toBe(hash(BODY));

    // A range the worker refuses: once more from the start.
    await writeFile(`${dest}.part`, BODY.subarray(0, 10_000));
    await writeFile(`${dest}.part.tag`, '"e1"');
    worker.plan = { ...defaultPlan(), refuse: true };
    await client(2_000).download("s1", "play_mix.pcm", dest);
    expect(worker.seen.slice(-2)).toEqual([
      { range: "bytes=10000-", ifRange: '"e1"' },
      { range: null, ifRange: null },
    ]);
    expect(hash(await readFile(dest))).toBe(hash(BODY));
  });

  it("does not resume a part it has no validator for", async () => {
    const dest = join(dir, "s1", "play_mix.pcm");
    await mkdir(join(dir, "s1"), { recursive: true });
    await writeFile(`${dest}.part`, Buffer.alloc(10_000, 9));
    await client(2_000).download("s1", "play_mix.pcm", dest);
    expect(worker.seen.at(-1)).toEqual({ range: null, ifRange: null });
    expect(hash(await readFile(dest))).toBe(hash(BODY));
  });

  it("karaoke files are bounded by progress the same way", async () => {
    worker.plan = { ...defaultPlan(), stallAt: 16_384 };
    const error = await rejection(
      client(300).karaokeFile("k1", "karaoke.m4a", join(dir, "k1", "karaoke.m4a")),
    );
    expect((error as SingWorkerError).message).toMatch(/karaoke k1\/karaoke\.m4a stopped arriving/);
    worker.plan = { ...defaultPlan(), chunk: 8_192, gapMs: 40 };
    const dest = join(dir, "k1", "karaoke.m4a");
    await client(2_000).karaokeFile("k1", "karaoke.m4a", dest);
    expect(hash(await readFile(dest))).toBe(hash(BODY));
  });
});
