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

import {
  type GpuContext,
  type SingWorker,
  SingWorkerError,
  type SongMeta,
  type SongQuery,
  type SongTrack,
  type WorkerJob,
} from "./client.js";

export interface FailoverOptions {
  /**
   * An unreachable worker is passed over this long before it is tried again, and a song whose
   * worker has been unreachable this long counts as gone (the singer asks the next one).
   */
  retryMs: number;
  now?: () => number;
  /** Told when a worker is found unreachable (by its id): the registry rests it too. */
  failed?: (id: string, error: unknown) => void;
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
}

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
  /** Which worker took a job / has a song, as answers come in (lost on restart, then searched). */
  readonly #jobs = new Map<string, Endpoint>();
  readonly #songs = new Map<string, Endpoint>();
  /** Jobs given up on (made again elsewhere, or cancelled while unreachable), to cancel later. */
  readonly #abandoned = new Map<string, Endpoint>();

  constructor(workers: readonly FailoverEntry[], options: FailoverOptions) {
    this.#retryMs = options.retryMs;
    this.#now = options.now ?? Date.now;
    this.#failed = options.failed ?? null;
    this.update(workers);
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
        };
        this.#known.set(id, ep);
      } else {
        ep.name = w.name;
        ep.url = w.url ?? null;
        ep.worker = w.worker;
        ep.gone = false;
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

  /** Where new work goes now: the first worker that answers. */
  current(): string | null {
    return this.#all.find((ep) => ep.downSince === null)?.name ?? null;
  }

  async submit(query: SongQuery, signal?: AbortSignal): Promise<WorkerJob> {
    let last: unknown = null;
    for (const ep of this.#candidates()) {
      try {
        const job = await this.#attempt(ep, (w) => w.submit(query, signal));
        this.#own(ep, job);
        return job;
      } catch (error) {
        // A timed-out request may have reached the worker: sending it to the next one could make
        // the song twice, so the singer hears about it as with a single worker.
        if (!isUnreachable(error) || maybeReceived(error)) throw error;
        last = error;
      }
    }
    throw last ?? unreachable(this.#all.length === 0 ? NO_WORKER : "no song worker answers");
  }

  async job(id: string, signal?: AbortSignal): Promise<WorkerJob> {
    const owner = this.#jobs.get(id);
    if (owner === undefined) {
      const [ep, job] = await this.#find(this.#all, (w) => w.job(id, signal));
      this.#own(ep, job);
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
      return job;
    } catch (error) {
      if (isUnreachable(error) && this.#dead(owner)) throw this.#lose(id, owner, error);
      throw error;
    }
  }

  async cancel(id: string): Promise<void> {
    const owner = this.#jobs.get(id);
    this.#jobs.delete(id);
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

  /** Healthy while any worker is; otherwise why each one is not. */
  async health(signal?: AbortSignal): Promise<string | null> {
    const all = this.#all;
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

  /** Workers for new work: those not passed over right now, or all of them when none is left. */
  #candidates(): Endpoint[] {
    const now = this.#now();
    const up = this.#all.filter((ep) => !this.#resting(ep, now));
    return up.length > 0 ? up : this.#all;
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
  }
}

const NO_WORKER = "no song worker is known";

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
