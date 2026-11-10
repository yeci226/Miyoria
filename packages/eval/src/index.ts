// @miyoria/eval: an evaluation set built from real incidents (docs/design/v3-architecture.md
// §18.2). Fixtures are JSON, checks are rules a program can decide, and the runner reports a
// pass^k scorecard with the known-broken fixtures marked as expected failures.

export {
  type Check,
  type CheckResult,
  CheckSchema,
  runCheck,
  runChecks,
} from "./checks.js";
export {
  FIXTURE_DIR,
  type Fixture,
  FixtureSchema,
  type Harness,
  loadFixtures,
  parseFixture,
} from "./fixture.js";
export { formatScorecard } from "./report.js";
export {
  type Attempt,
  type FixtureResult,
  type RunOptions,
  runFixture,
  runSuite,
  type Scorecard,
  type Verdict,
} from "./runner.js";
export { failureCode } from "./subjects/guard.js";
export { SUBJECTS } from "./subjects/index.js";
export {
  type Agent,
  arithmetic,
  type Criterion,
  FakeWorld,
  lazyAgent,
  referenceAgent,
  runTask,
  type TaskResult,
  TOOL_TASKS,
  type ToolEnv,
  type ToolTask,
} from "./tasks/index.js";
export { ofType, type Trace, type TraceEvent, TraceEventSchema } from "./trace.js";
