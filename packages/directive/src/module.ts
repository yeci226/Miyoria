// Module `directive`: the part of the rules that can be switched off. The rules themselves are the
// service the app provides at boot (`DirectivesKey`), so stopping this module takes away the tools
// and the commands and leaves every rule in force.

import { CommandMount } from "@miyoria/commands";
import { defineManifest, type Module, type ModuleContext, sleep } from "@miyoria/kernel";
import { ToolRegistryKey } from "@miyoria/tools";
import {
  DirectivesKey,
  EventLogKey,
  isJsonObject,
  type LogEvent,
  type ProposalBody,
} from "@miyoria/types";
import { registerCommands, unregisterCommands } from "./commands.js";
import { DirectiveConfigSchema } from "./config.js";
import { DirectiveService } from "./service.js";
import { directiveTools } from "./tools.js";

/** The proposal a log line brings, if it is one. */
function proposalOf(event: LogEvent) {
  if (event.kind !== "proposal" || !isJsonObject(event.body)) return null;
  const { proposal } = event.body as unknown as Partial<ProposalBody>;
  return typeof proposal?.id === "string" ? proposal : null;
}

export class DirectiveModule implements Module {
  static readonly ID = "directive";
  readonly manifest = defineManifest(DirectiveModule.ID, "Directive", {
    description: "The owner's rules: her tools and commands for them, and the proposals they stop",
    optional: ["facts", "commands", "actions", "agent"],
    configSchema: DirectiveConfigSchema,
  });
  #commands: CommandMount | null = null;
  #untools: (() => void) | null = null;
  #unproject: (() => void) | null = null;

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(DirectiveConfigSchema);
    const service = ctx.services.get(DirectivesKey);
    if (!(service instanceof DirectiveService)) {
      ctx.log.warn("no directive service provided by the app; there are no rules to manage");
      return;
    }
    service.configure(config);
    await service.refresh();
    if (!service.healthy) ctx.log.warn("cannot read the rules: everything stays closed");

    const lookup = () => ctx.services.get(DirectivesKey);
    const tools = ctx.services.get(ToolRegistryKey);
    if (tools) {
      const ours = directiveTools(lookup);
      for (const tool of ours) tools.register(tool);
      this.#untools = () => {
        for (const tool of ours) tools.unregister(tool.spec.name);
      };
    }
    const commands = new CommandMount(
      DirectiveModule.ID,
      (registry) => registerCommands(registry, lookup),
      unregisterCommands,
    );
    commands.attach(ctx);
    this.#commands = commands;

    // Every proposal passes the rules as it is written. Not inside `apply`: the board follows the
    // same log, and has to have seen a proposal before it can be told what became of it.
    const log = ctx.services.get(EventLogKey);
    if (log) {
      this.#unproject = await log.project({
        apply(event) {
          const proposal = proposalOf(event);
          if (proposal !== null) queueMicrotask(() => service.screen(proposal));
        },
      });
    }
    // What survived a restart on the board meets the rules of today.
    service.sweep();
    ctx.spawn("refresh", async () => {
      while (!ctx.signal.aborted) {
        await sleep(config.refresh_secs * 1000, ctx.signal);
        await service.refresh();
      }
    });
    ctx.log.info("rules running");
  }

  async stop(): Promise<void> {
    this.#unproject?.();
    this.#unproject = null;
    this.#commands?.detach();
    this.#commands = null;
    this.#untools?.();
    this.#untools = null;
  }
}
