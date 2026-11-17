import { z } from "zod";

/** `[modules.scheduler]` config section. Every field has a default. */
export const SchedulerConfigSchema = z.object({
  /** A lane worker with nothing queued exits after this long. */
  lane_idle_ms: z.number().int().min(0).default(60_000),
  /** A single action that takes longer than this fails with `timed out`. */
  execute_timeout_ms: z.number().int().min(0).default(30_000),
  /** Timeout for `speak` actions, which last as long as the playback. */
  speak_timeout_ms: z.number().int().min(0).default(120_000),
});

export type SchedulerConfig = z.output<typeof SchedulerConfigSchema>;
