// Module `activity`: runs the ActivityManager, feeds it the bus and installs it as the actuator
// registry's router, so every caller of an activity capability (her tools, commands, the panel,
// the mind, the directors) goes through it.

import { ActuatorRegistryKey } from "@miyoria/actions";
import { defineManifest, type Module, type ModuleContext } from "@miyoria/kernel";
import { ActivityManagerKey, ActivityRecoveryKey, TaskSteerKey } from "@miyoria/types";
import { ActivityConfigSchema } from "./config.js";
import { FACT_TOPICS, TASK_EVENT_TOPICS } from "./facts.js";
import { ActivityService } from "./manager.js";
import { GatePort } from "./port.js";

/**
 * Module `activity`: provides `ActivityManagerKey` and routes the capabilities that declare an
 * `activity` mapping (`voice.join`, `voice.leave`, `stream.start`, `stream.stop`, `game.start`,
 * `game.stop`, `stage.scene`) through it. Without this module they execute directly as before.
 */
export class ActivityModule implements Module {
  static readonly ID = "activity";
  readonly manifest = defineManifest(ActivityModule.ID, "Activity", {
    description: "What she is doing: voice presence, the broadcast and her activity, one owner",
    optional: ["actions", "facts"],
    configSchema: ActivityConfigSchema,
  });
  #service: ActivityService | null = null;
  #unroute: (() => void) | null = null;

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(ActivityConfigSchema);
    const service = new ActivityService({
      port: new GatePort(ctx.services),
      config,
      clock: ctx.clock,
      publish: (event) => ctx.publish(event),
      services: ctx.services,
    });
    // Subscribe before anyone can route a request here, so no confirmation is missed.
    const events = ctx.subscribe([...FACT_TOPICS, ...TASK_EVENT_TOPICS]);
    ctx.spawn("facts", async () => {
      for await (const env of events) service.observe(env);
    });
    ctx.provide(ActivityManagerKey, service);
    ctx.provide(TaskSteerKey, service);
    const registry = ctx.services.get(ActuatorRegistryKey);
    if (registry) this.#unroute = registry.setActivityRouter(service);
    else ctx.log.warn("no actuator registry: activity capabilities are not routed here");
    this.#service = service;
    const left = ctx.services.get(ActivityRecoveryKey)?.game() ?? null;
    if (left !== null) service.restore(left);
    ctx.log.info("activity manager running");
  }

  async stop(): Promise<void> {
    this.#unroute?.();
    this.#unroute = null;
    this.#service?.close();
    this.#service = null;
  }
}
