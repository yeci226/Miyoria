// Module `eval`: runs the live evaluation once a day (docs/design/v5-brain.md, B1).
//
// ```toml
// [modules.eval]
// nightly = "04:30"          # local time, HH:MM; "" (the default): no nightly run
// max_usd = 0.5              # the run's hard stop (`--max-usd`)
// suites = []                # `--suite`; empty: every suite that can run
// memory_set = ""            # `--memory-set`, relative to the config file's directory; "": none
// out = "data/eval/live"     # where the runs and `history.jsonl` are, relative to the same
// config = "miyoria.toml"    # the config file the run reads its model from, relative to the same
// timeout_min = 30           # a run that takes longer is killed
// ```
//
// The run is the eval tool as a child process (`pnpm eval --live ...`), so it has a router, a
// meter and a budget of its own and nothing of it runs inside Core. The tool is only in a
// repository checkout (`tools/eval`); an install without it says so once and schedules nothing.
// A run is not started while she is singing or live, or while the day's LLM budget is degraded or
// exhausted: that day is skipped. `history.jsonl` in the out folder stays the source of truth; a
// run that added a line is also published as `eval.run`.
//
// The module lives beside the API because the API reads the same folder for the panel
// (`GET /api/eval/live`) and asks this module where the nightly run stands (`EvalNightlyKey`).

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvalNightly } from "@miyoria/contracts/api";
import { type EvalLiveRun, EvalRun } from "@miyoria/contracts/events";
import { LlmRouterKey } from "@miyoria/llm/llm";
import {
  defineManifest,
  errorMessage,
  type Logger,
  type Module,
  type ModuleContext,
  type ServiceLookup,
  sleep,
  withTimeout,
} from "@miyoria/runtime/kernel";
import { SingerKey } from "@miyoria/sing";
import { ActivityManagerKey, type Clock, serviceKey, toTimestamp } from "@miyoria/types";
import { z } from "zod";
import { readEvalHistory } from "./history.js";

export const EvalConfigSchema = z.object({
  /** When the nightly run starts, local time `HH:MM`; `""`: there is none. */
  nightly: z
    .string()
    .regex(/^(|([01]\d|2[0-3]):[0-5]\d)$/, "expected a time as HH:MM, or an empty string")
    .default(""),
  /** The run's hard stop in USD. */
  max_usd: z.number().positive().default(0.5),
  /** The suites to run; empty: every suite that can run. */
  suites: z.array(z.string()).default([]),
  /** The memory suite's question set (relative to the config file's directory); `""`: none. */
  memory_set: z.string().default(""),
  /** Where the runs and `history.jsonl` are (relative to the config file's directory). */
  out: z.string().default("data/eval/live"),
  /** The config file the run reads its model from (relative to the config file's directory). */
  config: z.string().default("miyoria.toml"),
  /** A run that takes longer than this many minutes is killed. */
  timeout_min: z.number().positive().default(30),
});
export type EvalConfig = z.output<typeof EvalConfigSchema>;

/** What the API asks the `eval` module. */
export interface EvalNightlyService {
  /** The folder `history.jsonl` is in. */
  readonly outDir: string;
  status(): EvalNightly;
}
export const EvalNightlyKey = serviceKey<EvalNightlyService>("EvalNightly");

// ---- when ----------------------------------------------------------------------------------

/**
 * The next time the local clock reads `time` (`HH:MM`) strictly after `now`, in ms. Plain date
 * arithmetic on local fields, so a day that is 23 or 25 hours long still gives the same clock
 * time.
 */
export function nextRunAt(now: number, time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  const at = new Date(now);
  at.setHours(hours ?? 0, minutes ?? 0, 0, 0);
  if (at.getTime() <= now) {
    at.setDate(at.getDate() + 1);
    at.setHours(hours ?? 0, minutes ?? 0, 0, 0);
  }
  return at.getTime();
}

/**
 * Why a run must not start now (`null`: it may). Singing and live are read from the services
 * `GET /api/public/status` reads them from.
 */
export function evalHoldback(services: ServiceLookup): string | null {
  if ((services.get(SingerKey)?.playing() ?? null) !== null) return "she is singing";
  if (services.get(ActivityManagerKey)?.snapshot().broadcast.type === "live") return "she is live";
  const budget = services.get(LlmRouterKey)?.budgetState() ?? "ok";
  return budget === "ok" ? null : `the LLM budget is ${budget}`;
}

// ---- the child -----------------------------------------------------------------------------

export interface EvalCommand {
  command: string;
  args: string[];
  cwd: string;
}

export interface EvalExit {
  /** The exit code (`null`: it was killed, or never started). */
  code: number | null;
  /** The end of what it wrote to stderr, or why it did not start. */
  tail: string;
}

