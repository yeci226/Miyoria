// Test setup of every Node package (`vitest.shared.ts`): the bus check (K12a in
// docs/design/v5-contracts.md). Every envelope published on any `EventBus` during a test file is
// checked against the registry of bus topics (`busEventRegistry` in @miyoria/contracts/events):
// its topic must be registered and its payload must fit that topic's schema.
//
// `MIYORIA_BUS_CHECK` picks the mode:
// - `off` (the default): nothing is installed or loaded;
// - `report`: problems are collected, and the run prints one summary at its end
//   (`vitest.bus-check.global.ts`); no test fails because of them;
// - `strict`: a test whose events have a problem fails, with the topic, the first failing path and
//   the publishing module.
//
// A test that publishes made-up topics on purpose says so with `exemptFromBusCheck("test.*")`
// from @miyoria/runtime/kernel; the exemption ends with its file.

import { relative } from "node:path";
import { afterAll, afterEach, expect, inject } from "vitest";
import { busCheckMode } from "./packages/contracts/events/src/bus-check.ts";

declare module "vitest" {
  export interface ProvidedContext {
    /** Where each test file of the run leaves its bus check report; set by the global setup. */
    busCheckDir: string;
  }
}

const mode = busCheckMode(process.env.MIYORIA_BUS_CHECK);

if (mode !== "off") {
  const [{ BusCheck }, { busEventRegistry }, kernel, fs, path] = await Promise.all([
    import("./packages/contracts/events/src/bus-check.ts"),
    import("./packages/contracts/events/src/bus.ts"),
    import("./packages/runtime/kernel/src/bus.ts"),
    import("node:fs"),
    import("node:path"),
  ]);
  const check = new BusCheck(busEventRegistry(), mode);
  const file = (testPath: string | undefined): string | null =>
    testPath === undefined ? null : relative(process.cwd(), testPath).replaceAll("\\", "/");

  kernel.setBusPublishHook({
    published(envelope) {
      const state = expect.getState();
      check.published(
        { topic: envelope.type, source: envelope.source, payload: envelope.data },
        { file: file(state.testPath), test: state.currentTestName ?? null },
      );
    },
  });

  afterEach(() => {
    check.endTest();
  });

  afterAll(() => {
    kernel.setBusPublishHook(null);
    kernel.clearBusCheckExemptions();
    const report = check.report();
    const dir = inject("busCheckDir");
    if (typeof dir === "string" && report.events > 0) {
      const name = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
      fs.writeFileSync(path.join(dir, name), JSON.stringify(report));
    }
    // Strict mode: what was published in the file's own hooks, after its last test.
    check.endTest();
  });
}
