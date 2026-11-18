import { describe, expect, it } from "vitest";
import {
  ExtensionManifest,
  runsOnCore,
  validGameId,
  validPattern,
  validTopic,
} from "../src/index.js";

const FULL = `
id = "miyoria.minecraft"
version = "0.1.0"
kind = ["game-adapter", "tools", "commands"]
game = "minecraft"
runtime = "node"
entry = "dist/index.js"
placement = "stage"

[permissions]
events = ["game.*", "agent.turn.completed"]
tools = true
commands = true
network = ["localhost:25565"]
input = []

[config]
schema = "config.schema.json"

[[mcp_servers]]
name = "mc-wiki"
command = "npx"
args = ["-y", "some-minecraft-wiki-mcp"]
`;

describe("manifest", () => {
  it("parses_architecture_example", () => {
    const m = ExtensionManifest.parse(FULL);
    expect(m.id).toBe("miyoria.minecraft");
    expect(m.runtime).toBe("node");
    expect(m.placement).toBe("stage");
    expect(runsOnCore(m.placement)).toBe(false);
    expect(m.permissions.events).toHaveLength(2);
    expect(m.config.schema).toBe("config.schema.json");
    expect(m.mcp_servers[0]?.args).toEqual(["-y", "some-minecraft-wiki-mcp"]);
    expect(m.mcp_servers[0]?.url).toBeNull();
    expect(m.moduleId()).toBe("ext.miyoria.minecraft");
    expect(m.gameId()).toBe("minecraft");
    expect(m.errors()).toEqual([]);
    expect(m.warnings()).toEqual([]);
  });

  it("single_kind_and_defaults", () => {
    const m = ExtensionManifest.parse(
      'id = "x"\nversion = "1"\nkind = "module"\nruntime = "binary"\nentry = "x.exe"',
    );
    expect(m.kind).toEqual(["module"]);
    expect(m.placement).toBe("core");
    expect(m.permissions.tools).toBe(false);
    expect(m.displayName()).toBe("x");
  });

  it("reports_errors_and_warnings", () => {
    const m = ExtensionManifest.parse(`
      id = "Bad Id"
      version = ""
      kind = ["tools", "teleport"]
      runtime = "node"
      entry = "index.js"
      [permissions]
      events = ["Game.*", "game.**"]
      input = ["mouse"]
    `);
    expect(m.errors()).toHaveLength(4);
    expect(m.warnings()).toHaveLength(3);
    expect(() => ExtensionManifest.parse('id = "x"')).toThrow();
  });

  it("game_declaration", () => {
    const base = 'id = "x"\nversion = "1"\nruntime = "node"\nentry = "i.js"\n';
    let m = ExtensionManifest.parse(`${base}kind = "tools"\ngame = "mc"`);
    expect(m.errors()).toEqual(["`game` needs kind `game-adapter`"]);
    expect(m.gameId()).toBeNull();
    m = ExtensionManifest.parse(`${base}kind = "game-adapter"\ngame = "Mine Craft"`);
    expect(m.errors()).toHaveLength(1);
    m = ExtensionManifest.parse(`${base}kind = "game-adapter"`);
    expect(m.errors()).toEqual([]);
    expect(m.warnings()).toHaveLength(1);
    expect(m.gameId()).toBeNull();
    expect(validGameId("minecraft") && validGameId("ow-2")).toBe(true);
    expect(validGameId("a.b") || validGameId("")).toBe(false);
  });

  it("patterns", () => {
    expect(validPattern("*")).toBe(true);
    expect(validPattern("game.*")).toBe(true);
    expect(validPattern("agent.turn.completed")).toBe(true);
    expect(validPattern("game*")).toBe(false);
    expect(validPattern("*.x")).toBe(false);
    expect(validPattern("")).toBe(false);
    expect(validTopic("ext.miyoria.hello.ping")).toBe(true);
    expect(validTopic("a..b")).toBe(false);
  });

  it("serializes_to_the_wire_shape", () => {
    const m = ExtensionManifest.parse('id = "x"\nversion = "1"\nruntime = "node"\nentry = "i.js"');
    expect(JSON.parse(JSON.stringify(m))).toEqual({
      id: "x",
      version: "1",
      name: null,
      description: null,
      icon: null,
      kind: [],
      game: null,
      runtime: "node",
      entry: "i.js",
      placement: "core",
      permissions: { events: [], tools: false, commands: false, network: [], input: [] },
      config: { schema: null },
      env: { pass: [] },
      mcp_servers: [],
    });
  });

  it("validates_env_patterns", () => {
    const m = ExtensionManifest.parse(
      [
        'id = "x"',
        'version = "1"',
        'runtime = "node"',
        'entry = "i.js"',
        "[env]",
        'pass = ["MIYORIA_MC_*", "APP_URL", "*", "A*", "BAD-NAME"]',
      ].join("\n"),
    );
    expect(m.env.pass).toHaveLength(5);
    const errors = m.errors().filter((e) => e.startsWith("invalid env pattern"));
    expect(errors).toHaveLength(3);
    expect(errors.join("\n")).toContain("`*`");
    expect(errors.join("\n")).toContain("`A*`");
    expect(errors.join("\n")).toContain("`BAD-NAME`");
  });
});
