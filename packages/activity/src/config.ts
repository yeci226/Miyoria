import { z } from "zod";

/** `[modules.activity]`. Durations in ms. */
export const ActivityConfigSchema = z.object({
  /** How long Go Live may take to report `live` before the broadcast fails (`timeout`). */
  golive_timeout_ms: z.number().int().positive().default(60_000),
  /**
   * OBS streaming is the second sub-step of the broadcast while a stage node is connected (it
   * follows Go Live, through the gate). Off: Go Live only.
   */
  obs: z.boolean().default(true),
  /**
   * Wait this long after Go Live is up before pressing OBS "Start Streaming" (the voice node's
   * ffmpeg binds its listener first).
   */
  obs_start_delay_ms: z.number().int().nonnegative().default(3_000),
  /** OBS start attempts before the broadcast fails (and Go Live is stopped again). */
  obs_attempts: z.number().int().positive().default(3),
  /** How long a join / leave may take to be confirmed by the voice node. */
  voice_timeout_ms: z.number().int().positive().default(20_000),
  /** Leaving waits for the turn that asked to finish speaking, at most this long. */
  speech_wait_ms: z.number().int().nonnegative().default(30_000),
  /** How long a game may take to start (the launch and world load included). */
  game_timeout_ms: z.number().int().positive().default(300_000),
  /** A failed activity stays visible (`failed(reason)`) this long, or until the next request. */
  failed_hold_ms: z.number().int().nonnegative().default(120_000),
  /** How long a notice stays worth telling her. */
  notice_ttl_ms: z.number().int().positive().default(600_000),
  /** How long a game the last run left open may take to be reachable again before it counts as closed. */
  restore_grace_ms: z.number().int().positive().default(180_000),
  /** How often such a game is looked for. */
  restore_poll_ms: z.number().int().positive().default(5_000),
  /** How long an executor may take to accept a steer (a change of a running task's goal). */
  steer_timeout_ms: z.number().int().positive().default(10_000),
  /** Ended tasks remembered (`tasks()`, `task(id)`). */
  task_history: z.number().int().positive().default(50),
});

export type ActivityConfig = z.output<typeof ActivityConfigSchema>;

export function defaultActivityConfig(): ActivityConfig {
  return ActivityConfigSchema.parse({});
}
