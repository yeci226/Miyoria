// Several song workers in order (`url`, then `fallback_urls`): new songs go to the first that
// answers, a song stays with the worker that made it, and a song whose worker stays unreachable
// is reported gone (404) so the singer makes it again on the next one.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Supervisor } from "@miyoria/kernel";
import { describe, expect, it } from "vitest";
import {
  type GpuContext,
  HttpSingWorker,
  type SingWorker,
  SingWorkerError,
  type SongMeta,
  type SongQuery,
  type WorkerJob,
} from "../src/client.js";
import { SingConfigSchema } from "../src/config.js";
import { FailoverSingWorker } from "../src/failover.js";
import { SingModule, workerUrls } from "../src/module.js";

const RETRY = 30_000;

function meta(id: string): SongMeta {
  return {
    id,
    title: id,
    artist: null,
    duration_s: 1,
    lyrics: null,
    play: { sample_rate: 48_000, samples: 48_000 },
    pitch: {},
    timings: {},
    peak_vram_mb: null,
    has_video: false,
    video: null,
  };
}

/**
 * A worker that can be switched off (every call then fails as unreachable), or made slow (a
 * submit takes the job but times out before answering).
 */
class FakeWorker implements SingWorker {
  up = true;
  slow = false;
  readonly calls: string[] = [];
  readonly jobs = new Map<string, WorkerJob>();
  readonly cached = new Set<string>();
  told: GpuContext | null = null;
  #next = 1;

  constructor(readonly name: string) {}

  #call(what: string): void {
    this.calls.push(what);
    if (!this.up) {
      throw new SingWorkerError(`song worker unreachable at ${this.name}`, { unreachable: true });
    }
  }

  async submit(query: SongQuery): Promise<WorkerJob> {
    this.#call("submit");
    if (query.url?.includes("bad")) {
      throw new SingWorkerError("that link is not on an allowed host", { status: 400 });
    }
    const id = `${this.name}-j${this.#next++}`;
    if (this.slow) {
      this.jobs.set(id, { ...queued(id) });
      throw new SingWorkerError(`song worker unreachable at ${this.name}: timeout`, {
        unreachable: true,
        maybeReceived: true,
      });
    }
    const job = queued(id);
    this.jobs.set(id, job);
    return structuredClone(job);
  }

  async job(id: string): Promise<WorkerJob> {
    this.#call(`job ${id}`);
    const job = this.jobs.get(id);
    if (!job) throw new SingWorkerError(`no job ${id}`, { status: 404 });
    return structuredClone(job);
  }

  finish(id: string, song: string): void {
    Object.assign(this.jobs.get(id) ?? {}, {
      state: "done",
      progress: 1,
      song_id: song,
      song: meta(song),
    });
    this.cached.add(song);
  }

  async cancel(id: string): Promise<void> {
    this.#call(`cancel ${id}`);
    if (!this.jobs.delete(id)) throw new SingWorkerError(`no job ${id}`, { status: 404 });
  }

  async goExclusive(id: string): Promise<void> {
    this.#call(`exclusive ${id}`);
  }

  async context(context: GpuContext): Promise<void> {
    this.#call("context");
    this.told = context;
  }

  async songs(): Promise<SongMeta[]> {
    this.#call("songs");
    return [...this.cached].map(meta);
  }

  async audio(song: string): Promise<Int16Array> {
    this.#call(`audio ${song}`);
    if (!this.cached.has(song)) throw new SingWorkerError(`no song ${song}`, { status: 404 });
    return new Int16Array([this.name.length]);
  }

  async download(song: string): Promise<void> {
    this.#call(`download ${song}`);
    if (!this.cached.has(song)) throw new SingWorkerError(`no song ${song}`, { status: 404 });
  }

  async health(): Promise<string | null> {
    return this.up ? null : `unreachable at ${this.name}`;
  }
}

function queued(id: string): WorkerJob {
  return {
    id,
    state: "queued",
    stage: "queued",
    progress: 0,
    error: null,
    song_id: null,
    cached: false,
    position: 0,
    source: null,
    song: null,
    exclusive: null,
    gpu: null,
  };
}

