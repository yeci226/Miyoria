// The stage and live topics: their tiers and scopes, and payloads as their publishers build them.

import { describe, expect, it } from "vitest";
import { checkBusEvent } from "../src/bus-check.js";
import { busEventRegistry } from "../src/index.js";

const registry = busEventRegistry();

function problems(topic: string, payload: unknown) {
  return checkBusEvent(registry, topic, payload).problems;
}

describe("tiers and default scopes", () => {
  it.each([
    ["stage.status", "owner", "ambient"],
    ["stage.error", "owner", "short"],
    ["stage.clip", "owner", "short"],
    ["live.touch", "public", "ambient"],
  ])("%s: scope %s, tier %s", (type, scope, tier) => {
    expect(registry.defaults(type)).toEqual({ scope, tier });
  });
});

describe("payloads as they are published", () => {
  it("a status with the node connected, and one without", () => {
    expect(
      problems("stage.status", {
        connected: true,
        vts: true,
        obs: false,
        scene: null,
        streaming: false,
        scenes: ["Main"],
        hotkeys: [],
        overlay_url: null,
        obs_collection: "Miyoria",
        obs_warning: null,
      }),
    ).toEqual([]);
    expect(problems("stage.status", { connected: false })).toEqual([]);
    expect(problems("stage.status", { vts: true })).not.toEqual([]);
  });

  it("a touch says where and on what, never who", () => {
    expect(problems("live.touch", { x: 0.2, y: 0.8, part: "head" })).toEqual([]);
    expect(problems("live.touch", { x: 0.2, y: 0.8, part: "head", name: "Owen" })).not.toEqual([]);
  });
});
