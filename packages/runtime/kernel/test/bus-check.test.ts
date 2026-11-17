// The bus check as every package's tests run it (vitest.bus-check.ts at the repository root): a
// child Vitest runs a fixture that publishes a bad payload, an unregistered topic and a good one,
// in each mode.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = join(dirname(fileURLToPath(import.meta.url)), "bus-check");
const vitest = join(
  dirname(createRequire(import.meta.url).resolve("vitest/package.json")),
  "vitest.mjs",
);

function run(mode: string): { status: number | null; out: string } {
  // Plain output whatever runs this: a CI runner turns colours on, which splits the summary line
  // with escape codes, and adds a reporter that would annotate the fixture's failures as real ones.
  const env: NodeJS.ProcessEnv = { ...process.env, MIYORIA_BUS_CHECK: mode, NO_COLOR: "1" };
  delete env.FORCE_COLOR;
  delete env.GITHUB_ACTIONS;
  delete env.MIYORIA_BUS_CHECK_OUT;
  delete env.VITEST;
  delete env.VITEST_WORKER_ID;
  delete env.VITEST_POOL_ID;
  const child = spawnSync(
    process.execPath,
    [vitest, "run", "--config", join(here, "vitest.fixture.config.mjs")],
    { cwd: here, env, encoding: "utf8", timeout: 60_000 },
  );
  return { status: child.status, out: `${child.stdout}\n${child.stderr}` };
}

describe("the bus check in a test run", () => {
  it("fails the publishing tests in strict mode, naming the topic, the path and the publisher", () => {
    const { status, out } = run("strict");
    expect(status).not.toBe(0);
    expect(out).toContain("2 failed | 1 passed");
    expect(out).toContain("`system.module.state` from kernel: invalid at reason:");
    expect(out).toContain("`fixture.unknown` from fixture: unregistered topic");
  }, 60_000);

  it("fails nothing in report mode and prints one summary", () => {
    const { status, out } = run("report");
    expect(status).toBe(0);
    expect(out).toContain("3 passed");
    expect(out.match(/bus check \(report\)/g)).toHaveLength(1);
    expect(out).toContain("3 event(s) on 3 topic(s), 2 problem(s)");
    expect(out).toContain("`fixture.unknown` from fixture [1x]");
  }, 60_000);

  it("does nothing when off", () => {
    const { status, out } = run("off");
    expect(status).toBe(0);
    expect(out).not.toContain("bus check");
  }, 60_000);
});
