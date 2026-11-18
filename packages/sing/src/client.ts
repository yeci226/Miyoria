// HTTP client of the song worker (`workers/sing/server.py`, docs/protocols/voice-link.md
// 「歌曲 Worker」). Everything it returns about a song (title, artist, lyrics) comes from YouTube or
// lrclib and is untrusted. Every request goes through Core's endpoint registry (`request`), which
// adds the worker's token and relays it over a host's control link when the worker is not
// reachable directly.

import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { connect } from "node:net";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  type WORKERS_SING_PCM_TRACKS,
  WorkersHealthSchema,
  type WorkersKaraokeKeyReply,
  WorkersKaraokeKeyReplySchema,
  type WorkersKaraokeStreamAnswer,
  WorkersKaraokeStreamAnswerSchema,
  type WorkersKaraokeStreamRequest,
  type WorkersKaraokeVoicePitch,
  WorkersKaraokeVoicePitchSchema,
  type WorkersSingGpuContext,
  WorkersSingGpuStatusSchema,
  type WorkersSingJob,
  WorkersSingJobReplySchema,
  type WorkersSingJobRequestIn,
  WorkersSingJobSchema,
  type WorkersSingSongMeta,
  WorkersSingSongMetaSchema,
} from "@miyoria/contracts/workers";
import type { Endpoint, EndpointSource } from "./endpoints.js";

export const SongMetaSchema = WorkersSingSongMetaSchema;
export type SongMeta = WorkersSingSongMeta;

export const GpuStatusSchema = WorkersSingGpuStatusSchema;

export const WorkerJobSchema = WorkersSingJobSchema;
export type WorkerJob = WorkersSingJob;

/** What a request names: a search, a link or a file of the worker's song library. */
export type SongQuery = WorkersSingJobRequestIn;

/**
 * What only Core knows, for the worker's GPU decisions: who would notice her going quiet, and which
 * jobs are needed now. Sent on every poll; without it for a while the worker assumes people.
 */
export type GpuContext = WorkersSingGpuContext;

/** The two tracks Core streams: the mix, and the converted vocal her mouth follows. */
export type SongTrack = (typeof WORKERS_SING_PCM_TRACKS)[number];

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
  /** Saves one of a karaoke song's files (`GET /karaoke/{id}/files/{name}`) to `dest`. */
  karaokeFile(song: string, file: string, dest: string, signal?: AbortSignal): Promise<void>;
  /** Has a karaoke song's backing made in another key (`POST /karaoke/{id}/keys`). */
  karaokeKey(
    song: string,
    semitones: number,
    signal?: AbortSignal,
  ): Promise<WorkersKaraokeKeyReply>;
  /**
   * The pitch of a singer's recording (`POST /karaoke/voice`, the raw recording as the body): any
   * worker can read it; it deletes the recording before it answers.
   */
  karaokeVoice(
    bytes: Uint8Array,
    type: string,
    signal?: AbortSignal,
  ): Promise<WorkersKaraokeVoicePitch>;
  /** One batch of a karaoke room's live voice streams (`POST /karaoke/stream`). */
  karaokeStream(
    request: WorkersKaraokeStreamRequest,
    signal?: AbortSignal,
  ): Promise<WorkersKaraokeStreamAnswer>;
  /** `null` when healthy, else why not. */
  health(signal?: AbortSignal): Promise<string | null>;
}

/** Longest wait for the connection check after a submit timed out. */
const PROBE_MS = 3000;

/**
 * The request never left Core: there is no relay (`RelayUnavailableError` of `@miyoria/cluster`),
 * or the relay refused before sending (`RelayError` with `sent: false`: the host is not
 * connected, or too many requests to it are open).
 */
function relayUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "RelayUnavailableError") return true;
  return error.name === "RelayError" && (error as { sent?: unknown }).sent === false;
}

/** One song worker: an endpoint of Core's registry (`sing`). */
export class HttpSingWorker implements SingWorker {
  readonly #endpoint: Endpoint;
  readonly #source: EndpointSource;
  readonly #where: string;
  readonly #timeoutMs: number;

