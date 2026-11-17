// The guarded states Core gives the cluster: `singing` and `live`, read through service keys.

import { ServiceRegistry } from "@miyoria/runtime/kernel";
import { type Singer, SingerKey } from "@miyoria/sing";
import { type ActivityManager, ActivityManagerKey, type ActivitySnapshot } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { CLUSTER_GUARDS, liveGuard, singingGuard } from "../src/cluster-guards.js";

function snapshot(fields: {
  activity?: ActivitySnapshot["activity"];
  broadcast?: ActivitySnapshot["broadcast"];
}): ActivitySnapshot {
  return {
    activity: fields.activity ?? { type: "idle", since: "2026-11-15T00:00:00.000Z" },
    broadcast: fields.broadcast ?? { type: "off" },
  } as ActivitySnapshot;
}

function services(options: { playing?: boolean; snap?: ActivitySnapshot }): ServiceRegistry {
  const s = new ServiceRegistry();
  if (options.playing !== undefined) {
    s.provide("sing", SingerKey, {
      playing: () => (options.playing ? { id: "song" } : null),
    } as unknown as Singer);
  }
  if (options.snap !== undefined) {
    const snap = options.snap;
    s.provide("activity", ActivityManagerKey, { snapshot: () => snap } as ActivityManager);
  }
  return s;
}

const since = "2026-11-15T00:00:00.000Z";

describe("Core's cluster guards", () => {
  it("singing while a song plays or her activity is singing", () => {
    expect(singingGuard(services({}))).toBeNull();
    expect(singingGuard(services({ playing: false, snap: snapshot({}) }))).toBeNull();
    expect(singingGuard(services({ playing: true }))).toBe("singing");
    const activity = (phase: "starting" | "running" | "stopping" | "failed") =>
      snapshot({
        activity: { type: "singing", target: "s1", phase, task: null, failure: null, since },
      });
    expect(singingGuard(services({ snap: activity("starting") }))).toBe("singing");
    expect(singingGuard(services({ snap: activity("running") }))).toBe("singing");
    expect(singingGuard(services({ snap: activity("stopping") }))).toBeNull();
  });

  it("live while the broadcast is live", () => {
    expect(liveGuard(services({}))).toBeNull();
    const broadcast = (type: "starting" | "live" | "stopping") =>
      snapshot({
        broadcast: { type, guild: "g", golive: true, obs: true, task: null, since },
      });
    expect(liveGuard(services({ snap: broadcast("live") }))).toBe("live");
    expect(liveGuard(services({ snap: broadcast("starting") }))).toBeNull();
    expect(liveGuard(services({ snap: snapshot({}) }))).toBeNull();
  });

  it("Core adds both", () => {
    expect(CLUSTER_GUARDS).toEqual([singingGuard, liveGuard]);
  });
});
