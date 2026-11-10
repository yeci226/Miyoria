// `pnpm eval [--k N] [--json] [--live] [--dir D] [--trace FILE] [fixture-id ...]`: runs the incident fixtures and prints
// the scorecard. Exit code 1 when the suite is red (a green fixture broke, an xfail fixture got
// fixed and still says xfail, or a fixture is wrong).

import { readFileSync } from "node:fs";
import { z } from "zod";
import { runChecks } from "./checks.js";
import { loadFixtures } from "./fixture.js";
import { formatScorecard } from "./report.js";
import { runSuite } from "./runner.js";
import { TraceEventSchema } from "./trace.js";

const args = process.argv.slice(2);
const json = args.includes("--json");
const live = args.includes("--live") || process.env.MIYORIA_EVAL_LIVE === "1";
const kAt = args.indexOf("--k");
const k = kAt >= 0 ? Number(args[kAt + 1]) : 3;
if (!Number.isInteger(k) || k < 1) {
  process.stderr.write("usage: pnpm eval [--k N] [--json] [--live] [fixture-id ...]\n");
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
const card = runSuite(fixtures, { k, live });
process.stdout.write(`${json ? JSON.stringify(card, null, 2) : formatScorecard(card)}\n`);
process.exit(card.ok ? 0 : 1);