export interface EvalChild {
  /** Settles when the process is gone; never rejects. */
  exited: Promise<EvalExit>;
  kill(): void;
}

export type EvalSpawner = (command: EvalCommand) => EvalChild;

/** How much of the child's stderr is kept for the log. */
const TAIL_CHARS = 600;

/** Starts the command as a child process. Its stdout is dropped: the result is in the out folder. */
export const spawnEval: EvalSpawner = (command) => {
  const child = spawn(command.command, command.args, {
    cwd: command.cwd,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  let tail = "";
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    tail = (tail + chunk).slice(-TAIL_CHARS);
  });
  const exited = new Promise<EvalExit>((done) => {
    child.once("error", (error) => done({ code: null, tail: errorMessage(error) }));
    child.once("close", (code) => done({ code, tail }));
  });
  return { exited, kill: () => void child.kill() };
};

/** The eval tool's entry, from the repository root. */
const EVAL_CLI = "tools/eval/src/cli.ts";

/**
 * The repository root that has the eval tool and `tsx` to run it with: the first folder at or
 * above one of `starts` (`null`: none, a packaged install).
 */
export function findEvalCheckout(
  starts: readonly string[],
  exists: (path: string) => boolean = existsSync,
): string | null {
  for (const start of starts) {
    for (let dir = resolve(start); ; dir = dirname(dir)) {
      if (exists(join(dir, EVAL_CLI)) && exists(join(dir, "node_modules", "tsx"))) {
        return dir;
      }
      if (dirname(dir) === dir) break;
    }
  }
  return null;
}

/**
 * `pnpm eval --live ...` without pnpm: the root script is `tsx --conditions=@miyoria/source
 * tools/eval/src/cli.ts`, and this is the same in one node process (`--import tsx`), so killing
 * the child ends the run. Every path is absolute.
 */
export function evalCommand(root: string, baseDir: string, config: EvalConfig): EvalCommand {
  return {
    command: process.execPath,
    cwd: root,
    args: [
      "--conditions=@miyoria/source",
      "--import",
      "tsx",
      EVAL_CLI,
      "--live",
      "--config",
      resolve(baseDir, config.config),
      "--max-usd",
      String(config.max_usd),
      "--out",
      resolve(baseDir, config.out),
      ...(config.suites.length > 0 ? ["--suite", config.suites.join(",")] : []),
      ...(config.memory_set !== "" ? ["--memory-set", resolve(baseDir, config.memory_set)] : []),
    ],
  };
}

// ---- the runner ----------------------------------------------------------------------------

export type NightlyOutcome =
  /** The child ran to its end. `run`: the line it added to the history (`null`: none). */
  | { kind: "ran"; code: number | null; run: EvalLiveRun | null }
  | { kind: "skipped"; reason: string }
  /** It took longer than the limit and was killed. */
  | { kind: "timeout" }
  /** The module stopped while it ran, and it was killed. */
  | { kind: "stopped" };

export interface NightlyOptions {
  /** Local time, `HH:MM`. */
  time: string;
  timeoutMs: number;
  command: EvalCommand;
  outDir: string;
  clock: Clock;
  spawn: EvalSpawner;
  /** Why a run must not start now (`null`: it may). */
  holdback(): string | null;
  /** A run added this line to the history. */
  onRun(run: EvalLiveRun): void;
  log: Logger;
}

/** The longest one wait is: the clock is read again after it, so a suspended machine catches up. */
const WAIT_STEP_MS = 60_000;
/** How long a killed child is waited for (a module's tasks must settle within 5 s of its stop). */
const KILL_WAIT_MS = 3_000;

/** Starts the eval once a day at `time`, one run at a time. */
export class NightlyRunner {
  readonly #o: NightlyOptions;
  #nextAt: number | null = null;
  #running = false;

  constructor(options: NightlyOptions) {
    this.#o = options;
  }

  /** When the next run is due, in ms (`null`: the loop is not running). */
  get nextAt(): number | null {
    return this.#nextAt;
  }

  get running(): boolean {
    return this.#running;
  }