  constructor(endpoint: Endpoint, timeoutMs: number, source: EndpointSource) {
    this.#endpoint = endpoint;
    this.#source = source;
    this.#where =
      endpoint.via === "direct"
        ? endpoint.url.replace(/\/+$/, "")
        : `${endpoint.service} on ${endpoint.host} (over its control link)`;
    this.#timeoutMs = timeoutMs;
  }

  async #call(path: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const all = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.#source.request(this.#endpoint, path, { ...init, signal: all });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new SingWorkerError(`song worker unreachable at ${this.#where}: ${String(error)}`, {
        cause: error,
        unreachable: true,
        maybeReceived: !neverConnected(error) && !relayUnavailable(error),
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
    const parsed = WorkersSingJobReplySchema.safeParse(await res.json());
    if (!parsed.success) throw new SingWorkerError("song worker sent a malformed job");
    return parsed.data.job;
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
      // instead of refusing it, so the request timeout fires first). Only a direct endpoint can be
      // probed; over a control link the relay's own error is the answer.
      if (
        error instanceof SingWorkerError &&
        error.maybeReceived &&
        this.#endpoint.via === "direct" &&
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
    let url: URL;
    try {
      url = new URL(this.#endpoint.url);
    } catch {
      return Promise.resolve(false);
    }
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

  download(song: string, file: string, dest: string, signal?: AbortSignal): Promise<void> {
    // A video is far bigger than the audio (up to `SING_VIDEO_MAX_MB`): allow it a long time.
    return this.#save(
      `/songs/${encodeURIComponent(song)}/files/${encodeURIComponent(file)}`,
      Math.max(this.#timeoutMs * 60, 600_000),
      dest,
      signal,
    );
  }

  karaokeFile(song: string, file: string, dest: string, signal?: AbortSignal): Promise<void> {
    // A backing track is a few MB of AAC.
    return this.#save(
      `/karaoke/${encodeURIComponent(song)}/files/${encodeURIComponent(file)}`,
      this.#timeoutMs * 10,
      dest,
      signal,
    );
  }

  async karaokeKey(
    song: string,
    semitones: number,
    signal?: AbortSignal,
  ): Promise<WorkersKaraokeKeyReply> {
    // Rubber Band on a whole song takes a while on the worker's CPU.
    const res = await this.#call(
      `/karaoke/${encodeURIComponent(song)}/keys`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ semitones }),
      },
      Math.max(this.#timeoutMs * 20, 180_000),
      signal,
    );
    const parsed = WorkersKaraokeKeyReplySchema.safeParse(await res.json());
    if (!parsed.success) throw new SingWorkerError("song worker sent a malformed key answer");
    return parsed.data;
  }

  async karaokeVoice(
    bytes: Uint8Array,
    type: string,
    signal?: AbortSignal,
  ): Promise<WorkersKaraokeVoicePitch> {
    // Reading the pitch of a song-long recording takes seconds on the card, more on the CPU.
    const res = await this.#call(
      "/karaoke/voice",
      { method: "POST", headers: { "content-type": type }, body: bytes as Uint8Array<ArrayBuffer> },
      Math.max(this.#timeoutMs * 20, 180_000),
      signal,
    );
    const parsed = WorkersKaraokeVoicePitchSchema.safeParse(await res.json());
    if (!parsed.success) throw new SingWorkerError("song worker sent a malformed pitch");
    return parsed.data;
  }

  async karaokeStream(
    request: WorkersKaraokeStreamRequest,
    signal?: AbortSignal,
  ): Promise<WorkersKaraokeStreamAnswer> {
    // The caller bounds it (a batch every half second): a slow answer is dropped by its signal.
    const res = await this.#call(
      "/karaoke/stream",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      },
      this.#timeoutMs,
      signal,
    );
    const parsed = WorkersKaraokeStreamAnswerSchema.safeParse(await res.json());
    if (!parsed.success) throw new SingWorkerError("song worker sent a malformed stream answer");
    return parsed.data;
  }

  async #save(path: string, timeoutMs: number, dest: string, signal?: AbortSignal): Promise<void> {
    const res = await this.#call(path, {}, timeoutMs, signal);
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
      const body = WorkersHealthSchema.safeParse(await res.json());
      return body.success && body.data.status === "ok" ? null : "song worker is not ok";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
}
