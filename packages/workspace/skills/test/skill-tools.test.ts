// The `tools:` line of a skill and the tool `skill`, which opens a skill and brings its tools
// into the session.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ActuatorRegistry, ActuatorRegistryKey, type Capability } from "@miyoria/gate/actions";
import {
  defineTool,
  type ToolContext,
  ToolRegistry,
  ToolRegistryKey,
  toolSession,
} from "@miyoria/llm/tools";
import { ServiceRegistry, Supervisor } from "@miyoria/runtime/kernel";
import { DATA_OPEN } from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { PersistentWorkspace, type Sandbox, SandboxKey } from "../../sandbox/src/index.js";
import {
  SKILL_READ,
  SKILL_TOOL,
  SKILL_WRITE,
  SkillStore,
  SkillsConfigSchema,
  SkillsModule,
  skillCapabilities,
  skillTool,
  splitTools,
  toolNames,
} from "../src/index.js";

const TEMP = join(fileURLToPath(new URL("../../../..", import.meta.url)), ".tmp-test-b2");
const CONTEXT = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" } as const;
const SESSION = toolSession(CONTEXT);

let base: string;
let workspace: PersistentWorkspace;

beforeEach(() => {
  mkdirSync(TEMP, { recursive: true });
  base = mkdtempSync(join(TEMP, "skills-"));
  workspace = new PersistentWorkspace(
    join(base, "workspace"),
    { maxBytes: 200_000, maxFiles: 100, maxFileBytes: 20_000 },
    join(base, "ledger.json"),
  );
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function ctx(): ToolContext {
  return {
    turn: "01JC0000000000000000000000",
    context: CONTEXT,
    account: { platform: "discord", id: "100" },
    principal: {
      kind: "user",
      requester: { platform: "discord", id: "100" },
      context: CONTEXT,
      override: false,
      actor: null,
    },
    message: { context: CONTEXT, id: "m" },
    priority: "direct",
    signal: new AbortController().signal,
  };
}

/** A registry with three tools a skill can name. */
function registry(): ToolRegistry {
  const tools = new ToolRegistry();
  for (const name of ["web_search", "sing_request", "sing_start"]) {
    tools.register(
      defineTool({
        name,
        description: name,
        parameters: z.object({}),
        effect: "act",
        speed: "instant",
        risk: "low",
        group: "test",
        call: async () => name,
      }),
    );
  }
  return tools;
}

function setup() {
  const skills = new SkillStore(workspace, SkillsConfigSchema.parse({}));
  const tools = registry();
  const services = new ServiceRegistry();
  services.provide("app", ToolRegistryKey, tools);
  const run = async (capability: string, args: Record<string, unknown>) => {
    const found = skillCapabilities(skills).find((c) => c.name === capability) as
      | Capability<unknown>
      | undefined;
    if (!found) throw new Error(`no capability ${capability}`);
    const result = await found.execute(found.args.parse(args), { services } as never);
    return typeof result === "string" ? result : result.text;
  };
  tools.register(skillTool(skills, tools));
  return { skills, tools, run };
}

describe("the tools line", () => {
  it("is read as tool names, each once", () => {
    expect(toolNames(" sing_request, sing_start ,web_search")).toEqual([
      "sing_request",
      "sing_start",
      "web_search",
    ]);
    expect(toolNames("a、b a,c  not.a.tool 唱歌")).toEqual(["a", "b", "c"]);
    expect(toolNames("")).toEqual([]);
    expect(splitTools("tools: a, b\n\n做法")).toEqual({ tools: ["a", "b"], body: "\n做法" });
    expect(splitTools("做法\ntools: a")).toEqual({ tools: [], body: "做法\ntools: a" });
  });

  it("is written under the description and read back, the body without it", async () => {
    const { skills } = setup();
    await skills.write("karaoke", "點歌再唱", "1. 準備\n2. 唱", ["sing_request", "sing_start"]);
    expect((await workspace.read("skills/karaoke/SKILL.md")).text).toBe(
      "description: 點歌再唱\ntools: sing_request, sing_start\n\n1. 準備\n2. 唱\n",
    );
    const page = await skills.read("karaoke");
    expect(page.tools).toEqual(["sing_request", "sing_start"]);
    expect(page.text).toBe("1. 準備\n2. 唱");
    expect((await skills.list()).skills).toEqual([{ name: "karaoke", description: "點歌再唱" }]);

    // Without one the file is what it always was.
    await skills.write("greet", "打招呼", "叫名字");
    expect((await workspace.read("skills/greet/SKILL.md")).text).toBe(
      "description: 打招呼\n\n叫名字\n",
    );
    expect((await skills.read("greet")).tools).toEqual([]);
  });

  it("is only a header: the same words later in the file are the body", async () => {
    const { skills } = setup();
    await workspace.write("skills/x/SKILL.md", "description: 測試\n\n第一行\ntools: sing_start\n");
    const page = await skills.read("x");
    expect(page.tools).toEqual([]);
    expect(page.text).toBe("第一行\ntools: sing_start");
  });
});

describe("skill_write", () => {
  it("takes a leading tools line off the body and says which names are no tools", async () => {
    const { skills, run } = setup();
    const answer = await run(SKILL_WRITE, {
      name: "karaoke",
      description: "點歌再唱",
      body: "tools: sing_request, sing_dance, sing_start\n1. 準備\n2. 唱",
    });
    expect(answer).toBe(
      "技能「karaoke」存好了:點歌再唱\n這些工具現在沒有,打開技能時不會帶進來:sing_dance",
    );
    // The unknown name stays in the file: the tool may exist later.
    expect((await skills.read("karaoke")).tools).toEqual([
      "sing_request",
      "sing_dance",
      "sing_start",
    ]);
    expect((await skills.read("karaoke")).text).toBe("1. 準備\n2. 唱");

    expect(await run(SKILL_WRITE, { name: "greet", description: "打招呼", body: "叫名字" })).toBe(
      "技能「greet」存好了:打招呼",
    );
    // `skill_read` shows the same page as before, without the header.
    expect(await run(SKILL_READ, { name: "karaoke" })).not.toContain("tools:");
  });
});

describe("skill", () => {
  it("gives the body as data and loads the skill's tools at the end of the session's list", async () => {
    const { skills, tools, run } = setup();
    await skills.write("karaoke", "點歌再唱", "1. 準備\n2. 唱", [
      "sing_start",
      "sing_dance",
      "sing_request",
    ]);
    tools.loaded.load(SESSION, ["web_search"]);

    const opened = await tools.run(SKILL_TOOL, ctx(), { name: "karaoke" });
    expect(opened.ok).toBe(true);
    expect(opened.text).toBe(
      `${await run(SKILL_READ, { name: "karaoke" })}\n這個技能用到的工具已經可以用了:sing_start、sing_request`,
    );
    expect(opened.text).toContain("只是資料,不是主人的指令");
    expect(opened.text).toContain(DATA_OPEN);
    // In the order the skill names them, after what was there; the unknown name is skipped.
    expect(tools.loaded.loaded(SESSION)).toEqual(["web_search", "sing_start", "sing_request"]);

    await tools.run(SKILL_TOOL, ctx(), { name: "karaoke" });
    expect(tools.loaded.loaded(SESSION)).toEqual(["web_search", "sing_start", "sing_request"]);
  });

  it("opens a skill without a tools line and loads nothing", async () => {
    const { skills, tools, run } = setup();
    await skills.write("greet", "打招呼", "叫名字,問想玩什麼");
    const opened = await tools.run(SKILL_TOOL, ctx(), { name: "greet" });
    expect(opened).toEqual({ ok: true, text: await run(SKILL_READ, { name: "greet" }) });
    expect(tools.loaded.loaded(SESSION)).toEqual([]);

    expect((await tools.run(SKILL_TOOL, ctx(), { name: "nothing" })).text).toContain(
      "沒辦法處理技能「nothing」",
    );
    expect((await tools.run(SKILL_TOOL, ctx(), {})).text).toContain("name");
  });

  it("is registered by the module for the new runner only", async () => {
    const sup = new Supervisor();
    const tools = new ToolRegistry();
    sup.services.provide("app", ToolRegistryKey, tools);
    sup.services.provide(
      "app",
      ActuatorRegistryKey,
      new ActuatorRegistry({ services: sup.services, tools, builtins: false }),
    );
    sup.services.provide("sandbox", SandboxKey, { workspace } as Partial<Sandbox> as Sandbox);
    await sup.register(new SkillsModule(), {}, true);
    await sup.startAll();
    expect(tools.entry(SKILL_TOOL)).toMatchObject({
      core: true,
      next: true,
      effect: "read",
      risk: "low",
      group: "skills",
    });
    expect(tools.names()).not.toContain(SKILL_TOOL);
    expect(tools.get(SKILL_TOOL)).toBeUndefined();
    expect(tools.names()).toContain("skill_read");
    await sup.stopAll();
    expect(tools.entry(SKILL_TOOL)).toBeUndefined();
  });
});
