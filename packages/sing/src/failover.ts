// Several song workers in order of preference (the `sing` endpoints of Core's registry: e.g. a
// friend's GPU over Tailscale first and the worker on this machine when that one does not answer).
// New songs go to the first worker that answers; a song stays with the worker that made it (its
// files live there), and is made again on the next one only when that worker stays unreachable.
// A job left behind that way is cancelled on its worker once it answers again.
//
// The list changes while Core runs (`update`): a worker keeps what it holds as long as it keeps
// its id (or its URL, when only the id changed), and one that is no longer listed counts as gone,
// as one unreachable for too long. With a single worker none of the failover rules apply: it is
// used as it is.
//
// The list comes in the registry's order, which for the `job` class is its dispatch order
// (docs/design/v5-hostd.md §15): the worker that would have a new song back soonest first. A worker
// may be listed without taking new work (`takesWork: false`: drained, excluded, her speech host):
// it gets no new song, but the songs, jobs and karaoke files it holds are still fetched from it.
// Each new song is a unit the registry counts against its worker (`reserve`) until its job ends,
// so two songs asked together go to two idle workers.

import type {
  WorkersKaraokeKeyReply,
  WorkersKaraokeStreamAnswer,
  WorkersKaraokeStreamRequest,
  WorkersKaraokeVoicePitch,
} from "@miyoria/contracts/workers";
import {
  type GpuContext,
  type SingWorker,
  SingWorkerError,
  type SongMeta,
  type SongQuery,
  type SongTrack,
  type WorkerJob,
} from "./client.js";
import type { EndpointUnit } from "./endpoints.js";

export interface FailoverOptions {
  /**
   * An unreachable worker is passed over this long before it is tried again, and a song whose
   * worker has been unreachable this long counts as gone (the singer asks the next one).
   */
  retryMs: number;
  now?: () => number;
  /** Told when a worker is found unreachable (by its id): the registry rests it too. */
  failed?: (id: string, error: unknown) => void;
  /**
   * Asked before the list is read: the owner calls `update` when the workers known now are not
   * the ones listed. A list that was empty when it was made (the registry of another module was
   * not there yet) would otherwise stay empty, since nothing else asks again.
   */
  refresh?: () => void;
  /**
   * A new unit goes to the worker of this id (a song, a recording to read): the registry counts
   * it there until `done`. `null`: nothing is counted.
   */
  reserve?: (id: string, what?: string) => EndpointUnit | null;
  /** Where a karaoke room's voice streams should run: the id of a listed worker, or `null`. */
  openSession?: (room: string) => string | null;
}

/** One worker of the list. */
export interface FailoverEntry {
  /** What stays the same when it restarts elsewhere (default `name`). */
  id?: string;
  /** For messages (its URL). */
  name: string;
  /** Where it is now: a worker listed under a new id at the same URL is the same worker. */
  url?: string;
  worker: SingWorker;
  /** It takes new work now (default `true`); otherwise only what it holds is asked of it. */
  takesWork?: boolean;
}

interface Endpoint {
  id: string;
  name: string;
  url: string | null;
  worker: SingWorker;
  /** Unreachable since (`null`: it answered last time). */
  downSince: number | null;
  /** Last time it was found unreachable. */
  lastFail: number;
  /** No longer listed: whatever it holds counts as gone. */
  gone: boolean;
  takesWork: boolean;
}

/** Job states after which a job's unit is over. */
const ENDED: ReadonlySet<string> = new Set(["done", "failed", "cancelled"]);

function sameUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

export class FailoverSingWorker implements SingWorker {
  #all: Endpoint[] = [];
  /** Every worker ever listed, by id (the gone ones too: jobs and songs still point at them). */
  readonly #known = new Map<string, Endpoint>();
  readonly #retryMs: number;
  readonly #now: () => number;
  readonly #failed: ((id: string, error: unknown) => void) | null;
  #refresh: (() => void) | null = null;
  readonly #reserve: FailoverOptions["reserve"] | null;
  readonly #openSession: FailoverOptions["openSession"] | null;
  /** The registry's count of each job Core sent, until the job ends. */
  readonly #units = new Map<string, EndpointUnit>();
  /** When each of those jobs was first seen running (its run time is from there to its end). */
  readonly #running = new Map<string, number>();
  /** Which worker took a job / has a song, as answers come in (lost on restart, then searched). */
  readonly #jobs = new Map<string, Endpoint>();
  readonly #songs = new Map<string, Endpoint>();
  /** Which worker made a karaoke song (its own namespace on the worker: never in `songs()`). */
  readonly #karaoke = new Map<string, Endpoint>();
  /** The worker each karaoke room streams its singers' voices to. */
  readonly #streams = new Map<string, Endpoint>();
  /** Jobs given up on (made again elsewhere, or cancelled while unreachable), to cancel later. */
  readonly #abandoned = new Map<string, Endpoint>();

