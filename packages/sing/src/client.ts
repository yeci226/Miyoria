// HTTP client of the song worker (`workers/sing/server.py`, docs/protocols/voice-link.md
// 「歌曲 Worker」). Everything it returns about a song (title, artist, lyrics) comes from YouTube or
// lrclib and is untrusted.

import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { connect } from "node:net";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";

const LyricLineSchema = z.object({ t: z.number(), text: z.string() });

export const SongMetaSchema = z.object({
  id: z.string(),
  title: z.string().catch(""),
  artist: z.string().nullable().catch(null),
  duration_s: z.number().nullable().catch(null),
  lyrics: z
    .object({ synced: z.boolean().catch(false), lines: z.array(LyricLineSchema).catch([]) })
    .nullable()
    .catch(null),
  play: z.object({
    sample_rate: z.number().int().positive(),
    samples: z.number().int().nullable(),
  }),
  pitch: z.record(z.string(), z.unknown()).catch({}),
  timings: z.record(z.string(), z.number()).catch({}),
  peak_vram_mb: z.number().nullable().catch(null),
  /** Its original video sits in the song's cache dir as `video.file` (older workers: none). */
  has_video: z.boolean().catch(false),
  video: z.object({ file: z.string() }).nullable().catch(null),
  /** What became of the song's backing voices (`acapella` has no instrumental). */
  backing: z.string().optional().catch(undefined),
  /** Its beat: tempo and beat times in seconds from the start of the playback (older workers: none). */
  beats: z
    .object({ bpm: z.number(), times: z.array(z.number()) })
    .nullable()
    .catch(null)
    .optional(),
});
export type SongMeta = z.output<typeof SongMetaSchema>;
export type LyricLine = z.output<typeof LyricLineSchema>;

/**
 * Where the worker runs a job and why (`workers/sing/gpu.py`): decided before every GPU stage and
 * again while it runs. `reason` is written for people, and for her.
 */
export const GpuStatusSchema = z.object({
  policy: z.string().catch("auto"),
  stage: z.string().catch(""),
  /** `share`, `offload`, `exclusive`, `wait`, `cpu` or `give_up`. */
  mode: z.string().nullable().catch(null),
  code: z.string().nullable().catch(null),
  reason: z.string().nullable().catch(null),
  free_mb: z.number().nullable().catch(null),
  total_mb: z.number().nullable().catch(null),
  need_mb: z.number().nullable().catch(null),
  step_s: z.number().nullable().catch(null),
  baseline_s: z.number().nullable().catch(null),
  spilling: z.boolean().catch(false),
  spills: z.number().catch(0),
  waited_s: z.number().catch(0),
  silenced_s: z.number().catch(0),
  /** How long her voice would be gone if it went now, reload included. */
  silence_est_s: z.number().nullable().catch(null),
  silence_max_s: z.number().nullable().catch(null),
});
export type GpuStatus = z.output<typeof GpuStatusSchema>;

export const WorkerJobSchema = z.object({
  id: z.string(),
  state: z.enum(["queued", "running", "done", "failed", "cancelled"]),
  stage: z.string().catch(""),
  progress: z.number().catch(0),
  error: z.string().nullable().catch(null),
  song_id: z.string().nullable().catch(null),
  cached: z.boolean().catch(false),
  position: z.number().nullable().catch(null),
  source: z
    .object({ title: z.string().catch(""), artist: z.string().nullable().catch(null) })
    .nullable()
    .catch(null),
  song: SongMetaSchema.nullable().catch(null),
  /**
   * The job has the GPU to itself (the TTS / ASR workers offloaded): `waiting` for our go,
   * `offloading`, `active`, `reloading`, `done`; `shared`: it runs next to them, speech goes on;
   * `null` when it does not need it (older workers: always `null`).
   */
  exclusive: z
    .enum(["waiting", "offloading", "active", "reloading", "done", "shared"])
    .nullable()
    .catch(null),
  gpu: GpuStatusSchema.nullable().catch(null),
});
export type WorkerJob = z.output<typeof WorkerJobSchema>;

/** What a request names: a search, a link or a file of the worker's song library. */
export interface SongQuery {
  query?: string;
  url?: string;
  path?: string;
  /** Whole-song transposition in semitones (her voice follows). */
  key?: number;
  /** The song's backing voices (`keep` when left out; each mode is a song of its own in the worker). */
  backing?: "keep" | "drop" | "convert" | "acapella";
  /** The worker waits for `goExclusive` before it takes the GPU (she says she is off first). */
  exclusive_ack?: boolean;
}

