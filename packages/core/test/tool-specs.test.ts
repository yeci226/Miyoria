// What a run offers the model, held to a file: the real core is booted on an in-memory store (no
// Discord, API, cluster or extensions), the capabilities of modules that cannot start here (voice,
// Stage, the sandbox, the diary) are added from their factories, and every tool's spec is written
// out the way the runner reads it. A change to the registry must leave `tool-specs.snap` as it is.

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_TOOL_LIMITS, slimTool } from "@miyoria/brain/agent";
import { ActuatorRegistryKey, CapabilityTool, isGatedToolName } from "@miyoria/gate/actions";
import {
  searchTools,
  TOOL_EFFECTS,
  TOOL_RISKS,
  TOOL_SPEEDS,
  type Tool,
  ToolRegistryKey,
} from "@miyoria/llm/tools";
import { Config } from "@miyoria/runtime/kernel";
import { stageCapabilities } from "@miyoria/stage";
import { openStore } from "@miyoria/store";
import {
  codeRunCapability,
  codeSessionCapability,
  toolProposeCapability,
  workspaceRunCapability,
  workspaceSaveScriptCapability,
} from "@miyoria/workspace/sandbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { diaryCapability } from "../../memory/learning/src/diary.js";
import { voiceCapabilities } from "../../voice/voice/src/actions.js";
import { buildCoreWith, type Core } from "../src/boot.js";
import { defaultCatalog } from "../src/modules.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const BASE = join(ROOT, ".tmp-test-b2", "tool-specs");
const SNAPSHOT = fileURLToPath(new URL("./tool-specs.snap", import.meta.url));

const CONFIG = `
[core]
profiles_dir = '${join(ROOT, "profiles")}'
profile = "deepseek-chan"
[modules.cluster]
enabled = false
[modules.sandbox]
enabled = true
[modules.imagegen]
enabled = true
[modules.watch]
enabled = true
`;

/** What the runner reads of a tool besides calling it. */
function view(tool: Tool) {
  return {
    name: tool.spec.name,
    description: tool.spec.description,
    parameters: tool.spec.parameters,
    permission: tool.permission ?? null,
    actsFor: tool.actsFor === true,
    readOnly: tool.readOnly === true,
    framed: tool.framed === true,
  };
}

let core: Core;

beforeAll(async () => {
  mkdirSync(BASE, { recursive: true });
  core = await buildCoreWith(
    { ...defaultCatalog, discoverExtensions: async () => ({ skipped: [], modules: [] }) },
    Config.fromToml(CONFIG),
    { discord: false, api: false, baseDir: BASE, store: await openStore("memory://") },
  );
  await core.start();
  const actuators = core.services.require(ActuatorRegistryKey);
  const stub = {} as never;
  const box = { networkAllow: [] } as never;
  const sandbox = { sandbox: box, tools: stub, resultChars: 0, toolTimeoutMs: 0 };
  const workspace = { sandbox: box, workspace: stub, resultChars: 0, readChars: 0, keepOutputs: 0 };
  const extra = [
    ...voiceCapabilities(stub, () => ""),
    ...stageCapabilities(stub),
    codeRunCapability(sandbox),
    codeSessionCapability(sandbox),
    toolProposeCapability(sandbox),
    workspaceSaveScriptCapability(workspace),
    workspaceRunCapability(workspace),
    diaryCapability(stub, () => []),
  ];
  for (const capability of extra) {
    if (actuators.get(capability.name) === undefined) actuators.register(capability as never);
  }
}, 120_000);

afterAll(async () => {
  await core?.stop();
  rmSync(BASE, { recursive: true, force: true });
});

/** The registered tools a turn can be offered: all but a game adapter's raw ones. */
function offered(): Tool[] {
  const tools = core.services.require(ToolRegistryKey);
  return tools.names().flatMap((name) => {
    const tool = tools.get(name);
    if (!tool) return [];
    return isGatedToolName(name) && !(tool instanceof CapabilityTool) ? [] : [tool];
  });
}

