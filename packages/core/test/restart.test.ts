// Restarting the core with the game still open (the bug of 2026-11-07: 重啟 Core 後遊戲開著但顯示
// 閒置), on the real modules and a real database file. Only the game itself is fake.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActivityModule } from "@miyoria/activity";
import { FactsModule, toReplayLines } from "@miyoria/facts";
import { defineManifest, type Module, type ModuleContext, Supervisor } from "@miyoria/kernel";
import { entryTopic, formatEntry, isReplayInput, parseReplayLog } from "@miyoria/replay";
import { SqliteStore } from "@miyoria/store";
import {
  ActivityManagerKey,
  type ActivitySnapshot,
  customEvent,
  EventLogKey,
  type GameResume,
  GameResumeKey,
  SYSTEM_SHUTDOWN_TOPIC,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const VOICE = { platform: "discord", scope: "g", channel: "v", kind: "voice" } as const;
const ACTIVITY = { restore_grace_ms: 300, restore_poll_ms: 20 };

const session = (state: "started" | "stopped", extra: object = {}) =>
  customEvent("game.director.session", {
    state,
    game: "minecraft",
    game_name: "Minecraft",
    context: { ...VOICE },
    ...extra,
  });

/** The game module, as far as a restart cares: says the session back once the game is reachable. */
class FakeGame implements Module {
  readonly manifest = defineManifest("game", "game");
  reachable = false;
  resumed = 0;
  #ctx: ModuleContext | null = null;

  async start(ctx: ModuleContext): Promise<void> {
    this.#ctx = ctx;
    const resume: GameResume = {
      resume: async () => {
        if (!this.reachable) return "waiting";
        this.resumed++;
        ctx.publish(session("started"));
        return "resumed";
      },
    };
    ctx.provide(GameResumeKey, resume);
  }

  publish(event: ReturnType<typeof session>): void {
    this.#ctx?.publish(event);
  }

  /** What the director does on its way down. */
  async stop(): Promise<void> {
    this.publish(session("stopped"));
  }
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "miyoria-restart-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function boot(path: string, game: FakeGame) {
  const store = await SqliteStore.open(path);
  const sup = new Supervisor();
  await sup.register(new FactsModule(store, "p"), { flush_ms: 5 }, true);
  await sup.register(new ActivityModule(), ACTIVITY, true);
  await sup.register(game, null, true);
  await sup.startAll();
  const snapshot = (): ActivitySnapshot => sup.services.require(ActivityManagerKey).snapshot();
  const down = async (clean: boolean) => {
    if (clean) sup.bus.publish("kernel", customEvent(SYSTEM_SHUTDOWN_TOPIC, {}));
    await sup.stopAll();
    await store.close();
  };
  return { sup, snapshot, down };
}

async function played(path: string, clean: boolean): Promise<void> {
  const game = new FakeGame();
  const run = await boot(path, game);
  game.publish(session("started"));
  await vi.waitFor(() => expect(run.snapshot().activity.type).toBe("game"));
  await run.down(clean);
}

describe("reading the log back for a replay", () => {
  it("gives lines the replay's own parser takes", async () => {
    const path = join(dir, "replay.db");
    const game = new FakeGame();
    const run = await boot(path, game);
    game.publish(session("started"));
    const log = run.sup.services.require(EventLogKey);
    await vi.waitFor(async () => {
      expect(await log.query({ sources: ["game.session"] })).toHaveLength(1);
    });
    const lines = toReplayLines(await log.query({ sources: ["game.session"] }));
    const parsed = parseReplayLog(lines.map(formatEntry).join("\n"));
    expect(parsed.entries).toEqual(lines);
    const entry = parsed.entries[0];
    if (!entry) throw new Error("nothing was logged");
    expect(entryTopic(entry)).toBe("game.director.session");
    expect(isReplayInput(entryTopic(entry), entry.source)).toBe(true);
    await run.down(true);
  });
});

describe("restarting the core", () => {
  it("a game that is still open comes back, and is never shown as idle", async () => {
    const path = join(dir, "open.db");
    await played(path, true);

    const game = new FakeGame();
    const run = await boot(path, game);
    expect(run.snapshot().activity).toMatchObject({
      type: "game",
      target: "minecraft",
      phase: "starting",
    });
    game.reachable = true;
    await vi.waitFor(() =>
      expect(run.snapshot().activity).toMatchObject({ type: "game", phase: "running" }),
    );
    expect(game.resumed).toBe(1);
    await run.down(true);
  });

  it("also after the core was killed", async () => {
    const path = join(dir, "killed.db");
    const first = new FakeGame();
    const killed = await boot(path, first);
    first.publish(session("started"));
    await vi.waitFor(() => expect(killed.snapshot().activity.type).toBe("game"));
    await killed.sup.services.require(EventLogKey).flush();

    // Nothing stopped and nothing said goodbye: the next run only has what reached the file.
    const game = new FakeGame();
    game.reachable = true;
    const run = await boot(path, game);
    await vi.waitFor(() =>
      expect(run.snapshot().activity).toMatchObject({ type: "game", phase: "running" }),
    );
    await run.down(true);
    await killed.down(true);
  });

  it("a real stop without a shutdown is a stop", async () => {
    const path = join(dir, "stop.db");
    await played(path, false);
    const run = await boot(path, new FakeGame());
    expect(run.snapshot().activity.type).toBe("idle");
    await run.down(true);
  });

  it("a game that was closed while the core was down turns into idle", async () => {
    const path = join(dir, "closed.db");
    await played(path, true);
    const game = new FakeGame();
    const run = await boot(path, game);
    expect(run.snapshot().activity.type).toBe("game");
    await vi.waitFor(() => expect(run.snapshot().activity.type).toBe("idle"));
    expect(game.resumed).toBe(0);
    await run.down(true);
    // And it does not come back from the dead on the next start.
    const again = await boot(path, new FakeGame());
    expect(again.snapshot().activity.type).toBe("idle");
    await again.down(true);
  });

  it("two restarts in a row do not lose it", async () => {
    const path = join(dir, "twice.db");
    await played(path, true);
    const between = await boot(path, new FakeGame());
    expect(between.snapshot().activity.type).toBe("game");
    await between.down(true);

    const game = new FakeGame();
    game.reachable = true;
    const run = await boot(path, game);
    await vi.waitFor(() =>
      expect(run.snapshot().activity).toMatchObject({ type: "game", phase: "running" }),
    );
    await run.down(true);
  });

  it("a game stopped before the restart stays stopped", async () => {
    const path = join(dir, "stopped.db");
    const first = new FakeGame();
    const before = await boot(path, first);
    first.publish(session("started"));
    await vi.waitFor(() => expect(before.snapshot().activity.type).toBe("game"));
    first.publish(session("stopped"));
    await vi.waitFor(() => expect(before.snapshot().activity.type).toBe("idle"));
    await before.down(true);

    const run = await boot(path, new FakeGame());
    expect(run.snapshot().activity.type).toBe("idle");
    await run.down(true);
  });

  it("without the facts module nothing changes", async () => {
    const sup = new Supervisor();
    await sup.register(new ActivityModule(), ACTIVITY, true);
    await sup.startAll();
    const manager = sup.services.require(ActivityManagerKey);
    expect(manager.snapshot().activity.type).toBe("idle");
    await sup.stopAll();
  });
});
