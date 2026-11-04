import { z } from "zod";

const QUIET = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;

/**
 * `[modules.share]`: she scrolls Threads on her own and shares what the people in a channel would
 * care about. Off unless `enabled = true`. The Threads extension provides the browser.
 *
 * ```toml
 * [modules.share]
 * enabled = true
 * max_per_day = 3
 * ```
 */
export const ShareConfigSchema = z.object({
  /** `anytime`: as soon as she found something; `active`: waits until a channel is talking. */
  when: z.enum(["anytime", "active"]).default("anytime"),
  /** Posts shared a day. */
  max_per_day: z.number().int().nonnegative().default(3),
  /** Between two posts; she does not scroll during it either. */
  min_gap_mins: z.number().nonnegative().default(120),
  /** Rounds of scrolling a day. */
  browse_per_day: z.number().int().nonnegative().default(6),
  /** Between two rounds, so they spread over the day. */
  browse_gap_mins: z.number().nonnegative().default(120),
  /** Posts read in a round. */
  posts: z.number().int().positive().default(10),
  /** `HH:MM-HH:MM`, local time, may cross midnight: no scrolling, no posts. Empty: never. */
  quiet_hours: z
    .string()
    .refine((v) => v === "" || QUIET.test(v), "expected HH:MM-HH:MM")
    .default("01:00-08:00"),
  /** Channel ids she may post in; empty: she picks among the channels with recent activity. */
  channels: z.array(z.string()).default([]),
  /** Channel ids she never posts in. */
  exclude: z.array(z.string()).default([]),
  /** `when = "active"`: how long a post waits for a channel. */
  keep_hours: z.number().positive().default(24),
});
export type ShareConfig = z.output<typeof ShareConfigSchema>;
