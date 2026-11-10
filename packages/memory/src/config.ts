// Configuration: `[modules.memory]` (module settings) and the top-level `[memory.embedding]`
// section (passed in by the app, like `[llm]`).

import { z } from "zod";

const uint = () => z.number().int().min(0);

/** Hybrid retrieval weights. */
export const WeightsSchema = z.object({
  vector: z.number().default(0.35),
  text: z.number().default(0.25),
  recency: z.number().default(0.15),
  importance: z.number().default(0.15),
  /** Bonus when the memory is about someone present. */
  subject: z.number().default(0.1),
});
export type Weights = z.output<typeof WeightsSchema>;

/**
 * Where episodes and facts learned in guild channels live: `guild` (shared across the whole
 * guild / server) or `channel` (only where it was learned).
 */
export const GuildScopeSchema = z.enum(["guild", "channel"]);
export type GuildScope = z.output<typeof GuildScopeSchema>;

export const DedupeConfigSchema = z.object({
  /** Cosine similarity at which a new memory supersedes an existing one. */
  vector_similarity: z.number().default(0.9),
  /**
   * Character-bigram similarity of normalized text at which a new memory is the same as an
   * existing one (reinforced in place).
   */
  text_similarity: z.number().default(0.85),
  /** Confidence added when a fact is learned again. */
  reinforce: z.number().default(0.1),
});
export type DedupeConfig = z.output<typeof DedupeConfigSchema>;

/**
 * Down-weighting of a gag she keeps recalling: when memories saying (nearly) the same thing
 * were recalled more than `allowed` times in the last `window` recalled items, the next one
 * scores `penalty` less per extra time (never below `floor` of its score).
 */
export const RepeatConfigSchema = z.object({
  /** Recalled items remembered (0 turns the down-weighting off). */
  window: uint().default(40),
  /** Times the same thing may appear in the window before it is down-weighted. */
  allowed: uint().default(3),
  /** Score lost per extra appearance (fraction of the score). */
  penalty: z.number().min(0).max(1).default(0.15),
  /** Lowest factor applied. */
  floor: z.number().min(0).max(1).default(0.4),
  /** Share of the smaller token set that two memories must have in common to be the same thing. */
  similarity: z.number().min(0).max(1).default(0.6),
});
export type RepeatConfig = z.output<typeof RepeatConfigSchema>;

/** Daily maintenance: pruning episodes and decaying unreinforced facts. */
export const ForgettingConfigSchema = z.object({
  enabled: z.boolean().default(true),
  interval_hours: uint().default(24),
  /** Episodes older than this ... */
  episode_max_age_days: z.number().int().default(30),
  /** ... with importance at most this ... */
  episode_max_importance: z.number().default(0.3),
  /** ... and not recalled for this long are deleted. */
  episode_not_accessed_days: z.number().int().default(14),
  /** Facts not reinforced for this long lose confidence ... */
  decay_after_days: z.number().int().default(30),
  /** ... multiplied by this per day ... */
  decay_per_day: z.number().default(0.98),
  /** ... and are deleted below this confidence. */
  forget_below_confidence: z.number().default(0.1),
});
export type ForgettingConfig = z.output<typeof ForgettingConfigSchema>;

/**
 * The pinned layer: what is in every prompt without being looked up. Each section is cut to its
 * own cap, and `max_chars` caps the whole; a source that is too long is truncated, never
 * allowed to push the others out.
 */
export const PinnedConfigSchema = z.object({
  /** Characters over every pinned line. */
  max_chars: uint().default(1200),
  /**
   * Characters of the persona section; 0 leaves it out (the default). Only the main line reads the
   * pinned layer, and its prompt already holds the whole persona, so a pinned copy only took up to
   * 500 of the `max_chars` from the rules, the open commitments and the people.
   */
  persona_chars: uint().default(0),
  /** Characters of the rules section. */
  rules_chars: uint().default(400),
  /** Open commitments listed (the soonest first). */
  max_commitments: uint().default(4),
  /** Characters of one commitment line. */
  commitment_chars: uint().default(80),
  /** People with a line (the ones listed first in the request). */
  max_people: uint().default(6),
  /** Characters of one person's line. */
  person_chars: uint().default(120),
  /** Facts joined into one person's line, the most reliable first. */
  person_facts: uint().default(3),
  /** Seconds a person's line is reused before it is composed again (writes and forgets reset it). */
  cache_secs: uint().default(30),
});
export type PinnedConfig = z.output<typeof PinnedConfigSchema>;

/**
 * Evidence for person facts: a fact is stored only when a line that was really said backs it.
 * The check is lexical (no model): the fact has to share words with the line.
 */
export const EvidenceConfigSchema = z.object({
  /** Share of the fact's content words one supporting line must contain (0..1). */
  min_overlap: z.number().min(0).max(1).default(0.25),
  /** Evidence ids kept on one memory. */
  max_events: uint().default(24),
  /** Seconds either side of a chat line's time within which its EventLog event is looked for. */
  match_window_secs: uint().default(10),
});
export type EvidenceConfig = z.output<typeof EvidenceConfigSchema>;

