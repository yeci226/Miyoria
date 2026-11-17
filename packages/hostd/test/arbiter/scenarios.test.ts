// The 26 recorded scenarios (workers/sing/gpu_scenarios.json), played again against the arbiter.
//
// What runs: the real `Arbiter` on a simulated clock (sim.ts). Around it, the same fakes the Python
// recorder had, ported: the card (`SimCard`: free memory from what is on it, slow steps under a
// limit), the speech services (`Peer`: offload, reload, their own lease and self-reload, busy
// spans), Core (context every 1.5 s, go 4 s after `waiting`) and the stages (fixed step times).
// The song worker is played by `Worker`, a port of the job loop of workers/sing/server.py
// (`run_job`, `_gpu_stage`, `_place`, `_open_window`, `_close_window`, `_give_gpu_back`, the gate)
// in which every GPU question goes to the arbiter as the lease client of docs/design/v5-gpu.md
// §12 does: `gpu.acquire` where `GpuJob.decide` was, `gpu.renew` with `step` where `tick` was and
// with `end` where `finished`/`stopped` were, `gpu.busy` where `SpeechYield.busy` was, and
// `gpu.release` where `Exclusive.end`/`window_closed` were.
//
// How a recorded scenario is compared (strict, no tolerance on times or text):
// 1. Calls to the speech services (`POST tts/offload`, ... with body and reply): the same list in
//    the same order, each at the same time (to the millisecond, as recorded). hostd makes them now
//    instead of the worker; what is sent is compared, not who sends it.
// 2. Decisions (`mode/code`, stage, reason): the same list, same order, same times.
// 3. Other events (Core's go, card changes, the worker's trim/unload, a service reloading by
//    itself, the job's end, the horizon, the worker dying): the same list, same order, same times.
// 4. Observed states (`stage`, `exclusive`, `window`, `running`, `yield_pauses`, each service's
//    state): per state, the value it has at the end of each instant, as a timeline of changes.
//    The order of events of different kinds within one instant, and a value a state held only in
//    the middle of an instant, are not compared: both are artefacts of thread scheduling in the
//    recorder (which thread a probe ran in), not something any peer can observe. This is the only
//    relaxation.
// 5. The result: job outcome, the job's GPU summary (policy, spills, steps, waited and silenced
//    seconds), the last window's record (state, offloaded, errors, timings), yielding, the
//    services' final states, what was learned about the card, the end time, and the number of
//    steps run on each device. Not compared: how often `/health` and `/busy` were asked (hostd
//    polls them on its own schedule now) and the `gpu.*` exchanges between worker and hostd,
//    which are new.
// Two scenarios (`holder_dies_*`) are compared up to the death only. After it the design differs
// on purpose: hostd sees the holder exit and brings speech back at once (v5-hostd §8), where the
// worker left it offline until the services' own lease ran out or it restarted. What hostd does
// instead is asserted separately.

import { readFileSync, writeFileSync } from "node:fs";
import type {
  HostGpuAcquire,
  HostGpuAcquireResult,
  HostGpuBusy,
  HostGpuBusyResult,
  HostGpuRelease,
  HostGpuReleaseResult,
  HostGpuRenew,
  HostGpuRenewResult,
} from "@miyoria/contracts/host";
import { describe, expect, it } from "vitest";
import {
  Arbiter,
  type DeviceReading,
  type Limits,
  limitsFrom,
  type PeerClient,
  policyFrom,
  pyRound,
  type Tenant,
} from "../../src/arbiter/index.js";
import { Sim, SimEvent } from "./sim.js";
import { StageProfile, StepMeter } from "./worker.js";

type Json = Record<string, unknown>;
type Event = Json & { t: number };

interface StageSpec {
  stage: string;
  steps: number;
  step_s: number;
  cpu_step_s?: number;
  rvc_mb?: number;
  oom_once?: boolean;
  /** The backing voices' pass of a `backing: "convert"` job (a second conversion pass). */
  backing?: boolean;
}

interface Setup {
  env: Record<string, string>;
  total: number;
  others: number;
  peers: Record<string, [number, number, number]>;
  unreachable: string[];
  job_mb: number;
  cuda: boolean;
  spill_under: number;
  profile: { step_s?: Record<string, number> };
  ack: boolean;
  go_after: number | null;
  people: [number, boolean, number, boolean][];
  urgent: boolean;
  core_gone: number | null;
  core_back: number | null;
  busy: Record<string, [number, number][]>;
  card_changes: [number, Json][];
  audio_s: number;
  rvc: boolean;
  cpu_fallback: string[];
  die_at: number | null;
  restart_at: number | null;
  horizon: number;
  stages: StageSpec[];
  /** Speech offloaded by another holder before the job: no lease of ours, never back. */
  offline_from_start?: string[];
}

interface Recorded {
  name: string;
  about: string;
  setup: Setup;
  result: Json;
  events: Event[];
}

