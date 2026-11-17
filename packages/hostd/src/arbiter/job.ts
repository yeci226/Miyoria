// One song job as the arbiter sees it: the hostd half of gpu.py `GpuJob`, line for line. The
// worker keeps what only it can measure (step times, its own peaks and rates) and sends them with
// each call; everything else (the card, her voice, who listens, the windows, the waits, the spill
// response) is here.

import type { HostGpuWindow } from "@miyoria/contracts/host";
import { CPU_STAGES, type Limits, type Policy, type PolicySource } from "./limits.js";
import { median, pyFixed, pyRepr, pyRound } from "./num.js";
import {
  type Decision,
  decide,
  type Facts,
  gb,
  silenceEstimate,
  urgentOf,
  yieldAllowance,
} from "./rules.js";
import type { Audience, CardProfile, Clock, SpeechReader } from "./state.js";

/** The device now. `cuda` false: no GPU at all. `free_mb` null: there is one, but it cannot be read. */
export interface Card {
  cuda: boolean;
  total_mb: number | null;
  free_mb: number | null;
  own_mb: number;
  name: string;
}

/** What the device reader returns; it throws when the card cannot be read. */
export interface DeviceReading {
  cuda: boolean;
  total_mb: number | null;
  free_mb: number | null;
  name: string;
}

/** What all jobs share. */
export interface Machine {
  readonly clock: Clock;
  readonly profile: CardProfile;
  readonly audience: Audience;
  gapUntil: number;
  last: Card | null;
  /** Reads the card; `ownMb` is what the asking worker holds of it (counted as room). */
  card(ownMb: number): Promise<Card>;
}

/** What `renew` wants done before the next step. */
export interface Action {
  kind: "trim" | "reduce" | "offload" | "suspend";
  code: string;
  reason: string;
}

export interface HistoryEntry {
  stage: string;
  mode: string;
  code: string;
  reason: string;
  free_mb: number | null;
  need_mb: number | null;
  people: boolean | null;
  urgent: boolean | null;
  step_s: number | null;
  t: number;
}

export const LOW_FREE_READS = 3;
export const HISTORY_KEPT = 40;
export const STEP_WINDOW = 3;

/**
 * Per card (`name/total_mb`, `CardProfile.key`): the worker learns per card, and only hostd knows
 * which card it reads now, so the worker sends what it knows for each and hostd takes the entry of
 * the card it just read.
 */
export type ByCard = Readonly<Record<string, number>>;

/** What the worker tells about the stage it places or runs, on every call. */
export interface ClientFacts {
  /** What the stage needs as learned on each card; a card it learned nothing on gets the prior. */
  need_mb: ByCard;
  own_mb: number;
  /**
   * Its estimate of the work left in seconds, without the reload, with its rates on each card
   * (`est_work_by_card`) and with its prior rates (`est_work_s`); null without the audio's length.
   */
  est_work_s: number | null;
  est_work_by_card: ByCard;
  cpu_fallback: boolean;
  queued: readonly string[];
}

function onCard(values: ByCard, key: string): number | null {
  return Object.hasOwn(values, key) ? (values[key] as number) : null;
}

export class JobState {
  stage = "";
  device: "gpu" | "cpu" = "gpu";
  decision: Decision | null = null;
  history: HistoryEntry[] = [];
  facts: Facts | null = null;
  spilling = false;
  spills = 0;
  reducedTo: number | null = null;
  window = false;
  offloadUseless = false;
  cpuOnly = false;
  crowdedMb: number | null = null;
  silencedS = 0;
  waitedTotalS = 0;
  waitFrom: number | null = null;
  windowAt = 0;
  /** When the first offload of the open window was asked: her voice went then. */
  offlineAt = 0;
  /** Each closed window: its real silence next to the work time the limit bounds. */
  windows: HostGpuWindow[] = [];
  quietFrom: number | null = null;
  freeBefore: number | null = null;
  checked = 0;
  free0: number | null = null;
  freeMin: number | null = null;
  watchedMin: number | null = null;
  lowReads = 0;
  trimmed = false;
  clean = true;
  resumed = false;
  /** The last three step times the worker sent. */
  recent: number[] = [];
  client: ClientFacts = {
    need_mb: {},
    own_mb: 0,
    est_work_s: null,
    est_work_by_card: {},
    cpu_fallback: false,
    queued: [],
  };

