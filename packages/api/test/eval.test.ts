// The live evaluation beside the API: the tolerant reader of `history.jsonl`, the nightly run
// (when it starts, what holds it back, how it ends), the `eval` module and `GET /api/eval/live`.
// The child process is a fake; nothing here starts the eval tool.

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { EvalLiveHistory } from "@miyoria/contracts/api";
import { type EvalLiveRun, EvalRun } from "@miyoria/contracts/events";
import { LlmRouterKey } from "@miyoria/llm/llm";
import { getLogger, Supervisor, SupervisorKey } from "@miyoria/runtime/kernel";
import { SingerKey } from "@miyoria/sing";
import { ActivityManagerKey, type JsonObject, systemClock } from "@miyoria/types";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  ActiveProfileKey,
  ApiModule,
  EVAL_HISTORY_FILE,
  type EvalCommand,
  EvalConfigSchema,
  type EvalExit,
  EvalModule,
  EvalNightlyKey,
  type EvalSpawner,
  evalCommand,
  evalHoldback,
  findEvalCheckout,
  NightlyRunner,
  nextRunAt,
  parseEvalHistory,
  readEvalHistory,
} from "../src/index.js";
import { raw } from "./support/http.js";

const temp: string[] = [];
function tempDir(): string {
  mkdirSync(tmpdir(), { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "api-eval-"));
  temp.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of temp) rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  vi.useRealTimers();
});

const line = (at: string, over: Partial<EvalLiveRun> = {}): EvalLiveRun => ({
  v: 1,
  at,
  commit: "0d611db5aa",
  subject: "current",
  repeat: 1,
  suites: {
    persona: {
      headline: { score: 0.9, low_share: 0.1 },
      items: 20,
      unsupported: 0,
      stopped: false,
    },
  },
  tokens: {
    calls: 3,
    prompt_tokens: 100,
    completion_tokens: 10,
    cached_prompt_tokens: 0,
    reasoning_tokens: 0,
  },
  usd: 0.08,
  duration_ms: 840_000,
  models: ["opencode:flash"],
  stopped: null,
  ...over,
});

const jsonl = (...runs: unknown[]): string => runs.map((r) => `${JSON.stringify(r)}\n`).join("");

/** A local time on 16 November 2026, in ms. */
const local = (hours: number, minutes = 0, day = 16): number =>
  new Date(2026, 10, day, hours, minutes, 0, 0).getTime();

// ---- the reader ----------------------------------------------------------------------------

describe("reading history.jsonl", () => {
  it("has no runs when there is no folder or no file", async () => {
    const dir = tempDir();
    expect(await readEvalHistory(join(dir, "missing"), 90)).toEqual([]);
    expect(await readEvalHistory(dir, 90)).toEqual([]);
  });

  it("leaves out what is not a run of this version, and keeps the order", () => {
    const { v: _, ...old } = line("2026-11-15T20:30:00.000Z");
    const text = [
      JSON.stringify(old),
      "not json",
      "",
      JSON.stringify(line("2026-11-16T20:30:00.000Z")),
      JSON.stringify({ ...line("2026-11-17T20:30:00.000Z"), v: 2 }),
      '"a string"',
      JSON.stringify(line("2026-11-18T20:30:00.000Z", { usd: null, commit: null })),
    ].join("\r\n");
    expect(parseEvalHistory(text).map((r) => r.at)).toEqual([
      "2026-11-16T20:30:00.000Z",
      "2026-11-18T20:30:00.000Z",
    ]);
  });

  it("reads a file that is being appended to: the half-written last line is not a run yet", async () => {
    const dir = tempDir();
    const file = join(dir, EVAL_HISTORY_FILE);
    const whole = JSON.stringify(line("2026-11-17T20:30:00.000Z"));
    writeFileSync(file, jsonl(line("2026-11-16T20:30:00.000Z")) + whole.slice(0, 40));
    expect((await readEvalHistory(dir, 90)).map((r) => r.at)).toEqual(["2026-11-16T20:30:00.000Z"]);
    appendFileSync(file, `${whole.slice(40)}\n`);
    expect(await readEvalHistory(dir, 90)).toHaveLength(2);
  });

  it("returns the last runs asked for, oldest first", async () => {
    const dir = tempDir();
    const days = [10, 11, 12, 13, 14].map((d) => `2026-11-${d}T20:30:00.000Z`);
    writeFileSync(join(dir, EVAL_HISTORY_FILE), jsonl(...days.map((at) => line(at))));
    expect((await readEvalHistory(dir, 2)).map((r) => r.at)).toEqual(days.slice(3));
    expect(await readEvalHistory(dir, 90)).toHaveLength(5);
  });
});

