// The stage 3 acceptance metric (docs/design/v2-architecture.md §4) with fakes: 「開台玩 MC」,
// 「關台」, 「離開語音」 20 times in a row, with a second caller (the panel) asking at the same
// time. Afterwards nothing is left over, nothing started twice, and the scene director (fed by
// the manager's snapshots, like `stage.link`) never flapped.

import type { RoutedCall } from "@miyoria/actions";
import { SceneDirector, SceneRoles, ScenesConfigSchema } from "@miyoria/stage";
import {
  ACTIVITY_CHANGED_TOPIC,
  type ActivityRequest,
  type Principal,
  Principals,
  v2Payload,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT, FakeWorld, GUILD, OWEN } from "./fake.js";

const SCENES = ["Just Chatting", "Gameplay", "BRB", "Starting Soon", "Ending"];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 10, 3, 20, 0, 0));
});
afterEach(() => {
  vi.useRealTimers();
});

async function until(check: () => boolean, maxMs = 120_000): Promise<void> {
  for (let waited = 0; waited < maxMs; waited += 50) {
    if (check()) return;
    await vi.advanceTimersByTimeAsync(50);
  }
  throw new Error("condition not reached");
}

function call(
  capability: string,
  requests: ActivityRequest[],
  principal: Principal,
  wait: boolean,
  turn: string | null = null,
): RoutedCall {
  return {
    capability: {
      name: capability,
      summary: capability,
      risk: "medium",
      args: null as never,
      permission: null,
      execute: async () => "",
    },
    args: {},
    requests,
    request: { principal, capability, args: {}, why: "scenario", turn },
    decision: null as never,
    wait,
    signal: undefined,
    // The fake world runs the capability itself (see `FakeWorld.run`).
    execute: async () => ({ text: "", data: null }),
  };
}

describe("acceptance: 開台玩 MC / 關台 / 離開語音 × 20", () => {
  it("leaves no residual state, never starts twice and never flaps the scene", async () => {
    const w = new FakeWorld({ latency: 30, launchMs: 2_000 });
    const config = ScenesConfigSchema.parse({
      classify: false,
      starting_ms: 5_000,
      ending_ms: 2_000,
    });
    const roles = new SceneRoles(config, {
      settings: () => undefined,
      router: () => undefined,
      signal: new AbortController().signal,
    });
    roles.observe(SCENES);
    await roles.idle();
    const switches: { scene: string; at: number }[] = [];
    let director: SceneDirector;
    const show = () => director.onStatus({ obs: true, streaming: w.obsStreaming, scene: w.scene });
    const switchTo = async (scene: string | null) => {
      if (scene === null) return false;
      w.scene = scene;
      switches.push({ scene, at: Date.now() });
      show();
      return true;
    };
    director = new SceneDirector({
      config,
      roles,
      switchRole: (role) => switchTo(roles.resolve(role)),
      switchScene: (name) => switchTo(name),
    });
    w.scene = "Just Chatting";
    show();
    // `stage.link` feeds the director the manager's snapshots; the curtain is the director.
    w.listeners.push((event) => {
      const snapshot = v2Payload(event, ACTIVITY_CHANGED_TOPIC);
      if (snapshot !== null) director.onSnapshot(snapshot);
    });
    w.curtain = () => director.close();

    const her = Principals.user(OWEN, CHAT);
    const panel = Principals.panel("api");
    const playLive: ActivityRequest[] = [
      { type: "start", activity: "game", target: "minecraft", goal: null },
      { type: "ensure_live", platform: "discord", guild: GUILD, source: null },
    ];
    const cycles = 20;
    for (let i = 0; i < cycles; i++) {
      // 「開台玩 MC」: her tool answers at once; the panel asks for the same game meanwhile.
      const turn = `t${i}`;
      w.emit({ type: "agent_turn_started", data: { turn, context: CHAT } });
      const asked = await w.service.route(call("game.start", playLive, her, false, turn));
      expect(asked.text).toContain("開始了");
      const again = w.service.route(
        call(
          "game.start",
          [{ type: "start", activity: "game", target: "minecraft", goal: null }],
          panel,
          true,
        ),
      );
      w.emit({ type: "agent_turn_completed", data: { turn, context: CHAT, text: "好啊" } });
      await until(() => {
        const s = w.service.snapshot();
        return (
          s.broadcast.type === "live" &&
          s.activity.type === "game" &&
          s.activity.phase === "running"
        );
      });
      // The panel's request was the same task: it ends with it.
      expect((await again).text).toContain("開始玩");
      await vi.advanceTimersByTimeAsync(15_000);
      expect(w.scene).toBe("Gameplay");

      // 「關台」.
      await w.service.request(w.transition({ type: "stop_live" }, her));
      await until(() => w.service.snapshot().broadcast.type === "off");
      await vi.advanceTimersByTimeAsync(10_000);

      // Stop playing, then 「離開語音」 (after she said goodbye).
      await w.service.request(w.transition({ type: "stop", activity: "game" }, her));
      await until(() => w.service.snapshot().activity.type === "idle");
      const bye = `bye${i}`;
      w.emit({ type: "agent_turn_started", data: { turn: bye, context: CHAT } });
      await w.service.request({ ...w.transition({ type: "leave_voice" }, her), turn: bye });
      await vi.advanceTimersByTimeAsync(500);
      expect(w.voice.size, "she waits for her goodbye").toBe(1);
      w.emit({ type: "agent_turn_completed", data: { turn: bye, context: CHAT, text: "掰掰" } });
      await until(() => w.service.snapshot().presence.type === "none");
      await vi.advanceTimersByTimeAsync(10_000);

      // No residual state.
      const s = w.service.snapshot();
      expect(s.presence).toEqual({ type: "none" });
      expect(s.broadcast).toEqual({ type: "off" });
      expect(s.activity.type).toBe("idle");
      expect(w.golive.size).toBe(0);
      expect(w.obsStreaming).toBe(false);
      expect(w.session).toBeNull();
      expect(
        w.service.tasks(100).filter((t) => t.status === "queued" || t.status === "running"),
      ).toEqual([]);
    }

    // Never started twice.
    expect(w.starts).toBe(cycles);
    expect(w.count("game.start")).toBe(cycles);
    expect(w.count("stream.start")).toBe(cycles);
    expect(
      w.calls.filter((c) => c.capability === "stage.stream" && c.args.action === "start"),
    ).toHaveLength(cycles);
    expect(w.service.tasks(500).filter((t) => t.status === "failed")).toEqual([]);

    // No flapping: never back to the scene before within the debounce, never the same scene
    // twice in a row, and the same small story every cycle.
    for (let i = 2; i < switches.length; i++) {
      const [a, b, c] = [switches[i - 2], switches[i - 1], switches[i]] as const;
      if (a && b && c && a.scene === c.scene) {
        expect(c.at - b.at, `${a.scene} → ${b.scene} → ${c.scene}`).toBeGreaterThanOrEqual(
          config.debounce_ms,
        );
      }
      expect(c?.scene).not.toBe(b?.scene);
    }
    expect(switches.length).toBeLessThanOrEqual(cycles * 4);
    const story = switches.slice(0, 4).map((s) => s.scene);
    expect(story).toEqual(
      ["Starting Soon", "Gameplay", "Ending", "Just Chatting"].slice(0, story.length),
    );
    director.stop();
    w.service.close();
  }, 60_000);
});
