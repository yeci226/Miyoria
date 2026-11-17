// `contextKeyString` is the text form of a `ContextKey` (`<platform>:<scope or dm>:<channel>`,
// voice contexts with a `voice:` infix), as used for config keys, settings keys and lanes.
import { type ContextKey, contextKeyString as contextDisplay } from "@miyoria/types";
import { z } from "zod";

/**
 * How much she may talk in a channel: the owner's guardrail (docs/design/autonomy.md §21).
 * `quiet` / `normal` / `lively` are ceilings: she still decides with her own talkativeness, but
 * never above the level's limits (`levels.ts`). In voice contexts the three behave alike (the
 * voice numbers apply).
 */
export type ChannelMode =
  /** Never replies. */
  | "off"
  /** Replies only when directly addressed. */
  | "mention-only"
  /** Replies when addressed; joins in rarely, starts conversations very rarely. */
  | "quiet"
  /** Replies when addressed and sometimes joins in on her own (the old `ambient`). */
  | "normal"
  /** Joins in and starts conversations more readily. */
  | "lively"
  /** Replies to every turn. */
  | "always";

export const CHANNEL_MODES: readonly ChannelMode[] = [
  "off",
  "mention-only",
  "quiet",
  "normal",
  "lively",
  "always",
];

/** Modes that let her join in on her own (the ceiling levels). */
export const AMBIENT_MODES: readonly ChannelMode[] = ["quiet", "normal", "lively"];

export class ParseError extends Error {
  override readonly name = "ParseError";
}

/**
 * Lenient parse (`Mention_Only`, `mention`, ...). The old `ambient` is `normal`. Throws
 * `ParseError`.
 */
export function parseChannelMode(s: string): ChannelMode {
  const v = s.trim().toLowerCase().replaceAll("_", "-");
  switch (v) {
    case "off":
      return "off";
    case "mention-only":
    case "mention":
      return "mention-only";
    case "quiet":
      return "quiet";
    case "normal":
    case "ambient":
      return "normal";
    case "lively":
      return "lively";
    case "always":
      return "always";
    default:
      throw new ParseError(`unknown channel mode \`${v}\``);
  }
}

/** How eagerly she joins conversations she was not addressed in. */
export type Activeness = "low" | "medium" | "high";

export const ACTIVENESS_LEVELS: readonly Activeness[] = ["low", "medium", "high"];

/** Throws `ParseError`. */
export function parseActiveness(s: string): Activeness {
  const v = s.trim().toLowerCase();
  switch (v) {
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    default:
      throw new ParseError(`unknown activeness \`${v}\``);
  }
}

/** A channel mode in config. */
export const ChannelModeSchema = z.enum([
  "off",
  "mention-only",
  "quiet",
  "normal",
  "lively",
  "always",
]) satisfies z.ZodType<ChannelMode>;
export const ActivenessSchema = z.enum(["low", "medium", "high"]);

/**
 * `[modules.agent.voice]`: conversation in voice channels. Voice attention is more
 * conservative than text: she mostly listens and only sometimes chimes in.
 */
