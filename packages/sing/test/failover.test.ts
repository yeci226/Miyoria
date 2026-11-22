// Several song workers in order (the registry's `sing` endpoints, e.g. `url`, then
// `fallback_urls`): new songs go to the first that answers, a song stays with the worker that made
// it, and a song whose worker stays unreachable (or disappears from the registry) is reported gone
// (404) so the singer makes it again on the next one.

import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Supervisor } from "@miyoria/runtime/kernel";
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
import { karaokeWorker, SingModule, workerUrls } from "../src/module.js";
import { FakeEndpoints } from "./endpoints.js";

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

  /** Karaoke songs this worker made. */
  readonly karaoke = new Set<string>();

  finishKaraoke(id: string, song: string): void {
    Object.assign(this.jobs.get(id) ?? {}, {
      state: "done",
      progress: 1,
      karaoke: { id: song, title: "K", artist: null, duration_s: 10, quality: null },
    });
    this.karaoke.add(song);
  }

  async karaokeFile(song: string, file: string): Promise<void> {
    this.#call(`karaoke ${song} ${file}`);
    if (!this.karaoke.has(song)) throw new SingWorkerError(`no karaoke ${song}`, { status: 404 });
  }

  async karaokeKey(song: string, semitones: number) {
    this.#call(`key ${song} ${semitones}`);
    if (!this.karaoke.has(song)) throw new SingWorkerError(`no karaoke ${song}`, { status: 404 });
    return { file: `karaoke.k+${semitones}.m4a`, semitones, cached: false, method: "fake" };
  }

  /** Recordings this worker read (their sizes). */
  readonly voices: number[] = [];

  async karaokeVoice(bytes: Uint8Array) {
    this.#call("voice");
    if (this.slow) {
      throw new SingWorkerError(`song worker unreachable at ${this.name}: timeout`, {
        unreachable: true,
        maybeReceived: true,
      });
    }
    this.voices.push(bytes.length);
    return {
      hz: 50 as const,
      midi: [60, null],
      seconds: 0.04,
      level_db: -20,
      floor_db: -60,
      device: "cpu",
      method: "fake",
    };
  }

  /** Rooms whose stream batches this worker answered. */
  readonly streamed: string[] = [];

  async karaokeStream(request: { room: string }) {
    this.#call(`stream ${request.room}`);
    this.streamed.push(request.room);
    return { hz: 50 as const, streams: [], lost: [], device: "cpu", method: "fake" };
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

  it("asks for a karaoke job and fetches its files from the worker that made it", async () => {
    const { remote, local, worker } = setup();
    const kw = karaokeWorker(worker);
    const job = await kw.prepare({ url: "https://youtu.be/x" });
    remote.finishKaraoke(job.id, "k-1");
    expect((await kw.job(job.id)).karaoke?.id).toBe("k-1");
    await kw.file("k-1", "reference.json", "x");
    expect(remote.calls).toContain("karaoke k-1 reference.json");
    await kw.file("k-1", "play_karaoke.pcm", "x");
    await kw.file("k-1", "play_karaoke.k+3.pcm", "x");
    expect(remote.calls).toContain("karaoke k-1 play_karaoke.pcm");
    expect(remote.calls).toContain("karaoke k-1 play_karaoke.k+3.pcm");
    expect(local.calls.some((c) => c.startsWith("karaoke"))).toBe(false);
    // Never one of her covers.
    expect((await worker.songs()).map((s) => s.id)).not.toContain("k-1");
  });

  it("reads a recording on the first worker that answers, never sending it twice", async () => {
    const { remote, local, worker } = setup();
    const kw = karaokeWorker(worker);
    remote.up = false;
    const pitch = await kw.voice({ bytes: new Uint8Array(10), type: "audio/webm" });
    expect(pitch.midi).toEqual([60, null]);
    expect(local.voices).toEqual([10]);
    // One that timed out may be reading it: the next is not asked.
    const again = setup();
    again.remote.slow = true;
    await expect(
      karaokeWorker(again.worker).voice({ bytes: new Uint8Array(3), type: "audio/ogg" }),
    ).rejects.toThrow(/timeout/);
    expect(again.local.voices).toEqual([]);
  });

  it("keeps a karaoke room's voice streams on one worker, failing at once while it is away", async () => {
    const { remote, local, worker } = setup();
    const kw = karaokeWorker(worker);
    const batch = { room: "R1", chunks: [], drop: [] };
    await kw.stream?.(batch);
    expect(remote.streamed).toEqual(["R1"]);
    remote.up = false;
    await expect(kw.stream?.(batch)).rejects.toThrow(/unreachable/);
    // Not moved: the next batch fails too, at once, and the other worker never sees the room.
    await expect(kw.stream?.(batch)).rejects.toThrow(/unreachable/);
    expect(local.streamed).toEqual([]);
    // Another room starts on the worker that answers.
    await kw.stream?.({ room: "R2", chunks: [], drop: [] });
    expect(local.streamed).toEqual(["R2"]);
  });

  it("asks for a karaoke job without a video when told so", async () => {
    const { remote, worker } = setup();
    const submitted: unknown[] = [];
    const submit = remote.submit.bind(remote);
    remote.submit = async (q) => {
      submitted.push(q);
      return submit(q);
    };
    await karaokeWorker(worker).prepare({ query: "a", video: false });
    expect(submitted[0]).toMatchObject({ purpose: "karaoke", karaoke_video: false });
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

/** The client of the one worker at `url`, as the module makes it from the registry. */
function client(url: string, timeoutMs: number, headers: Record<string, string> = {}) {
  const source = new FakeEndpoints([{ name: "sing", url, headers }]);
  return new HttpSingWorker(source.candidates("sing")[0] as never, timeoutMs, source);
}

describe("HttpSingWorker errors", () => {
  async function listen(server: Server): Promise<string> {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("says a request was not sent when nothing listens", async () => {
    const server = createServer();
    const url = await listen(server);
    await new Promise((resolve) => server.close(resolve));
    const error = await rejection(client(url, 2000).submit({ query: "a" }));
    expect(error.unreachable).toBe(true);
    expect(error.maybeReceived).toBe(false);
  });

  it("says a submit may have reached a worker that takes it but does not answer in time", async () => {
    const server = createServer(() => {
      // takes the request, never answers
    });
    const url = await listen(server);
    try {
      const error = await rejection(client(url, 300).submit({ query: "a" }));
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

describe("SingModule and the registry's sing endpoints", () => {
  /** Starts the module on `endpoints`; the clients it makes, by URL. */
  async function start(endpoints: FakeEndpoints) {
    const made = new Map<string, FakeWorker>();
    const sup = new Supervisor();
    const sing = new SingModule(
      (endpoint) => {
        const w = new FakeWorker(endpoint.url);
        made.set(endpoint.url, w);
        return w;
      },
      { endpoints: () => endpoints },
    );
    await sup.register(sing, { clips: false }, true);
    await sup.startAll();
    return { sup, sing, made };
  }

  it("asks for one worker per endpoint, in the registry's order (`url` first)", async () => {
    const endpoints = new FakeEndpoints([
      { name: "sing", url: "http://100.83.26.41:8005" },
      { name: "sing.fallback.1", url: "http://127.0.0.1:8005" },
    ]);
    const { sup, sing, made } = await start(endpoints);
    expect([...made.keys()]).toEqual(["http://100.83.26.41:8005", "http://127.0.0.1:8005"]);
    // The friend's computer is off: still healthy, this machine's worker sings.
    (made.get("http://100.83.26.41:8005") as FakeWorker).up = false;
    expect(await sing.health()).toEqual({ status: "healthy" });
    // The failover rested it: the registry hears about it too.
    expect(endpoints.failures.map((f) => f.endpoint.host)).toEqual(["sing"]);
    (made.get("http://127.0.0.1:8005") as FakeWorker).up = false;
    expect((await sing.health()).status).toBe("degraded");
    await sup.stopAll();
    expect(endpoints.watching).toBe(0);
  });

  it("follows endpoints that appear and disappear", async () => {
    const endpoints = new FakeEndpoints();
    const { sup, sing, made } = await start(endpoints);
    expect(await sing.health()).toEqual({
      status: "degraded",
      reason: "no song worker is known",
    });
    endpoints.set([{ name: "main-pc", service: "sing", url: "http://127.0.0.1:8005" }]);
    expect([...made.keys()]).toEqual(["http://127.0.0.1:8005"]);
    expect(await sing.health()).toEqual({ status: "healthy" });
    endpoints.set([]);
    expect((await sing.health()).status).toBe("degraded");
    await sup.stopAll();
  });
});

describe("FailoverSingWorker with a changing list", () => {
  it("has no worker at first: a request waits, as for one that does not answer", async () => {
    const worker = new FailoverSingWorker([], { retryMs: RETRY });
    let error = await rejection(worker.submit({ query: "a" }));
    expect([error.unreachable, error.message]).toEqual([true, "no song worker is known"]);
    error = await rejection(worker.job("j"));
    expect(error.unreachable).toBe(true);
    expect(await worker.health()).toBe("no song worker is known");
    const local = new FakeWorker("local");
    worker.update([{ id: "pc/sing", name: "http://pc:8005", worker: local }]);
    expect((await worker.submit({ query: "a" })).id).toBe("local-j1");
  });

  it("reports the songs of a worker that left the list gone, and makes them on the next", async () => {
    const remote = new FakeWorker("remote");
    const local = new FakeWorker("local");
    const worker = new FailoverSingWorker(
      [
        { id: "friend/sing", name: "http://friend:8005", worker: remote },
        { id: "pc/sing", name: "http://pc:8005", worker: local },
      ],
      { retryMs: RETRY },
    );
    const job = await worker.submit({ query: "a" });
    expect(job.id).toBe("remote-j1");
    worker.update([{ id: "pc/sing", name: "http://pc:8005", worker: local }]);
    const error = await rejection(worker.job(job.id));
    expect([error.status, error.message]).toEqual([
      404,
      "the song worker at http://friend:8005 is gone",
    ]);
    expect((await worker.submit({ query: "a" })).id).toBe("local-j1");
    expect(remote.calls).toEqual(["submit"]);
    // It comes back: the job left behind is cancelled there.
    worker.update([
      { id: "friend/sing", name: "http://friend:8005", worker: remote },
      { id: "pc/sing", name: "http://pc:8005", worker: local },
    ]);
    expect(await worker.health()).toBe(null);
    await settle();
    expect(remote.calls).toContain(`cancel ${job.id}`);
  });

  it("keeps a worker's jobs and songs when its address changes (same id) or its id does (same address)", async () => {
    const first = new FakeWorker("w");
    const worker = new FailoverSingWorker(
      [{ id: "sing", name: "http://127.0.0.1:8005", url: "http://127.0.0.1:8005", worker: first }],
      { retryMs: RETRY },
    );
    const job = await worker.submit({ query: "a" });
    first.finish(job.id, "yt-1");
    await worker.job(job.id);

    // The worker restarted on another port: the same id, a new client that knows the same jobs.
    const moved = new FakeWorker("w");
    moved.jobs.set(job.id, structuredClone(first.jobs.get(job.id) as WorkerJob));
    moved.cached.add("yt-1");
    worker.update([
      { id: "sing", name: "http://127.0.0.1:9005", url: "http://127.0.0.1:9005", worker: moved },
    ]);
    expect((await worker.job(job.id)).song_id).toBe("yt-1");
    expect(moved.calls).toEqual([`job ${job.id}`]);

    // A hostd now reports the worker the static entry named: another id, the same address.
    const reported = new FakeWorker("w");
    reported.cached.add("yt-1");
    worker.update([
      {
        id: "elsewhere/sing",
        name: "http://10.0.0.9:8005",
        url: "http://10.0.0.9:8005",
        worker: new FakeWorker("x"),
      },
      {
        id: "main-pc/sing",
        name: "http://127.0.0.1:9005/",
        url: "http://127.0.0.1:9005/",
        worker: reported,
      },
    ]);
    expect(await worker.audio("yt-1", "play_mix.pcm")).toEqual(new Int16Array([1]));
    expect(reported.calls).toEqual(["audio yt-1"]);
  });

  it("uses a single worker as it is: no resting, no songs reported gone", async () => {
    const only = new FakeWorker("only");
    const clock = { t: 0 };
    const failed: string[] = [];
    const worker = new FailoverSingWorker([{ id: "sing", name: "http://pc:8005", worker: only }], {
      retryMs: RETRY,
      now: () => clock.t,
      failed: (id) => failed.push(id),
    });
    const job = await worker.submit({ query: "a" });
    only.up = false;
    expect((await rejection(worker.job(job.id))).unreachable).toBe(true);
    clock.t += RETRY * 2;
    // Asked every time, and still only unreachable (a lone worker's songs are not remade).
    const error = await rejection(worker.job(job.id));
    expect([error.unreachable, error.status]).toEqual([true, null]);
    expect(only.calls.filter((c) => c.startsWith("job"))).toHaveLength(2);
    expect(failed).toEqual(["sing", "sing"]);
    only.up = false;
    expect(await worker.health()).toBe("unreachable at only");
  });
});

describe("HttpSingWorker through the registry", () => {
  let server: Server | null = null;

  it("sends the endpoint's token on every call", async () => {
    const seen: IncomingHttpHeaders[] = [];
    server = createServer((req, res) => {
      seen.push(req.headers);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect(await client(url, 2000, { authorization: "Bearer sing-token" }).health()).toBe(null);
      expect(seen[0]?.authorization).toBe("Bearer sing-token");
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server?.close(resolve));
    }
  });

  it("takes the relay's error as the answer for a link endpoint (no connection probe)", async () => {
    const source = new FakeEndpoints([
      { name: "far", service: "sing", url: "link://far/sing", via: "link" },
    ]);
    const worker = new HttpSingWorker(source.candidates("sing")[0] as never, 2000, source);
    const error = await rejection(worker.submit({ query: "a" }));
    expect(error.unreachable).toBe(true);
    expect(error.maybeReceived).toBe(false);
    expect(error.message).toMatch(
      /^song worker unreachable at sing on far \(over its control link\)/,
    );
  });

  it("knows a relay error that sent nothing from one that may have reached the worker", async () => {
    const source = new FakeEndpoints([
      { name: "far", service: "sing", url: "link://far/sing", via: "link" },
    ]);
    const worker = new HttpSingWorker(source.candidates("sing")[0] as never, 2000, source);
    const relayError = (sent: boolean) =>
      Object.assign(new Error("host `far` is not connected"), { name: "RelayError", sent });

    source.linkError = relayError(false);
    expect((await rejection(worker.submit({ query: "a" }))).maybeReceived).toBe(false);

    source.linkError = relayError(true);
    expect((await rejection(worker.submit({ query: "a" }))).maybeReceived).toBe(true);
  });
});

describe("a list that was empty when it was made", () => {
  it("asks its owner again before it picks a worker", async () => {
    let known: { name: string; worker: SingWorker }[] = [];
    const failover: FailoverSingWorker = new FailoverSingWorker([], {
      retryMs: 1000,
      refresh: () => failover.update(known),
    });
    expect(failover.current()).toBeNull();
    known = [{ name: "late", worker: new FakeWorker("late") }];
    expect(failover.current()).toBe("late");
    expect(await failover.health()).toBeNull();
  });
});

describe("dispatch through the registry (v5-hostd §15)", () => {
  interface Unit {
    id: string;
    what: string | undefined;
    accepted: boolean;
    done: { ok?: boolean; run_ms?: number } | null;
  }

  /**
   * Two workers listed as a registry lists `job` work: fewest units counted first. The registry's
   * part is played by the hooks: `reserve` counts a unit until it is done, `refresh` lists again.
   */
  function dispatching(options: { place?: string } = {}) {
    const workers = { a: new FakeWorker("a"), b: new FakeWorker("b") };
    const clock = { t: 1_000_000 };
    const counts = new Map<string, number>([
      ["a", 0],
      ["b", 0],
    ]);
    const units: Unit[] = [];
    const takes = new Set(["a", "b"]);
    const list = () =>
      [...counts.entries()]
        .sort((x, y) => x[1] - y[1] || x[0].localeCompare(y[0]))
        .map(([id]) => ({
          id,
          name: id,
          worker: workers[id as "a" | "b"],
          takesWork: takes.has(id),
        }));
    const worker: FailoverSingWorker = new FailoverSingWorker(list(), {
      retryMs: RETRY,
      now: () => clock.t,
      refresh: () => worker.update(list()),
      reserve: (id, what) => {
        counts.set(id, (counts.get(id) ?? 0) + 1);
        const unit: Unit = { id, what, accepted: false, done: null };
        units.push(unit);
        return {
          accepted: () => {
            unit.accepted = true;
          },
          done: (outcome = {}) => {
            unit.done = outcome;
            counts.set(id, (counts.get(id) ?? 0) - 1);
          },
        };
      },
      ...(options.place !== undefined ? { openSession: () => options.place ?? null } : {}),
    });
    return { ...workers, worker, clock, units, takes };
  }

  it("sends two songs asked together to two workers", async () => {
    const { worker, units } = dispatching();
    const [one, two] = await Promise.all([
      worker.submit({ query: "one" }),
      worker.submit({ query: "two" }),
    ]);
    expect([one.id.split("-")[0], two.id.split("-")[0]]).toEqual(["a", "b"]);
    expect(units.map((u) => [u.id, u.what, u.accepted])).toEqual([
      ["a", "one", true],
      ["b", "two", true],
    ]);
  });

  it("ends a song's unit with its run time when its job ends", async () => {
    const { worker, a, clock, units } = dispatching();
    const job = await worker.submit({ query: "one" });
    Object.assign(a.jobs.get(job.id) ?? {}, { state: "running" });
    await worker.job(job.id);
    clock.t += 60_000;
    a.finish(job.id, "song-1");
    await worker.job(job.id);
    expect(units[0]?.done).toEqual({ ok: true, run_ms: 60_000 });
    // A later poll of the same job changes nothing.
    await worker.job(job.id);
    expect(units).toHaveLength(1);
  });

  it("teaches nothing from a job never seen running, a cancel, or a worker that does not answer", async () => {
    const { worker, a, b, units } = dispatching();
    const cached = await worker.submit({ query: "cached" });
    a.finish(cached.id, "song-c");
    await worker.job(cached.id);
    expect(units[0]?.done).toEqual({ ok: false });

    const cancelled = await worker.submit({ query: "cancelled" });
    await worker.cancel(cancelled.id);
    expect(units[1]?.done).toEqual({ ok: false });

    a.up = false;
    b.up = true;
    const moved = await worker.submit({ query: "moved" });
    expect(moved.id.startsWith("b-")).toBe(true);
    expect(units.filter((u) => u.id === "a").at(-1)?.done).toEqual({ ok: false });
    expect(units.at(-1)).toMatchObject({ id: "b", accepted: true, done: null });
  });

  it("gives a worker that takes no new work no song, and still fetches what it holds", async () => {
    const { worker, a, takes } = dispatching();
    const made = await worker.submit({ query: "made earlier" });
    a.finish(made.id, "song-a");
    await worker.job(made.id);
    takes.delete("a");
    const fresh = await worker.submit({ query: "new" });
    expect(fresh.id.startsWith("b-")).toBe(true);
    expect(worker.current()).toBe("b");
    // The song made on `a` is still played from there, and its job still found there.
    expect(await worker.audio("song-a", "play_mix.pcm")).toEqual(new Int16Array([1]));
    expect((await worker.job(made.id)).state).toBe("done");
    // Nobody takes new work: a request says so, as one no worker answers.
    takes.delete("b");
    const refused = await rejection(worker.submit({ query: "nobody" }));
    expect(refused.unreachable).toBe(true);
    expect(refused.message).toMatch(/takes new work/);
  });

  it("starts a karaoke room's streams where the registry places the session", async () => {
    const { worker, b } = dispatching({ place: "b" });
    await worker.karaokeStream({ room: "r1", batches: [] } as never);
    expect(b.streamed).toEqual(["r1"]);
  });
});
