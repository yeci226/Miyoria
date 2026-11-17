import { z } from "zod";

/**
 * Permission nodes checked by the queue commands. Phase-1 permissions only distinguish
 * `owner.` / `admin.` prefixes, so deployments that do not want every user to manage the queue
 * should set e.g. `manage = "admin.queue.manage"`.
 */
export const QueuePermissionsSchema = z.object({
  request: z.string().default("queue.request"),
  manage: z.string().default("queue.manage"),
  vote: z.string().default("queue.vote"),
});

/**
 * `[modules.queue]` config section.
 *
 * ```toml
 * [modules.queue]
 * max_pending_per_user = 2
 * affinity_weight = 1.0
 * ```
 */
export const QueueConfigSchema = z.object({
  /** Pending requests one account may have at the same time. */
  max_pending_per_user: z.number().default(2),
  /** Pending requests in total. */
  max_pending: z.number().default(100),
  /** Longest accepted request text, in characters. */
  max_text_chars: z.number().default(200),
  /** Finished items kept for `history`. */
  history_limit: z.number().default(50),
  /** Weight points per 10 affinity points (affinity is -100..100). */
  affinity_weight: z.number().default(1.0),
  /** Weight points per upvote. */
  vote_weight: z.number().default(1.0),
  /** Most options in a vote. */
  max_vote_options: z.number().default(10),
  /** Longest vote, in seconds. */
  max_vote_seconds: z.number().default(3600),
  /** Enqueue the winning option as an item (kind `vote`) when a vote ends. */
  vote_enqueue_winner: z.boolean().default(true),
  /** Priority of the enqueued winner. */
  vote_winner_priority: z.number().default(100),
  /** Snapshot delay after the last change, in milliseconds. */
  persist_debounce_ms: z.number().default(500),
  /** How often the run loop checks for expired votes, in milliseconds. */
  tick_ms: z.number().default(250),
  permissions: QueuePermissionsSchema.prefault({}),
});
export type QueueConfig = z.output<typeof QueueConfigSchema>;
