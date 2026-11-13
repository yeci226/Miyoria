// `contextKeyString` is Rust `ContextKey`'s `Display` (`<platform>:<scope or dm>:<channel>`,
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
    case "normal":
      return "medium";
    case "high":
      return "high";
    default:
      throw new ParseError(`unknown activeness \`${v}\``);
  }
}

/** A channel mode in config; also accepts the old `ambient` (= `normal`). */
export const ChannelModeSchema = z
  .enum(["off", "mention-only", "quiet", "normal", "lively", "always", "ambient"])
  .transform((v): ChannelMode => (v === "ambient" ? "normal" : v));
export const ActivenessSchema = z.enum(["low", "medium", "high"]);

/**
 * `[modules.agent.attention]`: when she replies. Only the prefilter, the score thresholds, the
 * share cap and the gray-zone check: cooldowns and the other multipliers are gone (see
 * `DEPRECATED_AGENT_KEYS`).
 */
export const AttentionConfigSchema = z.object({
  /** Window (in messages) for the anti-spam share check. */
  recent_window: z.number().int().nonnegative().default(20),
  /** Overrides the profile's `behavior.max_share_of_recent`. */
  max_share_of_recent: z.number().nullable().default(null),
  /** Topics that make a message more interesting to her. */
  keywords: z.array(z.string()).default([]),
  /** Ambient turns scoring below this are ignored. */
  gray_low: z.number().default(0.3),
  /** Ambient turns scoring at least this skip the LLM check. */
  gray_high: z.number().default(0.6),
  /** Reply probability when directly addressed. */
  direct_probability: z.number().default(1.0),
  /** Ask the `fast` model about gray-zone ambient turns. */
  llm_check: z.boolean().default(true),
  llm_check_timeout_ms: z.number().int().nonnegative().default(8000),
  /** Reply probability after the LLM check said yes. */
  llm_yes_probability: z.number().default(0.9),
  /**
   * Lowest talkativeness lessons and moods can push her to (her own setting of exactly 0 still
   * silences her). Someone answering what she just said is never shut out by it either way.
   */
  talk_floor: z.number().min(0).max(1).default(0.15),
});
export type AttentionConfig = z.output<typeof AttentionConfigSchema>;

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
  /** Her maximum share of recent voice history for ambient turns. */
  max_share_of_recent: z.number().default(0.2),
  /** A question this soon after she spoke counts as addressed to her. */
  question_window_ms: z.number().int().nonnegative().default(8000),
  /**
   * Below this salience an ambient voice turn is ignored (text uses `attention.gray_low`).
   * Lower than in text: spoken chatter rarely carries the cues that raise the score.
   */
  gray_low: z.number().default(0.15),
  /** Ask the `fast` model about gray-zone ambient voice turns (adds latency). */
  llm_check: z.boolean().default(false),
  /** Sentences that have not started playing within this time are dropped. */
  speak_ttl_ms: z.number().int().nonnegative().default(30_000),
  /**
   * Bilingual voice (she is heard in another language than she writes): she writes each
   * `<voice>` line first and it goes to TTS as soon as it is complete; the written sentence
   * after it becomes the subtitle and her history line (`agent.subtitle`). `false`: a line
   * waits for its written sentence and both go out together.
   */
  voice_first: z.boolean().default(true),
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
   * Also post what she said (the written text, so Chinese when she speaks Japanese through
   * `tts_translate`) to the voice channel's text chat, after each spoken reply.
   */
  text_echo: z.boolean().default(false),
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
  /** Images are only downloaded from these hosts (the platform's CDN), over HTTPS. */
  allowed_hosts: z.array(z.string()).default(["cdn.discordapp.com", "media.discordapp.net"]),
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
 * `max_context_chars` the room is shared fairly instead of the last ones dropping.
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
  /** Her own state (the trusted system part: mood, activity, policy, goals, limits). */
  self_chars: z.number().int().nonnegative().default(1600),
  /** Keep a compressed copy of every n-th turn's prompt (`agent.prompt`); 0 = none. */
  save_every: z.number().int().nonnegative().default(1),
  /** Saved prompts kept in memory. */
  saved: z.number().int().nonnegative().default(50),
  /** A saved message is cut to this many characters (head and tail kept). */
  saved_message_chars: z.number().int().nonnegative().default(800),
});
export type PromptConfig = z.output<typeof PromptConfigSchema>;