const FILE = new URL("../../../../workers/sing/gpu_scenarios.json", import.meta.url);
const RECORDED = JSON.parse(readFileSync(FILE, "utf8")) as { scenarios: Recorded[] };
const TAIL_S = 5.0;
const HOLDER = "sing";
/** lease.py `KEEPALIVE_S`. */
const KEEPALIVE_S = 20.0;

/** One `gpu.*` call of the worker and hostd's answer, in simulated seconds. */
interface Exchange {
  t: number;
  method: string;
  params: Json;
  result: unknown;
  t_end: number;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

class Suspended extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "Suspended";
  }
}
class JobError extends Error {
  override name = "JobError";
}
const NEVER = new Promise<never>(() => {});

// ── the fakes the recorder had ────────────────────────────────────────────

class Peer {
  state: "loaded" | "offloading" | "offloaded" | "reloading" = "loaded";
  reason: string | null = null;
  released: number | null = null;
  reachable = true;
  busy: [number, number][] = [];
  #lease = 0;

  constructor(
    private readonly sim: Sim,
    private readonly note: (e: Json) => void,
    readonly name: string,
    readonly mb: number,
    readonly offloadS: number,
    readonly reloadS: number,
  ) {}

  memory(): number {
    return this.state === "offloaded" ? 0 : this.mb;
  }

  health(): Json {
    const gone = this.state !== "loaded";
    const out: Json = {
      status: "ok",
      offloaded: gone,
      loading: this.state === "reloading",
      released_mb: this.released,
    };
    if (gone) out.reason = this.reason;
    return out;
  }

  busyNow(): number {
    return this.busy.filter(([a, b]) => a <= this.sim.now && this.sim.now < b).length;
  }

  lease(maxS: number | null): void {
    this.#lease += 1;
    const token = this.#lease;
    const s = maxS ?? 900.0;
    if (s > 0) this.sim.at(this.sim.now + s, () => this.#expired(token));
  }

  #expired(token: number): void {
    if (token !== this.#lease || this.state !== "offloaded") return;
    this.note({ peer: this.name, does: "nobody renewed the offload: reloads by itself" });
    this.state = "reloading";
    this.sim.at(this.sim.now + this.reloadS, () => {
      if (token === this.#lease && this.state === "reloading") {
        this.state = "loaded";
        this.reason = null;
      }
    });
  }

  async offload(body: { reason: string; max_s: number }): Promise<Json> {
    if (this.state === "loaded") {
      this.state = "offloading";
      await this.sim.sleep(this.offloadS);
      this.state = "offloaded";
      this.reason = (body.reason || "").slice(0, 80);
      this.released = this.mb;
      this.lease(body.max_s);
      return {
        state: "offloaded",
        offload_ms: Math.round(this.offloadS * 1000),
        released_mb: this.mb,
      };
    }
    if (this.state === "reloading") {
      this.state = "offloaded";
      this.lease(body.max_s);
      return { state: "offloaded", offload_ms: 0, cancelled_reload: true };
    }
    this.lease(body.max_s);
    return { state: "offloaded", offload_ms: 0, already: true };
  }

  async reload(): Promise<Json> {
    if (this.state === "loaded") return { state: "ready", reload_ms: 0, already: true };
    this.#lease += 1;
    if (this.state !== "reloading") {
      this.state = "reloading";
      await this.sim.sleep(this.reloadS);
      this.state = "loaded";
      this.reason = null;
    } else {
      while ((this.state as string) !== "loaded") await this.sim.sleep(0.5);
    }
    return { state: "ready", reload_ms: Math.round(this.reloadS * 1000) };
  }
}

class SimCard {
  cuda = true;
  running: "gpu" | "cpu" | null = null;
  extra = 0;
  spill_under = 0;
  slow_factor = 10.0;
  gateSet: () => boolean = () => false;

  constructor(
    public total: number,
    public others: number,
    readonly peers: Map<string, Peer>,
    readonly jobMb: number,
  ) {}

  own(): number {
    return this.running === "gpu" && this.gateSet() ? this.jobMb : 0;
  }

  free(): number {
    let speech = 0;
    for (const p of this.peers.values()) speech += p.memory();
    return Math.max(0, this.total - this.others - this.extra - speech - this.own());
  }
}

// ── one scenario ──────────────────────────────────────────────────────────

interface Excl {
  state: string | null;
  offloaded: string[];
  errors: string[];
  timings: Record<string, number>;
  reloading: Promise<void> | null;
}

interface Outcome {
  state: string;
  error?: string;
}

class Scenario {
  readonly sim = new Sim();
  readonly events: Event[] = [];
  readonly counts = new Map<string, number>();
  readonly peers = new Map<string, Peer>();
  readonly card: SimCard;
  readonly arbiter: Arbiter;
  readonly limits: Limits;
  readonly profile = new StageProfile();
  readonly errors: unknown[] = [];
  readonly go: SimEvent;
  readonly done: SimEvent;
  readonly jobId = "job1";
  outcome: Outcome = { state: "running at the horizon" };
  #seen = new Map<string, unknown>();
  // the worker
  stage = "queued";
  exclusive: Excl | null = null;
  gate: (() => Promise<void>) | null = null;
  rvc: boolean;
  meter = new StepMeter();
  yieldPauses = 0;
  yieldedS = 0.0;
  yieldMaxS = 0;
  yieldStopped = false;
  dead = false;
  summary: Json | null = null;
  readonly exchanges: Exchange[] = [];
  lastCall = 0;
  gpuStarted = false;
  readonly keepAliveStop: SimEvent;
  progress = new Map<string, number>();
  oomLeft = new Map<string, boolean>();
  goDue = false;

