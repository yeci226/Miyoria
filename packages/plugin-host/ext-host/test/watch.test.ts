import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TopicFilter } from "@miyoria/runtime/kernel";
import { describe, expect, it } from "vitest";
import {
  ExtensionManifest,
  gameToolAllowed,
  MANIFEST_FILE,
  protocolMismatch,
  RpcError,
  reservedBy,
  resolvePublish,
  sameSnapshot,
  snapshot,
  watchRoots,
} from "../src/index.js";

describe("watch", () => {
  it("detects_changes_and_skips_node_modules", () => {
    const dir = mkdtempSync(join(tmpdir(), "miyoria-watch-"));
    try {
      mkdirSync(join(dir, "dist/node_modules"), { recursive: true });
      writeFileSync(join(dir, MANIFEST_FILE), "x");
      writeFileSync(join(dir, "dist/index.js"), "1");
      const manifest = ExtensionManifest.parse(
        'id = "w"\nversion = "1"\nruntime = "node"\nentry = "dist/index.js"',
      );
      const roots = watchRoots(dir, manifest);
      const a = snapshot(roots);
      expect(a.size).toBe(2);
      writeFileSync(join(dir, "dist/node_modules/x.js"), "1");
      writeFileSync(join(dir, "src.ts"), "outside the entry dir");
      expect(sameSnapshot(snapshot(roots), a)).toBe(true);
      writeFileSync(join(dir, "dist/index.js"), "22");
      expect(sameSnapshot(snapshot(roots), a)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("extension", () => {
  it("game_tool_namespace", () => {
    expect(gameToolAllowed("weather.now", null)).toBe(true);
    expect(gameToolAllowed("gamer_tag", null)).toBe(true);
    expect(gameToolAllowed("game.minecraft.act", null)).toBe(false);
    expect(gameToolAllowed("game_minecraft_act", null)).toBe(false);
    expect(gameToolAllowed("game.minecraft.act", "minecraft")).toBe(true);
    expect(gameToolAllowed("game_minecraft_observe", "minecraft")).toBe(true);
    expect(gameToolAllowed("game.minecraft2.act", "minecraft")).toBe(false);
    expect(gameToolAllowed("game.minecraft", "minecraft")).toBe(false);
    expect(gameToolAllowed("game.terraria.act", "minecraft")).toBe(false);
  });

  it("reserves every type a built-in definition of the registry covers", () => {
    for (const [type, by] of [
      ["activity.changed", "activity.changed"],
      ["arbiter.ledger", "arbiter.ledger"],
      ["affect.event", "affect.event"],
      ["plan.goal", "plan.goal"],
      ["agent.notice", "agent.notice"],
      ["gate.decision", "gate.decision"],
      ["actions.outcome", "actions.outcome"],
      ["platform.message.created", "platform.message.created"],
      ["game.director.goal", "game.director.goal"],
      ["ext.me.task.done", "**.task.done"],
      ["game.osu.task.failed", "**.task.failed"],
    ]) {
      expect(reservedBy(type as string)?.type, type).toBe(by);
    }
    // The open namespaces and types nobody registered are not reserved.
    for (const type of ["ext.me.hello", "game.osu.death", "activityx.y", "custom.ok.x"]) {
      expect(reservedBy(type), type).toBeNull();
    }
  });

  it("resolves what an extension publishes against the registry", () => {
    const who = { id: "me", game: "osu", grants: new TopicFilter(["ext.friend.*", "custom.*"]) };
    const code = (type: string, data: unknown = { type: "x" }) => {
      try {
        resolvePublish(who, type, data as never);
        return 0;
      } catch (error) {
        return error instanceof RpcError ? error.code : -1;
      }
    };
    expect(resolvePublish(who, "ext.me.hello", { n: [1] })).toMatchObject({
      definition: { type: "ext.**" },
      data: { n: [1] },
    });
    // A game event is read as its schema reads it.
    expect(resolvePublish(who, "game.osu.death", { type: "death", extra: 1 })).toMatchObject({
      definition: { type: "game.*.*" },
      data: { type: "death" },
    });
    expect(code("ext.friend.x")).toBe(0);
    // The two built-in inputs meant for games and extensions: only with a grant, and checked.
    expect(code("self.nudge", { play: 0.2 })).toBe(-32001);
    expect(code("self.feel", { emotion: "joy", amount: 0.2 })).toBe(-32001);
    const granted = { ...who, grants: new TopicFilter(["self.*", "gate.*"]) };
    expect(resolvePublish(granted, "self.nudge", { play: 0.2, reason: "won" })).toMatchObject({
      definition: { type: "self.nudge" },
      data: { play: 0.2, reason: "won" },
    });
    expect(resolvePublish(granted, "self.feel", { emotion: "joy", amount: 0.2 })).toMatchObject({
      definition: { type: "self.feel" },
    });
    expect(() => resolvePublish(granted, "self.nudge", { play: "a lot" } as never)).toThrow();
    // A grant never opens any other built-in event.
    expect(() => resolvePublish(granted, "gate.decision", {} as never)).toThrow(/built-in/);
    expect(code("game.osu.death", { important: true })).toBe(-32602);
    expect(code("custom.thing")).toBe(-32602);
    expect(code("Bad Type")).toBe(-32602);
    expect(code("game.other.death")).toBe(-32001);
    expect(code("ext.stranger.x")).toBe(-32001);
    expect(code("voice.playback")).toBe(-32001);
    expect(code("ext.me.task.done")).toBe(-32001);
  });

  it("says which side is older when the protocols differ", () => {
    expect(protocolMismatch(1)).toBe(
      "the extension speaks extension protocol 1 and the host speaks 2; the extension is older: rebuild it against a newer @miyoria/sdk",
    );
    expect(protocolMismatch(3)).toContain("the host is older");
  });
});
