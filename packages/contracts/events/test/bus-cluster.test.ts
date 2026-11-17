// The cluster topics: their tiers and scopes, and payloads as the cluster module publishes them.

import { describe, expect, it } from "vitest";
import { checkBusEvent } from "../src/bus-check.js";
import { busEventRegistry } from "../src/index.js";

const registry = busEventRegistry();

function problems(topic: string, payload: unknown) {
  return checkBusEvent(registry, topic, payload).problems;
}

describe("tiers and default scopes", () => {
  it.each([
    ["cluster.host.joined", "owner", "keep"],
    ["cluster.host.approved", "owner", "keep"],
    ["cluster.host.removed", "owner", "keep"],
    ["cluster.host.connected", "owner", "short"],
    ["cluster.host.disconnected", "owner", "short"],
    ["cluster.service.state", "owner", "short"],
  ])("%s: scope %s, tier %s", (type, scope, tier) => {
    expect(registry.defaults(type)).toEqual({ scope, tier });
  });
});

describe("payloads as they are published", () => {
  it("a host's life", () => {
    expect(
      problems("cluster.host.joined", { id: "h1", host: "main-pc", status: "pending" }),
    ).toEqual([]);
    expect(
      problems("cluster.host.approved", { host: "main-pc", capabilities: ["asr", "tts"] }),
    ).toEqual([]);
    expect(problems("cluster.host.removed", { host: "main-pc", how: "revoked" })).toEqual([]);
    expect(problems("cluster.host.removed", { host: "main-pc", how: "gone" })).not.toEqual([]);
  });

  it("a link coming and going", () => {
    expect(
      problems("cluster.host.connected", {
        host: "main-pc",
        platform: "win32",
        version: "0.1.0",
        approved: false,
      }),
    ).toEqual([]);
    expect(
      problems("cluster.host.disconnected", { host: "main-pc", code: 4408, reason: "timeout" }),
    ).toEqual([]);
  });

  it("a service state uses the host protocol's states", () => {
    const state = { host: "main-pc", service: "asr", state: "failed", previous: "running" };
    expect(problems("cluster.service.state", { ...state, reason: "exited 1" })).toEqual([]);
    expect(problems("cluster.service.state", { ...state, reason: null })).toEqual([]);
    expect(
      problems("cluster.service.state", { ...state, state: "exploded", reason: null }),
    ).not.toEqual([]);
  });
});