export const VoiceConfigSchema = z.object({
  /** Quiet time after an utterance before her turn starts (the speaker may continue). */
  debounce_ms: z.number().int().nonnegative().default(700),
  /** The same when the utterance calls her (her name, a question right after she spoke). */
  direct_debounce_ms: z.number().int().nonnegative().default(400),
  /** The same when a model judged the speaker done (`turn_engine = "smart-turn"`). */
  turn_debounce_ms: z.number().int().nonnegative().default(100),
  /**
   * Upper bound on the debounce of one turn. While someone is speaking the debounce is
   * extended up to this.
   */
  max_debounce_ms: z.number().int().nonnegative().default(2500),
  /**
   * Mode of voice contexts without a `channels` entry or runtime override. `quiet` and `lively`
   * act like `normal` in voice.
   */
  default_mode: ChannelModeSchema.default("normal"),
  /** A question this soon after she spoke counts as addressed to her. */
  question_window_ms: z.number().int().nonnegative().default(8000),
  /** Sentences that have not started playing within this time are dropped. */
  speak_ttl_ms: z.number().int().nonnegative().default(30_000),
  /**
   * While she is in a voice channel, messages typed in its text chat are part of the voice
   * conversation and she answers them by speaking (Discord voice channels have a text chat
   * with the channel's own id).
   */
  text_chat: z.boolean().default(true),
  /**
   * Links and code blocks in her spoken replies are posted to the voice channel's text chat
   * instead of being read out.
   */
  text_aside: z.boolean().default(true),
  /**
   * While she is in a voice channel, what she has to say on her own in that server (task
   * results, game lines, what she says after doing something) is said there instead of being
   * posted to a text channel. Replies to people stay where they were asked.
   */
  keep_in_voice: z.boolean().default(true),
  /**
   * The debounces above count from the person's last sound (the utterance's end), not from when
   * its transcript arrived. The voice node's silence and ASR were already part of that wait: on
   * 2026-11-07 to 11-10 they took about a second, then 400 to 700 ms more were waited for the
   * same question. `false`: count from the transcript, as before.
   */
  debounce_from_speech_end: z.boolean().default(true),
  /**
   * When someone calls her and part of the wait is still left, her turn starts at once: memory,
   * the prompt and the model run while the wait ends; nothing of it is said or done before it
   * does. Someone going on drops it (its work is counted in `agent_voice_speculation_total`) and
   * the merged turn starts over.
   */
  speculate: z.boolean().default(true),
  /** Dropped early starts per voice channel per minute; past that she waits as before. */
  speculate_max_per_min: z.number().int().nonnegative().default(4),
  /**
   * What a voice turn's prompt needs that does not depend on the line she answers is kept per
   * voice channel and read without waiting (`warm_contributors`, her skills, pinned memory, the
   * profiles of the people here), then refreshed in the background for the next turn.
   */
  warm_context: z.boolean().default(true),
  /** Contributors kept warm: their sections may be one turn old (at most `warm_max_age_ms`). */
  warm_contributors: z.array(z.string()).default(["notebook", "just_now", "elsewhere"]),
  /** A warm value older than this is not used. Default 120 000. */
  warm_max_age_ms: z.number().int().positive().default(120_000),
  /**
   * What depends on the line she answers (memory retrieval, the other contributors) is waited
   * for this long in voice, then left out. Default 400 (text waits `contributor_timeout_ms`).
   */
  live_context_ms: z.number().int().nonnegative().default(400),
});
export type VoiceConfig = z.output<typeof VoiceConfigSchema>;

/** `[modules.agent.history]`: context she did not see live. */
export const HistoryConfigSchema = z.object({
  /**
   * When a text session starts cold (after a restart, or a channel idle long enough to be
   * forgotten), fetch up to this many earlier messages (at most `prompt_history`); 0 = off.
   * Without a platform history reader the message log is used.
   */
  backfill: z.number().int().nonnegative().default(20),
  /**
   * Parents of a reply that are not in the history, fetched and quoted before it (0: only the
   * direct parent, when the platform delivered it with the reply).
   */
  reply_chain: z.number().int().nonnegative().default(3),
  /** Lines before a quoted (out-of-view) reply parent shown with it. */
  reply_context_before: z.number().int().nonnegative().default(5),
  /** Lines after a quoted (out-of-view) reply parent shown with it. */
  reply_context_after: z.number().int().nonnegative().default(3),
  /** A turn waits at most this long (from the start of the fetch) for missing context. */
  timeout_ms: z.number().int().nonnegative().default(3000),
});
export type HistoryConfig = z.output<typeof HistoryConfigSchema>;

/**
 * `[modules.agent.vision]`: images she looks at with the chat model (when its model takes
 * images, see `[llm.image_input]`).
 */
