// The scene as a pure function of her situation, and the director reading it from the
// ActivityManager's snapshots (her override, one mutex for every switch).

import type { ActivitySnapshot } from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CURTAIN_GRACE_MS,
  factsOf,
  NO_FACTS,
  pickScene,
  SceneDirector,
  type SceneMemory,
  SceneRoles,
  type ScenesConfig,
  ScenesConfigSchema,
  sceneWants,
} from "../src/index.js";

const SCENES = ["Just Chatting", "Gameplay", "BRB", "Starting Soon", "Ending", "Camera", "Karaoke"];
const T0 = Date.UTC(2026, 10, 3, 20, 0, 0);
const at = (ms: number) => new Date(T0 + ms).toISOString();

function config(overrides: Partial<ScenesConfig> = {}): ScenesConfig {
  return { ...ScenesConfigSchema.parse({ classify: false }), ...overrides };
}

async function roles(cfg: ScenesConfig): Promise<SceneRoles> {
  const r = new SceneRoles(cfg, {
    settings: () => undefined,
    router: () => undefined,
    signal: new AbortController().signal,
  });
  r.observe(SCENES);
  await r.idle();
  return r;
}

const MEMORY: SceneMemory = {
  ended: false,
  endingUntil: 0,
  returnTo: null,
  lastActivity: T0,
  voiceThisLive: false,
};

function snap(over: Partial<ActivitySnapshot> = {}): ActivitySnapshot {
  return {
    version: 1,
    at: at(0),
    presence: { type: "none" },
    broadcast: { type: "off" },
    activity: { type: "idle", since: at(0) },
    override: null,
    scene: null,
    ...over,
  };
}

const LIVE = {
  type: "live" as const,
  guild: "g1",
  golive: true,
  obs: true,
  task: null,
  since: at(0),
};
const GAME = {
  type: "game" as const,
  target: "minecraft",
  phase: "running" as const,
  task: null,
  failure: null,
  since: at(0),
};

describe("scene rule", () => {
  it("is a function of presence, broadcast, activity and the override", async () => {
    const cfg = config({ starting_ms: 30_000 });
    const r = await roles(cfg);
    const scene = (s: ActivitySnapshot, now: number) =>
      pickScene(
        sceneWants(factsOf(s, now), MEMORY, cfg, (x) => r.roleOf(x), now),
        (role) => r.resolve(role),
      )?.scene ?? null;
    expect(scene(snap(), T0)).toBe("Just Chatting");
    expect(scene(snap({ activity: GAME }), T0)).toBe("Gameplay");
    // Starting the game is not playing yet; a failed game is not either.
    expect(scene(snap({ activity: { ...GAME, phase: "starting" } }), T0)).toBe("Just Chatting");
    expect(
      scene(
        snap({
          activity: {
            ...GAME,
            phase: "failed",
            failure: { code: "disconnected", detail: "x", at: at(0) },
          },
        }),
        T0,
      ),
    ).toBe("Just Chatting");
    expect(scene(snap({ broadcast: LIVE }), T0 + 1_000)).toBe("Starting Soon");
    expect(scene(snap({ broadcast: LIVE }), T0 + 31_000)).toBe("Just Chatting");
    // Her override wins while it lasts.
    const override = { scene: "Camera", until: at(60_000), by: "self" };
    expect(scene(snap({ activity: GAME, override }), T0 + 10_000)).toBe("Camera");
    expect(scene(snap({ activity: GAME, override }), T0 + 61_000)).toBe("Gameplay");
  });

  it("web browsing takes the browse scene, the old threads scene, or the game scene, in that order", async () => {
    const BROWSE = {
      type: "browse" as const,
      target: "鯨魚的資料",
      phase: "running" as const,
      task: null,
      failure: null,
      since: at(0),
    };
    const sceneFor = async (
      activity: ActivitySnapshot["activity"],
      over: Record<string, string>,
    ) => {
      const cfg = config({ roles: over });
      const r = await roles(cfg);
      const facts = factsOf(snap({ activity }), T0);
      return pickScene(
        sceneWants(facts, MEMORY, cfg, (x) => r.roleOf(x), T0),
        (role) => r.resolve(role),
      )?.scene;
    };
    // The target is a search, not a game name: it names no role.
    expect(factsOf(snap({ activity: BROWSE }), T0)).toMatchObject({
      playing: true,
      game: null,
      browsing: true,
    });
    expect(await sceneFor(BROWSE, { browse: "Camera", threads: "Karaoke" })).toBe("Camera");
    expect(await sceneFor(BROWSE, { threads: "Karaoke" })).toBe("Karaoke");
    expect(await sceneFor(BROWSE, {})).toBe("Gameplay");
    // A browse target that happens to look like a role name does not pick that role.
    expect(await sceneFor({ ...BROWSE, target: "karaoke" }, { karaoke: "Karaoke" })).toBe(
      "Gameplay",
    );
  });

  it("a broadcast that is only being started is not live yet (no starting/ending flap)", () => {
    const starting = snap({
      broadcast: {
        type: "starting",
        guild: "g1",
        golive: false,
        obs: false,
        task: "t",
        since: at(0),
      },
    });
    expect(factsOf(starting, T0).live).toBe(false);
    expect(factsOf(snap({ broadcast: { ...LIVE, obs: false } }), T0).live).toBe(true);
    expect(
      factsOf(
        snap({
          presence: {
            type: "in",
            channel: { platform: "discord", scope: "g1", channel: "v", kind: "voice" },
            since: at(0),
          },
        }),
        T0,
      ),
    ).toEqual({
      ...NO_FACTS,
      inVoice: true,
    });
  });
});