  constructor(
    readonly id: string,
    readonly machine: Machine,
    readonly speech: SpeechReader,
    readonly policy: Policy,
    readonly policySource: PolicySource,
    readonly limits: Limits,
    readonly coreExpected: boolean,
    private readonly onDecision: (job: JobState, entry: HistoryEntry) => void = () => {},
  ) {}

  get clock(): Clock {
    return this.machine.clock;
  }

  // ── reading the machine ──────────────────────────────────────────────

  people(): boolean | null {
    return this.machine.audience.people(this.limits.context_ttl_s, this.coreExpected);
  }

  urgent(): boolean {
    return urgentOf(this.id, this.client.queued, this.machine.audience.urgent);
  }

  /** On the card the profile is on now. */
  silenceEstimate(): number | null {
    if (this.client.est_work_s === null) return null;
    const work =
      onCard(this.client.est_work_by_card, this.machine.profile.key) ?? this.client.est_work_s;
    return silenceEstimate(work, this.machine.profile.reloadS());
  }

  /** The stage's need on the card the profile is on now (`Profile.need`). */
  needMb(): number {
    return onCard(this.client.need_mb, this.machine.profile.key) ?? this.limits.prior_need_mb;
  }

  async gather(stage: string, onGpu: boolean, pauses: boolean): Promise<Facts> {
    const m = this.machine;
    const card = await m.card(this.client.own_mb);
    const now = this.clock.now();
    const waited = this.waitingS();
    const speech = await this.speech.read();
    const freed = m.profile.freedMb();
    return {
      policy: this.policy,
      stage,
      limits: this.limits,
      cuda: card.cuda,
      on_gpu: onGpu,
      pauses,
      total_mb: card.total_mb,
      free_mb: card.free_mb,
      own_mb: card.own_mb,
      need_mb: this.needMb(),
      headroom_mb: m.profile.headroom(card.total_mb, this.limits),
      freed_mb: freed !== null ? freed : speech.released_mb,
      speech_loaded: speech.loaded,
      people: this.people(),
      urgent: this.urgent(),
      waited_s: waited,
      waited_total_s: this.waitedTotalS + waited,
      silence_est_s: this.silenceEstimate(),
      gap_s: Math.max(0.0, m.gapUntil - now),
      window: this.window,
      offload_useless: this.offloadUseless,
      cpu_only: this.cpuOnly && CPU_STAGES.includes(stage),
      cpu_fallback: this.client.cpu_fallback,
      crowded_mb: this.crowdedMb,
    };
  }

  async decide(stage: string, onGpu: boolean, pauses: boolean): Promise<Decision> {
    this.facts = await this.gather(stage, onGpu, pauses);
    const d = decide(this.facts);
    this.note(stage, d);
    if (d.mode === "wait" && this.waitFrom === null) this.waitFrom = this.clock.now();
    return d;
  }

  /** How long the wait under way has lasted. */
  waitingS(): number {
    return this.waitFrom === null ? 0.0 : this.clock.now() - this.waitFrom;
  }

  waitOver(): void {
    if (this.waitFrom !== null) {
      this.waitedTotalS += this.clock.now() - this.waitFrom;
      this.waitFrom = null;
    }
  }

  stepLast(): number | null {
    return this.recent.length > 0 ? pyRound(median(this.recent), 3) : null;
  }

  note(stage: string, d: Decision): void {
    const last = this.decision;
    this.stage = stage;
    this.decision = d;
    if (last !== null && last.mode === d.mode && last.code === d.code) return;
    const f = this.facts;
    const entry: HistoryEntry = {
      stage,
      mode: d.mode,
      code: d.code,
      reason: d.reason,
      free_mb: f ? f.free_mb : null,
      need_mb: f ? f.need_mb : null,
      people: f ? f.people : null,
      urgent: f ? f.urgent : null,
      step_s: this.stepLast(),
      t: pyRound(this.clock.now(), 1),
    };
    this.history = [...this.history, entry].slice(-HISTORY_KEPT);
    this.onDecision(this, entry);
  }

