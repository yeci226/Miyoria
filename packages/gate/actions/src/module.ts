// Module `actions`: configures the app's actuator registry (the gate's guardrails, the pause
// switch) and serves its commands.

import { CommandMount } from "@miyoria/commands";
import { ToolRegistryKey } from "@miyoria/llm/tools";
import {
  defineManifest,
  errorMessage,
  type Module,
  type ModuleContext,
} from "@miyoria/runtime/kernel";
import { SettingsStoreKey } from "@miyoria/store";
import { PresencePrivacyKey } from "@miyoria/types";
import { testHigh } from "./builtin.js";
import { registerCommands, unregisterCommands } from "./commands.js";
import { ActionsConfigSchema } from "./config.js";
import { PRIVACY_PROFILE } from "./privacy.js";
import { ActuatorRegistry, ActuatorRegistryKey, PAUSED_KEY } from "./registry.js";

/**
 * The app's registry, or (without one, e.g. in a module test) a private registry for this
 * module's capabilities and commands.
 */
export function actuatorsFor(ctx: ModuleContext): ActuatorRegistry {
  return (
    ctx.services.get(ActuatorRegistryKey) ??
    new ActuatorRegistry({
      services: ctx.services,
      tools: ctx.services.get(ToolRegistryKey) ?? null,
      publish: ctx.publisher,
      clock: ctx.clock,
      builtins: false,
    })
  );
}

/**
 * Module `actions`: applies `[modules.actions]` to the `ActuatorRegistry` the app provides
 * (`ActuatorRegistryKey`), restores the pause switch and registers `/admin autonomy ...`,
 * `/me privacy` and the approval buttons. Without this module the gate runs with the default
 * guardrails.
 */
export class ActionsModule implements Module {
  static readonly ID = "actions";
  readonly manifest = defineManifest(ActionsModule.ID, "Actions", {
    description: "The gate in front of everything she does: guardrails, consent, review, audit",
    optional: ["commands", "llm"],
    configSchema: ActionsConfigSchema,
  });
  readonly #name: string | null;
  #commands: CommandMount | null = null;
  #unregister: (() => void) | null = null;

  /** `name`: her display name, for the self-review prompt. */
  constructor(name: string | null = null) {
    this.#name = name;
  }

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(ActionsConfigSchema);
    const registry = ctx.services.get(ActuatorRegistryKey);
    if (!registry) {
      ctx.log.warn("no actuator registry provided by the app; the gate cannot be configured");
      return;
    }
    registry.configure(config, this.#name);
    let paused = config.paused;
    try {
      const saved = await ctx.services.get(SettingsStoreKey)?.get(PRIVACY_PROFILE, PAUSED_KEY);
      if (typeof saved === "boolean") paused = saved;
    } catch (error) {
      ctx.log.warn({ err: errorMessage(error) }, "cannot read the pause switch; using the config");
    }
    registry.restorePaused(paused);
    if (paused) ctx.log.warn("autonomy is paused (/admin autonomy resume)");
    if (config.test_capability) this.#unregister = registry.register(testHigh);
    const commands = new CommandMount(
      "actions",
      (r) =>
        registerCommands(
          r,
          () => ctx.services.get(ActuatorRegistryKey) ?? registry,
          () => ctx.services.get(PresencePrivacyKey),
        ),
      unregisterCommands,
    );
    commands.attach(ctx);
    this.#commands = commands;
  }

  async stop(): Promise<void> {
    this.#commands?.detach();
    this.#commands = null;
    this.#unregister?.();
    this.#unregister = null;
  }
}
