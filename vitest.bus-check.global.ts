// Global setup of every Node package (`vitest.shared.ts`): makes the folder the test files of a
// run leave their bus check reports in (`vitest.bus-check.ts`), and at the end of the run prints
// one summary of them. With `MIYORIA_BUS_CHECK_OUT=<dir>`, the merged report is also written to
// `<dir>/<project>.json` (the project's folder, `/` as `-`), for a look across packages.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";
import {
  type BusCheckReport,
  busCheckMode,
  formatBusCheckSummary,
  mergeBusCheckReports,
} from "./packages/contracts/events/src/bus-check.ts";

const ROOT = dirname(fileURLToPath(import.meta.url));

export default function setup(project: TestProject): (() => void) | undefined {
  const mode = busCheckMode(process.env.MIYORIA_BUS_CHECK);
  if (mode === "off") return undefined;
  const dir = mkdtempSync(join(tmpdir(), "miyoria-bus-check-"));
  project.provide("busCheckDir", dir);
  const name = relative(ROOT, project.config.root).replaceAll("\\", "/") || ".";
  return () => {
    const reports: BusCheckReport[] = [];
    for (const entry of readdirSync(dir)) {
      reports.push(JSON.parse(readFileSync(join(dir, entry), "utf8")) as BusCheckReport);
    }
    rmSync(dir, { recursive: true, force: true });
    const report = mergeBusCheckReports(reports);
    process.stdout.write(`\n${formatBusCheckSummary(report, { mode, project: name })}\n`);
    const out = process.env.MIYORIA_BUS_CHECK_OUT;
    if (out !== undefined && out !== "") {
      const target = resolve(out);
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, `${name.replaceAll("/", "-")}.json`), JSON.stringify(report));
    }
  };
}