  // ── a stage running ──────────────────────────────────────────────────

  started(stage: string, device: "gpu" | "cpu", resumed: boolean): void {
    this.stage = stage;
    this.device = device;
    this.recent = [];
    this.trimmed = false;
    this.clean = true;
    this.resumed = resumed;
    this.lowReads = 0;
    this.spilling = false;
    this.checked = this.clock.now();
    this.free0 = this.freeMin = this.facts ? this.facts.free_mb : null;
    this.watchedMin = null;
  }

  /** A reading taken by the watch while a stage that never ticks runs. */
  watched(free: number | null): void {
    if (free !== null)
      this.watchedMin = this.watchedMin === null ? free : Math.min(this.watchedMin, free);
  }

  lowestFree(): number | null {
    const seen = [this.freeMin, this.watchedMin].filter((m): m is number => m !== null);
    return seen.length > 0 ? Math.min(...seen) : null;
  }

  /**
   * A stage ended normally (`GpuJob.finished`, the hostd half): what the card shows of its peak,
   * and whether the worker may learn this run's step time and rate.
   */
  finished(
    stepS: number | null,
    normalByCard: ByCard,
  ): { drop_mb: number; note_step: boolean; note_rate: boolean; card: string } {
    const p = this.machine.profile;
    if (this.device !== "gpu")
      return { drop_mb: 0, note_step: false, note_rate: false, card: p.key };
    const normalS = onCard(normalByCard, p.key);
    const lowest = this.lowestFree();
    const drop = this.free0 === null || lowest === null ? 0 : this.free0 - lowest;
    let noteStep = false;
    let noteRate = false;
    if (this.clean && !this.spilling && stepS !== null) {
      // Nothing to compare with yet: a slow first run only teaches "normal" with room to spare.
      const f = this.facts;
      const tight = lowest !== null && f !== null && lowest <= f.headroom_mb;
      if (normalS !== null || stepS <= this.limits.spill_step_s || !tight) {
        noteStep = true;
        p.noteHealthy(lowest);
      }
      noteRate = !this.resumed;
    }
    p.save();
    return { drop_mb: drop, note_step: noteStep, note_rate: noteRate, card: p.key };
  }

  /** A stage was cut short: suspended, or out of VRAM. */
  async stopped(oom: boolean, ownMb: number): Promise<void> {
    this.clean = false;
    const p = this.machine.profile;
    if (oom) {
      this.spills += 1;
      const card = await this.machine.card(ownMb);
      this.crowdedMb = card.free_mb === null ? null : card.free_mb + card.own_mb;
      if (this.window) this.offloadUseless = true;
      this.note(this.stage, { mode: "wait", code: "oom", reason: "顯存不夠用,放掉重新決定" });
    }
    p.save();
  }

  // ── every step ───────────────────────────────────────────────────────

  yieldAllowance(): number {
    return yieldAllowance(this.urgent(), this.people(), this.limits);
  }

