import { actuatorsFor } from "@miyoria/gate/actions";
import { ToolRegistryKey } from "@miyoria/llm/tools";
import {
  defineManifest,
  HEALTHY,
  type Health,
  type Module,
  type ModuleContext,
} from "@miyoria/runtime/kernel";
import { SkillIndexKey, SkillShelfKey } from "@miyoria/types";
import { SandboxKey } from "../../sandbox/src/index.js";
import { SKILL_TOOL, skillCapabilities, skillTool } from "./capabilities.js";
import { SkillsConfigSchema } from "./config.js";
import { SkillStore } from "./store.js";

/**
 * Module `skills`: provides `SkillIndexKey` (the prompt's index of names and descriptions) and
 * `SkillShelfKey` (the admin API's list and read), and registers `skill.list`, `skill.read`,
 * `skill.write` and `skill.delete` in the app's actuator registry, and the tool `skill` (for the
 * new turn runner) in its tool registry. Skills live in the sandbox's
 * persistent workspace, so without module `sandbox` (opt-in) and its workspace the module idles:
 * no service, no tools. `/admin autonomy status` shows how many skills she has.
 */
export class SkillsModule implements Module {
  static readonly ID = "skills";
  readonly manifest = defineManifest(SkillsModule.ID, "Skills", {
    icon: "wand-sparkles",
    category: "system",
    description: "Small how-to documents she writes, improves and opens on demand",
    optional: ["sandbox", "actions"],
    configSchema: SkillsConfigSchema,
  });
  #unregister: Array<() => void> = [];
  #idle: string | null = "not started";

  async start(ctx: ModuleContext): Promise<void> {
    const sandbox = ctx.services.get(SandboxKey);
    const workspace = sandbox?.workspace ?? null;
    if (workspace === null) {
      this.#idle = sandbox === undefined ? "module sandbox is not running" : "workspace is off";
      ctx.log.info({ reason: this.#idle }, "skills are not available");
      return;
    }
    this.#idle = null;
    const store = new SkillStore(workspace, ctx.config(SkillsConfigSchema));
    // The store under the key the main line reads its prompt index from.
    ctx.provide(SkillIndexKey, store);
    // And the one the admin API lists and reads skills through.
    ctx.provide(SkillShelfKey, store);
    const registry = actuatorsFor(ctx);
    for (const capability of skillCapabilities(store)) {
      this.#unregister.push(
        registry.register(capability as Parameters<typeof registry.register>[0]),
      );
    }
    const tools = ctx.services.get(ToolRegistryKey);
    if (tools) {
      const tool = skillTool(store, tools);
      tools.register(tool);
      this.#unregister.push(() => {
        if (tools.entry(SKILL_TOOL)?.tool === tool) tools.unregister(SKILL_TOOL);
      });
    }
    this.#unregister.push(
      registry.addStatus(SkillsModule.ID, async () => {
        const { skills } = await store.list().catch(() => ({ skills: [] }));
        return [`技能:${skills.length === 0 ? "還沒有" : skills.map((s) => s.name).join("、")}`];
      }),
    );
  }

  async stop(): Promise<void> {
    for (const unregister of this.#unregister) unregister();
    this.#unregister = [];
  }

  async health(): Promise<Health> {
    return this.#idle === null ? HEALTHY : { status: "degraded", reason: this.#idle };
  }
}