  /** Waits for `time` and attempts a run, day after day, until `signal` aborts. */
  async run(signal: AbortSignal): Promise<void> {
    try {
      while (!signal.aborted) {
        const at = nextRunAt(this.#o.clock.now(), this.#o.time);
        this.#nextAt = at;
        for (let left = at - this.#o.clock.now(); left > 0; left = at - this.#o.clock.now()) {
          await sleep(Math.min(left, WAIT_STEP_MS), signal);
        }
        await this.attempt(signal);
      }
    } catch (error) {
      if (!signal.aborted) throw error;
    } finally {
      this.#nextAt = null;
    }
  }

  /** One run now, unless one is going on or something holds it back. Never throws. */
  async attempt(signal: AbortSignal): Promise<NightlyOutcome> {
    const { log } = this.#o;
    if (this.#running) return { kind: "skipped", reason: "a run is going on" };
    if (signal.aborted) return { kind: "stopped" };
    const reason = this.#o.holdback();
    if (reason !== null) {
      log.info({ reason }, "nightly eval skipped");
      return { kind: "skipped", reason };
    }
    this.#running = true;
    try {
      const before = (await readEvalHistory(this.#o.outDir, 1))[0]?.at ?? null;
      if (signal.aborted) return { kind: "stopped" };
      log.info({ out: this.#o.outDir }, "nightly eval started");
      const child = this.#o.spawn(this.#o.command);
      const limit = new AbortController();
      const end = await Promise.race([
        child.exited,
        sleep(this.#o.timeoutMs, AbortSignal.any([signal, limit.signal])).then(
          () => "timeout" as const,
          () => "stopped" as const,
        ),
      ]);
      limit.abort();
      if (end === "timeout" || end === "stopped") {
        child.kill();
        await withTimeout(child.exited, KILL_WAIT_MS);
        if (end === "timeout") {
          log.warn({ limit_ms: this.#o.timeoutMs }, "nightly eval took too long and was killed");
        }
        return { kind: end };
      }
      const last = (await readEvalHistory(this.#o.outDir, 1))[0] ?? null;
      const run = last !== null && last.at !== before ? last : null;
      if (end.code !== 0) {
        log.warn({ code: end.code, tail: end.tail }, "nightly eval ended with an error");
      } else {
        log.info(
          { usd: run?.usd ?? null, duration_ms: run?.duration_ms ?? null },
          "nightly eval done",
        );
      }
      if (run !== null) this.#o.onRun(run);
      return { kind: "ran", code: end.code, run };
    } catch (error) {
      log.warn({ err: errorMessage(error) }, "nightly eval could not run");
      return { kind: "ran", code: null, run: null };
    } finally {
      this.#running = false;
    }
  }
}

// ---- the module ----------------------------------------------------------------------------

export interface EvalModuleOptions {
  /** Base directory of the relative paths in the section (the config file's directory). */
  baseDir?: string;
  /** The repository root with the eval tool (`null`: none). Default: looked for on disk. */
  root?: string | null;
  spawn?: EvalSpawner;
}

export class EvalModule implements Module {
  static readonly ID = "eval";
  readonly manifest = defineManifest(EvalModule.ID, "Live evaluation", {
    icon: "flask-conical",
    category: "system",
    description:
      "Runs the live evaluation once a day as a child process (off unless a time is set)",
    configSchema: EvalConfigSchema,
  });
  readonly #baseDir: string;
  readonly #root: string | null | undefined;
  readonly #spawn: EvalSpawner;

  constructor(options: EvalModuleOptions = {}) {
    this.#baseDir = options.baseDir ?? process.cwd();
    this.#root = options.root;
    this.#spawn = options.spawn ?? spawnEval;
  }

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(EvalConfigSchema);
    const outDir = resolve(this.#baseDir, config.out);
    const idle = (state: "off" | "no_checkout"): EvalNightlyService => ({
      outDir,
      status: () => ({ state, time: config.nightly || null, next_at: null, running: false }),
    });
    if (config.nightly === "") {
      ctx.provide(EvalNightlyKey, idle("off"));
      return;
    }
    const root =
      this.#root !== undefined
        ? this.#root
        : findEvalCheckout([dirname(fileURLToPath(import.meta.url)), this.#baseDir]);
    if (root === null) {
      ctx.log.info(
        "nightly evals need a repository checkout (this install has no tools/eval): nothing is scheduled",
      );
      ctx.provide(EvalNightlyKey, idle("no_checkout"));
      return;
    }
    const runner = new NightlyRunner({
      time: config.nightly,
      timeoutMs: config.timeout_min * 60_000,
      command: evalCommand(root, this.#baseDir, config),
      outDir,
      clock: ctx.clock,
      spawn: this.#spawn,
      holdback: () => evalHoldback(ctx.services),
      onRun: (run) => void ctx.publish(EvalRun, run),
      log: ctx.log,
    });
    ctx.provide(EvalNightlyKey, {
      outDir,
      status: () => ({
        state: "scheduled",
        time: config.nightly,
        next_at: runner.nextAt === null ? null : toTimestamp(runner.nextAt),
        running: runner.running,
      }),
    });
    ctx.log.info({ at: config.nightly, out: outDir }, "nightly eval scheduled");
    ctx.spawn("nightly", (signal) => runner.run(signal));
  }
}
