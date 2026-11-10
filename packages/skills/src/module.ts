import { actuatorsFor } from "@miyoria/actions";
import {
  defineManifest,
  HEALTHY,
  type Health,
  type Module,
  type ModuleContext,
} from "@miyoria/kernel";
import { SandboxKey } from "@miyoria/sandbox";
import { SkillIndexKey, SkillShelfKey, serviceKey } from "@miyoria/types";
import { skillCapabilities } from "./capabilities.js";
import { SkillsConfigSchema } from "./config.js";
import { SkillStore } from "./store.js";

/** Her skills; the agent asks it for `index()` to put names and descriptions in the prompt. */
export const SkillStoreKey = serviceKey<SkillStore>("SkillStore");

/**
 * Module `skills`: provides `SkillStoreKey` and registers `skill.list`, `skill.read`,
 * `skill.write` and `skill.delete` in the app's actuator registry. Skills live in the sandbox's
 * persistent workspace, so without module `sandbox` (opt-in) and its workspace the module idles:
 * no service, no tools. `/admin autonomy status` shows how many skills she has.
 */
export class SkillsModule implements Module {
  static readonly ID = "skills";
  readonly manifest = defineManifest(SkillsModule.ID, "Skills", {
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
    ctx.provide(SkillStoreKey, store);
    // The same store under the key the main line reads its prompt index from.
    ctx.provide(SkillIndexKey, store);
    // And the one the admin API lists and reads skills through.
    ctx.provide(SkillShelfKey, store);
    const registry = actuatorsFor(ctx);
    for (const capability of skillCapabilities(store)) {
      this.#unregister.push(
        registry.register(capability as Parameters<typeof registry.register>[0]),
      );
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
