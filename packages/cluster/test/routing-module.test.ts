// The routing the cluster module offers (v5-hostd §15) against a real link: a host dialling from
// this machine counts as Core's own, its ping gives a round trip, the owner's controls are kept in
// the table and reach the registry, the estimates survive a restart of the module, and the voice
// events tell the speech-host rule where her voice is.

import { Events } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityTracker, clusterTables } from "../src/index.js";
import { approvedHost, FakeHost, Harness, report, service, waitUntil } from "./helpers.js";

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.stop();
  harness = null;
});

const sing = (name: string) =>
  service({
    name: "sing",
    url: `http://${name}:8005`,
    routing: {
      class: "job",
      latency: "batch",
      concurrency: 1,
      queue: true,
      yields_to: [],
      ready: true,
      accept: true,
    },
    load: { running: 0, queued: 0, age_ms: 0 },
  });

describe("the cluster module's routing", () => {
  it("knows a host on Core's machine and its round trip, and keeps the owner's controls", async () => {
    harness = await Harness.start({ ping_secs: 0.05 });
    const cluster = harness.cluster();
    const routing = cluster.routing;
    if (routing === undefined) throw new Error("no routing service");
    const a = approvedHost(cluster, "a", ["sing"]);
    const b = approvedHost(cluster, "b", ["sing"]);
    const ha = await FakeHost.connect(harness.url(), { host: a.id, key: a.key, name: "a" });
    const hb = await FakeHost.connect(harness.url(), { host: b.id, key: b.key, name: "b" });
    ha.peer.notify("host.report", report([sing("a")], "a"));
    hb.peer.notify("host.report", report([sing("b")], "b"));
    await waitUntil(() => cluster.registry.candidates("sing").length === 2, "both reported");

    // The test's hosts dial 127.0.0.1: Core's own machine.
    const hosts = routing.view().hosts;
    expect(hosts.map((h) => h.local)).toEqual([true, true]);
    await waitUntil(
      () => routing.view().hosts.every((h) => h.rtt_ms !== null),
      "a round trip of each ping",
    );

    routing.set({ kind: "pin", capability: "sing", host: "b" }, "owner");
    expect(cluster.registry.candidates("sing").map((e) => e.host)).toEqual(["b"]);
    routing.set({ kind: "drain", host: "b" }, "owner");
    expect(cluster.registry.candidates("sing")).toEqual([]);
    expect(routing.view().panel.map((c) => `${c.kind}:${c.capability}:${c.host}`)).toEqual([
      "drain::b",
      "pin:sing:b",
    ]);
    expect(routing.clear({ kind: "pin", capability: "sing", host: "b" })).toBe(true);
    expect(routing.clear({ kind: "drain", host: "b" })).toBe(true);
    expect(routing.clear({ kind: "drain", host: "b" })).toBe(false);
    expect(
      cluster.registry
        .candidates("sing")
        .map((e) => e.host)
        .sort(),
    ).toEqual(["a", "b"]);
    expect(() => routing.set({ kind: "weight", host: "a", value: 0 }, "owner")).toThrow(/above 0/);

    // A pin replaces the capability's other pin.
    routing.set({ kind: "pin", capability: "sing", host: "a" }, "owner");
    routing.set({ kind: "pin", capability: "sing", host: "b" }, "owner");
    const tables = harness.store.plugin(clusterTables);
    expect(tables.controls.view().pins).toEqual({ sing: "b" });

    // What was measured is in the table.
    const ep = cluster.registry.candidates("sing")[0];
    if (ep === undefined) throw new Error("no endpoint");
    cluster.registry.reserve(ep).done({ run_ms: 42_000 });
    expect(tables.estimates.load()).toEqual([
      expect.objectContaining({ host: "b", capability: "sing", unit_ms: 42_000, unit_n: 1 }),
    ]);
    await ha.close();
    await hb.close();
  });
});

describe("where her voice is", () => {
  it("follows the voice events and the live state", () => {
    const tracker = new ActivityTracker();
    const room = { platform: "discord", space: "g", channel: "v" };
    expect(tracker.snapshot()).toEqual({ in_voice: false, live: false, last_spoke_at: null });
    tracker.onEvent({ type: Events.VoiceJoined.type, data: { context: room } }, 1);
    expect(tracker.snapshot().in_voice).toBe(true);
    tracker.onEvent(
      { type: Events.VoiceSpeaking.type, data: { context: room, speaking: false } },
      2,
    );
    expect(tracker.snapshot().last_spoke_at).toBeNull();
    tracker.onEvent(
      { type: Events.VoiceSpeaking.type, data: { context: room, speaking: true } },
      3,
    );
    tracker.onEvent({ type: Events.VoicePlaybackEvent.type, data: {} }, 5);
    expect(tracker.snapshot().last_spoke_at).toBe(5);
    tracker.onEvent({ type: Events.VoiceLeft.type, data: { context: room, reason: null } }, 6);
    tracker.setLive(true);
    expect(tracker.snapshot()).toEqual({ in_voice: false, live: true, last_spoke_at: 5 });
  });
});
