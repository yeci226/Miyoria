import { nodeProject } from "../../../../../vitest.shared.ts";

// The child run of bus-check.test.ts: only the fixture.
export default nodeProject({
  root: import.meta.dirname,
  test: { include: ["publishes.fixture.ts"] },
});
