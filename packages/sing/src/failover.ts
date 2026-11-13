// Several song workers in order of preference (`[modules.sing] url`, then `fallback_urls`), e.g. a
// friend's GPU over Tailscale first and the worker on this machine when that one does not answer.
// New songs go to the first worker that answers; a song stays with the worker that made it (its
// files live there), and is made again on the next one only when that worker stays unreachable.
// A job left behind that way is cancelled on its worker once it answers again.

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
}

interface Endpoint {
  name: string;
  worker: SingWorker;
  /** Unreachable since (`null`: it answered last time). */
  downSince: number | null;
  /** Last time it was found unreachable. */
  lastFail: number;
}

export class FailoverSingWorker implements SingWorker {
  readonly #all: Endpoint[];
  readonly #retryMs: number;
  readonly #now: () => number;
  /** Which worker took a job / has a song, as answers come in (lost on restart, then searched). */
  readonly #jobs = new Map<string, Endpoint>();
  readonly #songs = new Map<string, Endpoint>();
  /** Jobs given up on (made again elsewhere, or cancelled while unreachable), to cancel later. */
  readonly #abandoned = new Map<string, Endpoint>();

  constructor(workers: { name: string; worker: SingWorker }[], options: FailoverOptions) {
    if (workers.length === 0) throw new Error("FailoverSingWorker needs at least one worker");
    this.#all = workers.map((w) => ({ ...w, downSince: null, lastFail: 0 }));
    this.#retryMs = options.retryMs;
    this.#now = options.now ?? Date.now;
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
    throw last ?? unreachable("no song worker answers");
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
      if (owner !== undefined && isUnreachable(error)) this.#abandoned.set(id, owner);
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
      throw (
        (results[0] as PromiseRejectedResult | undefined)?.reason ?? unreachable("no song worker")
      );
    }
  }

  /** The songs of every worker that answers, the preferred worker's first, each id once. */
  async songs(signal?: AbortSignal): Promise<SongMeta[]> {
    const eps = this.#candidates();
    const results = await Promise.allSettled(
      eps.map((ep) => this.#attempt(ep, (w) => w.songs(signal))),
    );
    if (results.every((r) => r.status === "rejected")) {
      throw (
        (results[0] as PromiseRejectedResult | undefined)?.reason ?? unreachable("no song worker")
      );
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
    const whys = await Promise.all(this.#all.map((ep) => ep.worker.health(signal)));
    const now = this.#now();
    whys.forEach((why, i) => {
      const ep = this.#all[i] as Endpoint;
      if (why === null) this.#up(ep);
      else this.#down(ep, now);
    });
    if (whys.some((why) => why === null)) return null;
    return this.#all.map((ep, i) => `${ep.name}: ${whys[i]}`).join("; ");
  }

  // ----- routing -----

  /** Workers for new work: those not passed over right now, or all of them when none is left. */
  #candidates(): Endpoint[] {
    const now = this.#now();
    const up = this.#all.filter((ep) => !this.#resting(ep, now));
    return up.length > 0 ? up : this.#all;
  }

  /** Found unreachable a moment ago: not asked again until `retryMs` passed. */
  #resting(ep: Endpoint, now = this.#now()): boolean {
    return ep.downSince !== null && now - ep.lastFail < this.#retryMs;
  }

  /** Unreachable for `retryMs` or longer: whatever it holds counts as gone. */
  #dead(ep: Endpoint): boolean {
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
      if (isUnreachable(error)) this.#down(ep, this.#now());
      else if (error instanceof SingWorkerError) this.#up(ep); // it answered, with an error
      throw error;
    }
  }

  #down(ep: Endpoint, now: number): void {
    ep.downSince ??= now;
    ep.lastFail = now;
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
      `the song worker at ${owner.name} has been unreachable for ${this.#downSecs(owner)} s`,
      { status: 404, cause },
    );
  }

  /**
   * The first worker in `order` that has it. A worker that says 404 does not; one that does not
   * answer might, so the caller waits for it (an unreachable error) unless it counts as gone.
   */
  async #find<T>(order: Endpoint[], use: (w: SingWorker) => Promise<T>): Promise<[Endpoint, T]> {
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