export const VisionConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Images per turn. */
  max_images: z.number().int().nonnegative().default(3),
  /** Larger images are skipped. */
  max_image_bytes: z.number().int().nonnegative().default(5_000_000),
  /** All images of one turn together. */
  max_total_bytes: z.number().int().nonnegative().default(10_000_000),
  /** Images the same person sent this long before the message she answers count too. */
  same_author_window_ms: z.number().int().nonnegative().default(120_000),
  /** How closely the model looks (`low` is cheapest). */
  detail: z.enum(["auto", "low", "high"]).default("auto"),
  /** Time limit for downloading one image. */
  download_timeout_ms: z.number().int().nonnegative().default(5000),
  /**
   * Images are only downloaded from these hosts (the platform's CDN and its link preview proxy),
   * over HTTPS.
   */
  allowed_hosts: z
    .array(z.string())
    .default([
      "cdn.discordapp.com",
      "media.discordapp.net",
      "images-ext-1.discordapp.net",
      "images-ext-2.discordapp.net",
    ]),
  /** Downloaded images kept in memory (by attachment id). */
  cache_entries: z.number().int().nonnegative().default(32),
});
export type VisionConfig = z.output<typeof VisionConfigSchema>;

/**
 * `[modules.agent.files]`: files people send her (not images). Reading, limits per person and
 * the size caps belong to the sandbox (`[modules.sandbox.files]`); this only picks the files.
 */
export const FilesConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Files per turn. */
  max_files: z.number().int().nonnegative().default(2),
});
export type FilesConfig = z.output<typeof FilesConfigSchema>;

/**
 * `[modules.agent.prompt]`: the prompt compiler (docs/design/v2-architecture.md §3.5). Every
 * data section has its own budget (characters of its body); over it a section is cut to whole
 * lines (or characters), and when the contributed sections together exceed
 * `mainline.data_chars` the room is shared fairly instead of the last ones dropping.
 */
export const PromptConfigSchema = z.object({
  /** Budget per section key; sections without one get `default_budget`. */
  budgets: z.record(z.string(), z.number().int().nonnegative()).default({
    conversation: 900,
    memory: 1000,
    knowledge: 700,
    lessons: 500,
    world: 500,
    game: 700,
    sing: 400,
    people: 800,
    examples: 2500,
  }),
  default_budget: z.number().int().nonnegative().default(600),
  /** Characters of her document about herself in the pinned block (it is never cut by a section's budget). */
  self_chars: z.number().int().nonnegative().default(2000),
  /**
   * `<style_note>` says in a sentence what her feelings make of her reply now: longer or shorter,
   * whether to react to a message with an emoji (`moodStyleLines`). Nothing is cut in code.
   */
  mood_style: z.boolean().default(true),
  /** Keep a compressed copy of every n-th turn's prompt (`agent.prompt`); 0 = none. */
  save_every: z.number().int().nonnegative().default(1),
  /** Saved prompts kept in memory. */
  saved: z.number().int().nonnegative().default(50),
  /** A saved message is cut to this many characters (head and tail kept). */
  saved_message_chars: z.number().int().nonnegative().default(800),
});
export type PromptConfig = z.output<typeof PromptConfigSchema>;

/**
 * `[modules.agent.mainline]`: the character budgets of the runner's prompt
 * (docs/design/v3-architecture.md §10). The prompt has no token cap (2026-11-08: 4000 left her
 * with no conversation); each part keeps its own character budget, the ones of
 * docs/design/v4-plan.md §4.1: the history sits in the cached prefix, so a long one costs little
 * once the layout keeps that prefix the same from turn to turn.
 */