/**
 * What only Core knows, for the worker's GPU decisions: who would notice her going quiet, and which
 * jobs are needed now. Sent on every poll; without it for a while the worker assumes people.
 */
export interface GpuContext {
  in_voice: boolean;
  /** People in her voice channels who can hear her. */
  listeners: number;
  /** Go Live or OBS is on: there are viewers, however many. */
  live: boolean;
  /** Jobs of songs that are sung as soon as they are ready. */
  urgent: string[];
}

/** The two tracks Core streams: the mix, and the converted vocal her mouth follows. */
export type SongTrack = "play_mix.pcm" | "play_vocals.pcm";

export class SingWorkerError extends Error {
  override readonly name = "SingWorkerError";

  /**
   * The worker's HTTP status (404: it does not know the job, e.g. after a restart).
   * `unreachable`: no answer at all (down, wrong address, timed out), so another worker may be tried.
   * `maybeReceived`: no answer, but the request may have reached the worker (it timed out, or the
   * connection broke after it opened), so sending it again elsewhere could do the work twice.
   */
  constructor(
    message: string,
    options?: ErrorOptions & { status?: number; unreachable?: boolean; maybeReceived?: boolean },
  ) {
    super(message, options);
    this.status = options?.status ?? null;
    this.unreachable = options?.unreachable ?? false;
    this.maybeReceived = this.unreachable && (options?.maybeReceived ?? false);
  }

  readonly status: number | null;
  readonly unreachable: boolean;
  readonly maybeReceived: boolean;
}