// ---- when and what -------------------------------------------------------------------------

describe("the next run", () => {
  it("is today at the time when that is still ahead, else tomorrow", () => {
    expect(nextRunAt(local(4, 0), "04:30")).toBe(local(4, 30));
    expect(nextRunAt(local(4, 30), "04:30")).toBe(local(4, 30, 17));
    expect(nextRunAt(local(23, 59), "04:30")).toBe(local(4, 30, 17));
    expect(nextRunAt(local(0, 0), "00:00")).toBe(local(0, 0, 17));
    // The last day of a month.
    expect(nextRunAt(new Date(2026, 10, 30, 12, 0).getTime(), "04:30")).toBe(
      new Date(2026, 11, 1, 4, 30).getTime(),
    );
  });
});

describe("the section and the command", () => {
  it("is off by default, and takes a time as HH:MM only", () => {
    expect(EvalConfigSchema.parse({})).toEqual({
      nightly: "",
      max_usd: 0.5,
      suites: [],
      memory_set: "",
      out: "data/eval/live",
      config: "miyoria.toml",
      timeout_min: 30,
    });
    expect(EvalConfigSchema.safeParse({ nightly: "04:30" }).success).toBe(true);
    for (const bad of ["4:30", "24:00", "04:60", "0430", "nightly"]) {
      expect(EvalConfigSchema.safeParse({ nightly: bad }).success, bad).toBe(false);
    }
  });

  it("is the root `eval` script with --live, in one node process, on absolute paths", () => {
    const base = resolve("/srv/miyoria");
    const config = EvalConfigSchema.parse({
      nightly: "04:30",
      suites: ["persona", "memory"],
      memory_set: "data/eval/sets/memory.json",
      max_usd: 0.25,
    });
    expect(evalCommand(resolve("/repo"), base, config)).toEqual({
      command: process.execPath,
      cwd: resolve("/repo"),
      args: [
        "--conditions=@miyoria/source",
        "--import",
        "tsx",
        "tools/eval/src/cli.ts",
        "--live",
        "--config",
        join(base, "miyoria.toml"),
        "--max-usd",
        "0.25",
        "--out",
        join(base, "data", "eval", "live"),
        "--suite",
        "persona,memory",
        "--memory-set",
        join(base, "data", "eval", "sets", "memory.json"),
      ],
    });
    const plain = evalCommand(resolve("/repo"), base, EvalConfigSchema.parse({}));
    expect(plain.args).not.toContain("--suite");
    expect(plain.args).not.toContain("--memory-set");
  });

  it("finds a checkout by its eval tool, at or above a folder, and none where there is none", () => {
    const root = resolve("/work/miyoria");
    const files = new Set([join(root, "tools", "eval", "src", "cli.ts")]);
    const exists = (path: string) => files.has(path);
    const inside = join(root, "packages", "api", "src", "eval");
    // No `tsx` to run it with yet.
    expect(findEvalCheckout([inside], exists)).toBeNull();
    files.add(join(root, "node_modules", "tsx"));
    expect(findEvalCheckout([inside], exists)).toBe(root);
    expect(findEvalCheckout([root], exists)).toBe(root);
    expect(findEvalCheckout([resolve("/opt/miyoria/lib"), inside], exists)).toBe(root);
    expect(findEvalCheckout([resolve("/opt/miyoria/lib"), resolve("/srv")], exists)).toBeNull();
  });

  it("finds this repository from this file", () => {
    expect(findEvalCheckout([import.meta.dirname])).toBe(resolve(import.meta.dirname, "../../.."));
  });
});

// ---- the runner ----------------------------------------------------------------------------

interface FakeChild {
  command: EvalCommand;
  killed: boolean;
  /** Ends the process as the tool does: a new history line when `run` is given. */
  exit(code: number, run?: EvalLiveRun): void;
}

function fakeSpawner(outDir: string): { spawn: EvalSpawner; children: FakeChild[] } {
  const children: FakeChild[] = [];
  const spawn: EvalSpawner = (command) => {
    let done: (exit: EvalExit) => void = () => {};
    const exited = new Promise<EvalExit>((r) => {
      done = r;
    });
    const child: FakeChild = {
      command,
      killed: false,
      exit(code, run) {
        if (run !== undefined) {
          mkdirSync(outDir, { recursive: true });
          appendFileSync(join(outDir, EVAL_HISTORY_FILE), jsonl(run));
        }
        done({ code, tail: code === 0 ? "" : "boom" });
      },
    };
    children.push(child);
    return {
      exited,
      kill: () => {
        child.killed = true;
        done({ code: null, tail: "" });
      },
    };
  };
  return { spawn, children };
}

