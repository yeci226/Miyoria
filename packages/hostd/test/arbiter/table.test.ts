// Every recorded decision (workers/sing/gpu_decisions.json), reproduced exactly: no tolerance, no
// row skipped. The hostd-side functions are the arbiter's own code; the worker-side ones
// (`typical_peak`, `profile.note_step`, the work part of `silence_estimate`) are the harness's
// copies in worker.ts, checked here so the scenario test plays the worker as the Python does.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  Arbiter,
  Audience,
  CardProfile,
  type Clock,
  type DeviceReading,
  decide,
  type Facts,
  headroom,
  JobState,
  LIMITS_DEFAULT,
  type Limits,
  limitsFrom,
  type PeerClient,
  type Policy,
  policyFrom,
  pyRepr,
  pyRound,
  SpeechReader,
  silenceEstimate,
  type Tenant,
  urgentOf,
  yieldAllowance,
  yieldHold,
} from "../../src/arbiter/index.js";
import { StageProfile, typicalPeak, workEstimate } from "./worker.js";

type Row = { fn: string; in: Record<string, unknown>; out: unknown };
type Json = Record<string, unknown>;

const TABLE_FILE = new URL("../../../../workers/sing/gpu_decisions.json", import.meta.url);
const TABLE = JSON.parse(readFileSync(TABLE_FILE, "utf8")) as {
  header: {
    functions: Record<string, { cases: number }>;
    bases: Record<string, Json>;
    limits_default: Limits;
  };
  cases: Row[];
};

/** Where each function of the table lives after the move. */
const WHERE: Record<string, "hostd" | "worker" | "both"> = {
  policy_from_env: "hostd",
  limits_from_env: "hostd",
  decide: "hostd",
  gather: "hostd",
  headroom: "hostd",
  typical_peak: "worker",
  "profile.note_step": "worker",
  "profile.note_spill": "hostd",
  "profile.note_healthy": "hostd",
  "audience.people": "hostd",
  "speech.read": "hostd",
  "speech.read_cache": "hostd",
  silence_estimate: "both",
  yield_allowance: "hostd",
  "yield.hold": "hostd",
  tick: "hostd",
  "server.urgent": "hostd",
  "server.recover_speech": "hostd",
};

const URLS = ["http://tts", "http://asr"];
const tenant = (url: string): Tenant => ({
  name: url.slice("http://".length),
  url,
  offload: "/offload",
  reload: "/reload",
  busy: "/busy",
  health: "/health",
});
const TENANTS = URLS.map(tenant);

function input(row: Row): Json {
  return { ...(TABLE.header.bases[row.fn] ?? {}), ...row.in };
}

function limitsOf(delta: unknown): Limits {
  return { ...TABLE.header.limits_default, ...((delta ?? {}) as Partial<Limits>) };
}

class TestClock implements Clock {
  constructor(public t: number) {}
  now(): number {
    return this.t;
  }
}

/** Health replies by base URL: an object, or "error" for one that does not answer. */
function healthPeers(replies: Record<string, unknown>): PeerClient {
  const fail = (): never => {
    throw new Error("not used here");
  };
  return {
    offload: async () => fail(),
    reload: async () => fail(),
    busy: async () => fail(),
    health: async (t) => {
      const r = replies[t.url] ?? { offloaded: false };
      if (r === "error") throw new Error("connection refused");
      return { ...(r as Json) };
    },
  };
}

const NO_TIMERS = { sleep: () => new Promise<void>(() => {}) };

function machineFor(
  clock: Clock,
  device: () => Promise<DeviceReading>,
  profile: CardProfile,
): Arbiter {
  return new Arbiter({
    clock,
    timers: NO_TIMERS,
    readDevice: device,
    peers: healthPeers({}),
    tenants: TENANTS,
    holders: ["sing"],
    profile,
  });
}

const SPEECH_STATES: Record<string, Record<string, unknown>> = {
  loaded: { "http://tts": { offloaded: false }, "http://asr": { offloaded: false } },
  offloaded: {
    "http://tts": { offloaded: true, released_mb: 4700 },
    "http://asr": { offloaded: true, released_mb: 1500 },
  },
  one_down: { "http://tts": "error", "http://asr": { offloaded: true, released_mb: 1500 } },
};