/**
 * Tools that answer at once (a lookup, a note, a short program): they run inside the turn and she
 * reads the result in the same call chain (docs/design/v4-plan.md §4.2). Everything else (games,
 * songs, going live, joining voice) stays with the hands and comes back in a turn of its own.
 */
export const LOOP_TOOLS: readonly string[] = [
  "web_search",
  "web_read",
  "recall",
  "remember",
  "check_coins",
  "set_call_name",
  "keep_note",
  "drop_note",
  "code_run",
  "voice_status",
  // The work lane answers these at once; `work_start` only gets a task going, so it stays with
  // the hands, which follow the task and tell her when it ends.
  "work_list",
  "work_steer",
  // Coins, collectibles and reminders answer at once too. With the hands they cost a 「稍等喔。」
  // and a result turn of their own, which said the same thing again (2026-11-13 02:49) or got
  // superseded by the next person (02:35); in the loop she reacts to the result in one reply.
  "accept_food",
  "give_coins",
  "treat_from_purse",
  "make_deal",
  "deal_done",
  "cancel_deal",
  "checkin_for_speaker",
  "post_bounty",
  "award_bounty",
  "check_shop",
  "check_collection",
  "check_quests",
  "draw_collectible",
  "remind_me",
  "remember_date",
];

/**
 * `[modules.agent.mainline]`: the main line of `pipeline = "v3"` (docs/design/v3-architecture.md
 * §10). The prompt has no token cap by default (2026-11-08: 4000 left her with no conversation);
 * each part keeps its own character budget. The budgets are the ones of docs/design/v4-plan.md
 * §4.1: the history sits in the cached prefix, so a long one costs little once the layout keeps
 * that prefix the same from turn to turn (11-07's 4000-token target was set before it did).
 */
