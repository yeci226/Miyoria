// The owner's per-channel levels for text channels (docs/design/autonomy.md §21): 關閉 / 只回提及
// / 安靜 / 一般 / 活躍 (plus the old 每則都回). A level is a ceiling, not a setting of her
// personality: she still chooses how talkative she is there (`SelfState` talkativeness, the
// `channel_activeness` tool), but whatever she chooses is capped by the level, and the level
// also bounds her own conversation starts there (`startGapMs`, applied by the Arbiter as one of
// its rules; without it by the agent). All numbers are here.
//
// Voice contexts have no ceiling: the voice numbers (`[modules.agent.voice]`) apply as before.
//
// The rhythm of text channels under the main line (v4 §7.2, §7.3) is here too, as numbers the
// owner sets (`[modules.agent.rhythm]`, `RhythmConfigSchema`) and the per-channel ledger that
// holds them (`Rhythm`): how many looks she takes an hour, how often she may react with an emoji,
// and how her several short messages are spaced.

import type { ContextKey } from "@miyoria/types";
import { z } from "zod";
import type { ChannelMode } from "./config.js";
import { contextId } from "./util.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** What a level allows her in one text channel. */
export interface Ceiling {
  mode: ChannelMode;
  /** Highest talkativeness she can have here; hers (with lessons) is capped to it. */
  maxTalk: number;
  /**
   * Her talkativeness here while she set none (scaled further by the configured activeness, but
   * never above `maxTalk`).
   */
  defaultTalk: number;
  /** Ambient turns scoring below this are ignored. */
  minScore: number;
  /** Upper bound of her share of recent messages for ambient turns (with the profile's). */
  maxShare: number;
  /**
   * At least this long between two conversations she starts herself here (0: none; the
   * Arbiter applies it as one of its rules).
   */
  startGapMs: number;
  /** How many looks an hour she takes here, relative to `normal` (1). */
  looks: number;
}

const QUIET: Ceiling = {
  mode: "quiet",
  // ×1 at most: never chattier than "as usual", ×0.5 by default.
  maxTalk: 0.5,
  defaultTalk: 0.25,
  // A plain question in a small group (0.3) is not enough; a topic of hers or a follow-up is.
  minScore: 0.45,
  maxShare: 0.15,
  startGapMs: 3 * 60 * MINUTE_MS,
  looks: 0.5,
};

const NORMAL: Ceiling = {
  mode: "normal",
  // ×1 by default (the old `ambient`), ×2 at most.
  maxTalk: 0.75,
  defaultTalk: 0.5,
  minScore: 0,
  maxShare: 1,
  startGapMs: 0,
  looks: 1,
};

const LIVELY: Ceiling = {
  mode: "lively",
  // ×1.5 by default, up to ×4 when she wants.
  maxTalk: 1,
  defaultTalk: 0.65,
  minScore: 0,
  maxShare: 1,
  startGapMs: 0,
  looks: 2,
};

/** The ceiling of each joining-in level. */
export const CEILINGS = { quiet: QUIET, normal: NORMAL, lively: LIVELY } as const;

/**
 * The ceiling for `context` in `mode`: `null` in voice contexts and DMs, and for modes that do
 * not let her join in (`off`, `mention-only`). `always` replies to everything; for her own
 * starts it counts as `lively`.
 */
export function ceilingFor(mode: ChannelMode, context: ContextKey): Ceiling | null {
  if (context.kind === "voice" || context.kind === "dm") return null;
  switch (mode) {
    case "quiet":
      return QUIET;
    case "normal":
      return NORMAL;
    case "lively":
    case "always":
      return LIVELY;
    default:
      return null;
  }
}

/** Her talkativeness under `ceiling`: hers capped, or the level's default when she set none. */
export function cappedTalk(ceiling: Ceiling, level: number | null): number {
  return Math.min(level ?? ceiling.defaultTalk, ceiling.maxTalk);
}

/** The level in words, for notices, the panel and her prompt. */
export function modeLabel(mode: ChannelMode): string {
  switch (mode) {
    case "off":
      return "關閉";
    case "mention-only":
      return "只回提及";
    case "quiet":
      return "安靜";
    case "normal":
      return "一般";
    case "lively":
      return "活躍";
    case "always":
      return "每則都回";
  }
}

/**
 * The level of a text channel for her situation notes (system: the owner's setting, nothing
 * derived from others); `null` where there is nothing to say (voice, DMs, `always`).
 */
export function levelHint(
  mode: ChannelMode,
  context: ContextKey,
  language: string | null = null,
): string | null {
  const level = modeHint(mode, context);
  const lang = languageHint(language);
  return level === null ? lang : lang === null ? level : `${level}\n${lang}`;
}

/**
 * The language set for a place (`language`, docs/design/v5-places.md), as a line of her
 * situation notes; `null` when none is set. The value is the owner's: one short line, quoted.
 */
export function languageHint(language: string | null): string | null {
  const text = language?.replace(/\s+/g, " ").trim() ?? "";
  if (text === "") return null;
  return `這裡的人用「${[...text].slice(0, 40).join("")}」聊天:你在這裡也用這個語言說話。`;
}

function modeHint(mode: ChannelMode, context: ContextKey): string | null {
  if (context.kind === "voice" || context.kind === "dm") return null;
  const adjust =
    "有人請你安靜點、少講話或多聊一點時,用 channel_activeness 自己決定要調多少、多久(這個等級是上限)。";
  switch (mode) {
    case "quiet":
      return `這個頻道的聊天等級是「安靜」:沒人叫你時很少插話,只在話題明顯跟你有關時才開口;有人叫你照常回。${adjust}`;
    case "normal":
      return `這個頻道的聊天等級是「一般」。${adjust}`;
    case "lively":
      return `這個頻道的聊天等級是「活躍」:可以比較常加入大家的對話。${adjust}`;
    case "mention-only":
      return "這個頻道的聊天等級是「只回提及」:只回應叫你的人,不主動插話或開話題。";
    default:
      return null;
  }
}