export const MainLineConfigSchema = z.object({
  /** Her own state in the tail of the prompt. */
  self_chars: z.number().int().nonnegative().default(1600),
  /** What contributors add to the data part, together. */
  data_chars: z.number().int().nonnegative().default(12_000),
  /** Memories retrieved per turn (the memory module's `recall_limit` when 0). */
  memory_lines: z.number().int().nonnegative().default(20),
  /**
   * Example dialogues, before the history (0: none). Which of them she sees turns over from one
   * session to the next and stays the same within one, so the prefix does too.
   */
  // 4000 (2026-11-11): her examples grew to about 2,100 characters; at 2000 some were never shown.
  examples_chars: z.number().int().nonnegative().default(4000),
  /** Lines before the one she answers that retrieval reads too (v4 §5.4: 「好啊」 finds nothing). */
  memory_recent_lines: z.number().int().nonnegative().default(4),
  /**
   * The profiles of the people here (`PersonProfiles`), before the history (v4 §4.1, §5.6): in
   * between changes of who is here the block reads the same and the prefix stays cached.
   */
  // 3600 since the people are `<person/>` tags: the attribute names take room the old lines did not.
  people_chars: z.number().int().nonnegative().default(3600),
  /**
   * 「今天的她」 (`LifeLog.summary`, v4 §6.2), before the history: it changes when she has done
   * something new, a few times a day, not every turn.
   */
  life_chars: z.number().int().nonnegative().default(800),
  /** Her skills, a name and a line each (`SkillIndex`), before the history. */
  skills_chars: z.number().int().nonnegative().default(800),
  /** The index of her notebook (contributor `notebook`), before the history. */
  notebook_chars: z.number().int().nonnegative().default(600),
  /**
   * The server's custom emoji and their meanings (contributor `server_emoji`, Discord), before
   * the history: they change when someone adds or renames one, not every turn.
   */
  emoji_chars: z.number().int().nonnegative().default(1200),
  /** What she did just now, across every place (contributor `just_now`), after the history. */
  just_now_chars: z.number().int().nonnegative().default(1200),
  /** What is going on in the other places she is in (contributor `elsewhere`), after it. */
  elsewhere_chars: z.number().int().nonnegative().default(900),
  /** Untrusted working-context entries in the data part. */
  context_entries: z.number().int().nonnegative().default(4),
  /** A commitment without a date is due this long after she made it. */
  commitment_due_secs: z.number().int().positive().default(120),
  /** How often overdue commitments are looked for. */
  commitment_sweep_ms: z.number().int().positive().default(5_000),
  /** How long one spoken character takes, for what she keeps of a sentence cut off. */
  ms_per_char: z.number().positive().default(180),
});
export type MainLineConfig = z.output<typeof MainLineConfigSchema>;

/**
 * `[modules.agent.work]`: the work lane (docs/design/v4-plan.md §4.3), cut down to what the game
 * director still drives step by step. Her own long tasks are the sub-agents' (`delegate`).
 */
export const WorkConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Tokens all tasks together may spend in a day (UTC), the game director's steps too. */
  daily_tokens: z.number().int().positive().default(600_000),
  /** Her conclusion, as the main line is told it. */
  result_chars: z.number().int().positive().default(1200),
  /** Lines of "what it did" the main line is told. */
  did_lines: z.number().int().positive().default(6),
  /** Ended tasks kept for `work_list` and the panel. */
  keep_ended: z.number().int().nonnegative().default(20),
});
export type WorkConfig = z.output<typeof WorkConfigSchema>;

/**
 * `[modules.agent.delegate]`: the sub-agents of the phase-3 runner (docs/design/v5-brain.md). The
 * per-kind limits are in `packages/brain/self/src/subagents.ts`.
 */