function reading(
  kind: string,
  free: number | null = 2500,
  total = 12288,
): () => Promise<DeviceReading> {
  return async () => {
    if (kind === "none") return { cuda: false, total_mb: null, free_mb: null, name: "cpu" };
    if (kind === "raises") throw new Error("NVML went away");
    if (kind === "unreadable" || free === null)
      return { cuda: true, total_mb: null, free_mb: null, name: "Sim GPU" };
    return { cuda: true, total_mb: total, free_mb: free, name: "Sim GPU" };
  };
}

async function runGather(g: Json): Promise<unknown> {
  const clock = new TestClock(1000.0);
  const profile = new CardProfile();
  profile.use("Sim GPU", 12288);
  const stages = new StageProfile().use("Sim GPU/12288");
  if (g.profile === "learned") {
    for (const mb of [3300, 3500]) stages.notePeak("convert", mb);
    stages.notePeak("separate", 2100);
    forceHeadroom(profile, 2256);
    profile.noteOffload(5800, null);
  }
  const arbiter = machineFor(clock, reading(g.card as string), profile);
  const m = arbiter.machine;
  m.audience.update({ in_voice: true, listeners: 2, live: false, urgent: [] });
  m.gapUntil = clock.t + (g.gap_s as number);
  const speech = new SpeechReader(
    TENANTS,
    healthPeers(SPEECH_STATES[g.speech as string] ?? {}),
    clock,
  );
  const job = new JobState("job", m, speech, "yield", "default", { ...LIMITS_DEFAULT }, false);
  const stage = g.stage as string;
  const work = stages.workByCard(180.0, 0, stage);
  job.client = {
    need_mb: stages.needByCard(stage),
    own_mb: g.own_mb as number,
    est_work_s: work.prior,
    est_work_by_card: work.byCard,
    cpu_fallback: (g.cpu_fallback as string[]).includes(stage),
    queued: [],
  };
  job.waitFrom = g.wait_age === null ? null : clock.t - (g.wait_age as number);
  job.waitedTotalS = g.waited_before_s as number;
  job.window = g.window as boolean;
  job.offloadUseless = g.offload_useless as boolean;
  job.cpuOnly = g.cpu_only as boolean;
  const f: Partial<Facts> = await job.gather(stage, true, true);
  delete f.limits;
  return { ...f, silence_est_s: f.silence_est_s == null ? null : pyRound(f.silence_est_s, 3) };
}

/**
 * A learned headroom of `mb` on a fresh profile (gpu.py's tests write `_device()["headroom_mb"]`;
 * nothing but a spill sets it here): a spill at `mb - 256` with no total gives exactly `mb`.
 */
function forceHeadroom(profile: CardProfile, mb: number): void {
  const before = profile.public().spills;
  profile.noteSpill("table", mb - 256, null, null, null);
  if (profile.public().headroom_mb !== mb || profile.public().spills !== before + 1) {
    throw new Error(`could not set a learned headroom of ${mb}`);
  }
}

async function runTick(g: Json): Promise<unknown> {
  const clock = new TestClock(1000.0);
  const total = g.total_mb as number;
  const profile = new CardProfile();
  profile.use("Sim GPU", total);
  const stages = new StageProfile().use(`Sim GPU/${total}`);
  const stage = g.stage as string;
  if (g.baseline !== null) stages.noteStep(stage, g.baseline as number);
  if (g.reload_s !== null) profile.noteOffload(null, g.reload_s as number);
  if (g.headroom_learned !== null) forceHeadroom(profile, g.headroom_learned as number);
  const arbiter = machineFor(clock, reading("12gb", g.free_mb as number | null, total), profile);
  const m = arbiter.machine;
  const people = g.people as boolean | null;
  if (g.urgent && people === null) throw new Error("an urgent job needs a context in this harness");
  if (people !== null)
    m.audience.update({
      in_voice: true,
      listeners: people ? 2 : 0,
      live: false,
      urgent: g.urgent ? ["job"] : [],
    });
  m.gapUntil = clock.t + (g.gap_s as number);
  const speechPeers = healthPeers(
    Object.fromEntries(URLS.map((u) => [u, { offloaded: !g.speech_loaded }])),
  );
  const job = new JobState(
    "job",
    m,
    new SpeechReader(TENANTS, speechPeers, clock),
    g.policy as Policy,
    "default",
    limitsOf(g.limits),
    people === null,
  );
  job.client = {
    need_mb: {},
    own_mb: g.own_mb as number,
    est_work_s: null,
    est_work_by_card: {},
    cpu_fallback: false,
    queued: [],
  };
  job.facts = await job.gather(stage, true, true);
  job.started(stage, "gpu", false);
  job.decision = g.window
    ? { mode: "exclusive", code: "window", reason: "" }
    : { mode: "share", code: "fits", reason: "" };
  job.window = g.window as boolean;
  job.offloadUseless = g.offload_useless as boolean;
  job.reducedTo = g.reduced_to as number | null;
  job.trimmed = g.trimmed as boolean;
  job.lowReads = g.low_reads as number;
  job.quietFrom = g.quiet_age === null ? null : clock.t - (g.quiet_age as number);
  job.checked = clock.t - 10.0;
  const recent = g.recent as number[];
  const r = await job.tick(
    stage,
    recent,
    stages.normalByCard(stage),
    g.own_mb as number,
    async () => (await job.speech.read()).loaded,
  );
  return {
    action:
      r.action === null
        ? null
        : { kind: r.action.kind, code: r.action.code, reason: r.action.reason },
    decision: `${job.decision?.mode}/${job.decision?.code}`,
    spilling: job.spilling,
    spills: job.spills,
    trimmed: job.trimmed,
    cpu_only: job.cpuOnly,
    reduced_to: job.reducedTo,
    offload_useless: job.offloadUseless,
    crowded_mb: job.crowdedMb,
    low_reads: job.lowReads,
    recent: r.clear ? [] : recent,
    quiet_age: job.quietFrom === null ? null : pyRound(clock.t - job.quietFrom, 3),
    headroom_learned: profile.learnedHeadroom(),
  };
}

