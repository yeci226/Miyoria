// Run by bus-check.test.ts in a child Vitest, never by the package's own tests (not `*.test.ts`):
// one test publishes a payload that does not fit its schema, one a topic nobody registered, one
// what fits.

import { Events, newId, toTimestamp } from "@miyoria/types";
import { expect, it } from "vitest";
import { EventBus, MetricsRegistry } from "../../src/index.js";

const bus = () => new EventBus({ metrics: new MetricsRegistry() });

it("publishes a module state without its reason", () => {
  bus().publish("kernel", Events.SystemModuleState, { module: "voice", state: "running" } as never);
  expect(true).toBe(true);
});

it("publishes a topic nobody registered", () => {
  bus().publishEnvelope({
    id: newId(),
    at: toTimestamp(Date.now()),
    type: "fixture.unknown",
    v: 1,
    source: "fixture",
    parent: null,
    turn: null,
    session: null,
    space_id: null,
    room_id: null,
    person_id: null,
    account_id: null,
    scope: null,
    key: null,
    data: { n: 1 },
  });
});

it("publishes what fits", () => {
  bus().publish("kernel", Events.SystemShutdown, {});
});