  constructor(readonly s: Setup) {
    const env = { SING_OFFLOAD_URLS: "http://tts,http://asr", ...s.env };
    this.limits = limitsFrom(env);
    // In the order of SING_OFFLOAD_URLS, the order they are offloaded and reloaded in (the recorded
    // setup's keys are sorted).
    const order = env.SING_OFFLOAD_URLS.split(",").map((u) => u.trim().replace(/^https?:\/\//, ""));
    for (const name of order) {
      const [mb, off, rel] = s.peers[name] as [number, number, number];
      const p = new Peer(this.sim, (e) => this.note(e), name, mb, off, rel);
      p.reachable = !s.unreachable.includes(name);
      if ((s.offline_from_start ?? []).includes(name)) {
        p.state = "offloaded";
        p.reason = "other";
      }
      p.busy = s.busy[name] ?? [];
      this.peers.set(name, p);
    }
    this.card = new SimCard(s.total, s.others, this.peers, s.job_mb);
    this.card.cuda = s.cuda;
    this.card.spill_under = s.spill_under;
    this.card.gateSet = () => this.gate !== null;
    this.rvc = s.rvc;
    this.profile.use(`Sim GPU/${s.total}`);
    for (const [stage, step] of Object.entries(s.profile.step_s ?? {}))
      this.profile.noteStep(stage, step);
    this.go = new SimEvent(this.sim);
    this.done = new SimEvent(this.sim);
    this.keepAliveStop = new SimEvent(this.sim);
    for (const st of s.stages) this.oomLeft.set(st.stage, Boolean(st.oom_once));
    const tenants: Tenant[] = [...this.peers.keys()].map((name) => ({
      name,
      url: `http://${name}`,
      offload: "/offload",
      reload: "/reload",
      busy: "/busy",
      health: "/health",
    }));
    this.arbiter = new Arbiter({
      clock: this.sim.clock,
      timers: this.sim.timers,
      readDevice: async (): Promise<DeviceReading> =>
        this.card.cuda
          ? { cuda: true, total_mb: this.card.total, free_mb: this.card.free(), name: "Sim GPU" }
          : { cuda: false, total_mb: null, free_mb: null, name: "cpu" },
      peers: this.peerClient(),
      tenants,
      holders: [HOLDER],
      policy: policyFrom(env),
      limits: this.limits,
      onEvent: (e) => {
        if (e.type === "decision") {
          this.note({
            decision: `${e.entry.mode}/${e.entry.code}`,
            at_stage: e.entry.stage,
            reason: e.entry.reason,
          });
        }
      },
    });
  }

  // ── what is observed ──

  note(e: Json): Event {
    this.probe();
    const event = { t: pyRound(this.sim.now, 3), ...e };
    this.events.push(event);
    return event;
  }

  probe(): void {
    const values: [string, unknown][] = [
      ["stage", this.stage],
      ["exclusive", this.exclusive ? this.exclusive.state : null],
      ["window", this.arbiter.windowOf(this.jobId)],
      ["running", this.card.running],
      ["yield_pauses", this.yieldPauses],
      ...[...this.peers.entries()].map(([n, p]) => [n, p.state] as [string, unknown]),
    ];
    for (const [k, v] of values) {
      if (this.#seen.has(k) && this.#seen.get(k) === v) continue;
      this.#seen.set(k, v);
      this.events.push({ t: pyRound(this.sim.now, 3), [k]: v });
    }
  }

  count(key: string, n = 1): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + n);
  }

  peerClient(): PeerClient {
    const peer = (t: Tenant): Peer => this.peers.get(t.name) as Peer;
    return {
      offload: async (t, body) => {
        const call = this.note({ call: `POST ${t.name}/offload`, body: { ...body } });
        const p = peer(t);
        if (!p.reachable) {
          call.reply = "connection refused";
          throw new Error("connection refused");
        }
        const out = await p.offload(body);
        call.reply = out;
        return out;
      },
      reload: async (t) => {
        const call = this.note({ call: `POST ${t.name}/reload` });
        const p = peer(t);
        if (!p.reachable) {
          call.reply = "connection refused";
          throw new Error("connection refused");
        }
        const out = await p.reload();
        call.reply = out;
        return out;
      },
      busy: async (t) => {
        this.count("GET /busy");
        const p = peer(t);
        if (!p.reachable) throw new Error("connection refused");
        return { busy: p.busyNow() };
      },
      health: async (t) => {
        this.count("GET /health");
        const p = peer(t);
        if (!p.reachable) throw new Error("connection refused");
        return p.health();
      },
    };
  }

  // ── the worker: every wait goes through here, so a dead worker stops where it is ──

  async w<T>(p: Promise<T>): Promise<T> {
    const v = await p;
    if (this.dead) await NEVER;
    return v;
  }

  sleep(s: number): Promise<void> {
    return this.w(this.sim.sleep(s));
  }

  stagePauses(stage: string): boolean {
    return !(stage === "convert" && this.rvc);
  }

  params(stage: string, resumed: boolean, announced: boolean): HostGpuAcquire {
    const work = this.profile.workByCard(this.s.audio_s, 0, stage);
    return {
      job: this.jobId,
      stage,
      mode: "exclusive",
      max_s: 60,
      reason: "",
      on_gpu: true,
      pauses: this.stagePauses(stage),
      need_mb: this.profile.needByCard(stage),
      own_mb: this.card.own(),
      est_work_s: work.prior,
      est_work_by_card: work.byCard,
      cpu_fallback: this.s.cpu_fallback.includes(stage),
      queued: [],
      ack: this.s.ack,
      resumed,
      announced,
    };
  }

  /**
   * Every `gpu.*` call of the worker goes through here: it is recorded (time asked, params,
   * answer, time answered) for the Python lease client's cross-check (lease_exchanges.jsonl).
   */
  async rpc<T>(method: string, params: Json): Promise<T> {
    const exchange: Exchange = {
      t: this.sim.now,
      method,
      params: clone(params),
      result: null,
      t_end: 0,
    };
    this.exchanges.push(exchange);
    this.lastCall = this.sim.now;
    const a = this.arbiter;
    const answer: Promise<unknown> =
      method === "gpu.acquire"
        ? a.acquire(HOLDER, params as unknown as HostGpuAcquire)
        : method === "gpu.renew"
          ? a.renew(params as unknown as HostGpuRenew)
          : method === "gpu.release"
            ? a.release(params as unknown as HostGpuRelease)
            : method === "gpu.busy"
              ? Promise.resolve(a.busy(params as unknown as HostGpuBusy))
              : Promise.resolve(a.state());
    const result = await answer;
    exchange.result = clone(result);
    exchange.t_end = this.sim.now;
    return this.w(Promise.resolve(result as T));
  }

  acquire(stage: string, resumed: boolean, announced: boolean): Promise<HostGpuAcquireResult> {
    return this.rpc("gpu.acquire", this.params(stage, resumed, announced) as unknown as Json);
  }

  renew(p: Partial<HostGpuRenew>): Promise<HostGpuRenewResult> {
    const params = {
      lease: this.jobId,
      own_mb: this.card.own(),
      queued: [],
      step: null,
      end: null,
      ...p,
    };
    return this.rpc("gpu.renew", params as unknown as Json);
  }

  release(window: "keep" | "close", done: boolean): Promise<HostGpuReleaseResult> {
    return this.rpc("gpu.release", { lease: this.jobId, window, done });
  }

  /** A bare `gpu.renew` when 20 s passed without any call (lease.py `_keepalive`). */
  async keepAlive(): Promise<void> {
    for (;;) {
      const due = this.lastCall + KEEPALIVE_S;
      const now = this.sim.now;
      if (now >= due) {
        await this.renew({});
        continue;
      }
      if (await this.w(this.keepAliveStop.wait(due - now))) return;
    }
  }

  /** `_place`. */
  async place(stage: string, resumed: boolean): Promise<"gpu" | "cpu"> {
    try {
      for (;;) {
        const r = await this.acquire(stage, resumed, false);
        if (r.type === "wait") {
          if (r.announce) {
            this.stage = stage;
            await this.openWindow(stage, resumed);
            return "gpu";
          }
          this.stage = "gpu_wait";
          await this.sleep(this.limits.check_s);
          continue;
        }
        this.stage = stage;
        if (r.type === "refused") throw new JobError(r.reason);
        if (
          r.type === "granted" &&
          r.mode === "share" &&
          (this.exclusive === null || this.exclusive.state !== "shared")
        ) {
          this.exclusive = {
            state: "shared",
            offloaded: [],
            errors: [],
            timings: { free_vram_mb: r.free_mb ?? 0 },
            reloading: null,
          };
        }
        return r.type === "cpu" ? "cpu" : "gpu";
      }
    } finally {
      this.stage = stage;
    }
  }

  /** `_open_window` with `Exclusive.begin`: Core's go, then hostd carries the eviction out. */
  async openWindow(stage: string, resumed: boolean): Promise<void> {
    this.go.clear();
    const ex: Excl = { state: null, offloaded: [], errors: [], timings: {}, reloading: null };
    this.exclusive = ex;
    const saved = this.stage;
    this.stage = "exclusive";
    try {
      if (this.s.ack) {
        ex.state = "waiting";
        const t0 = this.sim.now;
        while (!this.go.flag && this.sim.now - t0 < 30.0) await this.w(this.go.wait(0.1));
        ex.timings.exclusive_wait_s = pyRound(this.sim.now - t0, 2);
      }
      ex.state = "offloading";
      const r = await this.acquire(stage, resumed, true);
      if (r.type !== "granted")
        throw new Error(`an announced window was not granted: ${JSON.stringify(r)}`);
      ex.offloaded = [...r.evicted];
      ex.errors.push(...r.errors);
      if (r.released_mb !== null) ex.timings.released_mb = r.released_mb;
      if (r.offload_s !== null) ex.timings.offload_s = r.offload_s;
      ex.state = "active";
    } finally {
      this.stage = saved;
    }
  }

  /** `Exclusive.end`: speech starts coming back while the job goes on. */
  endExclusive(window: "keep" | "close"): void {
    const ex = this.exclusive;
    if (
      ex === null ||
      ex.reloading !== null ||
      ex.state === null ||
      ex.state === "done" ||
      ex.state === "shared"
    )
      return;
    ex.state = "reloading";
    ex.reloading = this.release(window, false).then((r) => {
      ex.errors.push(...r.errors);
      if (r.reload_s !== null) ex.timings.reload_s = r.reload_s;
      ex.state = "done";
    });
  }

  /** `_close_window`: one `close` release brings speech back and ends the window. */
  async closeWindow(): Promise<void> {
    if (this.exclusive === null || !this.arbiter.windowOf(this.jobId)) return;
    this.endExclusive("close");
    await this.exclusive.reloading;
  }

  /** `_give_gpu_back`. */
  giveGpuBack(): void {
    this.yieldStopped = true;
    this.gate = null;
    // The window ends when her voice is back (server.py `give_back`, lease.py: a `close` release).
    this.endExclusive("close");
  }

  async busy(): Promise<boolean> {
    return (await this.rpc<HostGpuBusyResult>("gpu.busy", { lease: this.jobId })).busy;
  }

  /** `SpeechYield.wait`. */
  async yieldWait(): Promise<void> {
    if (!(await this.busy()) || this.yieldedS >= this.yieldMaxS) return;
    const t0 = this.sim.now;
    this.yieldPauses += 1;
    while ((await this.busy()) && !this.yieldStopped) {
      if (this.yieldedS + this.sim.now - t0 >= this.yieldMaxS) break;
      await this.sleep(0.02);
    }
    this.yieldedS += this.sim.now - t0;
  }

  /** `_arm`: the gate before every step. */
  arm(stage: string, work: { steps: number | null } | null): void {
    this.gate = async () => {
      this.meter.step(this.sim.now);
      const b = await this.rpc<HostGpuBusyResult>("gpu.busy", { lease: this.jobId });
      if (b.busy) {
        this.yieldMaxS = b.allowance_s;
        await this.yieldWait();
      }
      const r = await this.renew({
        step: { recent_s: [...this.meter.recent], normal_s: this.profile.normalByCard(stage) },
      });
      if (r.clear_steps) this.meter.restart();
      const a = r.action;
      if (a !== null) {
        if (a.type === "trim") this.note({ backend: "trim: frees its own cache" });
        else if (a.type === "reduce") {
          if (work !== null) work.steps = a.steps;
        } else if (a.type === "offload") await this.openWindow(stage, false);
        else throw new Suspended(a.code);
      }
      this.meter.resume(this.sim.now);
    };
  }

  /** `_gpu_stage`. */
  async gpuStage(
    stage: string,
    run: (device: "gpu" | "cpu") => Promise<void>,
    work: { steps: number | null } | null,
  ): Promise<void> {
    if (!this.gpuStarted) {
      // lease.py `start`: the policy for what the job shows, then the keep-alive.
      this.gpuStarted = true;
      await this.rpc("gpu.state", {});
      this.sim.spawn(
        () => this.keepAlive(),
        (e) => this.errors.push(e),
      );
    }
    let resumed = false;
    for (;;) {
      const device = await this.place(stage, resumed);
      this.arm(stage, work);
      this.meter = new StepMeter();
      let how: "finished" | "suspended" | "oom";
      try {
        await run(device);
        how = "finished";
      } catch (e) {
        if (e instanceof Suspended) how = "suspended";
        else if (
          device === "gpu" &&
          e instanceof Error &&
          e.message.toLowerCase().includes("out of memory")
        )
          how = "oom";
        else {
          this.gate = null;
          throw e;
        }
      }
      if (how === "finished") {
        const median = this.meter.median();
        const r = await this.renew({
          end: { how, step_s: median, normal_s: this.profile.normalByCard(stage) },
        });
        this.gate = null;
        const learned = r.learned;
        if (learned !== null) {
          this.profile.use(learned.card);
          if (learned.drop_mb > 0) this.profile.notePeak(stage, learned.drop_mb);
          if (learned.note_step && median !== null) this.profile.noteStep(stage, median);
          if (learned.note_rate && this.s.audio_s)
            this.profile.noteRate(stage, this.meter.activeS / this.s.audio_s);
        }
        return;
      }
      await this.renew({ end: { how, step_s: null, normal_s: {} } });
      this.gate = null;
      this.note({ backend: "unload: drops its models" });
      await this.closeWindow();
      resumed = true;
    }
  }

  makeRun(
    st: StageSpec,
    work: { steps: number | null } | null,
  ): (device: "gpu" | "cpu") => Promise<void> {
    const name = st.stage;
    const key = st.backing ? "backing" : name; // what is counted, and where a pass goes on from
    return async (device) => {
      this.card.running = device;
      try {
        if (device === "gpu" && name === "convert" && this.rvc) {
          this.card.extra += st.rvc_mb ?? 0;
          try {
            await this.sleep(st.steps * st.step_s);
          } finally {
            this.card.extra -= st.rvc_mb ?? 0;
          }
          this.count(`${key} steps on gpu`, st.steps);
          return;
        }
        for (let i = name === "convert" ? (this.progress.get(key) ?? 0) : 0; i < st.steps; i++) {
          if (this.gate !== null) await this.gate();
          if (device === "gpu" && this.oomLeft.get(name) && !this.arbiter.windowOf(this.jobId)) {
            this.oomLeft.set(name, false);
            throw new Error("CUDA out of memory (simulated)");
          }
          if (device === "gpu") {
            const fewer = work !== null && name === "convert" ? (work.steps ?? 30) / 30 : 1.0;
            const slow = this.card.free() < this.card.spill_under ? this.card.slow_factor : 1.0;
            await this.sleep(st.step_s * slow * fewer);
          } else {
            await this.sleep(st.cpu_step_s ?? st.step_s * 20);
          }
          if (name === "convert") this.progress.set(key, i + 1);
          this.count(`${key} steps on ${device}`);
        }
      } finally {
        this.card.running = null;
      }
    };
  }

  /** The stages; consecutive conversion passes as `_convert_passes` runs them. */
  async pipeline(): Promise<void> {
    const stages = this.s.stages;
    let i = 0;
    while (i < stages.length) {
      const st = stages[i] as StageSpec;
      if (st.stage !== "convert") {
        await this.gpuStage(st.stage, this.makeRun(st, null), null);
        i += 1;
        continue;
      }
      // One pass after the other, each a stage placed on its own; her voice back after the last.
      try {
        while (i < stages.length && (stages[i] as StageSpec).stage === "convert") {
          const pass = stages[i] as StageSpec;
          i += 1;
          const work = { steps: null as number | null };
          await this.gpuStage("convert", this.makeRun(pass, work), work);
        }
      } finally {
        this.giveGpuBack();
      }
    }
  }

  /** `run_job` and the worker loop's outcome. */
  async jobMain(): Promise<void> {
    try {
      try {
        await this.pipeline();
      } finally {
        this.giveGpuBack();
        await this.exclusive?.reloading;
        const r = await this.release("close", true);
        this.keepAliveStop.set();
        this.summary = r.summary as unknown as Json;
      }
      this.outcome = { state: "done" };
    } catch (e) {
      if (!(e instanceof JobError)) throw e;
      this.outcome = { state: "failed", error: e.message };
    }
    this.note({ job: this.outcome.state });
    this.done.set();
  }

  // ── Core and the script ──

  peopleNow(): [number, boolean, number, boolean] {
    return this.s.people.filter((x) => x[0] <= this.sim.now).at(-1) as [
      number,
      boolean,
      number,
      boolean,
    ];
  }

  corePoll(): void {
    if (this.dead) return;
    const gone =
      this.s.core_gone !== null &&
      this.s.core_gone <= this.sim.now &&
      (this.s.core_back === null || this.sim.now < this.s.core_back);
    if (!gone) {
      const [, inVoice, listeners, live] = this.peopleNow();
      this.arbiter.context({
        in_voice: inVoice,
        listeners,
        live,
        urgent: this.s.urgent ? [this.jobId] : [],
      });
      const ex = this.exclusive;
      if (ex !== null && ex.state === "waiting" && !this.goDue && this.s.go_after !== null) {
        this.goDue = true;
        this.sim.at(this.sim.now + this.s.go_after, () => {
          this.goDue = false;
          this.note({ core: "POST /jobs/{id}/exclusive (go)" });
          this.go.set();
        });
      }
    }
    if (this.outcome.state === "running at the horizon")
      this.sim.at(this.sim.now + 1.5, () => this.corePoll());
  }

  async play(): Promise<Json> {
    const s = this.s;
    const fail = (e: unknown): void => {
      this.errors.push(e);
      this.sim.stop();
    };
    this.sim.afterEach = () => this.probe();
    this.sim.at(0.0, () => this.corePoll());
    for (const [t, values] of s.card_changes) {
      this.sim.at(t, () => {
        for (const [k, v] of Object.entries(values)) (this.card as unknown as Json)[k] = v;
        this.note({ card: values });
      });
    }
    if (s.die_at !== null) {
      this.sim.at(s.die_at, () => {
        this.note({ worker: "the song worker's process dies" });
        this.dead = true;
        this.card.running = null;
        this.card.extra = 0;
        this.gate = null;
        this.sim.spawn(() => this.arbiter.holderGone(HOLDER), fail);
      });
    }
    if (s.restart_at !== null) {
      this.sim.at(s.restart_at, () =>
        this.note({ worker: "the song worker starts again: _recover_speech" }),
      );
    }
    this.sim.spawn(() => this.jobMain(), fail);
    let result: Json = {};
    this.sim.spawn(async () => {
      const finished = await this.done.wait(s.horizon);
      if (finished) await this.sim.sleep(TAIL_S);
      else if (s.die_at === null) this.note({ horizon: "still running: the scenario stops here" });
      result = this.result();
      this.sim.stop();
    }, fail);
    this.probe();
    await this.sim.run();
    if (this.errors.length > 0) throw this.errors[0];
    return result;
  }

  result(): Json {
    const summary = this.summary ?? (this.arbiter.summaryOf(this.jobId) as unknown as Json | null);
    const gpu =
      summary === null
        ? null
        : Object.fromEntries(Object.entries(summary).filter(([k]) => k !== "decisions"));
    const ex = this.exclusive;
    const learned = this.arbiter.machine.profile.public();
    return {
      job: { ...this.outcome },
      gpu,
      exclusive:
        ex === null
          ? null
          : { state: ex.state, offloaded: ex.offloaded, errors: ex.errors, ...ex.timings },
      yielded: { yielded_s: pyRound(this.yieldedS, 2), pauses: this.yieldPauses },
      peers: Object.fromEntries([...this.peers.entries()].map(([n, p]) => [n, p.state])),
      learned: {
        headroom_mb: learned.headroom_mb,
        freed_mb: learned.freed_mb,
        reload_s: learned.reload_s,
      },
      steps: Object.fromEntries(
        [...this.counts.entries()].filter(([k]) => k.includes(" steps on ")).sort(),
      ),
      ended_at: pyRound(this.sim.now, 3),
    };
  }
}

// ── the comparison ────────────────────────────────────────────────────────

const STATE_KEYS = new Set([
  "stage",
  "exclusive",
  "window",
  "running",
  "yield_pauses",
  "tts",
  "asr",
]);

function kind(e: Event): "state" | "call" | "decision" | "other" {
  if ("call" in e) return "call";
  if ("decision" in e) return "decision";
  const keys = Object.keys(e).filter((k) => k !== "t");
  if (keys.length === 1 && STATE_KEYS.has(keys[0] as string)) return "state";
  return "other";
}

/** Per state: its value at the end of each instant, as changes. */
function timelines(events: Event[]): Record<string, [number, unknown][]> {
  const out: Record<string, [number, unknown][]> = {};
  for (const e of events) {
    if (kind(e) !== "state") continue;
    const key = Object.keys(e).find((k) => k !== "t") as string;
    if (out[key] === undefined) out[key] = [];
    const line = out[key] as [number, unknown][];
    const last = line.at(-1);
    if (last !== undefined && last[0] === e.t) last[1] = e[key];
    else line.push([e.t, e[key]]);
  }
  for (const key of Object.keys(out)) {
    out[key] = (out[key] as [number, unknown][]).filter(
      (x, i, a) => i === 0 || !same(x[1], (a[i - 1] as [number, unknown])[1]),
    );
  }
  return out;
}

function view(events: Event[]): Json {
  return {
    calls: events.filter((e) => kind(e) === "call"),
    decisions: events.filter((e) => kind(e) === "decision"),
    other: events.filter((e) => kind(e) === "other"),
    states: timelines(events),
  };
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(normal(a)) === JSON.stringify(normal(b));
}

/** Keys sorted, so two JSON values compare by content. */
function normal(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normal);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v as Json)
        .sort()
        .map((k) => [k, normal((v as Json)[k])]),
    );
  }
  return v;
}

