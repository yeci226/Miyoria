#!/usr/bin/env node
// `pnpm replay <file.jsonl> [--json] [--seed N]`: replays a recorded log (`[modules.replay]
// record = true`) through the real pipeline with a scripted LLM and prints the report. The
// replay runs under Vitest (its fake timers make an hour of log take a second or two).

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const json = args.includes("--json");
const seedAt = args.indexOf("--seed");
const seed = seedAt >= 0 ? args[seedAt + 1] : undefined;
const file = args.find((a, i) => !a.startsWith("--") && (seedAt < 0 || i !== seedAt + 1));
if (!file) {
  process.stderr.write("usage: pnpm replay <file.jsonl> [--json] [--seed N]\n");
  process.exit(2);
}
// pnpm runs root scripts from the root; the path is relative to where it was typed.
const path = resolve(process.env.INIT_CWD ?? process.cwd(), file);
if (!existsSync(path)) {
  process.stderr.write(`no such file: ${path}\n`);
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), "miyoria-replay-"));
const out = join(dir, "report");
try {
  const vitest = join(pkg, "node_modules", "vitest", "vitest.mjs");
  const run = spawnSync(
    process.execPath,
    [vitest, "run", "--config", join(pkg, "vitest.replay.config.ts"), "--root", pkg],
    {
      cwd: pkg,
      stdio: ["ignore", "ignore", "inherit"],
      env: {
        ...process.env,
        MIYORIA_REPLAY_FILE: path,
        MIYORIA_REPLAY_OUT: out,
        ...(seed ? { MIYORIA_REPLAY_SEED: seed } : {}),
      },
    },
  );
  const report = `${out}${json ? ".json" : ".txt"}`;
  if (run.status !== 0 || !existsSync(report)) {
    process.stderr.write(`replay failed (exit ${run.status ?? run.signal})\n`);
    process.exit(1);
  }
  process.stdout.write(readFileSync(report, "utf8"));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