  constructor(workers: readonly FailoverEntry[], options: FailoverOptions) {
    this.#retryMs = options.retryMs;
    this.#now = options.now ?? Date.now;
    this.#failed = options.failed ?? null;
    this.#reserve = options.reserve ?? null;
    this.#openSession = options.openSession ?? null;
    this.update(workers);
    this.#refresh = options.refresh ?? null;
  }

  /** The list as it is now, after asking the owner whether it changed. */
  #list(): Endpoint[] {
    this.#refresh?.();
    return this.#all;
  }

  /** The workers in order of preference now. */
  update(workers: readonly FailoverEntry[]): void {
    const ids = new Set(workers.map((w) => w.id ?? w.name));
    const next: Endpoint[] = [];
    for (const w of workers) {
      const id = w.id ?? w.name;
      let ep = this.#known.get(id);
      if (ep === undefined && w.url !== undefined) {
        // Listed under another id at the same address (a hostd now reports what a static entry
        // named): the same worker, with what it holds.
        const url = sameUrl(w.url);
        ep = [...this.#known.values()].find(
          (e) => e.url !== null && sameUrl(e.url) === url && !ids.has(e.id),
        );
        if (ep !== undefined) {
          this.#known.delete(ep.id);
          ep.id = id;
          this.#known.set(id, ep);
        }
      }
      if (ep === undefined) {
        ep = {
          id,
          name: w.name,
          url: w.url ?? null,
          worker: w.worker,
          downSince: null,
          lastFail: 0,
          gone: false,
          takesWork: w.takesWork !== false,
        };
        this.#known.set(id, ep);
      } else {
        ep.name = w.name;
        ep.url = w.url ?? null;
        ep.worker = w.worker;
        ep.gone = false;
        ep.takesWork = w.takesWork !== false;
      }
      if (!next.includes(ep)) next.push(ep);
    }
    for (const ep of this.#known.values()) if (!next.includes(ep)) ep.gone = true;
    this.#all = next;
  }

  /** More than one worker: the failover rules apply. */
  get #failover(): boolean {
    return this.#all.length > 1;
  }

  /** Where new work goes now: the first worker that answers and takes new work. */
  current(): string | null {
    return this.#list().find((ep) => ep.downSince === null && ep.takesWork)?.name ?? null;
  }

  async submit(query: SongQuery, signal?: AbortSignal): Promise<WorkerJob> {
    let last: unknown = null;
    for (const ep of this.#fresh()) {
      // Counted there before the request goes out: a song asked at the same moment goes elsewhere.
      const unit =
        this.#reserve?.(ep.id, query.title ?? query.query ?? query.url ?? undefined) ?? null;
      try {
        const job = await this.#attempt(ep, (w) => w.submit(query, signal));
        unit?.accepted();
        this.#own(ep, job);
        if (unit !== null) this.#units.set(job.id, unit);
        this.#settle(job);
        return job;
      } catch (error) {
        unit?.done({ ok: false });
        // A timed-out request may have reached the worker: sending it to the next one could make
        // the song twice, so the singer hears about it as with a single worker.
        if (!isUnreachable(error) || maybeReceived(error)) throw error;
        last = error;
      }
    }
    throw last ?? unreachable(this.#noWorker());
  }

  /** Why there is nobody to send new work to. */
  #noWorker(): string {
    if (this.#all.length === 0) return NO_WORKER;
    if (!this.#all.some((ep) => ep.takesWork)) return "no song worker takes new work now";
    return "no song worker answers";
  }

  /**
   * What a poll says of a job Core sent: when it started running, and once it ended its unit is
   * over, with how long it ran (from the first poll that saw it running, so to a poll's interval).
   */
  #settle(job: WorkerJob): void {
    const unit = this.#units.get(job.id);
    if (unit === undefined) return;
    if (job.state === "running" && !this.#running.has(job.id)) {
      this.#running.set(job.id, this.#now());
    }
    if (!ENDED.has(job.state)) return;
    const since = this.#running.get(job.id);
    this.#units.delete(job.id);
    this.#running.delete(job.id);
    const ran = since === undefined ? 0 : this.#now() - since;
    // A job never seen running (a cached song, one that failed at once) teaches nothing.
    unit.done(job.state === "done" && ran > 0 ? { ok: true, run_ms: ran } : { ok: false });
  }

  /** A job Core gave up on (cancelled, lost): its unit is over without a time. */
  #drop(id: string): void {
    this.#units.get(id)?.done({ ok: false });
    this.#units.delete(id);
    this.#running.delete(id);
  }

  async job(id: string, signal?: AbortSignal): Promise<WorkerJob> {
    const owner = this.#jobs.get(id);
    if (owner === undefined) {
      const [ep, job] = await this.#find(this.#all, (w) => w.job(id, signal));
      this.#own(ep, job);
      this.#settle(job);
      return job;
    }
    if (this.#dead(owner)) {
      // Unreachable long enough, and it failed again a moment ago (polling another of its songs):
      // no need to wait for one more try. The singer asks again and the next worker makes it.
      if (this.#resting(owner)) throw this.#lose(id, owner);
    } else if (this.#resting(owner)) {
      // Not asked while resting (each try waits for the timeout).
      throw unreachable(`the song worker at ${owner.name} is unreachable`);
    }
    try {
      const job = await this.#attempt(owner, (w) => w.job(id, signal));
      this.#own(owner, job);
      this.#settle(job);
      return job;
    } catch (error) {
      if (isUnreachable(error) && this.#dead(owner)) throw this.#lose(id, owner, error);
      throw error;
    }
  }

  async cancel(id: string): Promise<void> {
    const owner = this.#jobs.get(id);
    this.#jobs.delete(id);
    this.#drop(id);
    try {
      await this.#forJob(id, owner, (w) => w.cancel(id));
    } catch (error) {
      // Its worker is away: the job may still be running there, so cancel it when it is back.
      if (owner !== undefined && isUnreachable(error) && (this.#failover || owner.gone)) {
        this.#abandoned.set(id, owner);
      }
      throw error;
    }
  }

  async goExclusive(id: string): Promise<void> {
    await this.#forJob(id, this.#jobs.get(id), (w) => w.goExclusive(id));
  }

  /** Every worker that answers hears who is listening (any of them may be making a song). */
  async context(context: GpuContext, signal?: AbortSignal): Promise<void> {
    const results = await Promise.allSettled(
      this.#candidates().map((ep) => this.#attempt(ep, (w) => w.context(context, signal))),
    );
    if (results.every((r) => r.status === "rejected")) {
      throw (results[0] as PromiseRejectedResult | undefined)?.reason ?? unreachable(NO_WORKER);
    }
  }

  /** The songs of every worker that answers, the preferred worker's first, each id once. */
  async songs(signal?: AbortSignal): Promise<SongMeta[]> {
    const eps = this.#candidates();
    const results = await Promise.allSettled(
      eps.map((ep) => this.#attempt(ep, (w) => w.songs(signal))),
    );
    if (results.every((r) => r.status === "rejected")) {
      throw (results[0] as PromiseRejectedResult | undefined)?.reason ?? unreachable(NO_WORKER);
    }
    const seen = new Set<string>();
    const out: SongMeta[] = [];
    results.forEach((r, i) => {
      if (r.status !== "fulfilled") return;
      const ep = eps[i] as Endpoint;
      for (const song of r.value) {
        if (seen.has(song.id)) continue;
        seen.add(song.id);
        if (!this.#songs.has(song.id)) this.#songs.set(song.id, ep);
        out.push(song);
      }
    });
    return out;
  }

  audio(song: string, track: SongTrack, signal?: AbortSignal): Promise<Int16Array> {
    return this.#forSong(song, (w) => w.audio(song, track, signal));
  }

  download(song: string, file: string, dest: string, signal?: AbortSignal): Promise<void> {
    return this.#forSong(song, (w) => w.download(song, file, dest, signal));
  }

  /** From the worker that made it when known, else the first that has it. */
  async karaokeFile(song: string, file: string, dest: string, signal?: AbortSignal): Promise<void> {
    const owner = this.#karaoke.get(song);
    const order =
      owner === undefined ? this.#all : [owner, ...this.#all.filter((e) => e !== owner)];
    const [ep] = await this.#find(order, (w) => w.karaokeFile(song, file, dest, signal));
    this.#karaoke.set(song, ep);
  }

  /** On the worker that made it when known, else the first that has it. */
  async karaokeKey(
    song: string,
    semitones: number,
    signal?: AbortSignal,
  ): Promise<WorkersKaraokeKeyReply> {
    const owner = this.#karaoke.get(song);
    const order =
      owner === undefined ? this.#all : [owner, ...this.#all.filter((e) => e !== owner)];
    const [ep, reply] = await this.#find(order, (w) => w.karaokeKey(song, semitones, signal));
    this.#karaoke.set(song, ep);
    return reply;
  }

  /**
   * Any worker can read a recording: the first that answers, as for a new job. A timed-out one is
   * not asked again elsewhere (it may be reading it: the recording is not sent twice).
   */
  async karaokeVoice(
    bytes: Uint8Array,
    type: string,
    signal?: AbortSignal,
  ): Promise<WorkersKaraokeVoicePitch> {
    let last: unknown = null;
    for (const ep of this.#fresh()) {
      const unit = this.#reserve?.(ep.id, "karaoke voice") ?? null;
      try {
        const pitch = await this.#attempt(ep, (w) => w.karaokeVoice(bytes, type, signal));
        // Counted while it runs; a recording's few seconds say nothing of a song's time.
        unit?.done({ ok: false });
        return pitch;
      } catch (error) {
        unit?.done({ ok: false });
        if (!isUnreachable(error) || maybeReceived(error)) throw error;
        last = error;
      }
    }
    throw last ?? unreachable(this.#noWorker());
  }

  /**
   * A karaoke room's live voice streams go to one worker for the whole room (their audio lives
   * there): the first that answers the room's first batch. That worker away, the batch fails at
   * once; the room is never moved to another (the streams would start over half way).
   */
  async karaokeStream(
    request: WorkersKaraokeStreamRequest,
    signal?: AbortSignal,
  ): Promise<WorkersKaraokeStreamAnswer> {
    const owner = this.#streams.get(request.room);
    if (owner !== undefined) {
      if (this.#resting(owner)) {
        throw unreachable(`the song worker at ${owner.name} is unreachable (room ${request.room})`);
      }
      return this.#attempt(owner, (w) => w.karaokeStream(request, signal));
    }
    const fresh = this.#fresh();
    // Where the registry says the room's session should run, else the first that takes work.
    const placed = this.#openSession?.(request.room) ?? null;
    const ep = fresh.find((e) => e.id === placed) ?? fresh[0];
    if (ep === undefined) throw unreachable(this.#noWorker());
    this.#streams.set(request.room, ep);
    while (this.#streams.size > MAX_STREAM_ROOMS) {
      this.#streams.delete(this.#streams.keys().next().value as string);
    }
    return this.#attempt(ep, (w) => w.karaokeStream(request, signal));
  }

  /** Healthy while any worker is; otherwise why each one is not. */
  async health(signal?: AbortSignal): Promise<string | null> {
    const all = this.#list();
    if (all.length === 0) return NO_WORKER;
    const whys = await Promise.all(all.map((ep) => ep.worker.health(signal)));
    const now = this.#now();
    whys.forEach((why, i) => {
      const ep = all[i] as Endpoint;
      if (why === null) this.#up(ep);
      else this.#down(ep, now, new Error(why));
    });
    if (whys.some((why) => why === null)) return null;
    if (all.length === 1) return whys[0] ?? null;
    return all.map((ep, i) => `${ep.name}: ${whys[i]}`).join("; ");
  }

  // ----- routing -----

  /**
   * Workers for new work: those that take it and are not passed over right now, or all that take
   * it when none of them is left.
   */
  #fresh(): Endpoint[] {
    const now = this.#now();
    const taking = this.#list().filter((ep) => ep.takesWork);
    const up = taking.filter((ep) => !this.#resting(ep, now));
    return up.length > 0 ? up : taking;
  }

  /** Workers to ask about what they hold: those not passed over right now, or all of them. */
  #candidates(): Endpoint[] {
    const now = this.#now();
    const all = this.#list();
    const up = all.filter((ep) => !this.#resting(ep, now));
    return up.length > 0 ? up : all;
  }

  /** Found unreachable a moment ago: not asked again until `retryMs` passed. Gone: never. */
  #resting(ep: Endpoint, now = this.#now()): boolean {
    if (ep.gone) return true;
    if (!this.#failover) return false;
    return ep.downSince !== null && now - ep.lastFail < this.#retryMs;
  }

  /** Unreachable for `retryMs` or longer, or no longer listed: whatever it holds counts as gone. */
  #dead(ep: Endpoint): boolean {
    if (ep.gone) return true;
    if (!this.#failover) return false;
    return ep.downSince !== null && this.#now() - ep.downSince >= this.#retryMs;
  }

  #downSecs(ep: Endpoint): number {
    return ep.downSince === null ? 0 : Math.round((this.#now() - ep.downSince) / 1000);
  }

  async #attempt<T>(ep: Endpoint, use: (w: SingWorker) => Promise<T>): Promise<T> {
    try {
      const value = await use(ep.worker);
      this.#up(ep);
      return value;
    } catch (error) {
      if (isUnreachable(error)) this.#down(ep, this.#now(), error);
      else if (error instanceof SingWorkerError) this.#up(ep); // it answered, with an error
      throw error;
    }
  }

  #down(ep: Endpoint, now: number, error: unknown): void {
    ep.downSince ??= now;
    ep.lastFail = now;
    this.#failed?.(ep.id, error);
  }

  /** It answers (again): jobs left behind on it are cancelled. */
  #up(ep: Endpoint): void {
    ep.downSince = null;
    for (const [id, owner] of this.#abandoned) {
      if (owner !== ep) continue;
      this.#abandoned.delete(id);
      ep.worker.cancel(id).catch((error: unknown) => {
        if (isUnreachable(error)) this.#abandoned.set(id, ep); // away again: next time
      });
    }
  }

  /** The job counts as gone (404: the singer asks again); cancelled once its worker is back. */
  #lose(id: string, owner: Endpoint, cause?: unknown): SingWorkerError {
    this.#jobs.delete(id);
    this.#drop(id);
    this.#abandoned.set(id, owner);
    return new SingWorkerError(
      owner.gone
        ? `the song worker at ${owner.name} is gone`
        : `the song worker at ${owner.name} has been unreachable for ${this.#downSecs(owner)} s`,
      { status: 404, cause },
    );
  }

  /**
   * The first worker in `order` that has it. A worker that says 404 does not; one that does not
   * answer might, so the caller waits for it (an unreachable error) unless it counts as gone.
   */
  async #find<T>(order: Endpoint[], use: (w: SingWorker) => Promise<T>): Promise<[Endpoint, T]> {
    // No worker at all: wait for one, as for a worker that does not answer.
    if (this.#all.length === 0) throw unreachable(NO_WORKER);
    let waitFor: unknown = null;
    let missing: unknown = null;
    for (const ep of order) {
      if (this.#resting(ep)) {
        if (!this.#dead(ep))
          waitFor ??= unreachable(`the song worker at ${ep.name} is unreachable`);
        continue;
      }
      try {
        return [ep, await this.#attempt(ep, use)];
      } catch (error) {
        if (isNotFound(error)) missing ??= error;
        else if (isUnreachable(error)) {
          if (!this.#dead(ep)) waitFor ??= error;
        } else throw error;
      }
    }
    throw waitFor ?? missing ?? new SingWorkerError("no song worker has it", { status: 404 });
  }

  async #forJob<T>(
    id: string,
    owner: Endpoint | undefined,
    use: (w: SingWorker) => Promise<T>,
  ): Promise<T> {
    if (owner === undefined) {
      const [, value] = await this.#find(this.#all, use);
      return value;
    }
    // Resting: fail at once instead of waiting for the timeout.
    if (this.#resting(owner)) {
      throw unreachable(`the song worker at ${owner.name} is unreachable (job ${id})`);
    }
    return this.#attempt(owner, use);
  }

  async #forSong<T>(song: string, use: (w: SingWorker) => Promise<T>): Promise<T> {
    const owner = this.#songs.get(song);
    const order =
      owner === undefined ? this.#all : [owner, ...this.#all.filter((e) => e !== owner)];
    const [ep, value] = await this.#find(order, use);
    this.#songs.set(song, ep);
    return value;
  }

  #own(ep: Endpoint, job: WorkerJob): void {
    this.#jobs.set(job.id, ep);
    if (job.song_id !== null) this.#songs.set(job.song_id, ep);
    if (job.karaoke) this.#karaoke.set(job.karaoke.id, ep);
  }
}

const NO_WORKER = "no song worker is known";
/** Karaoke rooms whose stream worker is remembered (far more than ever sing at once). */
const MAX_STREAM_ROOMS = 64;

function isUnreachable(error: unknown): boolean {
  return error instanceof SingWorkerError && error.unreachable;
}

function maybeReceived(error: unknown): boolean {
  return error instanceof SingWorkerError && error.maybeReceived;
}

function isNotFound(error: unknown): boolean {
  return error instanceof SingWorkerError && error.status === 404;
}

function unreachable(message: string): SingWorkerError {
  return new SingWorkerError(message, { unreachable: true });
}