function recordedResult(r: Json): Json {
  const counts = (r.counts ?? {}) as Record<string, number>;
  return {
    job: r.job,
    gpu: r.gpu,
    exclusive: r.exclusive,
    yielded: r.yielded,
    peers: r.peers,
    learned: r.learned,
    steps: Object.fromEntries(
      Object.entries(counts)
        .filter(([k]) => k.includes(" steps on "))
        .sort(),
    ),
    ended_at: r.ended_at,
  };
}

describe("the recorded scenarios, against the arbiter", () => {
  it("has the 31 recorded scenarios", () => {
    expect(RECORDED.scenarios.length).toBe(31);
  });

  for (const rec of RECORDED.scenarios) {
    const dies = rec.setup.die_at;
    it(`${rec.name}: ${rec.about}`, { timeout: 60_000 }, async () => {
      const sc = new Scenario(rec.setup);
      const result = await sc.play();
      EXCHANGES.set(rec.name, compress(sc.exchanges));
      const upToDeath = (es: Event[]): Event[] =>
        dies === null ? es : es.filter((e) => e.t < dies);
      expect(normal(view(upToDeath(sc.events)))).toEqual(normal(view(upToDeath(rec.events))));
      if (dies === null) {
        expect(normal(result)).toEqual(normal(recordedResult(rec.result)));
        return;
      }
      // After the death: hostd sees the holder go and brings speech back at once, in turn; the
      // services' own lease and the worker's restart no longer have anything to do.
      const after = sc.events.filter((e) => e.t >= dies && kind(e) === "call");
      expect(after.map((e) => [e.t, e.call])).toEqual([
        [dies, "POST tts/reload"],
        [dies + 20, "POST asr/reload"],
      ]);
      expect(sc.events.some((e) => "peer" in e)).toBe(false);
      expect(result.peers).toEqual({ tts: "loaded", asr: "loaded" });
      expect(sc.arbiter.windowOf(sc.jobId)).toBe(false);
    });
  }

  it("has written down what the worker asked and hostd answered (lease_exchanges.jsonl)", () => {
    const text = exchangesText(RECORDED.scenarios.map((rec) => rec.name));
    if (process.env.UPDATE_LEASE_EXCHANGES === "1") {
      writeFileSync(EXCHANGES_FILE, text);
      return;
    }
    const old = readFileSync(EXCHANGES_FILE, "utf8").replaceAll("\r\n", "\n");
    expect(old === text, "lease_exchanges.jsonl is stale: run with UPDATE_LEASE_EXCHANGES=1").toBe(
      true,
    );
  });
});

