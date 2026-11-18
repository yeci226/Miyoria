// `pnpm eval --live --config <miyoria.toml> [--suite persona,tools,relationship,memory,corrections,feel,play] [--subject self]
//  [--repeat k] [--max-usd 0.5] [--out <dir>] [--profile <dir>] [--seed <text>]`
//
// Runs the live suites against the real model and writes the run to `--out` (default
// `data/eval/live/`): one JSON file and one line of `history.jsonl`. `--max-usd` is a hard stop:
// the estimated cost is checked before every model call, and the run ends with what finished.
// Paths are taken from where the command was typed (`INIT_CWD`, which pnpm sets).
//
// `pnpm eval --live --rebuild-history [--out <dir>]` runs nothing: it writes `history.jsonl` again
// from the run files in the folder, for lines written before the record had a version.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PersonaHandle } from "@miyoria/brain/agent";
import type { LlmRouter } from "@miyoria/llm/llm";
import { errorMessage } from "@miyoria/runtime/kernel";
import { Profile } from "@miyoria/runtime/profile";
import { routerJudge } from "./judge.js";
import type { Meter } from "./meter.js";
import { setupLiveModel } from "./model.js";
import {
  defaultSuites,
  formatRun,
  rebuildHistory,
  runLive,
  runnableSuites,
  writeRun,
} from "./run.js";
import type { Subject } from "./subject.js";
import type { SuiteRegistry } from "./suite.js";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const DEFAULT_PROFILE = "profiles/deepseek-chan";
const DEFAULT_OUT = "data/eval/live";
/** The owner's cap for one eval run (docs/design/v5-brain.md, Q4). */
const DEFAULT_MAX_USD = 0.5;

const USAGE =
  "usage: pnpm eval --live --config <miyoria.toml> [--suite persona,tools,relationship,memory,corrections] " +
  "[--subject self] [--repeat k] [--max-usd 0.5] [--out <dir>] [--profile <dir>] [--seed <text>] [--memory-set <set.json>] [--memory-target records|notes]\n" +
  "       pnpm eval --live --rebuild-history [--out <dir>]\n";

export interface SubjectDeps {
  router: LlmRouter;
  meter: Meter;
  profile: Profile;
}

/** The subjects by name. A new brain is one more entry here. */
const SUBJECTS: Readonly<Record<string, (deps: SubjectDeps) => Promise<Subject>>> = {
  self: async (deps) => new (await import("./self.js")).SelfSubject(deps),
};

export interface LiveHooks {
  /** Adds or fills suites before the run (the `memory` slot). */
  register?: (registry: SuiteRegistry, deps: SubjectDeps) => void | Promise<void>;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

function commitOf(dir: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/** Runs the live CLI on `argv` (without `--live`); returns the exit code. */
export async function liveMain(argv: readonly string[], hooks: LiveHooks = {}): Promise<number> {
  const out = hooks.out ?? ((t: string) => void process.stdout.write(t));
  const err = hooks.err ?? ((t: string) => void process.stderr.write(t));
  const opt = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const base = process.env.INIT_CWD ?? process.cwd();
  if (argv.includes("--rebuild-history")) {
    const dir = resolve(base, opt("out") ?? DEFAULT_OUT);
    try {
      const { runs, skipped } = rebuildHistory(dir);
      out(`${runs} runs written to history.jsonl in ${dir}\n`);
      if (skipped.length > 0) err(`not a run, left out: ${skipped.join(", ")}\n`);
      return 0;
    } catch (error) {
      err(`cannot rebuild the history in ${dir}: ${errorMessage(error)}\n`);
      return 2;
    }
  }
  const configArg = opt("config");
  const repeat = Number(opt("repeat") ?? 1);
  const maxUsd = Number(opt("max-usd") ?? DEFAULT_MAX_USD);
  const subjectName = opt("subject") ?? "self";
  const makeSubject = SUBJECTS[subjectName];
  if (makeSubject === undefined) {
    err(`no subject \`${subjectName}\` (there is: ${Object.keys(SUBJECTS).join(", ")})\n${USAGE}`);
    return 2;
  }
  if (
    configArg === undefined ||
    !Number.isInteger(repeat) ||
    repeat < 1 ||
    !Number.isFinite(maxUsd) ||
    maxUsd <= 0
  ) {
    err(USAGE);
    return 2;
  }

  const profile = await Profile.loadDir(resolve(REPO, opt("profile") ?? DEFAULT_PROFILE));
  const model = await setupLiveModel(resolve(base, configArg), profile, maxUsd);
  if (model.kind === "none") {
    err(`live eval did not run: ${model.reason}\n`);
    return 2;
  }
  const deps: SubjectDeps = { router: model.router, meter: model.meter, profile };
  const registry = defaultSuites();
  await hooks.register?.(registry, deps);
  const suites =
    opt("suite")
      ?.split(",")
      .filter((s) => s !== "") ?? runnableSuites(registry);
  const unknown = suites.filter((s) => !registry.has(s));
  if (suites.length === 0 || unknown.length > 0) {
    err(`no suite \`${unknown.join(", ")}\` (there is: ${registry.names().join(", ")})\n${USAGE}`);
    return 2;
  }

  err(
    `live eval: ${suites.join(", ")} on ${subjectName}, model ${model.chain}, limit $${maxUsd}\n`,
  );
  const subject = await makeSubject(deps);
  try {
    const seed = opt("seed");
    const run = await runLive({
      subject,
      judge: routerJudge(model.router),
      meter: model.meter,
      router: model.router,
      registry,
      suites,
      persona: profile.personaPrompt(),
      handle: new PersonaHandle(profile),
      repeat,
      ...(seed === undefined ? {} : { seed }),
      commit: commitOf(REPO),
      chain: model.chain.split(" > "),
      log: (line) => err(`  ${line}\n`),
    });
    const written = writeRun(run, resolve(base, opt("out") ?? DEFAULT_OUT));
    out(`${formatRun(run)}\n${written.file}\n`);
    return 0;
  } finally {
    await subject.close?.();
  }
}
