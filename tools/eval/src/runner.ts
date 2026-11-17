// Runs fixtures and decides, for each one, whether the suite is still telling the truth.
//
//   detector  the checks must FAIL on the recorded incident (else the fixture proves nothing)
//   control   the checks must PASS on a correct run (else nothing could ever satisfy them)
//   current   the code under test, k times; pass^k means all k runs passed every check
//
// Verdicts: `pass` (expected and green), `xfail` (expected broken and broken), `FAIL` (a green
// fixture broke), `XPASS` (an xfail fixture works now: fixed, change its status), `BROKEN` (the
// fixture itself is wrong). The suite is green when nothing is FAIL, XPASS or BROKEN.

import { type CheckResult, runChecks } from "./checks.js";
import type { Fixture } from "./fixture.js";
import { SUBJECTS } from "./subjects/index.js";

export type Verdict = "pass" | "xfail" | "FAIL" | "XPASS" | "BROKEN";

export interface Attempt {
  ok: boolean;
  failed: CheckResult[];
}

export interface FixtureResult {
  id: string;
  title: string;
  category: Fixture["category"];
  harness: Fixture["harness"];
  expected: Fixture["status"];
  /** Checks that failed on the recorded incident (empty: the fixture cannot see it). */
  caught: CheckResult[];
  /** `null`: the fixture has no control. */
  controlOk: boolean | null;
  /** The runs of the code under test; empty for the `trace` harness. */
  attempts: Attempt[];
  /** All attempts passed; `null` when there is no code to run. */
  passK: boolean | null;
  verdict: Verdict;
  note: string;
}

export interface RunOptions {
  /** Runs per fixture (pass^k). */
  k?: number;
  live?: boolean;
}

export async function runFixture(
  fixture: Fixture,
  options: RunOptions = {},
): Promise<FixtureResult> {
  const k = options.k ?? 3;
  const live = options.live ?? false;
  const base = {
    id: fixture.id,
    title: fixture.title,
    category: fixture.category,
    harness: fixture.harness,
    expected: fixture.status,
  };
  const caught = runChecks(fixture.checks, fixture.trace).filter((r) => !r.ok);
  const controlResults = fixture.control ? runChecks(fixture.checks, fixture.control) : null;
  const controlOk = controlResults ? controlResults.every((r) => r.ok) : null;

  const broken = (note: string): FixtureResult => ({
    ...base,
    caught,
    controlOk,
    attempts: [],
    passK: null,
    verdict: "BROKEN",
    note,
  });
  if (caught.length === 0) return broken("no check fails on the recorded incident");
  if (controlOk === false) {
    const why = controlResults?.find((r) => !r.ok);
    return broken(`the control fails ${why?.rule}: ${why?.detail}`);
  }

  if (fixture.harness === "trace") {
    // Nothing to run: the incident can only be judged again on a new recording of the same case.
    if (fixture.status !== "xfail") return broken("a trace-only fixture cannot be green");
    return {
      ...base,
      caught,
      controlOk,
      attempts: [],
      passK: null,
      verdict: "xfail",
      note: `not replayable: ${fixture.reason}`,
    };
  }

  const subject = SUBJECTS[fixture.harness];
  const attempts: Attempt[] = [];
  for (let attempt = 0; attempt < k; attempt++) {
    const failed = runChecks(fixture.checks, await subject.run(fixture, { attempt, live })).filter(
      (r) => !r.ok,
    );
    attempts.push({ ok: failed.length === 0, failed });
  }
  const passK = attempts.every((a) => a.ok);
  const firstFailure = attempts.find((a) => !a.ok)?.failed[0];
  const verdict: Verdict =
    fixture.status === "pass" ? (passK ? "pass" : "FAIL") : passK ? "XPASS" : "xfail";
  const note =
    verdict === "xfail"
      ? `${firstFailure?.rule}: ${firstFailure?.detail}`
      : verdict === "XPASS"
        ? `fixed (${fixture.flips_with}): set status to pass`
        : verdict === "FAIL"
          ? `${firstFailure?.rule}: ${firstFailure?.detail}`
          : "";
  return { ...base, caught, controlOk, attempts, passK, verdict, note };
}

export interface Scorecard {
  k: number;
  live: boolean;
  results: FixtureResult[];
  totals: Record<Verdict, number>;
  /** Fixtures with code to run, and how many of them are pass^k today. */
  runnable: number;
  passingK: number;
  ok: boolean;
}

export async function runSuite(
  fixtures: readonly Fixture[],
  options: RunOptions = {},
): Promise<Scorecard> {
  const results: FixtureResult[] = [];
  for (const f of fixtures) results.push(await runFixture(f, options));
  const totals: Record<Verdict, number> = { pass: 0, xfail: 0, FAIL: 0, XPASS: 0, BROKEN: 0 };
  for (const r of results) totals[r.verdict] += 1;
  const runnable = results.filter((r) => r.passK !== null);
  return {
    k: options.k ?? 3,
    live: options.live ?? false,
    results,
    totals,
    runnable: runnable.length,
    passingK: runnable.filter((r) => r.passK === true).length,
    ok: totals.FAIL + totals.XPASS + totals.BROKEN === 0,
  };
}