// ── the exchanges, for the Python lease client's cross-check ──────────────
//
// workers/tests/test_gpu_lease_replay.py runs the song worker's real job loop with
// SING_GPU_ARBITER=hostd against a hostd that answers from this file, and requires the worker to
// ask the same, at the same simulated times. Stored compactly: `gpu.busy` as runs of equal answers
// `[first t, last t, count, busy, allowance_s]`; every other call in order, a run of consecutive
// equal calls answered at once (same params and answer, no time between asking and answer) as one
// entry with its count and first and last time, a call answered later on its own with `t_end`.

const EXCHANGES_FILE = new URL("./lease_exchanges.jsonl", import.meta.url);
const EXCHANGES = new Map<string, { busy: unknown[]; calls: Json[] }>();

function compress(xs: Exchange[]): { busy: unknown[]; calls: Json[] } {
  const busy: [number, number, number, boolean, number][] = [];
  const calls: (Json & { key?: string })[] = [];
  for (const x of xs) {
    if (x.method === "gpu.busy") {
      const r = x.result as HostGpuBusyResult;
      const last = busy.at(-1);
      if (last !== undefined && last[3] === r.busy && last[4] === r.allowance_s) {
        last[1] = x.t;
        last[2] += 1;
      } else busy.push([x.t, x.t, 1, r.busy, r.allowance_s]);
      continue;
    }
    const instant = x.t_end === x.t;
    const key = instant
      ? JSON.stringify([x.method, normal(x.params), normal(x.result)])
      : undefined;
    const last = calls.at(-1);
    if (key !== undefined && last !== undefined && last.key === key) {
      last.n = (last.n as number) + 1;
      last.t1 = x.t;
      continue;
    }
    calls.push({
      key,
      method: x.method,
      n: 1,
      t0: x.t,
      t1: x.t,
      t_end: x.t_end,
      params: x.params,
      result: x.result,
    });
  }
  return {
    busy,
    calls: calls.map(({ key: _, ...c }) => c),
  };
}

/**
 * JSON Lines (one JSON value per line, so a diff shows one call per line, and the formatter, which
 * would spread a .json file over thirty thousand lines, leaves it alone): an `about` line, then per
 * scenario a line with its `busy` runs and one line per call.
 */
function exchangesText(names: string[]): string {
  const about =
    "What the song worker (the scenario harness's port of server.py, as lease.py does it) asked hostd's arbiter and what it answered, per recorded scenario, in simulated seconds. Written by packages/hostd/test/arbiter/scenarios.test.ts (UPDATE_LEASE_EXCHANGES=1); replayed by workers/tests/test_gpu_lease_replay.py.";
  const out = [JSON.stringify({ about })];
  for (const name of names) {
    const x = EXCHANGES.get(name);
    if (x === undefined) throw new Error(`no exchanges for ${name}: run the whole file`);
    out.push(JSON.stringify({ scenario: name, busy: x.busy }));
    for (const c of x.calls) out.push(JSON.stringify({ scenario: name, call: normal(c) }));
  }
  return `${out.join("\n")}\n`;
}