async function runRecover(g: Json): Promise<unknown> {
  const calls: string[] = [];
  const health = g.health as unknown[];
  const replies: Record<string, unknown> = { "http://tts": health[0], "http://asr": health[1] };
  const timeout = (s: number): string => pyRepr(s);
  const peers: PeerClient = {
    offload: async () => {
      throw new Error("not used");
    },
    busy: async () => {
      throw new Error("not used");
    },
    health: async (t, s) => {
      calls.push(`GET ${t.url}${t.health} ${timeout(s)}`);
      const r = replies[t.url];
      if (r === "error") throw new Error("connection refused");
      return { ...(r as Json) };
    },
    reload: async (t, s) => {
      calls.push(`POST ${t.url}${t.reload} {} ${timeout(s)}`);
      if (g.reload_fails) throw new Error("connection refused");
      return { state: "ready" };
    },
  };
  const arbiter = new Arbiter({
    clock: new TestClock(0),
    timers: NO_TIMERS,
    readDevice: reading("12gb"),
    peers,
    tenants: TENANTS,
    holders: ["sing"],
  });
  await arbiter.recover();
  return { calls };
}

async function compute(row: Row): Promise<unknown> {
  const g = input(row);
  switch (row.fn) {
    case "policy_from_env": {
      const r = policyFrom(g.env as Record<string, string>);
      return { policy: r.policy, source: r.source };
    }
    case "limits_from_env":
      return { value: limitsFrom(g.env as Record<string, string>)[g.field as keyof Limits] };
    case "decide": {
      const { limits, ...rest } = g;
      const d = decide({ ...(rest as unknown as Facts), limits: limitsOf(limits) });
      return { mode: d.mode, code: d.code, reason: d.reason };
    }
    case "gather":
      return runGather(g);
    case "headroom":
      return {
        headroom_mb: headroom(
          g.total_mb as number | null,
          g.headroom_pct as number,
          g.learned_mb as number | null,
        ),
      };
    case "typical_peak":
      return { peak_mb: typicalPeak(g.peaks_mb as number[]) };
    case "profile.note_step": {
      const p = new StageProfile();
      if (g.step_s_before !== null) p.noteStep("convert", g.step_s_before as number);
      p.noteStep("convert", g.step_s as number);
      return { step_s: p.step("convert"), samples: p.samples("convert") };
    }
    case "profile.note_spill": {
      const p = new CardProfile(null, () => "2026-11-16T00:00:00Z");
      p.use("Sim GPU", g.total_mb as number | null);
      if (g.headroom_mb_before !== null) forceHeadroom(p, g.headroom_mb_before as number);
      const before = p.public().spills;
      p.noteSpill("convert", g.free_mb as number | null, 7.0, 0.1, g.total_mb as number | null);
      return { headroom_mb: p.learnedHeadroom(), spills: p.public().spills - before };
    }
    case "profile.note_healthy": {
      const p = new CardProfile();
      p.use("Sim GPU", 12288);
      if (g.headroom_mb_before !== null) forceHeadroom(p, g.headroom_mb_before as number);
      p.noteHealthy(g.free_min_mb as number | null);
      return { headroom_mb: p.learnedHeadroom() };
    }
    case "audience.people": {
      const clock = new TestClock(500.0);
      const a = new Audience(clock);
      if (g.age_s !== null) {
        a.update({
          in_voice: g.in_voice as boolean,
          listeners: g.listeners as number,
          live: g.live as boolean,
          urgent: [],
        });
        clock.t += g.age_s as number;
      }
      return {
        people: a.people(g.ttl_s as number, g.core_expected as boolean),
        fresh: a.public(g.ttl_s as number).fresh,
      };
    }
    case "speech.read": {
      const health = g.health as unknown[];
      const tenants = TENANTS.slice(0, health.length);
      const replies = Object.fromEntries(tenants.map((t, i) => [t.url, health[i]]));
      const got = await new SpeechReader(tenants, healthPeers(replies), new TestClock(0)).read();
      return { loaded: got.loaded, released_mb: got.released_mb };
    }
    case "speech.read_cache": {
      const clock = new TestClock(100.0);
      const replies: Record<string, unknown> = { "http://tts": { offloaded: false } };
      const s = new SpeechReader([tenant("http://tts")], healthPeers(replies), clock);
      expect(s.everyS).toBe(g.every_s);
      const first = (await s.read()).loaded;
      replies["http://tts"] = { offloaded: true };
      clock.t += g.age_s as number;
      if (g.forget) s.forget();
      return { first, again: (await s.read()).loaded };
    }
    case "silence_estimate": {
      const learned = g.learned as { rates?: Record<string, number>; reload_s?: number };
      const stages = new StageProfile();
      for (const [s, r] of Object.entries(learned.rates ?? {})) stages.noteRate(s, r);
      const card = new CardProfile();
      if (learned.reload_s !== undefined) card.noteOffload(null, learned.reload_s);
      const work = workEstimate(
        g.audio_s as number | null,
        g.converted as number,
        g.stage as string,
        stages,
      );
      const est = silenceEstimate(work, card.reloadS());
      return { silence_est_s: est === null ? null : pyRound(est, 3) };
    }
    case "yield_allowance":
      return {
        max_s: yieldAllowance(g.urgent as boolean, g.people as boolean | null, limitsOf(g.limits)),
      };
    case "yield.hold":
      return { hold_s: yieldHold(g.poll_s as number, g.hold_s as number) };
    case "tick":
      return runTick(g);
    case "server.urgent": {
      const queued = (g.jobs as [string, string][])
        .filter(([, s]) => s === "queued")
        .map(([id]) => id);
      return { urgent: urgentOf("me", queued, new Set(g.urgent as string[])) };
    }
    case "server.recover_speech":
      return runRecover(g);
    default:
      throw new Error(`no implementation for ${row.fn}`);
  }
}