/** What the level means, in one line. */
export function modeDescription(mode: ChannelMode): string {
  switch (mode) {
    case "off":
      return "完全不說話";
    case "mention-only":
      return "只在被提及、回覆或叫名字時回覆";
    case "quiet":
      return "被叫到會回;只在話題明顯跟她有關時偶爾插話,很少主動開話題";
    case "normal":
      return "被叫到會回,有時會自己加入對話";
    case "lively":
      return "比較常加入對話,也比較常主動開話題";
    case "always":
      return "每則訊息都回覆(測試用)";
  }
}

/**
 * `[modules.agent.rhythm]`: her rhythm in text channels under the main line (v4 §7.2, §7.3).
 * Read on its own section by the agent (`Agent.rhythm`).
 */
export const RhythmConfigSchema = z.object({
  /** Emoji reactions per channel per hour (they are not lines: the Floor's budget skips them). */
  reactions_per_hour: z.number().int().nonnegative().default(20),
  /** At least this long between two of her reactions in one channel. */
  reaction_gap_ms: z.number().int().nonnegative().default(3000),
  /**
   * Several short messages of one reply go out spaced by their length, with typing shown in
   * between: this long per character of the next one, within `pace_min_ms`..`pace_max_ms`.
   */
  pace_ms_per_char: z.number().nonnegative().default(40),
  pace_min_ms: z.number().int().nonnegative().default(300),
  pace_max_ms: z.number().int().nonnegative().default(1800),
  /**
   * A line said to her that is only a plain thank-you or goodbye ("謝謝", "掰掰", "thanks",
   * "おやすみ") may get just an emoji and no run (v5-architecture §9.5; `selfhost/courtesy.ts`).
   * Never with a question, an attachment, a mention of someone else, a party game or a job of
   * hers waiting there, or a run going in that place. The reaction counts toward
   * `reactions_per_hour` too.
   */
  courtesy_react: z.boolean().default(true),
  /** How often such a line gets only the reaction (the rest wake her as before). */
  courtesy_chance: z.number().min(0).max(1).default(0.35),
  /** Reaction-only answers per channel per hour, at most. */
  courtesy_per_hour: z.number().int().nonnegative().default(3),
});
export type RhythmConfig = z.output<typeof RhythmConfigSchema>;

/** The agent's section as far as the rhythm goes (`ModuleContext.config` strips the rest). */
export const RhythmSectionSchema = z.object({ rhythm: RhythmConfigSchema.prefault({}) });

/** How long the next of several messages waits after the one before (typing meanwhile). */
export function paceMs(config: RhythmConfig, text: string): number {
  const ms = [...text.trim()].length * config.pace_ms_per_char;
  return Math.round(Math.min(Math.max(ms, config.pace_min_ms), config.pace_max_ms));
}

/** Times in the last hour per context, oldest first. */
class HourLog {
  readonly #at = new Map<string, number[]>();

  recent(context: ContextKey, now: number): number[] {
    const id = contextId(context);
    const kept = (this.#at.get(id) ?? []).filter((t) => now - t < HOUR_MS);
    if (kept.length === 0) this.#at.delete(id);
    else this.#at.set(id, kept);
    return kept;
  }

  add(context: ContextKey, now: number): void {
    this.#at.set(contextId(context), [...this.recent(context, now), now]);
  }
}

/** Message ids she already took a turn on, remembered at most. */
const TAKEN_MAX = 256;

/**
 * The per-channel ledger of her rhythm: the looks she took (the cap per hour), the messages a turn
 * already answered or looked at (a question is not looked at twice) and her emoji reactions, which
 * have their own limit: they are not lines, so the Floor's budget and her share do not hold them.
 * In memory only.
 */
export class Rhythm {
  readonly #looks = new HourLog();
  readonly #reactions = new HourLog();
  readonly #taken = new Set<string>();

  constructor(
    readonly config: RhythmConfig,
    readonly now: () => number,
  ) {}

  /** Looks taken in `context` in the last hour. */
  looksUsed(context: ContextKey): number {
    return this.#looks.recent(context, this.now()).length;
  }

  noteLook(context: ContextKey): void {
    this.#looks.add(context, this.now());
  }

  /** A turn answered or looked at these messages. */
  took(ids: readonly string[]): void {
    for (const id of ids) {
      this.#taken.delete(id);
      this.#taken.add(id);
    }
    while (this.#taken.size > TAKEN_MAX) {
      const oldest = this.#taken.values().next().value;
      if (oldest === undefined) break;
      this.#taken.delete(oldest);
    }
  }

  taken(id: string): boolean {
    return this.#taken.has(id);
  }

  /** Why she may not react in `context` now, or `null`: then the reaction is booked. */
  takeReaction(context: ContextKey): string | null {
    const now = this.now();
    const recent = this.#reactions.recent(context, now);
    if (recent.length >= this.config.reactions_per_hour) {
      return `這個頻道這一小時已經按了 ${recent.length} 個表情,先不要再按`;
    }
    const last = recent.at(-1);
    if (last !== undefined && now - last < this.config.reaction_gap_ms) {
      return "剛剛才按過表情,等一下再按";
    }
    this.#reactions.add(context, now);
    return null;
  }
}
