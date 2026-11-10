// After a restart (v3 §5): the game the last run left open is not shown as idle, is confirmed
// before it counts as running, and gives way to the truth and to whoever asks for something else.

import { ServiceRegistry } from "@miyoria/kernel";
import {
  ACTIVITY_RESTORE_TOPIC,
  type ActivityRestore,
  type ContextKey,
  customEvent,
  type Event,
  type GameResume,
  GameResumeKey,
  newEnvelope,
  Principals,
  type RestoredGame,
  toTimestamp,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultActivityConfig } from "../src/config.js";
import { ActivityService } from "../src/manager.js";
import type { ActivityPort } from "../src/port.js";

const VOICE: ContextKey = { platform: "discord", scope: "g1", channel: "v1", kind: "voice" };
const LEFT: RestoredGame = {
  game: "minecraft",
  name: "Minecraft",
  context: VOICE,
  since: toTimestamp(Date.UTC(2026, 10, 7, 10)),
};

const port: ActivityPort = {
  has: () => true,
  run: async () => ({ text: "好", data: null }),
};

function harness(answer: GameResume["resume"] | null) {
  const services = new ServiceRegistry();
  const calls: RestoredGame[] = [];
  if (answer !== null) {
    services.provide("game", GameResumeKey, {
      resume: (game, signal) => {
        calls.push(game);
        return answer(game, signal);
      },
    });
  }
  const events: Event[] = [];
  const service = new ActivityService({
    port,
    services,
    config: { ...defaultActivityConfig(), restore_grace_ms: 10_000, restore_poll_ms: 1_000 },
    publish: (e) => events.push(e),
  });
  const restores = () =>
    events.flatMap((e) =>
      e.type === "custom" && e.data.topic === ACTIVITY_RESTORE_TOPIC
        ? [e.data.payload as unknown as ActivityRestore]
        : [],
    );
  const session = (state: "started" | "stopped", game = "minecraft") =>
    service.observe(
      newEnvelope(
        "game",
        customEvent("game.director.session", {
          state,
          game,
          game_name: game,
          context: { ...VOICE },
        }),
      ),
    );
  return { service, services, calls, restores, session };
}

const activity = (h: { service: ActivityService }) => h.service.snapshot().activity;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a game the last run left open", () => {
  it("is not idle while it is being looked for", () => {
    const h = harness(async () => "waiting");
    h.service.restore(LEFT);
    expect(activity(h)).toMatchObject({ type: "game", target: "minecraft", phase: "starting" });
    h.service.close();
  });

  it("runs once the game module has it back", async () => {
    const h = harness(async () => "resumed");
    h.service.restore(LEFT);
    await vi.advanceTimersByTimeAsync(0);
    expect(activity(h)).toMatchObject({ type: "game", target: "minecraft", phase: "running" });
    expect(h.restores()).toEqual([{ game: "minecraft", outcome: "resumed" }]);
    h.service.close();
  });

  it("does not flicker to idle between `resumed` and the session event", async () => {
    const h = harness(async () => "resumed");
    h.service.restore(LEFT);
    await vi.advanceTimersByTimeAsync(0);
    const version = h.service.snapshot().version;
    h.session("started");
    expect(activity(h)).toMatchObject({ type: "game", phase: "running" });
    expect(h.service.snapshot().version).toBe(version);
    h.service.close();
  });

  it("keeps looking while the game cannot be reached", async () => {
    let up = false;
    const h = harness(async () => (up ? "resumed" : "waiting"));
    h.service.restore(LEFT);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.calls).toHaveLength(4);
    expect(activity(h)).toMatchObject({ phase: "starting" });
    up = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(activity(h)).toMatchObject({ phase: "running" });
    h.service.close();
  });

  it("waits for a game module that is not there yet", async () => {
    const h = harness(null);
    h.service.restore(LEFT);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(activity(h)).toMatchObject({ phase: "starting" });
    h.services.provide("game", GameResumeKey, { resume: async () => "resumed" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(activity(h)).toMatchObject({ phase: "running" });
    h.service.close();
  });

  it("was closed after all when it does not come back: idle, without a failure", async () => {
    const h = harness(async () => "waiting");
    h.service.restore(LEFT);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(activity(h).type).toBe("idle");
    expect(h.restores()).toEqual([{ game: "minecraft", outcome: "gone" }]);
    h.service.close();
  });

  it("survives a resume that throws", async () => {
    const h = harness(async () => {
      throw new Error("boom");
    });
    h.service.restore(LEFT);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(activity(h)).toMatchObject({ phase: "starting" });
    h.service.close();
  });

  it("settles when the session shows up on its own", async () => {
    const h = harness(async () => "waiting");
    h.service.restore(LEFT);
    h.session("started");
    expect(activity(h)).toMatchObject({ type: "game", phase: "running" });
    expect(h.restores()).toEqual([{ game: "minecraft", outcome: "resumed" }]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(activity(h)).toMatchObject({ phase: "running" });
    h.service.close();
  });

  it("gives way to another game", () => {
    const h = harness(async () => "waiting");
    h.service.restore(LEFT);
    h.session("started", "osu");
    expect(activity(h)).toMatchObject({ target: "osu", phase: "running" });
    expect(h.restores()).toEqual([{ game: "minecraft", outcome: "dropped" }]);
    h.service.close();
  });

  it("is dropped when she is told to stop playing", async () => {
    const h = harness(async () => "waiting");
    h.service.restore(LEFT);
    const result = await h.service.request({
      request: { type: "stop", activity: "game" },
      principal: Principals.panel("owen", null),
      turn: null,
      context: null,
      why: "不要玩了",
    });
    expect(result.status).toBe("already");
    expect(activity(h).type).toBe("idle");
    expect(h.restores()).toEqual([{ game: "minecraft", outcome: "dropped" }]);
    const asked = h.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.calls).toHaveLength(asked);
    h.service.close();
  });

  it("is what she is already heading to when she is asked to play it", async () => {
    const h = harness(async () => "waiting");
    h.service.restore(LEFT);
    const result = await h.service.request({
      request: { type: "start", activity: "game", target: "minecraft", goal: null },
      principal: Principals.panel("owen", null),
      turn: null,
      context: null,
      why: "玩",
    });
    expect(result.status).toBe("already");
    h.service.close();
  });

  it("stops being looked for when the module stops", async () => {
    const h = harness(async () => "waiting");
    h.service.restore(LEFT);
    h.service.close();
    const asked = h.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.calls).toHaveLength(asked);
    // A stop is not a verdict: the next start looks again.
    expect(h.restores()).toEqual([]);
  });
});