export const DelegateConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Jobs running at once; more wait in the queue. */
  max_running: z.number().int().min(1).max(4).default(2),
  /** Jobs waiting at most; a start past it is refused (she hears so). */
  max_queued: z.number().int().nonnegative().default(4),
  /** What all sub-agents together may spend in a day, from the router's price table (USD). */
  daily_usd: z.number().positive().default(3),
  /** The same cap in tokens, for calls of a model that has no price. */
  daily_tokens: z.number().int().positive().default(9_000_000),
  /** What the nightly reflection may spend in a day (USD). */
  reflect_daily_usd: z.number().positive().default(0.5),
  reflect_daily_tokens: z.number().int().positive().default(1_500_000),
  /** Characters of a job's summary she is told when it ends; the rest is for `delegate_read`. */
  result_chars: z.number().int().positive().default(1500),
  /** Characters one `delegate_read` gives. */
  read_chars: z.number().int().positive().default(8000),
  /** Ended jobs kept for the lists and `delegate_read`. */
  keep_ended: z.number().int().nonnegative().default(20),
});
export type DelegateConfig = z.output<typeof DelegateConfigSchema>;

/**
 * `[modules.agent.corrections]`: the six checks of her output the runner keeps (numbered as in
 * docs/design/v4-patches.md and docs/design/v5-brain.md Q8). Every one is on by default; a switch
 * is for debugging, and turning one off removes only that check, never an outer wall (owner
 * rules, the action gate, the delivery ledger, output moderation, the Floor's limits).
 */
export const CorrectionsConfigSchema = z.object({
  /** #9: a text response that turns out to be her reasoning is dropped (leak.ts `ReplyScreen`). */
  leak_screen: z.boolean().default(true),
  /** #10: a spoken sentence that is her reasoning is not said. */
  leak_screen_spoken: z.boolean().default(true),
  /** #11: `<emo:thinking>…</emo:thinking>` is her reasoning and is never shown. */
  thinking_block: z.boolean().default(true),
  /** #15: someone left waiting gets one fixed line when the run gave them nothing. */
  fallback_line: z.boolean().default(true),
  /** #18: tools written as tags, DeepSeek's tool-call markup and HTML tags are taken out. */
  tag_strip: z.boolean().default(true),
  /**
   * #19: a note to herself about how to answer, in the third person (leak.ts `isSelfTalk`,
   * 2026-11-08 「莎露朵在問我上面訊息寫什麼,直接念給她聽就好。」), is left out of the reply and
   * not said aloud. Only that line: the rest of the reply is hers.
   */
  self_talk: z.boolean().default(true),
});
export type CorrectionsConfig = z.output<typeof CorrectionsConfigSchema>;

