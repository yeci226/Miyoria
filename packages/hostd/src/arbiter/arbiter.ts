// The GPU arbiter of one machine (docs/design/v5-gpu.md §12): the leases of `gpu.acquire`,
// `gpu.renew`, `gpu.release`, `gpu.busy` and `gpu.state`, the windows in which the speech services
// are offline, their own leases (renewed every `lease_s / 3`), the busy cache, Core's context, and
// what happens when a holder goes away. The decisions are `rules.ts` and `job.ts`; this file is the
// mechanism that the song worker used to run itself (exclusive.py, yielding.py, server.py).
//
// Everything it touches is injected: the clock and the timers (seconds), the device reading and
// the HTTP calls to the speech services. Nothing here starts a timer or a request of its own.

import type {
  HostClusterContext,
  HostGpuAcquire,
  HostGpuAcquireResult,
  HostGpuBusy,
  HostGpuBusyResult,
  HostGpuJobState,
  HostGpuRelease,
  HostGpuReleaseResult,
  HostGpuRenew,
  HostGpuRenewResult,
  HostGpuState,
} from "@miyoria/contracts/host";
import { type Card, type DeviceReading, type HistoryEntry, JobState, type Machine } from "./job.js";
import { LIMITS_DEFAULT, type Limits, type Policy, type PolicySource } from "./limits.js";
import { pyRound } from "./num.js";
import { yieldHold } from "./rules.js";
import {
  Audience,
  CardProfile,
  type Clock,
  type PeerClient,
  SpeechReader,
  type Tenant,
  truthy,
} from "./state.js";

/** Sleeps on the arbiter's clock; rejects at once when `signal` is (or becomes) aborted. */
export interface Timers {
  sleep(seconds: number, signal: AbortSignal): Promise<void>;
}

/** What the arbiter reports as it goes (logging, the scenario tests). */
export type ArbiterEvent =
  | { type: "decision"; job: string; entry: HistoryEntry }
  | { type: "holder_gone"; job: string; holder: string; why: "exited" | "expired" };

export interface ArbiterOptions {
  clock: Clock;
  timers: Timers;
  /** One reading of the card; throws when it cannot be read. */
  readDevice: () => Promise<DeviceReading>;
  peers: PeerClient;
  /** The evictable services, in the order they are offloaded and reloaded. */
  tenants: readonly Tenant[];
  /** Names of the services that may hold a window: speech they left offloaded is reloaded at start. */
  holders: readonly string[];
  policy?: { policy: Policy; source: PolicySource };
  limits?: Limits;
  profile?: CardProfile;
  /** How often speech is asked whether it is busy, and how long a busy answer counts. */
  yieldPollS?: number;
  yieldHoldS?: number;
  offloadTimeoutS?: number;
  reloadTimeoutS?: number;
  onEvent?: (event: ArbiterEvent) => void;
}

interface Eviction {
  asked: Tenant[];
  offloaded: string[];
  errors: string[];
  releasedMb: number | null;
  offloadS: number | null;
  state: "offloading" | "active" | "reloading" | "done";
  renew: AbortController;
  reloading: Promise<void> | null;
  reloaded: string[];
  reloadErrors: string[];
  reloadS: number | null;
  /** When the first offload was asked, and when the reload was: the window's real silence. */
  offlineAt: number;
  askedBackAt: number | null;
}

interface Lease {
  job: JobState;
  holder: string;
  maxS: number;
  lastContact: number;
  /** An eviction decided and announced to the holder, not yet carried out. */
  pending: { fromTick: boolean } | null;
  eviction: Eviction | null;
  watch: AbortController | null;
  expiry: AbortController;
}