describe("director on snapshots", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function rig(cfg: ScenesConfig, delayMs = 0) {
    const r = await roles(cfg);
    const switches: string[] = [];
    let current = "Just Chatting";
    let director: SceneDirector;
    const show = (scene: string) => {
      current = scene;
      director.onStatus({ obs: true, streaming: true, scene });
    };
    const apply = async (scene: string, label: string) => {
      // The node reports the new scene before the request is answered.
      show(scene);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      switches.push(label);
      return true;
    };
    director = new SceneDirector({
      config: cfg,
      roles: r,
      switchRole: async (role) => {
        const scene = r.resolve(role);
        return scene === null ? false : apply(scene, role);
      },
      switchScene: async (name) => apply(name, `scene:${name}`),
    });
    show(current);
    return { director, switches, current: () => current, show };
  }

  it("follows the snapshot and honours her timed override without a manual hold", async () => {
    const t = await rig(config({ manual_hold_ms: 600_000 }));
    t.director.onSnapshot(snap({ activity: GAME }));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.switches).toEqual(["game"]);
    // Her `stage_scene`: the capability switched already, the snapshot carries the override.
    t.show("Camera");
    t.director.onSnapshot(
      snap({ activity: GAME, override: { scene: "Camera", until: at(60_000), by: "self" } }),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.current()).toBe("Camera");
    expect(t.switches).toEqual(["game"]);
    // It ends: back to what fits, without the 10-minute manual hold.
    t.director.onSnapshot(snap({ activity: GAME }));
    await vi.advanceTimersByTimeAsync(40_000);
    expect(t.switches).toEqual(["game", "game"]);
    expect(t.current()).toBe("Gameplay");
    // The raw bus inputs are ignored once snapshots arrive.
    t.director.onGame(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(t.current()).toBe("Gameplay");
    t.director.stop();
  });

  it("the curtain waits for a switch in flight, so its own switch is never taken as manual", async () => {
    const t = await rig(config({ ending_ms: 5_000, starting_ms: 0 }), 100);
    t.director.onSnapshot(snap({ broadcast: LIVE }));
    await vi.advanceTimersByTimeAsync(10);
    t.director.onSnapshot(snap({ broadcast: LIVE, activity: GAME }));
    await vi.advanceTimersByTimeAsync(1_550); // the game switch is in flight now
    let closed = false;
    void t.director.close().then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(t.switches).toEqual(["game", "ending"]);
    expect(t.current()).toBe("Ending");
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(closed).toBe(true);
    t.director.stop();
  });

  it("after the curtain's hold the ending scene stays until the stream stops", async () => {
    // CI 2026-11-10: a switch back to chat went out between the hold and the stop.
    const t = await rig(config({ ending_ms: 50, starting_ms: 0 }));
    t.director.onSnapshot(snap({ broadcast: LIVE }));
    await vi.advanceTimersByTimeAsync(10);
    let closed = false;
    void t.director.close().then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(60);
    expect(closed).toBe(true);
    expect(t.current()).toBe("Ending");
    // The stop is late; someone talks meanwhile.
    t.director.onActivity();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.current()).toBe("Ending");
    // It never came: after the grace the director lets go.
    await vi.advanceTimersByTimeAsync(CURTAIN_GRACE_MS);
    expect(t.current()).not.toBe("Ending");
    t.director.stop();
  });

  it("is the SceneRule: the snapshot's scene", async () => {
    const t = await rig(config());
    const input = snap({ activity: GAME });
    expect(t.director.scene(input, T0)).toBe("Gameplay");
    expect(t.director.scene(snap(), T0)).toBe("Just Chatting");
    t.director.stop();
  });
});