export const MainLineConfigSchema = z.object({
  /** A cap on the prompt (null: none); over it the oldest history gives way. */
  prompt_tokens: z.number().int().positive().nullable().default(null),
  /** Her own state in the tail of the prompt. */
  self_chars: z.number().int().nonnegative().default(1600),
  /** What contributors add to the data part, together. */
  data_chars: z.number().int().nonnegative().default(12_000),
  /** History lines shown at most, and their characters. */
  history_lines: z.number().int().nonnegative().default(200),
  history_chars: z.number().int().nonnegative().default(20_000),
  /**
   * A history over its budget is cut back to this share of it in one go, not a line per turn: the
   * first line of the history then stays where it is for many turns, and so does the cached prefix.
   */
  history_trim: z.number().gt(0).lte(1).default(0.6),
  /** The newest lines kept even when the prompt is over `prompt_tokens`. */
  history_floor: z.number().int().nonnegative().default(8),
  /** One history entry. */
  entry_chars: z.number().int().nonnegative().default(600),
  /** Memories retrieved per turn (the memory module's `recall_limit` when 0). */
  memory_lines: z.number().int().nonnegative().default(20),
  /**
   * Example dialogues, before the history (0: none). Which of them she sees turns over from one
   * session to the next and stays the same within one, so the prefix does too.
   */
  // 4000 (2026-11-11): her examples grew to about 2,100 characters; at 2000 some were never shown.
  examples_chars: z.number().int().nonnegative().default(4000),
  /** Tools that run inside the turn (`LOOP_TOOLS`); the rest go to the hands. */
  loop_tools: z.array(z.string()).default([...LOOP_TOOLS]),
  /** Calls of the loop run per round; more in one response are refused (she hears so). */
  loop_calls: z.number().int().positive().default(4),
  /**
   * What the loop's results of one round add to the messages, together. One result may be a whole
   * page now (`max_tool_result_chars`), so the bound a round had before (four calls of 4,000) is
   * kept here: a result past it is cut shorter, never the turn's prompt made four pages longer.
   */
  loop_round_chars: z.number().int().positive().default(16_000),
  /**
   * All the loop's tools of one turn together, in text: the turn holds the Floor meanwhile. Spent,
   * a call of the loop is not run and further calls go to the hands.
   */
  loop_budget_ms: z.number().int().positive().default(30_000),
  /** The same in voice, where someone waits in silence. */
  voice_loop_budget_ms: z.number().int().positive().default(12_000),
  /** Lines before the one she answers that retrieval reads too (v4 §5.4: 「好啊」 finds nothing). */
  memory_recent_lines: z.number().int().nonnegative().default(4),
  /**
   * The profiles of the people here (`PersonProfiles`), before the history (v4 §4.1, §5.6). They
   * are written again only when who is here or who talks with her changes, or after
   * `people_refresh_mins`: in between the block reads the same and the prefix stays cached.
   */
  // 3600 since the people are `<person/>` tags: the attribute names take room the old lines did not.
  people_chars: z.number().int().nonnegative().default(3600),
  people_refresh_mins: z.number().nonnegative().default(30),
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
  /**
   * What her tools of the loop brought back in a turn, a few lines kept beside her reply in the
   * history (v4 §4.2), so the next turn knows what she looked up: all calls of a turn together,
   * and one call's result.
   */
  trace_chars: z.number().int().nonnegative().default(600),
  trace_result_chars: z.number().int().nonnegative().default(160),
  /** Turns whose trace a conversation keeps (the window shows the ones beside its lines). */
  traces: z.number().int().nonnegative().default(12),
  /**
   * A tool's description as offered, and one argument's (v4 §4.2: the full text again, the fixed
   * prefix is cached). Longer ones are cut at a sentence.
   */
  tool_chars: z.number().int().nonnegative().default(600),
  tool_arg_chars: z.number().int().nonnegative().default(200),
  /** Lines of "最近講過" in the tail. */
  recent_lines: z.number().int().nonnegative().default(4),
  /** Untrusted working-context entries in the data part. */
  context_entries: z.number().int().nonnegative().default(4),
  /** Proposals shown at most. */
  proposals: z.number().int().nonnegative().default(3),
  /** No first token for this long and the call counts as failed: the fixed line goes out. */
  first_token_timeout_ms: z.number().int().positive().default(15_000),
  /** The same with reasoning on: a provider can think this long before its first event. */
  reasoning_first_token_timeout_ms: z.number().int().positive().default(60_000),
  /** At most one fixed line per context this often. */
  fallback_gap_ms: z.number().int().nonnegative().default(20_000),
  /** A commitment without a date is due this long after she made it. */
  commitment_due_secs: z.number().int().positive().default(120),
  /** How often overdue commitments are looked for. */
  commitment_sweep_ms: z.number().int().positive().default(5_000),
  /** How long one spoken character takes, for what she keeps of a sentence cut off. */
  ms_per_char: z.number().positive().default(180),
});
export type MainLineConfig = z.output<typeof MainLineConfigSchema>;

/**
 * Tools a work-lane task may be given (v4 §4.3 "能用的": the web, the sandbox, her notebook, her
 * memory, reading files). Never more than the Directives' filter offers where the task started,
 * and never a tool that says something to someone, whatever is listed here (`worklane/allow.ts`).
 */
export const WORK_TOOLS: readonly string[] = [
  "web_search",
  "web_read",
  "recall",
  "code_run",
  "workspace_list",
  "workspace_read",
  "workspace_write",
  "workspace_run",
  "workspace_save_script",
  "skill_list",
  "skill_read",
  "skill_write",
  "notebook_read",
  "notebook_write",
];