const COMMAND: EvalCommand = { command: "node", args: ["eval"], cwd: "." };
const TIMEOUT_MS = 30 * 60_000;

function runner(over: { holdback?: () => string | null; time?: string } = {}) {
  const outDir = join(tempDir(), "live");
  const { spawn, children } = fakeSpawner(outDir);
  const runs: EvalLiveRun[] = [];
  const nightly = new NightlyRunner({
    time: over.time ?? "04:30",
    timeoutMs: TIMEOUT_MS,
    command: COMMAND,
    outDir,
    clock: systemClock,
    spawn,
    holdback: over.holdback ?? (() => null),
    onRun: (run) => runs.push(run),
    log: getLogger("test.eval"),
  });
  return { nightly, children, runs, outDir };
}

/** Waits (in real time) until `n` children were started. The clock does not move. */
async function started(children: FakeChild[], n: number): Promise<void> {
  await vi.waitFor(() => expect(children).toHaveLength(n), { timeout: 2000, interval: 5 });
}

describe("the nightly runner", () => {
  it("runs once a day at the time, and reports the line the run added", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(local(4, 0));
    const { nightly, children, runs } = runner();
    const stop = new AbortController();
    const loop = nightly.run(stop.signal);
    expect(nightly.nextAt).toBe(local(4, 30));

    await vi.advanceTimersByTimeAsync(29 * 60_000);
    expect(children).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60_000);
    await started(children, 1);
    expect(children[0]?.command).toBe(COMMAND);
    expect(nightly.running).toBe(true);

    await vi.advanceTimersByTimeAsync(14 * 60_000);
    const first = line(new Date(local(4, 30)).toISOString());
    children[0]?.exit(0, first);
    await vi.waitFor(() => expect(runs).toEqual([first]), { interval: 5 });
    await vi.waitFor(() => expect(nightly.nextAt).toBe(local(4, 30, 17)), { interval: 5 });
    expect(nightly.running).toBe(false);

    // The rest of the day: nothing. The next day at the time: once more.
    await vi.advanceTimersByTimeAsync(23 * 3_600_000);
    expect(children).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3_600_000);
    await started(children, 2);
    children[1]?.exit(0, line(new Date(local(4, 30, 17)).toISOString()));
    await vi.waitFor(() => expect(runs).toHaveLength(2), { interval: 5 });

    stop.abort();
    await loop;
    expect(nightly.nextAt).toBeNull();
    expect(children.every((c) => !c.killed)).toBe(true);
  });

  it.each(["she is singing", "she is live", "the LLM budget is exhausted"])(
    "skips the day when %s",
    async (reason) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      vi.setSystemTime(local(4, 29));
      let held: string | null = reason;
      const { nightly, children } = runner({ holdback: () => held });
      const stop = new AbortController();
      const loop = nightly.run(stop.signal);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(children).toHaveLength(0);
      expect(nightly.nextAt).toBe(local(4, 30, 17));
      // What held it back ends an hour later: the day stays skipped.
      held = null;
      await vi.advanceTimersByTimeAsync(23 * 3_600_000);
      expect(children).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(3_600_000);
      await started(children, 1);
      stop.abort();
      await loop;
      expect(children[0]?.killed).toBe(true);
    },
  );

  it("says why an attempt was skipped", async () => {
    const { nightly, children } = runner({ holdback: () => "she is singing" });
    expect(await nightly.attempt(new AbortController().signal)).toEqual({
      kind: "skipped",
      reason: "she is singing",
    });
    expect(children).toHaveLength(0);
  });

  it("never runs two at once", async () => {
    const { nightly, children } = runner();
    const signal = new AbortController().signal;
    const first = nightly.attempt(signal);
    expect(await nightly.attempt(signal)).toEqual({ kind: "skipped", reason: "a run is going on" });
    await started(children, 1);
    expect(await nightly.attempt(signal)).toEqual({ kind: "skipped", reason: "a run is going on" });
    children[0]?.exit(0);
    // It ended without a new line: nothing to report.
    expect(await first).toEqual({ kind: "ran", code: 0, run: null });
    expect(children).toHaveLength(1);
    // Once it is over, the next may start.
    const second = nightly.attempt(signal);
    await started(children, 2);
    children[1]?.exit(1);
    expect(await second).toEqual({ kind: "ran", code: 1, run: null });
  });

  it("kills a run that takes longer than the limit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(local(4, 30));
    const { nightly, children, runs } = runner();
    const attempt = nightly.attempt(new AbortController().signal);
    await started(children, 1);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1000);
    expect(children[0]?.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await attempt).toEqual({ kind: "timeout" });
    expect(children[0]?.killed).toBe(true);
    expect(runs).toEqual([]);
    expect(nightly.running).toBe(false);
  });

  it("kills the run when the module stops", async () => {
    const { nightly, children } = runner();
    const stop = new AbortController();
    const attempt = nightly.attempt(stop.signal);
    await started(children, 1);
    stop.abort();
    expect(await attempt).toEqual({ kind: "stopped" });
    expect(children[0]?.killed).toBe(true);
    // Stopped already: nothing is started.
    expect(await nightly.attempt(stop.signal)).toEqual({ kind: "stopped" });
    expect(children).toHaveLength(1);
  });

  it("reports a run only when it added a line to the history", async () => {
    const { nightly, children, runs, outDir } = runner();
    mkdirSync(outDir, { recursive: true });
    const old = line("2026-11-15T20:30:00.000Z");
    writeFileSync(join(outDir, EVAL_HISTORY_FILE), jsonl(old));
    const signal = new AbortController().signal;
    const failed = nightly.attempt(signal);
    await started(children, 1);
    children[0]?.exit(2);
    expect(await failed).toEqual({ kind: "ran", code: 2, run: null });
    expect(runs).toEqual([]);

    const fresh = line("2026-11-16T20:30:00.000Z", { stopped: "budget" });
    const ok = nightly.attempt(signal);
    await started(children, 2);
    children[1]?.exit(0, fresh);
    expect(await ok).toEqual({ kind: "ran", code: 0, run: fresh });
    expect(runs).toEqual([fresh]);
  });
});

