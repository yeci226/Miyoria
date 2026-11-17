// Keeps a module's commands in the current `CommandRegistry` service.

import {
  errorMessage,
  getLogger,
  type ModuleContext,
  type ServiceLookup,
} from "@miyoria/runtime/kernel";
import { Events, is } from "@miyoria/types";
import { type CommandRegistry, CommandRegistryKey } from "./registry.js";

const log = getLogger("commands.mount");

/** Module id of the `commands` module (whose restarts re-provide the registry). */
const COMMANDS_MODULE = "commands";

/**
 * Registers a module's commands in the `CommandRegistry` service and keeps them there: when the
 * module starts (the registry may appear later), again whenever the `commands` module comes
 * back with a different registry, and removes them on `detach` (call it from `stop`).
 *
 * The first registration throws (e.g. a duplicate component route fails the module's start);
 * later ones are logged.
 */
export class CommandMount {
  #installed: CommandRegistry | null = null;

  constructor(
    private readonly name: string,
    private readonly install: (registry: CommandRegistry) => void,
    private readonly uninstall: (registry: CommandRegistry) => void,
  ) {}

  /** The registry the commands are in, if any. */
  get registry(): CommandRegistry | null {
    return this.#installed;
  }

  /** Registers now and follows `commands` module restarts until the module stops. */
  attach(ctx: ModuleContext): void {
    this.#sync(ctx.services, true);
    const events = ctx.subscribe(Events.SystemModuleState.type);
    ctx.spawn("command-mount", async () => {
      for await (const env of events) {
        if (
          is(Events.SystemModuleState, env) &&
          env.data.module === COMMANDS_MODULE &&
          env.data.state === "running"
        ) {
          this.#sync(ctx.services, false);
        }
      }
    });
  }

  /** Registers in the current registry if it changed (idempotent). */
  sync(services: ServiceLookup): void {
    this.#sync(services, false);
  }

  #sync(services: ServiceLookup, strict: boolean): void {
    const registry = services.get(CommandRegistryKey);
    if (!registry || registry === this.#installed) return;
    if (this.#installed) this.#remove(this.#installed);
    this.#installed = null;
    try {
      this.install(registry);
      this.#installed = registry;
    } catch (error) {
      this.#remove(registry);
      if (strict) throw error;
      log.warn({ commands: this.name, error: errorMessage(error) }, "could not register commands");
    }
  }

  detach(): void {
    if (this.#installed) this.#remove(this.#installed);
    this.#installed = null;
  }

  #remove(registry: CommandRegistry): void {
    try {
      this.uninstall(registry);
    } catch (error) {
      log.warn(
        { commands: this.name, error: errorMessage(error) },
        "could not unregister commands",
      );
    }
  }
}
