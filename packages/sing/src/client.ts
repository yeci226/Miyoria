// HTTP client of the song worker (`workers/sing/server.py`, docs/protocols/voice-link.md
// 「歌曲 Worker」). Everything it returns about a song (title, artist, lyrics) comes from YouTube or
// lrclib and is untrusted. Every request goes through Core's endpoint registry (`request`), which
// adds the worker's token and relays it over a host's control link when the worker is not
// reachable directly.
//
// Files (a song's audio and video, a karaoke song's files) are bounded by progress, not by a total:
// the answer must come within the stall time, and then the bytes must keep coming (none for
// `stallMs` and the transfer is given up), so a slow link that works finishes however long the
// file is (2026-11-19: a 4-minute song's raw audio over a friend's home upload took longer than
// the 200 s the whole download was allowed). Each transfer logs its size, time and rate; a stalled
// one logs where it stopped. A file saved to disk is written to `<dest>.part` first and resumed
// from there (`range` with `if-range`) when it is asked for again after a broken transfer.

import {
  type FileHandle,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { connect } from "node:net";
import { dirname } from "node:path";
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
import { getLogger } from "@miyoria/runtime/kernel";
import type { Endpoint, EndpointSource } from "./endpoints.js";

const log = getLogger("sing");

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
  /**
   * Saves one of the song's files (its video, its audio) to `dest`; the worker may be on another
   * machine. A transfer that broke leaves `<dest>.part`, which the next call resumes when it can.
   */
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

/** How long a file transfer may go without a byte, by default. */
export const DEFAULT_STALL_MS = 30_000;

export interface HttpSingWorkerOptions {
  /**
   * A file transfer is given up when no byte came for this long (and when its answer took this
   * long, or the request timeout when that is longer). Default `DEFAULT_STALL_MS`.
   */
  stallMs?: number;
}

/** Where a transfer's bytes go. */
interface TransferSink {
  /**
   * The answer came: `status` 200 or 206 (`from`: where a 206 starts), the body's length when the
   * worker said it, and the file's validator (its ETag, else Last-Modified) when it sent one.
   */
  start(
    status: number,
    from: number,
    length: number | null,
    validator: string | null,
  ): Promise<void>;
  write(chunk: Uint8Array): Promise<void> | void;
}

/** The body's length (`content-length`), or `null`. */
function lengthOf(res: Response): number | null {
  const raw = res.headers.get("content-length");
  if (raw === null || !/^\d+$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

/** Where a 206 answer starts (`content-range: bytes <from>-<to>/<size>`), or -1. */
function rangeStart(res: Response): number {
  const m = /^bytes\s+(\d+)-\d+\/(?:\d+|\*)$/.exec((res.headers.get("content-range") ?? "").trim());
  return m === null ? -1 : Number(m[1]);
}

/** s16le bytes as samples. */
export function pcmOf(bytes: Uint8Array): Int16Array {
  const n = bytes.byteLength >> 1;
  if (LITTLE_ENDIAN && bytes.byteOffset % 2 === 0) {
    return new Int16Array(bytes.buffer, bytes.byteOffset, n).slice();
  }
  const out = new Int16Array(n);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** One song worker: an endpoint of Core's registry (`sing`). */
export class HttpSingWorker implements SingWorker {
  readonly #endpoint: Endpoint;
  readonly #source: EndpointSource;
  readonly #where: string;
  readonly #timeoutMs: number;
  readonly #stallMs: number;

  constructor(
    endpoint: Endpoint,
    timeoutMs: number,
    source: EndpointSource,
    options: HttpSingWorkerOptions = {},
  ) {
    this.#endpoint = endpoint;
    this.#source = source;
    this.#where =
      endpoint.via === "direct"
        ? endpoint.url.replace(/\/+$/, "")
        : `${endpoint.service} on ${endpoint.host} (over its control link)`;
    this.#timeoutMs = timeoutMs;
    this.#stallMs = options.stallMs ?? DEFAULT_STALL_MS;
  }

  /** `timeoutMs` `null`: the caller's `signal` bounds it (a file transfer, see `#transfer`). */
  async #call(path: string, init: RequestInit, timeoutMs: number | null, signal?: AbortSignal) {
    const timeout = timeoutMs === null ? null : AbortSignal.timeout(timeoutMs);
    const all = timeout === null ? signal : signal ? AbortSignal.any([signal, timeout]) : timeout;
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

  /** A call whose answer is not read: its body is let go, so the connection is free at once. */
  async #send(path: string, init: RequestInit, signal?: AbortSignal): Promise<void> {
    const res = await this.#call(path, init, this.#timeoutMs, signal);
    await res.body?.cancel().catch(() => undefined);
  }

  async cancel(id: string): Promise<void> {
    await this.#send(`/jobs/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async goExclusive(id: string): Promise<void> {
    await this.#send(`/jobs/${encodeURIComponent(id)}/exclusive`, { method: "POST" });
  }

  async context(context: GpuContext, signal?: AbortSignal): Promise<void> {
    await this.#send(
      "/gpu/context",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(context),
      },
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
    let bytes = new Uint8Array(0);
    let at = 0;
    await this.#transfer(
      `/songs/${encodeURIComponent(song)}/files/${track}`,
      `${song}/${track}`,
      {},
      {
        start: async (_status, _from, total) => {
          // The length as said, within reason; it grows if more comes.
          bytes = new Uint8Array(Math.min(total ?? 1024 * 1024, 256 * 1024 * 1024));
        },
        write: (chunk) => {
          if (at + chunk.byteLength > bytes.byteLength) {
            const grown = new Uint8Array(Math.max(bytes.byteLength * 2, at + chunk.byteLength));
            grown.set(bytes.subarray(0, at));
            bytes = grown;
          }
          bytes.set(chunk, at);
          at += chunk.byteLength;
        },
      },
      signal,
    );
    return pcmOf(bytes.subarray(0, at));
  }

  download(song: string, file: string, dest: string, signal?: AbortSignal): Promise<void> {
    return this.#save(
      `/songs/${encodeURIComponent(song)}/files/${encodeURIComponent(file)}`,
      `${song}/${file}`,
      dest,
      signal,
    );
  }

  karaokeFile(song: string, file: string, dest: string, signal?: AbortSignal): Promise<void> {
    return this.#save(
      `/karaoke/${encodeURIComponent(song)}/files/${encodeURIComponent(file)}`,
      `karaoke ${song}/${file}`,
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

  /**
   * Saves a file to `dest` through `<dest>.part`. The part of a broken transfer is kept with the
   * file's validator (`<dest>.part.tag`: its ETag, or Last-Modified) and resumed by the next call
   * with `range` and `if-range`: a worker whose file changed since sends it whole (200), as does
   * one that cannot resume, and a range it refuses (416) starts the file over once.
   */
  async #save(path: string, what: string, dest: string, signal?: AbortSignal): Promise<void> {
    await mkdir(dirname(dest), { recursive: true });
    const part = `${dest}.part`;
    const tagFile = `${part}.tag`;
    for (let fresh = false; ; fresh = true) {
      const tag = fresh ? null : await readFile(tagFile, "utf8").catch(() => null);
      const have = tag === null ? 0 : ((await stat(part).catch(() => null))?.size ?? 0);
      const headers: Record<string, string> =
        tag !== null && have > 0 ? { range: `bytes=${have}-`, "if-range": tag } : {};
      const out: { file: FileHandle | null } = { file: null };
      try {
        await this.#transfer(
          path,
          what,
          headers,
          {
            start: async (status, from, _length, validator) => {
              if (status === 206 && (have === 0 || from !== have)) {
                throw new SingWorkerError(`a range of ${what} that was not asked for`, {
                  status: 416,
                });
              }
              // 206: the rest of the part. 200: the file whole, over whatever part there was.
              out.file = await open(part, status === 206 ? "a" : "w");
              if (validator !== null) await writeFile(tagFile, validator);
              else await rm(tagFile, { force: true });
            },
            write: async (chunk) => {
              await out.file?.write(chunk);
            },
          },
          signal,
        );
        await out.file?.close();
        out.file = null;
        await rename(part, dest);
        await rm(tagFile, { force: true });
        return;
      } catch (error) {
        await out.file?.close().catch(() => {});
        if (!fresh && error instanceof SingWorkerError && error.status === 416) {
          await rm(part, { force: true });
          await rm(tagFile, { force: true });
          continue;
        }
        // A part with its validator is kept for the next call; one without cannot be resumed.
        if ((await readFile(tagFile, "utf8").catch(() => null)) === null) {
          await rm(part, { force: true });
        }
        throw error;
      }
    }
  }

  /**
   * One file transfer: the answer within the stall time (or the request timeout when that is
   * longer), then the body with no gap of `stallMs` between bytes; the bytes go to `sink`. Logs the
   * size, time and rate when it is complete, and how far it got when it stalled.
   */
  async #transfer(
    path: string,
    what: string,
    headers: Record<string, string>,
    sink: TransferSink,
    signal?: AbortSignal,
  ): Promise<void> {
    const where = this.#where;
    const t0 = performance.now();
    const seconds = () => Math.round((performance.now() - t0) / 100) / 10;
    const stop = new AbortController();
    const all = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
    const headMs = Math.max(this.#timeoutMs, this.#stallMs);
    let received = 0;
    let timer = setTimeout(() => {
      stop.abort(
        new SingWorkerError(`song worker at ${where} did not answer for ${what} in ${headMs} ms`, {
          unreachable: true,
          maybeReceived: true,
        }),
      );
    }, headMs);
    try {
      const res = await this.#call(path, { headers }, null, all);
      if (res.body === null) throw new SingWorkerError("song worker sent an empty file");
      const total = lengthOf(res);
      const from = res.status === 206 ? rangeStart(res) : 0;
      const validator = res.headers.get("etag") ?? res.headers.get("last-modified");
      await sink.start(res.status, from, total, validator);
      // From here only progress counts: no byte for `stallMs` and it is given up.
      clearTimeout(timer);
      timer = setTimeout(() => {
        log.warn(
          { worker: where, file: what, bytes: received, seconds: seconds() },
          "a song worker file stopped arriving",
        );
        stop.abort(
          new SingWorkerError(
            `${what} stopped arriving from ${where}: ${received} bytes in ${seconds()} s, then ` +
              `nothing for ${Math.round(this.#stallMs / 1000)} s`,
            { unreachable: true, maybeReceived: true },
          ),
        );
      }, this.#stallMs);
      const reader = res.body.getReader();
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          timer.refresh();
          received += next.value.byteLength;
          await sink.write(next.value);
        }
      } finally {
        reader.releaseLock();
      }
      if (total !== null && received !== total) {
        throw new SingWorkerError(
          `${what} from ${where} ended after ${received} of ${total} bytes`,
          {
            unreachable: true,
            maybeReceived: true,
          },
        );
      }
      const secs = seconds();
      log.info(
        {
          worker: where,
          file: what,
          bytes: received,
          ...(from > 0 ? { resumed_at: from } : {}),
          seconds: secs,
          mbit_s: secs > 0 ? Math.round(((received * 8) / 1e6 / secs) * 100) / 100 : null,
        },
        "song worker file fetched",
      );
    } catch (error) {
      // The stall (or the wait for the answer) is the reason, not the abort it caused.
      if (stop.signal.aborted && !signal?.aborted) throw stop.signal.reason;
      throw error;
    } finally {
      clearTimeout(timer);
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