// ---- what holds a run back ------------------------------------------------------------------

describe("what holds a run back", () => {
  const services = (over: { singing?: boolean; live?: boolean; budget?: string }) => {
    const sup = new Supervisor();
    sup.services.provide("sing", SingerKey, {
      playing: () => (over.singing ? {} : null),
    } as never);
    sup.services.provide("activity", ActivityManagerKey, {
      snapshot: () => ({ broadcast: { type: over.live ? "live" : "off" } }),
    } as never);
    sup.services.provide("llm", LlmRouterKey, {
      budgetState: () => over.budget ?? "ok",
    } as never);
    return sup.services;
  };

  it("is nothing when she is idle and the budget is fine, or when nobody can say", () => {
    expect(evalHoldback(services({}))).toBeNull();
    expect(evalHoldback(new Supervisor().services)).toBeNull();
  });

  it("is singing, live, or a budget that is degraded or exhausted", () => {
    expect(evalHoldback(services({ singing: true }))).toBe("she is singing");
    expect(evalHoldback(services({ live: true }))).toBe("she is live");
    expect(evalHoldback(services({ budget: "degraded" }))).toBe("the LLM budget is degraded");
    expect(evalHoldback(services({ budget: "exhausted" }))).toBe("the LLM budget is exhausted");
  });
});

// ---- the module and the route ---------------------------------------------------------------

const TOKEN = "test-token";
const sups: Supervisor[] = [];
afterEach(async () => {
  for (const s of sups.splice(0)) await s.stopAll();
});

async function harness(section: JsonObject | null, root: string | null = "/repo") {
  const baseDir = tempDir();
  const outDir = join(baseDir, "data", "eval", "live");
  const { spawn, children } = fakeSpawner(outDir);
  const sup = new Supervisor();
  sups.push(sup);
  sup.services.provide("kernel", SupervisorKey, sup);
  sup.services.provide("kernel", ActiveProfileKey, "p");
  const api = new ApiModule({ env: () => undefined });
  await sup.register(api, { bind: "127.0.0.1:0", token: TOKEN, panel_dir: "" }, true);
  if (section !== null) {
    await sup.register(new EvalModule({ baseDir, root, spawn }), section, true);
  }
  await sup.startAll();
  const base = api.url();
  if (!base) throw new Error("api is not running");
  const history = async (query = ""): Promise<EvalLiveHistory> => {
    const got = await raw(base, "GET", `/api/eval/live${query}`, { token: TOKEN });
    expect(got.status).toBe(200);
    return got.body as EvalLiveHistory;
  };
  return { sup, base, outDir, children, history };
}