const aborted = (e: unknown): boolean => e instanceof Error && e.name === "AbortError";
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class Arbiter {
  readonly limits: Limits;
  readonly policy: Policy;
  readonly policySource: PolicySource;
  readonly machine: Machine;
  readonly #o: ArbiterOptions;
  readonly #leases = new Map<string, Lease>();
  readonly #pollS: number;
  readonly #holdS: number;
  #busyUntil = 0;
  #poller: AbortController | null = null;

  constructor(options: ArbiterOptions) {
    this.#o = options;
    this.limits = options.limits ?? { ...LIMITS_DEFAULT };
    this.policy = options.policy?.policy ?? "yield";
    this.policySource = options.policy?.source ?? "default";
    this.#pollS = options.yieldPollS ?? 0.1;
    this.#holdS = yieldHold(this.#pollS, options.yieldHoldS ?? 0.3);
    const profile = options.profile ?? new CardProfile();
    const clock = options.clock;
    const read = options.readDevice;
    const machine: Machine = {
      clock,
      profile,
      audience: new Audience(clock),
      gapUntil: 0,
      last: null,
      async card(ownMb: number): Promise<Card> {
        let reading: DeviceReading;
        try {
          reading = await read();
        } catch {
          return { cuda: true, total_mb: null, free_mb: null, own_mb: 0, name: "cpu" };
        }
        const card: Card = reading.cuda
          ? {
              cuda: true,
              total_mb: reading.total_mb,
              free_mb: reading.free_mb,
              own_mb: ownMb,
              name: reading.name,
            }
          : { cuda: false, total_mb: null, free_mb: null, own_mb: 0, name: "cpu" };
        profile.use(card.name, card.total_mb);
        machine.last = card;
        return card;
      },
    };
    this.machine = machine;
  }

  get #now(): number {
    return this.#o.clock.now();
  }

  // ── Core ─────────────────────────────────────────────────────────────

  /** `cluster.context`. */
  context(context: HostClusterContext): void {
    this.machine.audience.update(context);
  }

  // ── gpu.acquire ──────────────────────────────────────────────────────

  async acquire(holder: string, p: HostGpuAcquire): Promise<HostGpuAcquireResult> {
    const lease = this.#lease(holder, p.job, p.ack, p.max_s);
    lease.lastContact = this.#now;
    if (lease.maxS !== p.max_s) {
      lease.maxS = p.max_s;
      lease.expiry.abort();
      lease.expiry = new AbortController();
      void this.#expiry(lease);
    }
    const job = lease.job;
    job.client = {
      need_mb: p.need_mb,
      own_mb: p.own_mb,
      est_work_s: p.est_work_s,
      est_work_by_card: p.est_work_by_card,
      cpu_fallback: p.cpu_fallback,
      queued: p.queued,
    };
    if (p.announced && lease.pending !== null) {
      const { fromTick } = lease.pending;
      lease.pending = null;
      const ev = await this.#openWindow(lease);
      if (!fromTick) {
        job.waitOver();
        this.#started(lease, p.stage, "gpu", p.resumed, p.pauses);
      }
      return {
        type: "granted",
        lease: job.id,
        mode: "exclusive",
        code: job.decision?.code ?? "window",
        reason: job.decision?.reason ?? "",
        free_mb: job.facts?.free_mb ?? null,
        evicted: [...ev.offloaded],
        errors: [...ev.errors],
        released_mb: ev.releasedMb,
        offload_s: ev.offloadS,
      };
    }
    lease.pending = null;
    const d = await job.decide(p.stage, p.on_gpu, p.pauses);
    const granted = (mode: "share" | "exclusive"): HostGpuAcquireResult => ({
      type: "granted",
      lease: job.id,
      mode,
      code: d.code,
      reason: d.reason,
      free_mb: job.facts?.free_mb ?? null,
      evicted: [],
      errors: [],
      released_mb: null,
      offload_s: null,
    });
    switch (d.mode) {
      case "wait":
        return { type: "wait", code: d.code, reason: d.reason, announce: false, evict: [] };
      case "give_up":
        job.waitOver();
        return { type: "refused", code: d.code, reason: d.reason };
      case "offload":
        if (p.mode === "share")
          return { type: "wait", code: d.code, reason: d.reason, announce: false, evict: [] };
        await job.windowOpening();
        lease.pending = { fromTick: false };
        return {
          type: "wait",
          code: d.code,
          reason: d.reason,
          announce: true,
          evict: this.#o.tenants.map((t) => t.url),
        };
      case "cpu":
        job.waitOver();
        this.#started(lease, p.stage, "cpu", p.resumed, p.pauses);
        return { type: "cpu", code: d.code, reason: d.reason };
      default:
        job.waitOver();
        this.#started(lease, p.stage, "gpu", p.resumed, p.pauses);
        return granted(d.mode === "exclusive" ? "exclusive" : "share");
    }
  }

  #lease(holder: string, id: string, ack: boolean, maxS: number): Lease {
    const known = this.#leases.get(id);
    if (known !== undefined) return known;
    const speech = new SpeechReader(this.#o.tenants, this.#o.peers, this.#o.clock);
    const job = new JobState(
      id,
      this.machine,
      speech,
      this.policy,
      this.policySource,
      this.limits,
      ack,
      (j, entry) => this.#o.onEvent?.({ type: "decision", job: j.id, entry }),
    );
    const lease: Lease = {
      job,
      holder,
      maxS,
      lastContact: this.#now,
      pending: null,
      eviction: null,
      watch: null,
      expiry: new AbortController(),
    };
    this.#leases.set(id, lease);
    if (this.#poller === null) this.#startPoller();
    void this.#expiry(lease);
    return lease;
  }

  #started(
    lease: Lease,
    stage: string,
    device: "gpu" | "cpu",
    resumed: boolean,
    pauses: boolean,
  ): void {
    lease.job.started(stage, device, resumed);
    if (device === "gpu" && !pauses) this.#watch(lease);
  }

  /** A stage that never checks in between steps: the card is read every 0.25 s while it runs. */
  #watch(lease: Lease): void {
    const stop = new AbortController();
    lease.watch = stop;
    const every = Math.min(0.25, this.limits.check_s);
    void (async () => {
      for (;;) {
        try {
          await this.#o.timers.sleep(every, stop.signal);
        } catch {
          return;
        }
        const card = await this.machine.card(lease.job.client.own_mb);
        lease.job.watched(card.free_mb);
      }
    })();
  }

  #unwatch(lease: Lease): void {
    lease.watch?.abort();
    lease.watch = null;
  }

  // ── windows ──────────────────────────────────────────────────────────

  async #openWindow(lease: Lease): Promise<Eviction> {
    const ev: Eviction = {
      asked: [],
      offloaded: [],
      errors: [],
      releasedMb: null,
      offloadS: null,
      state: "offloading",
      renew: new AbortController(),
      reloading: null,
      reloaded: [],
      reloadErrors: [],
      reloadS: null,
      offlineAt: this.#now,
      askedBackAt: null,
    };
    lease.eviction = ev;
    const maxS = this.limits.lease_s;
    const t0 = this.#now;
    for (const t of this.#o.tenants) {
      ev.asked.push(t);
      try {
        const r = await this.#o.peers.offload(
          t,
          { reason: lease.holder, max_s: maxS },
          this.#o.offloadTimeoutS ?? 60.0,
        );
        ev.offloaded.push(t.url);
        if (typeof r.released_mb === "number")
          ev.releasedMb = (ev.releasedMb ?? 0.0) + r.released_mb;
      } catch (e) {
        ev.errors.push(`offload ${t.url}: ${message(e)}`.slice(0, 200));
      }
    }
    ev.offloadS = pyRound(this.#now - t0, 2);
    ev.state = "active";
    if (ev.asked.length > 0 && maxS > 0) void this.#renewSpeech(ev, lease.holder, maxS);
    await lease.job.windowOpened(ev.offlineAt);
    return ev;
  }

  /** The speech services' own lease, renewed while the window is open; a failure is tried again next time. */
  async #renewSpeech(ev: Eviction, holder: string, maxS: number): Promise<void> {
    for (;;) {
      try {
        await this.#o.timers.sleep(maxS / 3, ev.renew.signal);
      } catch {
        return;
      }
      for (const t of ev.asked) {
        try {
          await this.#o.peers.offload(t, { reason: holder, max_s: maxS }, Math.min(5.0, maxS / 3));
        } catch {
          // the next renewal tries again; without one it reloads by itself
        }
      }
    }
  }

  /** Brings back what the window took (once; later calls wait for the same reload). */
  #endEviction(ev: Eviction): Promise<void> {
    ev.renew.abort();
    if (ev.reloading !== null) return ev.reloading;
    if (ev.state === "done") return Promise.resolve();
    ev.state = "reloading";
    ev.reloading = (async () => {
      const t0 = this.#now;
      ev.askedBackAt = t0;
      for (const t of ev.asked) {
        try {
          await this.#o.peers.reload(t, this.#o.reloadTimeoutS ?? 300.0);
          ev.reloaded.push(t.url);
        } catch (e) {
          ev.reloadErrors.push(`reload ${t.url}: ${message(e)}`.slice(0, 200));
        }
      }
      ev.reloadS = pyRound(this.#now - t0, 2);
      ev.state = "done";
    })();
    return ev.reloading;
  }

  // ── gpu.renew ────────────────────────────────────────────────────────

  async renew(p: HostGpuRenew): Promise<HostGpuRenewResult> {
    const none: HostGpuRenewResult = {
      ok: false,
      action: null,
      clear_steps: false,
      learned: null,
      evict: [],
    };
    const lease = this.#leases.get(p.lease);
    if (lease === undefined) return none;
    const job = lease.job;
    lease.lastContact = this.#now;
    job.client = { ...job.client, own_mb: p.own_mb, queued: p.queued };
    if (p.end !== null) {
      this.#unwatch(lease);
      if (p.end.how === "finished") {
        return { ...none, ok: true, learned: job.finished(p.end.step_s, p.end.normal_s) };
      }
      await job.stopped(p.end.how === "oom", p.own_mb);
      return { ...none, ok: true };
    }
    if (p.step === null) return { ...none, ok: true };
    const r = await job.tick(
      job.stage,
      p.step.recent_s,
      p.step.normal_s,
      p.own_mb,
      async () => (await job.speech.read()).loaded,
    );
    if (r.action === null) return { ...none, ok: true, clear_steps: r.clear };
    let evict: string[] = [];
    if (r.action.kind === "offload") {
      await job.windowOpening();
      lease.pending = { fromTick: true };
      evict = this.#o.tenants.map((t) => t.url);
    }
    return {
      ok: true,
      action: {
        type: r.action.kind,
        code: r.action.code,
        reason: r.action.reason,
        steps: r.action.kind === "reduce" ? job.reducedTo : null,
      },
      clear_steps: r.clear,
      learned: null,
      evict,
    };
  }

  // ── gpu.release ──────────────────────────────────────────────────────

  async release(p: HostGpuRelease): Promise<HostGpuReleaseResult> {
    const lease = this.#leases.get(p.lease);
    if (lease === undefined)
      return {
        reloaded: [],
        errors: [],
        reload_s: null,
        closed: false,
        summary: null,
        window: null,
      };
    lease.lastContact = this.#now;
    const ev = lease.eviction;
    if (ev !== null) await this.#endEviction(ev);
    let closed = false;
    let window: HostGpuReleaseResult["window"] = null;
    if (p.window === "close") {
      closed = lease.job.window;
      window = lease.job.windowClosed(ev ? ev.reloadS : null, ev ? ev.askedBackAt : null);
    }
    const summary = p.done ? lease.job.summary() : null;
    if (p.done) this.#forget(lease);
    return {
      reloaded: ev ? [...ev.reloaded] : [],
      errors: ev ? [...ev.reloadErrors] : [],
      reload_s: ev ? ev.reloadS : null,
      closed,
      summary,
      window,
    };
  }

  #forget(lease: Lease): void {
    if (this.#leases.get(lease.job.id) === lease) this.#leases.delete(lease.job.id);
    this.#unwatch(lease);
    lease.expiry.abort();
    if (this.#leases.size === 0) {
      this.#poller?.abort();
      this.#poller = null;
    }
  }

  // ── a holder that went away ──────────────────────────────────────────

  /** The holder's process ended: what its jobs took offline comes back now. */
  async holderGone(holder: string): Promise<void> {
    for (const lease of [...this.#leases.values()]) {
      if (lease.holder === holder) await this.#drop(lease, "exited");
    }
  }

  async #drop(lease: Lease, why: "exited" | "expired"): Promise<void> {
    this.#forget(lease);
    this.#o.onEvent?.({ type: "holder_gone", job: lease.job.id, holder: lease.holder, why });
    const ev = lease.eviction;
    if (ev !== null) await this.#endEviction(ev);
    lease.job.windowClosed(ev ? ev.reloadS : null, ev ? ev.askedBackAt : null);
  }

  async #expiry(lease: Lease): Promise<void> {
    for (;;) {
      const left = lease.maxS - (this.#now - lease.lastContact);
      if (left <= 0) {
        await this.#drop(lease, "expired");
        return;
      }
      try {
        await this.#o.timers.sleep(left, lease.expiry.signal);
      } catch {
        return;
      }
    }
  }

  // ── gpu.busy ─────────────────────────────────────────────────────────

  #startPoller(): void {
    const stop = new AbortController();
    this.#poller = stop;
    this.#busyUntil = 0;
    void (async () => {
      for (;;) {
        for (const t of this.#o.tenants) {
          try {
            const r = await this.#o.peers.busy(t, 0.5);
            if (Math.trunc(Number(r.busy ?? 0)) > 0) this.#busyUntil = this.#now + this.#holdS;
          } catch {
            // a service that does not answer counts as idle
          }
        }
        try {
          await this.#o.timers.sleep(this.#pollS, stop.signal);
        } catch {
          return;
        }
      }
    })();
  }

  busy(p: HostGpuBusy): HostGpuBusyResult {
    const lease = this.#leases.get(p.lease);
    if (lease !== undefined) lease.lastContact = this.#now;
    return {
      busy: this.#now < this.#busyUntil,
      allowance_s: lease ? lease.job.yieldAllowance() : this.limits.yield_patient_s,
    };
  }

  // ── start ────────────────────────────────────────────────────────────

  /**
   * At hostd's start: a speech service left offloaded for a holder (hostd or the holder went away
   * mid-window) is asked back. Returns the base URLs asked.
   */
  async recover(): Promise<string[]> {
    const asked: string[] = [];
    for (const t of this.#o.tenants) {
      try {
        const h = await this.#o.peers.health(t, 2.0);
        if (
          truthy(h.offloaded) &&
          typeof h.reason === "string" &&
          this.#o.holders.includes(h.reason)
        ) {
          asked.push(t.url);
          await this.#o.peers.reload(t, this.#o.reloadTimeoutS ?? 300.0);
        }
      } catch (e) {
        if (aborted(e)) throw e;
        // it comes back by itself when its lease runs out
      }
    }
    return asked;
  }

  /** Stops every loop; what is offline stays so until `recover` or the services' own leases. */
  close(): void {
    for (const lease of [...this.#leases.values()]) {
      lease.eviction?.renew.abort();
      this.#forget(lease);
    }
  }

  // ── gpu.state ────────────────────────────────────────────────────────

  /** Whether the job's window is open (`false` for a job hostd does not know). */
  windowOf(job: string): boolean {
    return this.#leases.get(job)?.job.window ?? false;
  }

  /** The job's summary while it holds a lease. */
  summaryOf(job: string): ReturnType<JobState["summary"]> | null {
    return this.#leases.get(job)?.job.summary() ?? null;
  }

  state(): HostGpuState {
    const m = this.machine;
    const last = m.last;
    const jobs: HostGpuJobState[] = [...this.#leases.values()].map((lease) => {
      const j = lease.job;
      return {
        lease: j.id,
        holder: lease.holder,
        stage: j.stage,
        mode: j.decision?.mode ?? null,
        code: j.decision?.code ?? null,
        reason: j.decision?.reason ?? null,
        window: j.window,
        eviction: lease.eviction?.state ?? null,
        spills: j.spills,
        steps: j.reducedTo,
        waited_s: pyRound(j.waitedTotalS + j.waitingS(), 1),
        silenced_s: pyRound(j.silencedS, 1),
      };
    });
    return {
      policy: this.policy,
      policy_source: this.policySource,
      cuda: last ? last.cuda : null,
      total_mb: last ? last.total_mb : null,
      free_mb: last ? last.free_mb : null,
      headroom_mb: m.profile.headroom(last ? last.total_mb : null, this.limits),
      gap_s: Math.max(0, m.gapUntil - this.#now),
      busy: this.#now < this.#busyUntil,
      audience: m.audience.public(this.limits.context_ttl_s),
      learned: m.profile.public(),
      jobs,
    };
  }
}
