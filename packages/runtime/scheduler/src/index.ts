// @miyoria/runtime/scheduler: module `scheduler`. Provides the `ActionSink` service; everything that
// produces output submits `Action`s to it. Each lane (`LaneKey`) gets its own worker that runs
// the lane's actions one at a time, most urgent first, through the `PlatformSinks` service
// (`VoiceSink` for `speak`). Idle lane workers exit, so lanes cost nothing while quiet.

import { ActionSinkKey, type LaneKey } from "@miyoria/types";
import {
  defineManifest,
  type Module,
  type ModuleContext,
  type ModuleManifest,
} from "../../kernel/src/index.js";
import { type SchedulerConfig, SchedulerConfigSchema } from "./config.js";
import { Scheduler } from "./scheduler.js";

export { type SchedulerConfig, SchedulerConfigSchema } from "./config.js";
export { Scheduler, SchedulerStoppedError } from "./scheduler.js";

/** Module `scheduler`: provides the `ActionSink` service. */
export class SchedulerModule implements Module {
  static readonly ID = "scheduler";

  readonly manifest: ModuleManifest = defineManifest(SchedulerModule.ID, "Action scheduler", {
    icon: "calendar-clock",
    category: "system",
    description: "Per-lane output queues with priority, TTL and coalescing",
    configSchema: SchedulerConfigSchema,
  });

  #current: Scheduler | null = null;

  /** The scheduler of the current run, if the module is running. */
  scheduler(): Scheduler | null {
    return this.#current;
  }

  /** Lanes that currently have a worker. */
  activeLanes(): LaneKey[] {
    return this.#current?.activeLanes() ?? [];
  }

  async start(ctx: ModuleContext): Promise<void> {
    const config: SchedulerConfig = ctx.config(SchedulerConfigSchema);
    const scheduler = new Scheduler(ctx, config);
    ctx.provide(ActionSinkKey, scheduler);
    this.#current = scheduler;
  }

  async stop(): Promise<void> {
    this.#current = null;
  }
}
