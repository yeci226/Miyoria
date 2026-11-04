// Watch lifecycle: one friend's Go Live at a time, plus keyframe snapshots.
//
//   start() ─> starting ─(first decrypted media)─> live ─> stopped | failed
//
// Independent of Discord: the receiving side is an injected {@link WatchEngine} and the voice-channel
// side an injected {@link WatchHost}. Nothing here throws or rejects to its caller, and every hook
// handed to the engine is bound to its job, so a finished job can never touch the current one.
import type { CapturePipeline } from "../capture.js";
import type { Logger } from "../log.js";
import { noopLogger } from "../log.js";
import type { WatchWireState } from "../protocol.js";

export const SNAPSHOT_ATTEMPTS = 3;

export interface WatchPlan {
  guild: string;
  channel: string;
  userId: string;
  sessionId: string;
}

export interface WatchHooks {
  /** First decrypted media arrived. */
  onLive(): void;
  /** One complete, decrypted keyframe. */
  onKeyframe(frame: Buffer): void;
  /** One decrypted Opus packet. */
  onOpus(packet: Buffer): void;
}

export interface WatchEngine {
  /**
   * Resolves with a reason when the streamer stops or the connection ends; rejects if it cannot start or breaks.
   * Once `signal` aborts it must return within a second or two, even if Discord never answers: a run that
   * never returns blocks `stopAll`, shutdown and queued starts.
   */
  run(plan: WatchPlan, hooks: WatchHooks, signal: AbortSignal): Promise<string>;
  requestKeyframe(): void;
}

export interface WatchHost {
  attach(guild: string, userId: string, signal: AbortSignal): Promise<WatchPlan>;
  goLiveActive(): boolean;
}

export interface WatchEvent {
  guild: string;
  userId: string;
  state: WatchWireState;
  error?: string;
  reason?: string;
}

export interface WatchManagerOptions {
  engine: WatchEngine;
  host: WatchHost;
  emit(ev: WatchEvent): void;
  snapshotDone(id: number, jpeg: Buffer): void;
  snapshotFailed(id: number, error: string): void;
  audio(frame: Buffer): void;
  toJpeg(h264: Buffer, signal: AbortSignal): Promise<Buffer>;
  pipeline(): CapturePipeline;
  attemptMs?: number;
  log?: Logger;
}

/** One shared attempt cycle: every pending snapshot id gets the same JPEG from the next keyframe. */
interface Cycle {
  attempts: number;
  converting: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  abort: AbortController;
}

