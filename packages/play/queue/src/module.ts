import { CommandMount } from "@miyoria/commands";
import {
  defineManifest,
  errorMessage,
  getLogger,
  type Module,
  type ModuleContext,
} from "@miyoria/runtime/kernel";
import { SettingsStoreKey } from "@miyoria/store";
import { PlacesKey, SocialSignalsKey, serviceKey } from "@miyoria/types";
import { registerCommands } from "./commands.js";
import { QueueConfigSchema } from "./config.js";
import { queueSpaces, RequestQueue } from "./queue.js";

const log = getLogger("queue");

export const RequestQueueKey = serviceKey<RequestQueue>("RequestQueue");

interface Running {
  queue: RequestQueue;
  commands: CommandMount;
}

/**
 * Module `queue`: provides the `RequestQueue`, restores and snapshots its state, publishes
 * `queue.*` events and registers the queue commands. Each Space (server) has its own queue, pause
 * and vote; a snapshot of before is read as the original server's.
 *
 * Uses the optional services `SettingsStore` (persistence), `SocialSignals` (affinity
 * weighting) and `CommandRegistry` (commands, module `commands`). Config: see `QueueConfig`.
 */
export class QueueModule implements Module {
  static readonly ID = "queue";
  readonly manifest = defineManifest(QueueModule.ID, "Request queue", {
    icon: "list-ordered",
    category: "play",
    description: "Fair request queue with voting mode",
    optional: ["commands", "heart"],
    configSchema: QueueConfigSchema,
  });
  #running: Running | null = null;

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(QueueConfigSchema);
    const queue = new RequestQueue(config, {
      // Looked up at each use: the heart may restart and provide a new one.
      social: () => ctx.services.get(SocialSignalsKey) ?? null,
      store: ctx.services.get(SettingsStoreKey) ?? null,
      publisher: ctx.publisher,
      clock: ctx.clock,
      // Each Space its own queue (phase 6); without identity's places, one queue.
      spaces: queueSpaces(ctx.services.get(PlacesKey) ?? null),
    });
    try {
      if (await queue.restore()) log.info("restored the request queue");
    } catch (error) {
      log.warn(
        { error: errorMessage(error) },
        "could not restore the request queue; starting empty",
      );
    }

    let paths: string[] = [];
    const commands = new CommandMount(
      "queue",
      (registry) => {
        paths = registerCommands(registry, queue);
      },
      (registry) => {
        for (const path of paths) registry.unregister(path);
      },
    );
    commands.attach(ctx);

    ctx.provide(RequestQueueKey, queue);
    ctx.spawn("queue", (signal) => queue.run(signal));
    this.#running = { queue, commands };
  }

  async stop(): Promise<void> {
    const running = this.#running;
    this.#running = null;
    if (!running) return;
    running.commands.detach();
    await running.queue.persist();
  }
}
