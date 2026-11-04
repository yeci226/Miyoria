// Config of the three modules. Only caps and plumbing: what she notes down, how she structures
// it and what she learns are hers; the numbers bound the cost, the size and the noise.

import { z } from "zod";

const count = () => z.number().int().nonnegative();

/**
 * `[modules.conversation]`: continuous conversation compaction.
 *
 * ```toml
 * [modules.conversation]
 * fold_every_messages = 16
 * fold_idle_secs = 90
 * ```
 */
export const ConversationConfigSchema = z.object({
  /** LLM purpose of a fold (thinking on via `[llm.thinking]`). */
  purpose: z.string().default("summarizer"),
  /** Fold as soon as this many new lines arrived in a context ... */
  fold_every_messages: count().default(16),
  /** ... or once the conversation paused this long with at least `min_lines` new lines. */
  fold_idle_secs: count().default(90),
  min_lines: count().default(4),
  /** At most this many lines go into one fold (older unfolded lines wait for the next). */
  max_lines_per_fold: count().default(60),
  /** Caps over all contexts. */
  max_calls_per_hour: count().default(40),
  max_calls_per_day: count().default(400),
  /** At least this long between two folds of one context. */
  min_interval_secs: count().default(30),
  /** Size of her notes (compact JSON characters) and of the recap. */
  max_notes_chars: count().default(2500),
  max_recap_chars: count().default(500),
  /** States kept (least recently updated dropped). */
  max_states: count().default(300),
  /** A context counts as one session until it is quiet this long. */
  session_gap_mins: count().default(30),
  /** How often contexts are checked. */
  tick_secs: z.number().positive().default(5),
  timeout_ms: count().default(60_000),
  /**
   * Budget of one fold reply. It has to hold the whole JSON (notes + recap + documents, Chinese
   * runs about a token per character) plus her thinking; 2000 cut most folds off mid-JSON.
   */
  max_tokens: count().default(6000),
  /** Characters of the state in a turn's prompt. */
  prompt_chars: count().default(1500),
  /**
   * A thread of her notes (an open question, a plan, a topic) nobody touched for this long is
   * stale: turns no longer see it and the next fold is asked to drop it if it is over (0 = never).
   */
  stale_thread_mins: count().default(30),
  /** Offset of local time in transcripts (minutes east of UTC). */
  utc_offset_minutes: z
    .number()
    .int()
    .default(8 * 60),
  /** Let folds propose knowledge changes and feedback (in the same call). */
  knowledge: z.boolean().default(true),
});
export type ConversationConfig = z.output<typeof ConversationConfigSchema>;

/**
 * `[modules.knowledge]`: her self-organized documents. Only the envelope is bounded.
 */
export const KnowledgeConfigSchema = z.object({
  max_docs: count().default(400),
  max_docs_per_subject: count().default(12),
  /** Compact JSON characters of one document's content. */
  max_doc_chars: count().default(6000),
  /** All documents of one subject together. */
  max_subject_chars: count().default(16_000),
  /** One text value (free-form rich text, Markdown allowed), one key. */
  max_field_chars: count().default(1200),
  max_key_chars: count().default(64),
  max_depth: z.number().int().min(2).default(6),
  max_keys: count().default(40),
  max_array: count().default(50),
  /** Versions kept per document. */
  history_keep: count().default(10),
  /** Characters of documents in a turn's prompt. */
  prompt_chars: count().default(1800),
  /** What someone says about another person (or a server, a topic) is at most this certain. */
  said_confidence: z.number().min(0).max(1).default(0.6),
  /** Offer the tool `knowledge_note` in turns. */
  tool: z.boolean().default(true),
});
export type KnowledgeConfig = z.output<typeof KnowledgeConfigSchema>;

/**
 * `[modules.reflect]`: feedback signals, lessons and her reflections.
 *
 * ```toml
 * [modules.reflect]
 * daily_hour = 5
 * max_calls_per_day = 6
 * ```
 */
export const ReflectConfigSchema = z.object({
  /** LLM purpose of a reflection (thinking on). */
  purpose: z.string().default("summarizer"),
  /** Her local time zone (minutes east of UTC). */
  utc_offset_minutes: z
    .number()
    .int()
    .default(8 * 60),
  /** The daily reflection runs once a day in a quiet moment from this local hour on ... */
  daily_hour: z.number().int().min(0).max(23).default(5),
  /** ... when nobody talked for this long (or by `daily_hour + 6` at the latest). */
  quiet_mins: count().default(20),
  /** A lighter reflection after a session of at least this many lines went quiet. */
  light_after_lines: count().default(80),
  light_quiet_mins: count().default(10),
  max_calls_per_day: count().default(6),
  min_interval_mins: count().default(30),
  timeout_ms: count().default(120_000),
  max_tokens: count().default(4000),
  /** Memories reviewed by the daily reflection. */
  max_notes: count().default(60),
  /**
   * Lessons kept (oldest dropped), their default and longest lifetime (days). Kept short: a
   * month of "be quieter" lessons from a few bad evenings silenced her everywhere.
   */
  max_lessons: count().default(25),
  lesson_days: count().default(7),
  max_lesson_days: count().default(14),
  /** Long-term goals added per reflection, and how long they stay on her agenda. */
  max_goals: count().default(2),
  goal_days: count().default(3),
  /** Reflections kept for the panel. */
  runs_keep: count().default(60),
  /** Feedback: a reply within this long counts as an answer to her. */
  reply_window_mins: count().default(10),
  /** Days of feedback kept. */
  feedback_days: count().default(14),
  /** Characters of lessons in a turn's prompt. */
  prompt_chars: count().default(600),
});
export type ReflectConfig = z.output<typeof ReflectConfigSchema>;

export function conversationConfig(o: z.input<typeof ConversationConfigSchema> = {}) {
  return ConversationConfigSchema.parse(o);
}
export function knowledgeConfig(o: z.input<typeof KnowledgeConfigSchema> = {}) {
  return KnowledgeConfigSchema.parse(o);
}
export function reflectConfig(o: z.input<typeof ReflectConfigSchema> = {}) {
  return ReflectConfigSchema.parse(o);
}