  /**
   * Before every step on the GPU: is this still right? `recent` and `normalByCard` are the
   * worker's last step times and its learned normal one. `clear` asks it to restart its step window.
   */
  async tick(
    stage: string,
    recent: readonly number[],
    normalByCard: ByCard,
    ownMb: number,
    speechLoaded: () => Promise<boolean>,
  ): Promise<{ action: Action | null; clear: boolean }> {
    this.recent = recent.slice(-STEP_WINDOW);
    if (this.device !== "gpu") return { action: null, clear: false };
    const now = this.clock.now();
    const limits = this.limits;
    const p = this.machine.profile;
    const free = await this.look(now, ownMb);
    if (this.window && this.policy !== "offload") {
      if (this.people() === false) this.quietFrom = null;
      else if (this.quietFrom === null) this.quietFrom = now;
      // The reload counts as silence too, but a window always gets half for work: one that
      // ended the moment it opened would silence her again and again and get nowhere.
      const workS = Math.max(limits.silence_max_s - p.reloadS(), limits.silence_max_s / 2);
      if (this.quietFrom !== null && now - this.quietFrom >= workS) {
        return {
          action: this.do({
            kind: "suspend",
            code: "silence_limit",
            reason: `語音已經離線快 ${pyFixed(limits.silence_max_s, 0)} 秒,先讓她回來,之後接著做`,
          }),
          clear: false,
        };
      }
    }
    const baseline = onCard(normalByCard, p.key);
    const head = p.headroom(this.facts ? this.facts.total_mb : null, limits);
    const limit = baseline ? baseline * limits.spill_factor : limits.spill_step_s;
    let slow = this.recent.length === STEP_WINDOW && Math.min(...this.recent) >= limit;
    if (slow && baseline === null && (free === null || free > head)) slow = false; // a slow card with room to spare
    const low = this.lowReads >= LOW_FREE_READS && !this.window && this.people() !== false;
    if (!(slow || low)) {
      this.spilling = false;
      return { action: null, clear: false };
    }
    return this.onSpill(stage, free, baseline, slow, ownMb, speechLoaded);
  }

  /** The free VRAM, read every `check_s`. */
  async look(now: number, ownMb: number): Promise<number | null> {
    const m = this.machine;
    if (now - this.checked < this.limits.check_s) return m.last ? m.last.free_mb : null;
    this.checked = now;
    const free = (await m.card(ownMb)).free_mb;
    if (free !== null) {
      this.freeMin = this.freeMin === null ? free : Math.min(this.freeMin, free);
      const head = m.profile.headroom(m.last ? m.last.total_mb : null, this.limits);
      this.lowReads = free < head / 2 ? this.lowReads + 1 : 0;
    }
    return free;
  }

  async onSpill(
    stage: string,
    free: number | null,
    baseline: number | null,
    slow: boolean,
    ownMb: number,
    speechLoaded: () => Promise<boolean>,
  ): Promise<{ action: Action; clear: boolean }> {
    const limits = this.limits;
    const p = this.machine.profile;
    const step = this.stepLast();
    this.spilling = true;
    this.clean = false;
    if (!this.trimmed) {
      this.spills += 1;
      if (slow) {
        const total = this.machine.last ? this.machine.last.total_mb : null;
        p.noteSpill(stage, free, step, baseline, total);
        p.save();
      }
      this.trimmed = true;
      this.recent = [];
      this.lowReads = 0;
      const what = slow
        ? `每步 ${pyRepr(step)} 秒,平常 ${pyRepr(baseline)} 秒`
        : `顯存只剩 ${gb(free)}`;
      return {
        action: this.do({
          kind: "trim",
          code: "spill_free",
          reason: `溢出了(${what}),先清掉這邊的快取`,
        }),
        clear: true,
      };
    }
    this.recent = [];
    this.lowReads = 0;
    const room = free === null ? null : free + ownMb;
    const reduce =
      stage === "convert" && this.reducedTo === null && limits.steps_min < limits.steps;
    if (CPU_STAGES.includes(stage)) {
      this.cpuOnly = true;
      return {
        action: this.do({
          kind: "suspend",
          code: "spill_cpu",
          reason: "分離溢出了,放掉顯示卡,改用 CPU 重做",
        }),
        clear: true,
      };
    }
    if (this.window) {
      if (reduce) {
        this.reducedTo = limits.steps_min;
        return {
          action: this.do({
            kind: "reduce",
            code: "spill_reduce",
            reason: `語音已經讓出來還是溢出,剩下的改成 ${limits.steps_min} 步(音質稍差,換時間)`,
          }),
          clear: true,
        };
      }
      this.offloadUseless = true;
      this.crowdedMb = room;
      return {
        action: this.do({
          kind: "suspend",
          code: "spill_wait",
          reason: "語音讓出來還是溢出,讓她回來,放掉顯存等空間",
        }),
        clear: true,
      };
    }
    if (this.policy === "share" && reduce) {
      this.reducedTo = limits.steps_min;
      return {
        action: this.do({
          kind: "reduce",
          code: "spill_reduce",
          reason: `設定不動語音,溢出時剩下的改成 ${limits.steps_min} 步(音質稍差)`,
        }),
        clear: true,
      };
    }
    const gap = this.machine.gapUntil - this.clock.now();
    const loaded = await speechLoaded();
    if (
      (this.policy === "auto" || this.policy === "yield") &&
      loaded &&
      !this.offloadUseless &&
      gap <= 0 &&
      (this.urgent() || this.people() === false)
    ) {
      return {
        action: this.do({
          kind: "offload",
          code: "spill_offload",
          reason: "溢出了,這時候可以請語音讓出來",
        }),
        clear: true,
      };
    }
    this.crowdedMb = room;
    return {
      action: this.do({
        kind: "suspend",
        code: "spill_wait",
        reason: "溢出了,放掉顯存,等空間再從這裡接著做",
      }),
      clear: true,
    };
  }

