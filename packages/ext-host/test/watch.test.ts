import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ExtensionManifest,
  gameToolAllowed,
  MANIFEST_FILE,
  reservedTopic,
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

  it("reserves the v2 topic prefixes and the gate's", () => {
    for (const topic of [
      "activity.changed",
      "activity.failed",
      "arbiter.ledger",
      "affect.event",
      "plan.goal",
      "agent.notice",
      "gate.decision",
      "actions.outcome",
    ]) {
      expect(reservedTopic(topic), topic).toBe(true);
    }
    expect(reservedTopic("activityx.y")).toBe(false);
    expect(reservedTopic("custom.ok.x")).toBe(false);
  });
});