describe("the recorded decision table", () => {
  it("names every function, and every function has a place after the move", () => {
    expect(Object.keys(TABLE.header.functions).sort()).toEqual(Object.keys(WHERE).sort());
    expect(TABLE.cases.length).toBe(
      Object.values(TABLE.header.functions).reduce((n, f) => n + f.cases, 0),
    );
  });

  it.each(Object.keys(WHERE))("%s: every row, exactly", async (fn) => {
    const rows = TABLE.cases.filter((c) => c.fn === fn);
    expect(rows.length).toBe(TABLE.header.functions[fn]?.cases);
    const wrong: string[] = [];
    for (const row of rows) {
      const got = await compute(row);
      if (!sameJson(got, row.out)) {
        wrong.push(
          `in ${JSON.stringify(row.in)}\n  recorded ${JSON.stringify(row.out)}\n  got      ${JSON.stringify(got)}`,
        );
      }
    }
    expect(wrong.slice(0, 5).join("\n"), `${wrong.length} of ${rows.length} rows differ`).toBe("");
  });
});

/** Equal as JSON values: numbers by value (Python's 2.0 is JavaScript's 2), keys in any order. */
function sameJson(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => sameJson(x, b[i]));
  const ka = Object.keys(a as Json).sort();
  const kb = Object.keys(b as Json).sort();
  return (
    ka.length === kb.length &&
    ka.every((k, i) => k === kb[i] && sameJson((a as Json)[k], (b as Json)[k]))
  );
}