/** `[modules.agent]` config section. */
export const AgentConfigSchema = z.object({
  /** Quiet time after the last message before a turn starts. */
  debounce_ms: z.number().int().nonnegative().default(800),
  /** A typing notification pushes the turn start to at least this far out. */
  typing_extend_ms: z.number().int().nonnegative().default(2500),
  /** Upper bound on the total debounce of one turn. */
  max_debounce_ms: z.number().int().nonnegative().default(4000),
  /** Messages kept per conversation context. */
  history_limit: z.number().int().nonnegative().default(240),
  /** Messages of history included in the prompt. */
  prompt_history: z.number().int().nonnegative().default(30),
  /**
   * `@name` of someone in the conversation in her text replies becomes a real mention (on
   * platforms that have them). Role, `@everyone` and `@here` mentions are always removed.
   */
  mention_users: z.boolean().default(true),
  /** Overrides the profile's `behavior.default_channel_mode`. */
  default_mode: ChannelModeSchema.nullable().default(null),
  /**
   * Per-context modes. Keys are matched against the full context key
   * (`discord:<guild>:<channel>`), then `<platform>:<guild>`, then the bare channel id.
   */
  channels: z.record(z.string(), ChannelModeSchema).default({}),
  /** Overrides the profile's `behavior.initiative`. */
  default_activeness: ActivenessSchema.nullable().default(null),
  /** Per-context activeness, keyed like `channels`. */
  activeness: z.record(z.string(), ActivenessSchema).default({}),
  /** Treat messages from other bots as input (they are always recorded). */
  respond_to_bots: z.boolean().default(false),
  /** Reply messages are dropped if not sent within this time. */
  reply_ttl_ms: z.number().int().nonnegative().default(120_000),
  /** Longer replies are split into several messages. */
  max_message_chars: z.number().int().nonnegative().default(1900),
  /**
   * Send replies to someone who called her as platform replies quoting the first message she
   * answers (the turn's focus).
   */
  reply_reference: z.boolean().default(true),
  /**
   * Text: several people calling her at once get a turn each, in the order they called, instead
   * of one turn answering them all (where the answers mixed and read as said to the first).
   */
  one_caller_per_turn: z.boolean().default(true),
  /** The typing indicator is resubmitted this often while generating. */
  typing_refresh_ms: z.number().int().nonnegative().default(8000),
  /** The main line. */
  mainline: MainLineConfigSchema.prefault({}),
  /** The work lane (v4 §4.3). */
  work: WorkConfigSchema.prefault({}),
  /** The sub-agents. */
  delegate: DelegateConfigSchema.prefault({}),
  /** The after-the-fact corrections that may be switched off once measured (v4 §4.5). */
  corrections: CorrectionsConfigSchema.prefault({}),
  temperature: z.number().nullable().default(null),
  max_tokens: z.number().int().nonnegative().nullable().default(null),
  /** A context with no activity for this long forgets its session. */
  session_idle_ms: z
    .number()
    .int()
    .nonnegative()
    .default(6 * 3600 * 1000),
  /** Time limit for each prompt contributor; slower ones are skipped. */
  contributor_timeout_ms: z.number().int().nonnegative().default(800),
  voice: VoiceConfigSchema.prefault({}),
  history: HistoryConfigSchema.prefault({}),
  vision: VisionConfigSchema.prefault({}),
  files: FilesConfigSchema.prefault({}),
  prompt: PromptConfigSchema.prefault({}),
});
export type AgentConfig = z.output<typeof AgentConfigSchema>;

/** The defaults: the schema parsed from an empty config. */
export function defaultAgentConfig(): AgentConfig {
  return AgentConfigSchema.parse({});
}

export function maxDebounceMs(config: AgentConfig): number {
  return Math.max(config.max_debounce_ms, config.debounce_ms);
}

export function typingRefreshMs(config: AgentConfig): number {
  return Math.max(config.typing_refresh_ms, 1000);
}

export function voiceMaxDebounceMs(voice: VoiceConfig): number {
  return Math.max(voice.max_debounce_ms, voice.debounce_ms);
}

/**
 * Mode for `context`, falling back to `default_mode`, then `profileDefault`. Voice contexts
 * fall back to `voice.default_mode` instead.
 */
export function modeFor(
  config: AgentConfig,
  context: ContextKey,
  profileDefault: ChannelMode,
): ChannelMode {
  const configured = lookup(config.channels, context);
  if (context.kind === "voice") return configured ?? config.voice.default_mode;
  return configured ?? config.default_mode ?? profileDefault;
}

/** Activeness for `context`, falling back to `default_activeness`, then `profileDefault`. */
export function activenessFor(
  config: AgentConfig,
  context: ContextKey,
  profileDefault: Activeness,
): Activeness {
  return lookup(config.activeness, context) ?? config.default_activeness ?? profileDefault;
}

function own<T>(map: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

/** Full context key, then `<platform>:<guild>`, then the bare channel id. */
function lookup<T>(map: Readonly<Record<string, T>>, context: ContextKey): T | undefined {
  if (Object.keys(map).length === 0) return undefined;
  const full = own(map, contextDisplay(context));
  if (full !== undefined) return full;
  if (context.scope !== null) {
    const scoped = own(map, `${context.platform}:${context.scope}`);
    if (scoped !== undefined) return scoped;
  }
  return own(map, context.channel);
}