/**
 * `[modules.memory]`.
 *
 * ```toml
 * [modules.memory]
 * consolidate_idle_secs = 300
 * consolidate_every_messages = 40
 * recall_limit = 8
 *
 * [modules.memory.weights]
 * vector = 0.35
 * text = 0.25
 * ```
 */
export const MemoryConfigSchema = z.object({
  /** Consolidate a context after it has been quiet this long. */
  consolidate_idle_secs: uint().default(300),
  /** ... or as soon as this many new lines arrived since the last watermark. */
  consolidate_every_messages: uint().default(40),
  /** How often the background task checks contexts. */
  tick_secs: uint().default(15),
  /** At most this many log lines go into one consolidation. */
  max_lines_per_batch: uint().default(200),
  /** Wait this long before retrying a context whose consolidation failed. */
  retry_secs: uint().default(120),
  /** LLM purpose used for consolidation. */
  purpose: z.string().default("summarizer"),
  /** How her own lines are labelled in the transcript given to the summarizer. */
  self_label: z.string().default("我"),
  /** Offset of local time used in transcripts (minutes east of UTC). */
  utc_offset_minutes: z
    .number()
    .int()
    .default(8 * 60),
  /** Memories recalled into the prompt per turn. */
  recall_limit: uint().default(8),
  /** Candidates fetched from the store per kind of match before ranking. */
  candidate_limit: uint().default(32),
  /**
   * Records scoring below this are never recalled. Was 0.05, which let almost anything in and
   * kept the same old memories on top; about 0.25 needs a real match or real importance.
   */
  min_score: z.number().default(0.25),
  /**
   * A memory has to be about what is being said: a word in common with the query, or an
   * embedding at least this similar. Being about someone who is present, or being one of the
   * nearest neighbours of a query it has nothing to do with, is not enough.
   */
  min_vector: z.number().default(0.3),
  weights: WeightsSchema.prefault({}),
  /** Recency decay time constant (days): `exp(-age / tau)`. */
  recency_tau_days: z.number().default(14),
  /**
   * The same for episodes ("what happened last night"): hours to days, not weeks. 1.5 days
   * halves an episode's recency weight in about a day.
   */
  episode_recency_tau_days: z.number().default(1.5),
  /**
   * How long a present-tense state or commitment note ("已經開台", "正在下載") stays true when
   * the summarizer gave no lifetime (hours; 0 = no expiry). Expired notes are not recalled.
   */
  state_note_hours: z.number().min(0).default(12),
  /**
   * Followups nobody brought up within this many hours of their time are closed and no longer
   * offered (0 = never).
   */
  followup_max_age_hours: z.number().min(0).default(6),
  repeat: RepeatConfigSchema.prefault({}),
  guild_scope: GuildScopeSchema.default("guild"),
  /**
   * Lets facts marked `global` in a DM become person-wide. Off by default: nothing learned in
   * a DM leaves that DM.
   */
  allow_global_from_dm: z.boolean().default(false),
  /** Extracted items below this importance are dropped as trivia. */
  min_importance: z.number().default(0.1),
  dedupe: DedupeConfigSchema.prefault({}),
  forgetting: ForgettingConfigSchema.prefault({}),
  pinned: PinnedConfigSchema.prefault({}),
  evidence: EvidenceConfigSchema.prefault({}),
  /**
   * Weight (0..1) of a memory of unknown provenance (written before origins were recorded)
   * against one with evidence. They stay usable, just never as sure as a memory with a source.
   */
  unknown_origin_factor: z.number().min(0).max(1).default(0.8),
});
export type MemoryConfig = z.output<typeof MemoryConfigSchema>;

/** `MemoryConfig` with defaults, optionally overriding some fields (tests, embedding apps). */
export function memoryConfig(overrides: z.input<typeof MemoryConfigSchema> = {}): MemoryConfig {
  return MemoryConfigSchema.parse(overrides);
}

/**
 * Top-level `[memory.embedding]`. Embeddings are optional; without them retrieval uses full
 * text, recency and importance only.
 *
 * ```toml
 * [memory.embedding]
 * provider = "openai-compatible"
 * base_url = "http://localhost:11434/v1"
 * model = "bge-m3"
 * ```
 */
export const EmbeddingConfigSchema = z.object({
  /** `"none"` (default) or `"openai-compatible"`. */
  provider: z.string().default("none"),
  /** API root, e.g. `https://api.openai.com/v1`; `/embeddings` is appended. */
  base_url: z.string().default(""),
  api_key: z.string().nullable().default(null),
  model: z.string().default(""),
  /** Requested output size, for models that support it. */
  dimensions: uint().nullable().default(null),
  timeout_secs: uint().default(10),
  /** Texts per request. */
  batch_size: uint().default(32),
});
export type EmbeddingConfig = z.output<typeof EmbeddingConfigSchema>;

/** `EmbeddingConfig` with defaults, optionally overriding some fields. */
export function embeddingConfig(
  overrides: z.input<typeof EmbeddingConfigSchema> = {},
): EmbeddingConfig {
  return EmbeddingConfigSchema.parse(overrides);
}
