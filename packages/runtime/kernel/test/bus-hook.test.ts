// The test-only publish hook: it sees every envelope published on any bus, it can be kept away
// from made-up topics, and it cannot be switched on outside a Vitest run.

import { type Envelope, Events } from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BusPublishHook,
  busPublishHook,
  clearBusCheckExemptions,
  EventBus,
  exemptFromBusCheck,
  MetricsRegistry,
  setBusPublishHook,
} from "../src/index.js";

// A made-up topic is published under the extension namespace (`ext.**`).
const ext = (type: string) => ({ type });

let before: BusPublishHook | null = null;

beforeEach(() => {
  before = busPublishHook();
});

afterEach(() => {
  setBusPublishHook(before);
  clearBusCheckExemptions();
});

function recording(): { hook: BusPublishHook; seen: Envelope[] } {
  const seen: Envelope[] = [];
  return { hook: { published: (envelope) => seen.push(envelope) }, seen };
}

describe("the bus publish hook", () => {
  it("sees every envelope of every bus, before delivery", async () => {
    const { hook, seen } = recording();
    setBusPublishHook(hook);
    const a = new EventBus({ metrics: new MetricsRegistry() });
    const b = new EventBus({ metrics: new MetricsRegistry() });
    const sub = a.subscribe("*");
    const env = a.publish("m1", Events.ExtensionEvent, { n: 1 }, ext("ext.x.one"));
    b.publish("m2", Events.SystemModuleState, { module: "m2", state: "running", reason: null });
    expect(seen.map((e) => e.source)).toEqual(["m1", "m2"]);
    expect(seen[0]).toBe(env);
    expect(await sub.recv()).toBe(env);
  });

  it("is not called for exempt topics until the exemptions are cleared", () => {
    const { hook, seen } = recording();
    setBusPublishHook(hook);
    const bus = new EventBus({ metrics: new MetricsRegistry() });
    exemptFromBusCheck(["ext.test.*", "ext.custom.hello"]);
    bus.publish("m", Events.ExtensionEvent, {}, ext("ext.test.ping"));
    bus.publish("m", Events.ExtensionEvent, {}, ext("ext.custom.hello"));
    bus.publish("m", Events.ExtensionEvent, {}, ext("ext.other.thing"));
    clearBusCheckExemptions();
    bus.publish("m", Events.ExtensionEvent, {}, ext("ext.test.ping"));
    expect(seen.map((e) => e.type)).toEqual(["ext.other.thing", "ext.test.ping"]);
  });

  it("never reaches the publisher when it throws", () => {
    setBusPublishHook({
      published: () => {
        throw new Error("boom");
      },
    });
    const bus = new EventBus({ metrics: new MetricsRegistry() });
    const sub = bus.subscribe("*");
    expect(() => bus.publish("m", Events.ExtensionEvent, {}, ext("ext.x.y"))).not.toThrow();
    expect(sub.tryRecv()).not.toBeNull();
  });

  it("is removed with null", () => {
    const { hook, seen } = recording();
    setBusPublishHook(hook);
    setBusPublishHook(null);
    expect(busPublishHook()).toBeNull();
    new EventBus({ metrics: new MetricsRegistry() }).publish(
      "m",
      Events.ExtensionEvent,
      {},
      ext("ext.x.y"),
    );
    expect(seen).toEqual([]);
  });

  it("cannot be installed, and is never called, outside a Vitest run", async () => {
    const { hook, seen } = recording();
    setBusPublishHook(hook);
    vi.stubEnv("VITEST", undefined);
    vi.resetModules();
    try {
      const fresh = await import("../src/bus.js");
      expect(() => fresh.setBusPublishHook(hook)).toThrow("for tests only");
      expect(fresh.busPublishHook()).toBeNull();
      new fresh.EventBus({ metrics: new MetricsRegistry() }).publish(
        "m",
        Events.ExtensionEvent,
        {},
        ext("ext.x.y"),
      );
      expect(seen).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
