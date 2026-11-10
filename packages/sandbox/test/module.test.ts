import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActuatorRegistry, ActuatorRegistryKey } from "@miyoria/actions";
import { Supervisor } from "@miyoria/kernel";
import { MemorySettingsStore, SettingsStoreKey } from "@miyoria/store";
import { ToolRegistry } from "@miyoria/tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CODE_RUN,
  ProposedToolsKey,
  SandboxConfigSchema,
  SandboxKey,
  SandboxModule,
  TOOL_PROPOSE,
} from "../src/index.js";
import { FakeRunner } from "./fake-runner.js";

/** A supervisor with an app-level actuator registry (like the core's boot). */
function app(): { sup: Supervisor; registry: ActuatorRegistry; tools: ToolRegistry } {
  const sup = new Supervisor();
  const tools = new ToolRegistry();
  const registry = new ActuatorRegistry({ services: sup.services, tools, builtins: false });
  sup.services.provide("app", ActuatorRegistryKey, registry);
  sup.services.provide("app", SettingsStoreKey, new MemorySettingsStore());
  return { sup, registry, tools };
}

describe("SandboxModule capabilities", () => {
  it("registers_code_run_and_tool_propose_when_docker_is_healthy", async () => {
    const runner = new FakeRunner();
    const { sup, registry, tools } = app();
    await sup.register(new SandboxModule("p", { baseDir: base, runner: () => runner }), {}, true);
    await sup.startAll();
    await waitFor(() => registry.get(CODE_RUN) !== undefined);
    expect(registry.get(TOOL_PROPOSE)).toBeDefined();
    expect(tools.get("code_run")).toBeDefined();
    expect((await registry.statusLines()).join("\n")).toContain("code.run / tool.propose 已開放");
    await sup.stopAll();
    // Withdrawn with the module.
    expect(registry.get(CODE_RUN)).toBeUndefined();
    expect(tools.get("code_run")).toBeUndefined();
    expect(await registry.statusLines()).toEqual([]);
  });

  it("offers_the_workspace_file_tools_even_without_docker_and_withdraws_them_on_stop", async () => {
    const down = new FakeRunner();
    down.dockerUp = false;
    const { sup, registry, tools } = app();
    await sup.register(new SandboxModule("p", { baseDir: base, runner: () => down }), {}, true);
    await sup.startAll();
    for (const name of [
      "workspace.list",
      "workspace.read",
      "workspace.write",
      "workspace.delete",
    ]) {
      expect(registry.get(name), name).toBeDefined();
    }
    expect(tools.get("workspace_write")).toBeDefined();
    // Running a saved script and saving one (a review) need Docker.
    expect(registry.get("workspace.run")).toBeUndefined();
    expect(registry.get("workspace.save_script")).toBeUndefined();
    const status = (await registry.statusLines()).join("\n");
    expect(status).toContain("工作區:0/500 個檔案");
    expect(status).toContain("網路:關閉");
    await sup.stopAll();
    expect(registry.get("workspace.write")).toBeUndefined();
  });

  it("keeps_the_workspace_tools_off_when_the_workspace_is_disabled", async () => {
    const { sup, registry } = app();
    await sup.register(
      new SandboxModule("p", { baseDir: base, runner: () => new FakeRunner() }),
      { workspace: { enabled: false } },
      true,
    );
    await sup.startAll();
    expect(registry.get("workspace.write")).toBeUndefined();
    await sup.stopAll();
  });

  it("registers_nothing_without_docker_or_when_disabled", async () => {
    const down = new FakeRunner();
    down.dockerUp = false;
    const a = app();
    await a.sup.register(new SandboxModule("p", { baseDir: base, runner: () => down }), {}, true);
    await a.sup.startAll();
    await waitFor(() => down.calledWith("version").length > 0);
    await new Promise((r) => setTimeout(r, 20));
    expect(a.registry.get(CODE_RUN)).toBeUndefined();
    expect((await a.registry.statusLines()).join("\n")).toContain("能力未開放");
    await a.sup.stopAll();

    const up = new FakeRunner();
    const b = app();
    await b.sup.register(new SandboxModule("p", { baseDir: base, runner: () => up }), {}, false);
    await b.sup.startAll();
    await new Promise((r) => setTimeout(r, 20));
    expect(b.registry.get(CODE_RUN)).toBeUndefined();
    expect(up.calls).toHaveLength(0);
    await b.sup.stopAll();
  });
});

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "miyoria-sandbox-module-"));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("SandboxModule", () => {
  it("provides_services_reaps_and_reports_health", async () => {
    const runner = new FakeRunner();
    runner.psOutput = "0123456789ab\n";
    const module = new SandboxModule("deepseek-chan", { baseDir: base, runner: () => runner });
    const sup = new Supervisor();
    sup.services.provide("app", SettingsStoreKey, new MemorySettingsStore());
    await sup.register(module, { root: "sbx" }, true);
    await sup.startAll();
    expect(sup.services.has(SandboxKey)).toBe(true);
    expect(sup.services.has(ProposedToolsKey)).toBe(true);
    await waitFor(() => runner.calledWith("rm").length > 0);
    expect(runner.calledWith("rm")).toEqual([["rm", "-f", "0123456789ab"]]);
    expect(await module.health()).toEqual({ status: "healthy" });
    expect(sup.services.require(SandboxKey).tools).toMatchObject({
      dir: join(base, "sbx", "profiles", "deepseek-chan", "tools"),
    });
    await sup.stopAll();
    expect(sup.services.get(SandboxKey)).toBeUndefined();
  });

  it("runs_degraded_without_docker", async () => {
    const runner = new FakeRunner();
    runner.dockerUp = false;
    const module = new SandboxModule("deepseek-chan", { baseDir: base, runner: () => runner });
    const sup = new Supervisor();
    await sup.register(module, null, true);
    await sup.startAll();
    await waitFor(() => runner.calledWith("version").length > 0);
    await waitFor(() => module.health !== undefined && sup.list()[0]?.state === "running");
    const health = await module.health();
    expect(health.status).toBe("degraded");
    // No settings store: no proposed tools, the sandbox itself still exists.
    expect(sup.services.has(ProposedToolsKey)).toBe(false);
    const error = await sup.services
      .require(SandboxKey)
      .run({ language: "python", code: "print(1)" })
      .catch((e: unknown) => e);
    expect((error as { kind: string }).kind).toBe("unavailable");
    expect(runner.calledWith("ps")).toHaveLength(0);
    await sup.stopAll();
  });
});

describe("result sizes", () => {
  it("default to what fits the main line tool result (4000), long output going to a file", () => {
    const config = SandboxConfigSchema.parse({});
    expect(config.result_chars).toBe(3900);
    expect(config.workspace.read_chars).toBe(3900);
    expect(config.workspace.keep_outputs).toBeGreaterThan(0);
  });
});