interface Job {
  guild: string;
  userId: string;
  abort: AbortController;
  state: WatchWireState;
  stopReason: string | undefined;
  pending: Set<number>;
  cycle: Cycle | undefined;
  done: Promise<void>;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class WatchManager {
  private readonly o: WatchManagerOptions;
  private readonly log: Logger;
  private readonly attemptMs: number;
  private job: Job | undefined;
  private queued: { guild: string; user_id: string } | undefined;

  constructor(opts: WatchManagerOptions) {
    this.o = opts;
    this.log = opts.log ?? noopLogger;
    this.attemptMs = opts.attemptMs ?? 1600;
  }

  get activeGuild(): string | undefined {
    return this.job?.guild;
  }

  /** Starts watching `user_id`; a different target first stops the current watch. Never throws. */
  start(msg: { guild: string; user_id: string }): void {
    const job = this.job;
    if (!job) {
      this.begin(msg);
      return;
    }
    const sameAsCurrent = job.guild === msg.guild && job.userId === msg.user_id;
    if (sameAsCurrent && !this.queued && !job.abort.signal.aborted) {
      this.send({ guild: job.guild, userId: job.userId, state: job.state });
      return;
    }
    if (this.queued && this.queued.guild === msg.guild && this.queued.user_id === msg.user_id) return;
    this.queued = msg;
    this.stopJob(job, "switched");
  }

  /** Stops the watch in `guild`; does nothing when that guild is not being watched. */
  stop(guild: string, reason: string): void {
    if (this.queued?.guild === guild) this.queued = undefined;
    const job = this.job;
    if (job && job.guild === guild) this.stopJob(job, reason);
  }

  async stopAll(reason: string): Promise<void> {
    this.queued = undefined;
    const job = this.job;
    if (!job) return;
    this.stopJob(job, reason);
    await job.done;
  }

  /** Asks for a JPEG of the current picture; answers through snapshotDone / snapshotFailed. */
  snapshot(id: number): void {
    const job = this.job;
    if (!job || job.abort.signal.aborted) {
      this.safe(() => this.o.snapshotFailed(id, "not watching"));
      return;
    }
    job.pending.add(id);
    if (!job.cycle) {
      job.cycle = { attempts: 0, converting: false, timer: undefined, abort: new AbortController() };
      this.attempt(job, job.cycle);
    }
  }

  private begin(msg: { guild: string; user_id: string }): void {
    const { guild, user_id: userId } = msg;
    let goLive = false;
    try {
      goLive = this.o.host.goLiveActive();
    } catch (e) {
      this.log.warn(`watch: goLiveActive failed: ${errMsg(e)}`);
    }
    if (goLive) {
      this.send({ guild, userId, state: "failed", error: "she is streaming her own Go Live; stop it first" });
      return;
    }
    const job: Job = {
      guild,
      userId,
      abort: new AbortController(),
      state: "starting",
      stopReason: undefined,
      pending: new Set(),
      cycle: undefined,
      done: Promise.resolve(),
    };
    this.job = job;
    this.send({ guild, userId, state: "starting" });
    job.done = this.run(job);
  }

  private stopJob(job: Job, reason: string): void {
    if (job.stopReason === undefined) job.stopReason = reason;
    job.abort.abort();
    this.failPending(job);
  }

  /** Ends the snapshot cycle (killing any ffmpeg) and fails every pending id. */
  private failPending(job: Job): void {
    this.endCycle(job);
    const ids = [...job.pending];
    job.pending.clear();
    for (const id of ids) this.safe(() => this.o.snapshotFailed(id, "watch ended"));
  }

  private isCurrent(job: Job): boolean {
    return this.job === job && !job.abort.signal.aborted;
  }

  private hooks(job: Job, pipeline: CapturePipeline): WatchHooks {
    return {
      onLive: () => {
        if (!this.isCurrent(job) || job.state !== "starting") return;
        job.state = "live";
        this.send({ guild: job.guild, userId: job.userId, state: "live" });
      },
      onKeyframe: (frame) => {
        if (!this.isCurrent(job)) return;
        const cycle = job.cycle;
        if (!cycle || cycle.converting || job.pending.size === 0) return;
        this.convert(job, cycle, frame);
      },
      onOpus: (packet) => {
        if (!this.isCurrent(job)) return;
        try {
          for (const f of pipeline.push(packet)) this.o.audio(f);
        } catch (e) {
          this.log.warn(`watch: audio failed: ${errMsg(e)}`);
        }
      },
    };
  }

  private async run(job: Job): Promise<void> {
    const { signal } = job.abort;
    let final: WatchEvent;
    let pipeline: CapturePipeline | undefined;
    try {
      pipeline = this.o.pipeline();
      const plan = await this.o.host.attach(job.guild, job.userId, signal);
      if (signal.aborted) throw new Error("aborted");
      const reason = await this.o.engine.run(plan, this.hooks(job, pipeline), signal);
      final = signal.aborted
        ? { guild: job.guild, userId: job.userId, state: "stopped", reason: job.stopReason ?? reason }
        : { guild: job.guild, userId: job.userId, state: "stopped", reason };
    } catch (e) {
      if (signal.aborted) {
        final = { guild: job.guild, userId: job.userId, state: "stopped", reason: job.stopReason ?? "stopped" };
      } else {
        const error = errMsg(e);
        this.log.warn(`watch: failed: ${error}`);
        final = { guild: job.guild, userId: job.userId, state: "failed", error };
      }
    }

    // Tear down before anything else can see the job as finished.
    job.abort.abort();
    job.state = final.state;
    this.failPending(job);
    const pl = pipeline;
    if (pl) this.safe(() => pl.dispose());
    this.job = undefined;
    this.send(final);

    const next = this.queued;
    this.queued = undefined;
    if (next) this.begin(next);
  }

  private attempt(job: Job, cycle: Cycle): void {
    cycle.attempts++;
    cycle.converting = false;
    if (cycle.timer) clearTimeout(cycle.timer);
    cycle.timer = setTimeout(() => this.nextAttempt(job, cycle), this.attemptMs);
    cycle.timer.unref?.();
    this.safe(() => this.o.engine.requestKeyframe());
  }

  private nextAttempt(job: Job, cycle: Cycle): void {
    if (job.cycle !== cycle || !this.isCurrent(job)) return;
    if (cycle.attempts < SNAPSHOT_ATTEMPTS) {
      this.attempt(job, cycle);
      return;
    }
    const ids = [...job.pending];
    job.pending.clear();
    this.endCycle(job);
    for (const id of ids) this.safe(() => this.o.snapshotFailed(id, "no keyframe arrived"));
  }

  private endCycle(job: Job): void {
    const cycle = job.cycle;
    if (!cycle) return;
    if (cycle.timer) clearTimeout(cycle.timer);
    cycle.abort.abort();
    job.cycle = undefined;
  }

  private convert(job: Job, cycle: Cycle, frame: Buffer): void {
    cycle.converting = true;
    if (cycle.timer) clearTimeout(cycle.timer);
    let p: Promise<Buffer>;
    try {
      p = this.o.toJpeg(frame, cycle.abort.signal);
    } catch (e) {
      p = Promise.reject(e);
    }
    p.then(
      (jpeg) => {
        if (job.cycle !== cycle || !this.isCurrent(job)) return;
        const ids = [...job.pending];
        job.pending.clear();
        this.endCycle(job);
        for (const id of ids) this.safe(() => this.o.snapshotDone(id, jpeg));
      },
      (e) => {
        if (job.cycle !== cycle || !this.isCurrent(job)) return;
        this.log.warn(`watch: snapshot conversion failed: ${errMsg(e)}`);
        this.nextAttempt(job, cycle);
      },
    );
  }

  private send(ev: WatchEvent): void {
    this.safe(() => this.o.emit(ev));
  }

  private safe(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.log.warn(`watch: callback failed: ${errMsg(e)}`);
    }
  }
}
