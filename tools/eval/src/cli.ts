// `pnpm eval [--k N] [--json] [--dir D] [--trace FILE] [fixture-id ...]`: runs the incident fixtures and prints
// the scorecard. Exit code 1 when the suite is red (a green fixture broke, an xfail fixture got
// fixed and still says xfail, or a fixture is wrong).
//
// `pnpm eval --live --config <miyoria.toml> ...` runs the live suites against the real model
// instead (live/cli.ts) and none of the above.

import { readFileSync } from "node:fs";
import { z } from "zod";
import { runChecks } from "./checks.js";
import { loadFixtures } from "./fixture.js";
import { formatScorecard } from "./report.js";
import { runSuite } from "./runner.js";
import { TraceEventSchema } from "./trace.js";

const args = process.argv.slice(2);
if (args.includes("--live")) {
  // Loaded only here: the offline suite needs none of the live code or what it imports.
  const { liveMain } = await import("./live/cli.js");
  const { resolve } = await import("node:path");
  const base = process.env.INIT_CWD ?? process.cwd();
  const at = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const setPath = at("--memory-set");
  const configPath = at("--config");
  const target = at("--memory-target") ?? "records";
  if (target !== "records" && target !== "notes") {
    process.stderr.write(`--memory-target is \`records\` or \`notes\`, not \`${target}\`\n`);
    process.exit(2);
  }
  process.exit(
    await liveMain(
      args.filter((a) => a !== "--live"),
      {
        // The set holds real conversations and is never in the repository: no flag, no suite.
        register: async (registry) => {
          if (setPath === undefined || configPath === undefined) return;
          const { memoryRunner } = await import("./live/suites/memory.js");
          registry.register(
            "memory",
            memoryRunner({
              setPath: resolve(base, setPath),
              configPath: resolve(base, configPath),
              target,
            }),
          );
        },
      },
    ),
  );
}
const json = args.includes("--json");
const live = process.env.MIYORIA_EVAL_LIVE === "1";
const kAt = args.indexOf("--k");
const k = kAt >= 0 ? Number(args[kAt + 1]) : 3;
if (!Number.isInteger(k) || k < 1) {
  process.stderr.write("usage: pnpm eval [--k N] [--json] [fixture-id ...]\n");
  process.exit(2);
}
const dirAt = args.indexOf("--dir");
const traceAt = args.indexOf("--trace");
const taken = new Set([kAt, dirAt, traceAt].filter((i) => i >= 0).map((i) => i + 1));
const ids = args.filter((a, i) => !a.startsWith("--") && !taken.has(i));
const fixtures = loadFixtures(dirAt >= 0 ? args[dirAt + 1] : undefined).filter(
  (f) => ids.length === 0 || ids.includes(f.id),
);
if (fixtures.length === 0) {
  process.stderr.write(`no fixture matches ${ids.join(", ")}\n`);
  process.exit(2);
}
if (traceAt >= 0) {
  // A fresh recording of the same case (scripts/window-trace.mjs): the fixtures' checks, nothing else.
  const trace = z
    .array(TraceEventSchema)
    .parse(JSON.parse(readFileSync(args[traceAt + 1] ?? "", "utf8")));
  let red = false;
  for (const f of fixtures) {
    for (const r of runChecks(f.checks, trace)) {
      red ||= !r.ok;
      process.stdout.write(`${r.ok ? "ok  " : "FAIL"} ${f.id} ${r.rule} ${r.detail}
`);
    }
  }
  process.exit(red ? 1 : 0);
}
const card = await runSuite(fixtures, { k, live });
process.stdout.write(`${json ? JSON.stringify(card, null, 2) : formatScorecard(card)}\n`);
process.exit(card.ok ? 0 : 1);
