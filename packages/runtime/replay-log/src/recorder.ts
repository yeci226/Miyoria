// Module `replay`: an opt-in recorder of what she perceives, for the replay harness (tools/replay)
// (docs/design/v2-architecture.md §4, "從階段 1 開始建回放測試").
//
// ```toml
// [modules.replay]
// record = false            # true: append the events to <dir>/<YYYY-MM-DD>.jsonl
// dir = "data/replay"       # relative to the config file's directory
// ```
//
// Off by default: a log holds what people said (messages and voice transcripts), so it is kept
// only when the owner turns it on, on the owner's disk, and never leaves it. Each line is one bus
// envelope as JSON (`ReplayEntry`, log.ts); `pnpm replay <file>` replays one.

import { appendFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { toTimestamp } from "@miyoria/types";
import { z } from "zod";
import {
  defineManifest,
  errorMessage,
  type Module,
  type ModuleContext,
  SerialQueue,
} from "../../kernel/src/index.js";
import { DEFAULT_RECORD_TOPICS, formatEntry } from "./log.js";

export const ReplayConfigSchema = z.object({
  /** Record the events (off by default: the log holds what people said). */
  record: z.boolean().default(false),
  /** Where the daily logs go (relative to the config file's directory). */
  dir: z.string().default("data/replay"),
  /** Topics recorded (exact or `prefix.*`); default: her input plus her turn outcomes. */
  topics: z.array(z.string()).default([...DEFAULT_RECORD_TOPICS]),
});

export interface ReplayRecorderOptions {
  /** Base directory of a relative `dir` (the config file's directory). */
  baseDir?: string;
}

/** The daily log file for `nowMs` (UTC day). */
export function logFileFor(dir: string, nowMs: number): string {
  return join(dir, `${toTimestamp(nowMs).slice(0, 10)}.jsonl`);
}

export class ReplayRecorderModule implements Module {
  static readonly ID = "replay";
  readonly manifest = defineManifest(ReplayRecorderModule.ID, "Replay recorder", {
    icon: "history",
    category: "system",
    description: "Records what she perceives to JSONL for the replay harness (opt-in)",
    configSchema: ReplayConfigSchema,
  });
  readonly #baseDir: string;

  constructor(options: ReplayRecorderOptions = {}) {
    this.#baseDir = options.baseDir ?? process.cwd();
  }

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(ReplayConfigSchema);
    if (!config.record) return;
    const dir = resolve(this.#baseDir, config.dir);
    await mkdir(dir, { recursive: true });
    const writes = new SerialQueue();
    const sub = ctx.subscribe(config.topics);
    ctx.log.info({ dir }, "recording events for replay");
    ctx.spawn("record", async () => {
      for await (const env of sub) {
        const line = formatEntry(env);
        const file = logFileFor(dir, Date.parse(env.at));
        try {
          await writes.run(() => appendFile(file, `${line}\n`, "utf8"));
        } catch (error) {
          ctx.log.warn({ err: errorMessage(error), topic: env.type }, "cannot write a replay line");
        }
      }
    });
  }
}