/** `[modules.agent.work]`: the work lane (docs/design/v4-plan.md §4.3). */
export const WorkConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Tasks running at once (one or two); more wait in the queue. */
  max_running: z.number().int().min(1).max(4).default(1),
  /** Tasks waiting at most; a start past it is refused (she hears so). */
  max_queued: z.number().int().nonnegative().default(4),
  /** Model calls one task may make. */
  max_steps: z.number().int().positive().default(12),
  /** Tool calls one model call may make; more are refused (it hears so). */
  calls_per_step: z.number().int().positive().default(4),
  /** How long one task may run, from its first step. */
  max_minutes: z.number().positive().default(10),
  /** Tokens one task may spend (prompt and completion). */
  max_tokens: z.number().int().positive().default(80_000),
  /** Tokens all tasks together may spend in a day (UTC), the game director's steps too. */
  daily_tokens: z.number().int().positive().default(600_000),
  /** Tools a task may be given (`WORK_TOOLS`). */
  tools: z.array(z.string()).default([...WORK_TOOLS]),
  /** One tool call. */
  tool_timeout_ms: z.number().int().positive().default(30_000),
  /** One tool result in its transcript (a page is 12,000). */
  tool_result_chars: z.number().int().positive().default(12_500),
  /**
   * Its transcript, all the results together: past it the oldest results are cut to a line, so a
   * long task keeps what it concluded, not every page it read.
   */
  transcript_chars: z.number().int().positive().default(48_000),
  /** Her conclusion, as the main line is told it. */
  result_chars: z.number().int().positive().default(1200),
  /** Lines of "what it did" the main line is told. */
  did_lines: z.number().int().positive().default(6),
  /** Ended tasks kept for `work_list` and the panel. */
  keep_ended: z.number().int().nonnegative().default(20),
  /**
   * Her own wish to do something that is work (§8.2: browse, code, tidy her notebook, improve a
   * skill) is proposed as a work-lane task, not as a one-line call.
   */
  initiative: z.boolean().default(true),
  /** Model calls a task she starts on her own may make. */
  initiative_steps: z.number().int().positive().default(8),
});
export type WorkConfig = z.output<typeof WorkConfigSchema>;

/**
 * `[modules.agent.corrections]`: the after-the-fact corrections of her output that v4 §4.5 steps
 * 2 to 4 retire once they are measured (docs/design/v4-patches.md says what count over what
 * period justifies switching each off). Every one is on by default; switching one off removes
 * only that correction, never an outer wall (owner rules, the action gate, the delivery ledger,
 * output moderation, the Floor's limits).
 */