describe("the eval module and GET /api/eval/live", () => {
  it("needs the token", async () => {
    const h = await harness({});
    expect((await raw(h.base, "GET", "/api/eval/live")).status).toBe(401);
    const bad = await raw(h.base, "GET", "/api/eval/live?limit=two", { token: TOKEN });
    expect(bad.status).toBe(400);
  });

  it("has no runs and no nightly without the module", async () => {
    const h = await harness(null);
    expect(await h.history()).toEqual({
      runs: [],
      nightly: { state: "off", time: null, next_at: null, running: false },
    });
  });

  it("is off by default, and still serves the runs made by hand", async () => {
    const h = await harness({});
    expect(await h.history()).toEqual({
      runs: [],
      nightly: { state: "off", time: null, next_at: null, running: false },
    });
    mkdirSync(h.outDir, { recursive: true });
    const days = [12, 13, 14].map((d) => line(`2026-11-${d}T20:30:00.000Z`));
    writeFileSync(join(h.outDir, EVAL_HISTORY_FILE), `${jsonl(...days)}{"v":1,"at":"half`);
    expect((await h.history()).runs).toEqual(days);
    expect((await h.history("?limit=1")).runs).toEqual(days.slice(2));
    expect(h.children).toHaveLength(0);
  });

  it("says a time needs a repository checkout where there is none, and starts nothing", async () => {
    const h = await harness({ nightly: "04:30" }, null);
    expect((await h.history()).nightly).toEqual({
      state: "no_checkout",
      time: "04:30",
      next_at: null,
      running: false,
    });
    expect(h.sup.list().find((m) => m.id === "eval")?.state).toBe("running");
    expect(h.children).toHaveLength(0);
  });

  it("says when the next run is", async () => {
    const h = await harness({ nightly: "04:30" });
    const nightly = (await h.history()).nightly;
    expect(nightly).toMatchObject({ state: "scheduled", time: "04:30", running: false });
    const next = Date.parse(nightly.next_at ?? "");
    expect(next).toBeGreaterThan(Date.now());
    expect(next).toBe(nextRunAt(next - 1, "04:30"));
    expect(h.children).toHaveLength(0);
  });
});

/** The module alone on a supervisor, a minute before its time. */
async function atNight(provide: (sup: Supervisor) => void = () => {}) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(local(4, 29));
  const baseDir = tempDir();
  const outDir = join(baseDir, "runs");
  const { spawn, children } = fakeSpawner(outDir);
  const sup = new Supervisor();
  sups.push(sup);
  provide(sup);
  const module = new EvalModule({ baseDir, root: resolve("/repo"), spawn });
  await sup.register(module, { nightly: "04:30", out: "runs", suites: ["tools"] }, true);
  await sup.startAll();
  const status = () => sup.services.require(EvalNightlyKey).status();
  return { sup, baseDir, outDir, children, status };
}

describe("the eval module at its time", () => {
  it("starts the eval tool, and publishes the line it wrote as eval.run", async () => {
    const h = await atNight();
    const sub = h.sup.bus.subscribe(EvalRun.type);
    expect(h.status()).toEqual({
      state: "scheduled",
      time: "04:30",
      next_at: new Date(local(4, 30)).toISOString(),
      running: false,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await started(h.children, 1);
    expect(h.status().running).toBe(true);
    const command = h.children[0]?.command;
    expect(command?.cwd).toBe(resolve("/repo"));
    expect(command?.args).toEqual(
      expect.arrayContaining(["--live", "--out", h.outDir, "--suite", "tools", "--max-usd", "0.5"]),
    );
    expect(command?.args).toContain(join(h.baseDir, "miyoria.toml"));

    const run = line(new Date(local(4, 30)).toISOString());
    h.children[0]?.exit(0, run);
    await vi.waitFor(() => expect(h.status().running).toBe(false), { interval: 5 });
    const env = sub.tryRecv();
    expect(env).toMatchObject({ type: "eval.run", source: "eval", data: run });
    expect(sub.tryRecv()).toBeNull();
    expect(h.status().next_at).toBe(new Date(local(4, 30, 17)).toISOString());
    sub.close();
  });

  it("does not start while she is singing", async () => {
    const h = await atNight((sup) =>
      sup.services.provide("sing", SingerKey, { playing: () => ({}) } as never),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.children).toHaveLength(0);
    expect(h.status().next_at).toBe(new Date(local(4, 30, 17)).toISOString());
  });

  it("kills the run on shutdown", async () => {
    const h = await atNight();
    await vi.advanceTimersByTimeAsync(60_000);
    await started(h.children, 1);
    await h.sup.stopAll();
    expect(h.children[0]?.killed).toBe(true);
    expect(h.sup.services.get(EvalNightlyKey)).toBeUndefined();
  });
});