  do(a: Action): Action {
    const mode =
      a.kind === "suspend"
        ? "wait"
        : a.kind === "offload"
          ? "offload"
          : this.decision
            ? this.decision.mode
            : "share";
    this.note(this.stage, { mode: mode as Decision["mode"], code: a.code, reason: a.reason });
    return a;
  }

  // ── windows: her voice offline for this job ──────────────────────────

  async windowOpening(): Promise<void> {
    this.freeBefore = (await this.machine.card(this.client.own_mb)).free_mb;
  }

  /** `offlineAt`: when the first offload was asked. */
  async windowOpened(offlineAt: number | null = null): Promise<void> {
    const now = this.clock.now();
    this.window = true;
    this.windowAt = now;
    this.offlineAt = offlineAt ?? now;
    this.quietFrom = this.people() === false ? null : now;
    this.speech.forget();
    const free = (await this.machine.card(this.client.own_mb)).free_mb;
    if (free !== null) this.free0 = this.freeMin = free;
    // A difference on the whole card: whatever else moved meanwhile is in it.
    if (free !== null && this.freeBefore !== null && free > this.freeBefore) {
      this.machine.profile.noteOffload(free - this.freeBefore, null);
    }
    this.machine.profile.save();
  }

  /**
   * Her voice is back (or was asked back and could not be reached). `askedBackAt`: when the
   * reload was asked. The window's record, or null when no window was open.
   */
  windowClosed(reloadS: number | null, askedBackAt: number | null = null): HostGpuWindow | null {
    if (!this.window) return null;
    this.window = false;
    const now = this.clock.now();
    this.silencedS += now - this.windowAt;
    const asked = askedBackAt ?? now;
    const record: HostGpuWindow = {
      offload_s: pyRound(this.windowAt - this.offlineAt, 1),
      work_s: pyRound(asked - this.windowAt, 1),
      reload_s: pyRound(now - asked, 1),
      silence_s: pyRound(now - this.offlineAt, 1),
      // What `silence_max_s` bounded: the work time, while people could hear (else none).
      limit_s: this.quietFrom !== null ? this.limits.silence_max_s : null,
    };
    this.windows.push(record);
    if (this.quietFrom !== null) this.machine.gapUntil = now + this.limits.silence_gap_s;
    this.quietFrom = null;
    this.speech.forget();
    this.machine.profile.noteOffload(null, reloadS);
    this.machine.profile.save();
    return record;
  }

  // ── what is shown ────────────────────────────────────────────────────

  summary(): {
    policy: Policy;
    policy_source: PolicySource;
    decisions: HistoryEntry[];
    spills: number;
    steps: number | null;
    waited_s: number;
    silenced_s: number;
    windows: HostGpuWindow[];
  } {
    return {
      policy: this.policy,
      policy_source: this.policySource,
      decisions: this.history,
      spills: this.spills,
      steps: this.reducedTo,
      waited_s: pyRound(this.waitedTotalS, 1),
      silenced_s: pyRound(this.silencedS, 1),
      windows: [...this.windows],
    };
  }
}