export const CorrectionsConfigSchema = z.object({
  /** A tool written as text instead of called: she is asked once more to call it. */
  tool_text_reask: z.boolean().default(true),
  /**
   * A promise in her words ("我等一下進語音") or a tool written as text that no call followed
   * becomes a commitment, so it cannot just evaporate.
   */
  promise_commit: z.boolean().default(true),
  /**
   * The claim regexes (claims.ts): a line that says something only a tool does, or that work is
   * done, waits for the action or its result, is dropped without one, and she is asked once more.
   */
  claims: z.boolean().default(true),
  /** The reply screen (leak.ts): lines that are her reasoning are dropped before they are sent. */
  leak_screen: z.boolean().default(true),
  /**
   * A note to herself about how to answer, in the third person (leak.ts `isSelfTalk`,
   * 2026-11-08 「莎露朵在問我上面訊息寫什麼,直接念給她聽就好。」), is left out of the reply and
   * not said aloud. Only that line: the rest of the reply is hers.
   */
  self_talk: z.boolean().default(true),
  /**
   * The owner said plainly "don't play <game>" and she did not call `directive_add`: the rule is
   * written for her at the end of the turn, as the person who said it (prohibition.ts); the
   * directive service still decides whether that person may.
   */
  prohibition_write: z.boolean().default(true),
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
  /**
   * Messages kept per conversation context. More than the main line's `history_lines`, so the
   * oldest line it shows is never the one that falls out.
   */
  history_limit: z.number().int().nonnegative().default(240),
  /** Messages of history included in the prompt. */
  prompt_history: z.number().int().nonnegative().default(30),
  /**
   * When her conversation notes (module `conversation`) cover older lines, the prompt keeps only
   * the lines after them, but at least this many of the newest.
   */
  history_after_fold: z.number().int().nonnegative().default(25),
  /** The history in the prompt is cut to this many characters, oldest entries first. */
  max_prompt_chars: z.number().int().nonnegative().default(16_000),
  /** One history entry is cut to this many characters. */
  max_entry_chars: z.number().int().nonnegative().default(2000),
  /** Two messages further apart than this get a time-gap line between them. */
  time_gap_ms: z
    .number()
    .int()
    .nonnegative()
    .default(30 * 60 * 1000),
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
  /** The main line of `pipeline = "v3"`. */
  mainline: MainLineConfigSchema.prefault({}),
  /** The work lane (v4 §4.3). */
  work: WorkConfigSchema.prefault({}),
  /** The after-the-fact corrections that may be switched off once measured (v4 §4.5). */
  corrections: CorrectionsConfigSchema.prefault({}),
  /** Offer registered tools to the model. */
  tools_enabled: z.boolean().default(true),
  /**
   * Rounds of tool calls per turn before she must answer. Under the main line: rounds of
   * `mainline.loop_tools` inside one turn, and how long a chain of result turns may get.
   */
  max_tool_steps: z.number().int().nonnegative().default(3),
  /** Time limit for one tool call. */
  tool_timeout_ms: z.number().int().nonnegative().default(10_000),
  /**
   * Tool results are truncated to this many characters (v4 §4.2: a page read is 12,000 with its
   * block markers, `[modules.web] result_chars`; a little more for a moderation note before it).
   * What one round of the loop adds together stays bounded by `mainline.loop_round_chars`.
   */
  max_tool_result_chars: z.number().int().nonnegative().default(12_500),
  temperature: z.number().nullable().default(null),
  max_tokens: z.number().int().nonnegative().nullable().default(null),
  /** A context with no activity for this long forgets its session. */
  session_idle_ms: z
    .number()
    .int()
    .nonnegative()
    .default(6 * 3600 * 1000),
  /** Seed for the decision sampler; random when unset. */
  seed: z.number().int().nonnegative().nullable().default(null),
  /** Time limit for each prompt contributor; slower ones are skipped. */
  contributor_timeout_ms: z.number().int().nonnegative().default(800),
  /** Contributed data sections together are budgeted to this many characters. */
  max_context_chars: z.number().int().nonnegative().default(4000),
  /**
   * While the LLM budget is exhausted, her canned "out of energy" line is sent at most once
   * per context in this interval.
   */
  budget_notice_interval_ms: z
    .number()
    .int()
    .nonnegative()
    .default(3600 * 1000),
  attention: AttentionConfigSchema.prefault({}),
  voice: VoiceConfigSchema.prefault({}),
  history: HistoryConfigSchema.prefault({}),
  vision: VisionConfigSchema.prefault({}),
  files: FilesConfigSchema.prefault({}),
  prompt: PromptConfigSchema.prefault({}),
});
export type AgentConfig = z.output<typeof AgentConfigSchema>;

/**
 * Keys of `[modules.agent]` that are gone (attention's cooldowns and multipliers, v2 §3.3): an
 * old `miyoria.toml` that still has them loads (they are ignored) with a deprecation warning.
 */
export const DEPRECATED_AGENT_KEYS: readonly string[] = [
  "attention.cooldown_ms",
  "attention.min_cooldown_ms",
  "voice.ambient_factor",
  "voice.cooldown_ms",
  "voice.min_cooldown_ms",
  "voice.interrupt_scale",
];

/** The deprecated keys `raw` (the `[modules.agent]` section) still sets. */
export function deprecatedAgentKeys(raw: unknown): string[] {
  const obj = (v: unknown): Record<string, unknown> | null =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  const root = obj(raw);
  if (root === null) return [];
  return DEPRECATED_AGENT_KEYS.filter((path) => {
    const [section, key] = path.split(".") as [string, string];
    const part = obj(root[section]);
    return part !== null && Object.hasOwn(part, key);
  });
}

/** The defaults (Rust `AgentConfig::default()`). */
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
