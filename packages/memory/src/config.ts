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
 * What she can see of the last hours across every place (v4 §5.2, §5.3): the "just now"
 * timeline, the other places she is in and her questions to people. Read from the EventLog, so a
 * restart loses none of it.
 */
export const RecentConfigSchema = z.object({
  /** Hours of the log looked at. */
  hours: z.number().min(0).default(6),
  /** Newest events read from the log per pass (the rest is too old to matter). */
  max_events: uint().default(3000),
  /** Seconds one read of the log is reused (the voice hot path asks every turn). */
  cache_secs: uint().default(10),
  /** Register the prompt contributors `just_now` and `elsewhere`. */
  contributors: z.boolean().default(true),
  /** Characters of the timeline in a prompt. */
  just_now_chars: uint().default(1200),
  /** Exchanges with people (someone talked to her, she answered) kept in the timeline. */
  talk_entries: uint().default(6),
  /** Characters of one quoted line inside an entry. */
  quote_chars: uint().default(60),
  /** Minutes within which the same state (who is in voice) is written once. */
  coalesce_mins: uint().default(10),
  /** A place counts as active elsewhere when something was said there this recently. */
  elsewhere_mins: uint().default(30),
  /** Other places summarized. */
  elsewhere_places: uint().default(3),
  /** Last lines quoted per place. */
  elsewhere_lines: uint().default(3),
  /** Characters of the recap of one place. */
  elsewhere_recap_chars: uint().default(240),
  /** Characters of the whole summary in a prompt. */
  elsewhere_chars: uint().default(900),
  /** Hours within which her questions to a person are grouped and counted. */
  question_hours: z.number().min(0).default(24),
  /** Hours after a question within which the person speaking to her counts as the answer. */
  answer_hours: z.number().min(0).default(12),
  /**
   * Channel ids (text or voice) whose content never shows anywhere else: places not everyone in
   * the guild can see, until a platform provides `PlaceAccess`.
   */
  hidden_channels: z.array(z.string()).default([]),
});
export type RecentConfig = z.output<typeof RecentConfigSchema>;

/** Person profiles (v4 §5.6): one block per person present, every source read once. */
export const ProfilesConfigSchema = z.object({
  /** People with a profile, the ones she is talking with first. */
  max_people: uint().default(6),
  /** Characters of one person's profile. */
  person_chars: uint().default(360),
  /** Things she holds about them (facts, then her documents), retrieved ones left out. */
  points: uint().default(5),
  /** Minutes of silence that end a stretch of talk ("last seen" is before the current one). */
  session_gap_mins: uint().default(30),
  /** Characters of the last topic. */
  topic_chars: uint().default(80),
});
export type ProfilesConfig = z.output<typeof ProfilesConfigSchema>;

/** Her notebook (v4 §5.5): pages she writes and reads with tools. */
export const NotebookConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Pages kept (a write past it is refused: she has to tidy up first). */
  max_pages: uint().default(300),
  /** Characters of one page. */
  page_chars: uint().default(4000),
  /** Characters of a path (`人/Owen`, `主題/Minecraft 建築`). */
  path_chars: uint().default(60),
  /** Characters one read returns (longer pages are read in parts). */
  read_chars: uint().default(2000),
  /** Writes per hour, all pages together. */
  writes_per_hour: uint().default(30),
  /** Characters of the page index in a prompt. */
  index_chars: uint().default(600),
});
export type NotebookConfig = z.output<typeof NotebookConfigSchema>;

/**
 * `[modules.memory.dates]`: birthdays and other dates people tell her (`remember_date`), and the
 * day she met them; on the day, the first time they speak she gets a followup to bring it up.
 */
export const DatesConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Her calendar's offset from UTC (minutes; 480 = Taiwan). */
  utc_offset_minutes: z.number().int().min(-840).max(840).default(480),
  /** The yearly day she first met someone counts too (from the first anniversary on). */
  met_anniversary: z.boolean().default(true),
});
export type DatesConfig = z.output<typeof DatesConfigSchema>;

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
  /**
   * Weight of the lines before the one being answered against the line itself (0..1): a reply
   * like "好啊" shares no word with anything, the talk around it does (v4 §5.4).
   */
  context_weight: z.number().min(0).max(1).default(0.6),
  /**
   * Memories about a person she is talking with, or named in the talk, that may come back
   * without a shared word (their most important ones, still above `min_score`). 2026-11-10:
   * someone answering "好啊" got none of what she knew about them.
   */
  person_points: uint().default(2),
  /** ... only those at least this important. */
  person_point_importance: z.number().min(0).max(1).default(0.5),
  recent: RecentConfigSchema.prefault({}),
  profiles: ProfilesConfigSchema.prefault({}),
  notebook: NotebookConfigSchema.prefault({}),
  dates: DatesConfigSchema.prefault({}),
});
export type MemoryConfig = z.output<typeof MemoryConfigSchema>;

/** `MemoryConfig` with defaults, optionally overriding some fields (tests, embedding apps). */
export function memoryConfig(overrides: z.input<typeof MemoryConfigSchema> = {}): MemoryConfig {
  return MemoryConfigSchema.parse(overrides);
}

/** The model `provider = "local"` uses when `model` is empty: small, multilingual, CPU-friendly. */
export const DEFAULT_LOCAL_MODEL = "Xenova/multilingual-e5-small";

/**
 * Top-level `[memory.embedding]`. Embeddings are optional; without them retrieval uses full
 * text, recency and importance only.
 *
 * `provider = "local"` is the owner's choice (v4 §16 row 5: members' words do not leave this
 * machine): a small multilingual model on the CPU, in a worker thread, through the ONNX runtime
 * of `@huggingface/transformers` (installed separately; see `local-embed.ts`).
 *
 * ```toml
 * [memory.embedding]
 * provider = "local"                      # model = "Xenova/multilingual-e5-small" by default
 *
 * # or a server that speaks the OpenAI format
 * provider = "openai-compatible"
 * base_url = "http://localhost:11434/v1"
 * model = "bge-m3"
 * ```
 */
export const EmbeddingConfigSchema = z.object({
  /** `"none"` (default), `"local"` or `"openai-compatible"`. */
  provider: z.string().default("none"),
  /** `local`: the module that runs the model (resolved from this package, or a `file:` URL). */
  runtime: z.string().default("@huggingface/transformers"),
  /** `local`: where model files are kept (empty: the runtime's own cache). */
  models_dir: z.string().default(""),
  /** `local`: fetch the model files once when they are not there (only the model comes in). */
  allow_download: z.boolean().default(true),
  /** `local`: weight type (`q8` is about a quarter of `fp32` and close enough). */
  dtype: z.string().default("q8"),
  /** `local`: CPU threads of the worker (keep it off the cores voice needs). */
  threads: uint().default(2),
  /** Prepended to texts searched for (e5 models: `query: `). Default by model for `local`. */
  query_prefix: z.string().nullable().default(null),
  /** Prepended to texts stored (e5 models: `passage: `). Default by model for `local`. */
  passage_prefix: z.string().nullable().default(null),
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