/** Lets fire-and-forget calls (cancelling jobs left behind) run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function setup() {
  const remote = new FakeWorker("remote");
  const local = new FakeWorker("local");
  const clock = { t: 1_000_000 };
  const worker = new FailoverSingWorker(
    [
      { name: "http://100.83.26.41:8005", worker: remote },
      { name: "http://127.0.0.1:8005", worker: local },
    ],
    { retryMs: RETRY, now: () => clock.t },
  );
  return { remote, local, clock, worker };
}

async function rejection(p: Promise<unknown>): Promise<SingWorkerError> {
  const error = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(SingWorkerError);
  return error as SingWorkerError;
}

describe("FailoverSingWorker", () => {
  it("sends new songs to the first worker and keeps a song with the worker that made it", async () => {
    const { remote, local, worker } = setup();
    const job = await worker.submit({ query: "On & On" });
    expect(job.id).toBe("remote-j1");
    remote.finish(job.id, "yt-1");
    expect((await worker.job(job.id)).song_id).toBe("yt-1");
    expect(await worker.audio("yt-1", "play_mix.pcm")).toEqual(new Int16Array([6]));
    await worker.goExclusive(job.id);
    expect(local.calls).toEqual([]);
    expect(worker.current()).toBe("http://100.83.26.41:8005");
  });

  it("goes to the next worker when the first does not answer, and rests the first a while", async () => {
    const { remote, clock, worker } = setup();
    remote.up = false;
    expect((await worker.submit({ query: "a" })).id).toBe("local-j1");
    expect(worker.current()).toBe("http://127.0.0.1:8005");
    // Resting: not asked again (each try would wait for the timeout).
    clock.t += RETRY - 1;
    expect((await worker.submit({ query: "b" })).id).toBe("local-j2");
    expect(remote.calls).toEqual(["submit"]);
    // Rested: asked again, and back to it once it answers.
    remote.up = true;
    clock.t += 1;
    expect((await worker.submit({ query: "c" })).id).toBe("remote-j1");
    expect(worker.current()).toBe("http://100.83.26.41:8005");
  });

  it("tries every worker when all are resting", async () => {
    const { remote, local, worker } = setup();
    remote.up = false;
    local.up = false;
    const error = await rejection(worker.submit({ query: "a" }));
    expect(error.unreachable).toBe(true);
    local.up = true;
    expect((await worker.submit({ query: "b" })).id).toBe("local-j1");
  });

  it("does not try the next worker when a worker answers with an error", async () => {
    const { local, worker } = setup();
    const error = await rejection(worker.submit({ url: "https://bad.example/x" }));
    expect(error.status).toBe(400);
    expect(local.calls).toEqual([]);
  });

  it("does not send a song to the next worker when the request may have reached the first", async () => {
    const { remote, local, worker } = setup();
    remote.slow = true;
    const error = await rejection(worker.submit({ query: "a" }));
    expect(error.maybeReceived).toBe(true);
    expect(local.calls).toEqual([]);
  });

  it("waits for the worker of a song, then reports the song gone so it is made on the next", async () => {
    const { remote, local, clock, worker } = setup();
    const job = await worker.submit({ query: "a" });
    remote.up = false;
    // Just gone: wait for it (unreachable, not 404), without asking it every poll.
    let error = await rejection(worker.job(job.id));
    expect(error.unreachable).toBe(true);
    clock.t += 1_500;
    error = await rejection(worker.job(job.id));
    expect(error.status).toBe(null);
    expect(remote.calls.filter((c) => c.startsWith("job"))).toHaveLength(1);
    // Still gone after the retry time: one more try, then the job counts as lost.
    clock.t += RETRY;
    error = await rejection(worker.job(job.id));
    expect(error.status).toBe(404);
    // The singer asks again: the song is made on this machine.
    expect((await worker.submit({ query: "a" })).id).toBe("local-j1");
    expect(local.calls).toEqual(["submit"]);
  });

  it("reports every song of a worker gone at once when it stays unreachable", async () => {
    const { remote, clock, worker } = setup();
    const a = await worker.submit({ query: "a" });
    const b = await worker.submit({ query: "b" });
    remote.up = false;
    await rejection(worker.job(a.id));
    await rejection(worker.job(b.id));
    clock.t += RETRY;
    // The poll of `a` tries it once more and fails; `b` does not wait another round for its own try.
    expect((await rejection(worker.job(a.id))).status).toBe(404);
    expect((await rejection(worker.job(b.id))).status).toBe(404);
    expect(remote.calls.filter((c) => c.startsWith("job"))).toHaveLength(2);
  });

  it("cancels a job made again elsewhere once its worker is back", async () => {
    const { remote, clock, worker } = setup();
    const job = await worker.submit({ query: "a" });
    remote.up = false;
    await rejection(worker.job(job.id));
    clock.t += RETRY;
    expect((await rejection(worker.job(job.id))).status).toBe(404);
    expect((await worker.submit({ query: "a" })).id).toBe("local-j1");
    remote.up = true;
    expect(await worker.health()).toBe(null);
    await settle();
    expect(remote.calls).toContain(`cancel ${job.id}`);
    expect(remote.jobs.has(job.id)).toBe(false);
  });

  it("fails a cancel at once while the worker rests, and cancels the job once it is back", async () => {
    const { remote, worker } = setup();
    const job = await worker.submit({ query: "a" });
    remote.up = false;
    await rejection(worker.job(job.id));
    await rejection(worker.goExclusive(job.id));
    const error = await rejection(worker.cancel(job.id));
    expect(error.unreachable).toBe(true);
    expect(remote.calls.filter((c) => c.startsWith("cancel") || c.startsWith("exclusive"))).toEqual(
      [],
    );
    remote.up = true;
    await worker.health();
    await settle();
    expect(remote.calls).toContain(`cancel ${job.id}`);
  });

  it("passes over a worker that a health check found unreachable", async () => {
    const { remote, worker } = setup();
    remote.up = false;
    await worker.health();
    expect((await worker.submit({ query: "a" })).id).toBe("local-j1");
    expect(remote.calls).toEqual([]);
  });

  it("keeps a song with its worker when it comes back in time", async () => {
    const { remote, clock, worker } = setup();
    const job = await worker.submit({ query: "a" });
    remote.up = false;
    await rejection(worker.job(job.id));
    remote.up = true;
    clock.t += RETRY;
    expect((await worker.job(job.id)).id).toBe(job.id);
  });

  it("finds a job it does not know (after a restart) on whichever worker has it", async () => {
    const { local, worker } = setup();
    const lost = await local.submit({ query: "a" });
    expect((await worker.job(lost.id)).id).toBe(lost.id);
    const error = await rejection(worker.job("nowhere"));
    expect(error.status).toBe(404);
  });

  it("does not call a job gone while a worker that might have it is only briefly unreachable", async () => {
    const { remote, clock, worker } = setup();
    remote.up = false;
    let error = await rejection(worker.job("unknown"));
    expect(error.unreachable).toBe(true);
    clock.t += RETRY;
    error = await rejection(worker.job("unknown"));
    expect(error.status).toBe(404);
  });

  it("lists the songs of every worker and fetches each from the worker that has it", async () => {
    const { remote, local, worker } = setup();
    remote.cached.add("yt-1");
    local.cached.add("yt-1");
    local.cached.add("yt-2");
    expect((await worker.songs()).map((s) => s.id)).toEqual(["yt-1", "yt-2"]);
    expect(await worker.audio("yt-1", "play_mix.pcm")).toEqual(new Int16Array([6]));
    expect(await worker.audio("yt-2", "play_mix.pcm")).toEqual(new Int16Array([5]));
    await worker.download("yt-2", "video.mp4", "x");
    expect(remote.calls).not.toContain("audio yt-2");
  });

  it("fetches a song from another worker that has it when its own is unreachable", async () => {
    const { remote, local, worker } = setup();
    const job = await worker.submit({ query: "a" });
    remote.finish(job.id, "yt-1");
    await worker.job(job.id);
    local.cached.add("yt-1");
    remote.up = false;
    expect(await worker.audio("yt-1", "play_mix.pcm")).toEqual(new Int16Array([5]));
  });

  it("reports a song gone only when no worker that answers has it", async () => {
    const { remote, clock, worker } = setup();
    const job = await worker.submit({ query: "a" });
    remote.finish(job.id, "yt-1");
    await worker.job(job.id);
    remote.up = false;
    let error = await rejection(worker.audio("yt-1", "play_mix.pcm"));
    expect(error.unreachable).toBe(true);
    clock.t += RETRY;
    error = await rejection(worker.audio("yt-1", "play_mix.pcm"));
    expect(error.status).toBe(404);
  });

  it("tells every worker that answers who is listening", async () => {
    const { remote, local, worker } = setup();
    const ctx = { in_voice: true, listeners: 2, live: false, urgent: [] };
    await worker.context(ctx);
    expect(remote.told).toEqual(ctx);
    expect(local.told).toEqual(ctx);
    remote.up = false;
    await worker.context(ctx);
    local.up = false;
    await rejection(worker.context(ctx));
  });

  it("is healthy while any worker is", async () => {
    const { remote, local, worker } = setup();
    remote.up = false;
    expect(await worker.health()).toBe(null);
    local.up = false;
    expect(await worker.health()).toBe(
      "http://100.83.26.41:8005: unreachable at remote; http://127.0.0.1:8005: unreachable at local",
    );
  });
});

describe("HttpSingWorker errors", () => {
  async function listen(server: Server): Promise<string> {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("says a request was not sent when nothing listens", async () => {
    const server = createServer();
    const url = await listen(server);
    await new Promise((resolve) => server.close(resolve));
    const error = await rejection(new HttpSingWorker(url, 2000).submit({ query: "a" }));
    expect(error.unreachable).toBe(true);
    expect(error.maybeReceived).toBe(false);
  });

  it("says a submit may have reached a worker that takes it but does not answer in time", async () => {
    const server = createServer(() => {
      // takes the request, never answers
    });
    const url = await listen(server);
    try {
      const error = await rejection(new HttpSingWorker(url, 300).submit({ query: "a" }));
      expect(error.unreachable).toBe(true);
      expect(error.maybeReceived).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("fallback_urls config", () => {
  it("accepts only addresses", () => {
    expect(SingConfigSchema.safeParse({ fallback_urls: ["100.83.26.41:8005"] }).success).toBe(
      false,
    );
    expect(SingConfigSchema.safeParse({ fallback_urls: ["http://127.0.0.1:8005"] }).success).toBe(
      true,
    );
  });

  it("uses each address once", () => {
    expect(
      workerUrls("http://100.83.26.41:8005", [
        "http://100.83.26.41:8005/",
        "http://127.0.0.1:8005",
        "http://127.0.0.1:8005",
      ]),
    ).toEqual(["http://100.83.26.41:8005", "http://127.0.0.1:8005"]);
  });
});

describe("SingModule with fallback_urls", () => {
  it("asks for one worker per url, the url first", async () => {
    const made = new Map<string, FakeWorker>();
    const sup = new Supervisor();
    const sing = new SingModule((url) => {
      const w = new FakeWorker(url);
      made.set(url, w);
      return w;
    });
    await sup.register(
      sing,
      { url: "http://100.83.26.41:8005", fallback_urls: ["http://127.0.0.1:8005"], clips: false },
      true,
    );
    await sup.startAll();
    expect([...made.keys()]).toEqual(["http://100.83.26.41:8005", "http://127.0.0.1:8005"]);
    // The friend's computer is off: still healthy, this machine's worker sings.
    (made.get("http://100.83.26.41:8005") as FakeWorker).up = false;
    expect(await sing.health()).toEqual({ status: "healthy" });
    (made.get("http://127.0.0.1:8005") as FakeWorker).up = false;
    expect((await sing.health()).status).toBe("degraded");
    await sup.stopAll();
  });

  it("uses a single worker when the fallbacks only repeat the url", async () => {
    const made: string[] = [];
    const sup = new Supervisor();
    const sing = new SingModule((url) => {
      made.push(url);
      return new FakeWorker(url);
    });
    await sup.register(
      sing,
      { url: "http://127.0.0.1:8005", fallback_urls: ["http://127.0.0.1:8005/"], clips: false },
      true,
    );
    await sup.startAll();
    expect(made).toEqual(["http://127.0.0.1:8005"]);
    await sup.stopAll();
  });
});