describe("the tools of a run", () => {
  it("are offered with the same specs as before", async () => {
    const slim = DEFAULT_TOOL_LIMITS;
    const tools = offered();
    const snapshot = {
      tools: tools.map(view),
      // What is sent: each spec cut to its budget.
      sent: tools.map((t) => slimTool(t.spec, slim)),
    };
    await expect(`${JSON.stringify(snapshot, null, 2)}\n`).toMatchFileSnapshot(SNAPSHOT);
  });

  it("cover every module that owns tools", () => {
    const names = new Set(offered().map((t) => t.spec.name));
    // One tool of each owner, so a module that stops registering here is noticed.
    const owners: Record<string, string> = {
      agent: "react",
      directive: "directive_add",
      memory: "recall",
      notebook: "notebook_read",
      knowledge: "knowledge_note",
      diary: "diary_write",
      social: "set_call_name",
      mind: "remind_me",
      economy: "give_coins",
      game: "game_start",
      party: "party_start",
      sing: "sing_start",
      watch: "watch_start",
      voice: "voice_join",
      stage: "stage_scene",
      web: "web_search",
      sandbox: "code_run",
      workspace: "workspace_read",
      skills: "skill_read",
      actions: "message_dm",
    };
    const missing = Object.entries(owners).filter(([, tool]) => !names.has(tool));
    expect(missing).toEqual([]);
  });
});

describe("the registry behind them", () => {
  it("knows of every tool what it does, how fast and at what risk", () => {
    const tools = core.services.require(ToolRegistryKey);
    const actuators = core.services.require(ActuatorRegistryKey);
    const entries = tools.entries();
    // Nothing here falls back to the defaults an MCP or extension tool gets.
    expect(entries.filter((e) => !e.declared).map((e) => e.name)).toEqual([]);
    for (const entry of entries) {
      expect(TOOL_EFFECTS, entry.name).toContain(entry.effect);
      expect(TOOL_SPEEDS, entry.name).toContain(entry.speed);
      expect(TOOL_RISKS, entry.name).toContain(entry.risk);
      expect(entry.group, entry.name).toMatch(/^[a-z]+$/);
      // A capability's entry carries the risk the gate decides by.
      if (entry.tool instanceof CapabilityTool) {
        expect(entry.risk, entry.name).toBe(actuators.get(entry.tool.capability.name)?.risk);
      }
    }
  });

  it("has the always-on tools of the new runner, some of them only on the new runner", () => {
    const tools = core.services.require(ToolRegistryKey);
    const always = tools
      .entries()
      .filter((e) => e.core)
      .map((e) => e.name);
    expect(always).toEqual([
      "code_run",
      "delegate",
      "find_tools",
      "keep_note",
      "look",
      "message_dm",
      "notebook_read",
      "notebook_write",
      "react",
      "recall",
      "remember",
      "remind_me",
      "say",
      "schedule",
      "sing_request",
      "sing_start",
      "sing_stop",
      "skill",
      "watch_look",
      "watch_start",
      "watch_stop",
      "web_image",
      "web_read",
      "web_search",
    ]);
    const next = tools.entries().filter((e) => e.next);
    expect(next.map((e) => e.name)).toEqual([
      "delegate",
      "delegate_cancel",
      "delegate_list",
      "delegate_read",
      "find_tools",
      "look",
      "say",
      "schedule",
      "schedule_cancel",
      "schedule_list",
      "skill",
    ]);
    for (const { name } of next) {
      expect(tools.names()).not.toContain(name);
      expect(tools.get(name)).toBeUndefined();
    }
    expect(tools.entries()).toHaveLength(tools.names().length + next.length);
    // What starts something that ends later.
    const long = tools.entries().filter((e) => e.speed === "long");
    expect(long.map((e) => e.name)).toEqual([
      "delegate",
      "game_start",
      "party_start",
      "sing_request",
      "sing_start",
      "stream_start",
      "voice_join",
      "watch_start",
    ]);
  });

  it("finds the tools a turn does not always offer", () => {
    const tools = core.services.require(ToolRegistryKey);
    const found = (query: string) => searchTools(tools.listings(), query).map((t) => t.name);
    expect(found("魚幣").length).toBe(8);
    // The sing tools are always offered, so a search has none of them to find.
    expect(found("唱歌").filter((name) => name.startsWith("sing_"))).toEqual([]);
    expect(found("派對遊戲")[0]).toMatch(/^party_/);
    expect(found("開台")).toContain("stream_start");
    expect(found("voice")).toEqual(expect.arrayContaining(["voice_join", "voice_leave"]));
    expect(found("recall")).toEqual([]);
  });
});