/** Errors of a connection that never opened: the request was not sent. */
const NOT_CONNECTED = new Set([
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EHOSTDOWN",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EADDRNOTAVAIL",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** Whether a failed fetch never connected (looks through `cause` and `AggregateError`s). */
function neverConnected(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) return false;
  const e = error as { code?: unknown; cause?: unknown; errors?: unknown };
  if (typeof e.code === "string" && NOT_CONNECTED.has(e.code)) return true;
  if (Array.isArray(e.errors) && e.errors.length > 0) {
    return e.errors.every((inner) => neverConnected(inner, depth + 1));
  }
  return neverConnected(e.cause, depth + 1);
}

/** The song worker as the module uses it (`HttpSingWorker`, or a fake in tests). */
export interface SingWorker {
  submit(query: SongQuery, signal?: AbortSignal): Promise<WorkerJob>;
  job(id: string, signal?: AbortSignal): Promise<WorkerJob>;
  cancel(id: string): Promise<void>;
  /** Lets a job that is `exclusive: "waiting"` take the GPU. */
  goExclusive(id: string): Promise<void>;
  /** Tells the worker who is listening (`POST /gpu/context`). */
  context(context: GpuContext, signal?: AbortSignal): Promise<void>;
  /** Every song the worker has finished and cached (newest first): what she has covered. */
  songs(signal?: AbortSignal): Promise<SongMeta[]>;
  /** PCM s16le mono at `song.play.sample_rate`. */
  audio(song: string, track: SongTrack, signal?: AbortSignal): Promise<Int16Array>;
  /** Saves one of the song's files (its video) to `dest`; the worker may be on another machine. */
  download(song: string, file: string, dest: string, signal?: AbortSignal): Promise<void>;
  /** `null` when healthy, else why not. */
  health(signal?: AbortSignal): Promise<string | null>;
}

/** Longest wait for the connection check after a submit timed out. */
const PROBE_MS = 3000;

export class HttpSingWorker implements SingWorker {
  readonly #base: string;
  readonly #timeoutMs: number;

  constructor(url: string, timeoutMs: number) {
    this.#base = url.replace(/\/+$/, "");
    this.#timeoutMs = timeoutMs;
  }

  async #call(path: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const all = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetch(`${this.#base}${path}`, { ...init, signal: all });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new SingWorkerError(`song worker unreachable at ${this.#base}: ${String(error)}`, {
        cause: error,
        unreachable: true,
        maybeReceived: !neverConnected(error),
      });
    }
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: unknown };
        if (typeof body.error === "string") message = body.error;
      } catch {
        // not JSON
      }
      throw new SingWorkerError(message, { status: res.status });
    }
    return res;
  }

  async #job(path: string, init: RequestInit, signal?: AbortSignal): Promise<WorkerJob> {
    const res = await this.#call(path, init, this.#timeoutMs, signal);
    const body = (await res.json()) as { job?: unknown };
    const parsed = WorkerJobSchema.safeParse(body.job);
    if (!parsed.success) throw new SingWorkerError("song worker sent a malformed job");
    return parsed.data;
  }

  async submit(query: SongQuery, signal?: AbortSignal): Promise<WorkerJob> {
    try {
      return await this.#job(
        "/jobs",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(query),
        },
        signal,
      );
    } catch (error) {
      // Timed out: the worker may have taken the job, unless it cannot even be connected to now
      // (a computer that is off, or off the tailnet, often drops the connection attempt silently
      // instead of refusing it, so the request timeout fires first).
      if (
        error instanceof SingWorkerError &&
        error.maybeReceived &&
        !(await this.#connects(Math.min(this.#timeoutMs, PROBE_MS)))
      ) {
        throw new SingWorkerError(error.message, { cause: error.cause, unreachable: true });
      }
      throw error;
    }
  }

  /**
   * Whether a TCP connection to the worker opens within `ms`. The OS accepts it even while the
   * worker is too busy to answer, so this tells "off" from "slow".
   */
  #connects(ms: number): Promise<boolean> {
    const url = new URL(this.#base);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
    return new Promise((resolve) => {
      const socket = connect({ host, port, timeout: ms });
      const done = (ok: boolean) => {
        socket.destroy();
        resolve(ok);
      };
      socket.once("connect", () => done(true));
      socket.once("timeout", () => done(false));
      socket.once("error", () => done(false));
    });
  }

  job(id: string, signal?: AbortSignal): Promise<WorkerJob> {
    return this.#job(`/jobs/${encodeURIComponent(id)}`, {}, signal);
  }

  async cancel(id: string): Promise<void> {
    await this.#call(`/jobs/${encodeURIComponent(id)}`, { method: "DELETE" }, this.#timeoutMs);
  }

  async goExclusive(id: string): Promise<void> {
    await this.#call(
      `/jobs/${encodeURIComponent(id)}/exclusive`,
      { method: "POST" },
      this.#timeoutMs,
    );
  }

  async context(context: GpuContext, signal?: AbortSignal): Promise<void> {
    await this.#call(
      "/gpu/context",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(context),
      },
      this.#timeoutMs,
      signal,
    );
  }

  async songs(signal?: AbortSignal): Promise<SongMeta[]> {
    const res = await this.#call("/songs", {}, this.#timeoutMs, signal);
    const body = (await res.json()) as { songs?: unknown };
    if (!Array.isArray(body.songs)) throw new SingWorkerError("song worker sent a malformed list");
    // One song the schema cannot read does not hide the others.
    return body.songs.flatMap((raw) => {
      const parsed = SongMetaSchema.safeParse(raw);
      return parsed.success ? [parsed.data] : [];
    });
  }

  async audio(song: string, track: SongTrack, signal?: AbortSignal): Promise<Int16Array> {
    const res = await this.#call(
      `/songs/${encodeURIComponent(song)}/files/${track}`,
      {},
      this.#timeoutMs * 10,
      signal,
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    const out = new Int16Array(bytes.byteLength >> 1);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true);
    return out;
  }

  async download(song: string, file: string, dest: string, signal?: AbortSignal): Promise<void> {
    // A video is far bigger than the audio (up to `SING_VIDEO_MAX_MB`): allow it a long time.
    const res = await this.#call(
      `/songs/${encodeURIComponent(song)}/files/${encodeURIComponent(file)}`,
      {},
      Math.max(this.#timeoutMs * 60, 600_000),
      signal,
    );
    if (res.body === null) throw new SingWorkerError("song worker sent an empty file");
    await mkdir(dirname(dest), { recursive: true });
    const part = `${dest}.part`;
    try {
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(part));
      await rename(part, dest);
    } catch (error) {
      await rm(part, { force: true });
      throw error;
    }
  }

  async health(signal?: AbortSignal): Promise<string | null> {
    try {
      const res = await this.#call("/health", {}, this.#timeoutMs, signal);
      const body = (await res.json()) as { status?: unknown };
      return body.status === "ok" ? null : "song worker is not ok";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
}
