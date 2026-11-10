// The owner's per-channel levels for text channels (docs/design/autonomy.md §21): 關閉 / 只回提及
// / 安靜 / 一般 / 活躍 (plus the old 每則都回). A level is a ceiling, not a setting of her
// personality: she still chooses how talkative she is there (`SelfState` talkativeness, the
// `channel_activeness` tool), but whatever she chooses is capped by the level, and the level
// also bounds her own conversation starts there (`startGapMs`, applied by the Arbiter as one of
// its rules; without it by the agent). All numbers are here.
//
// Voice contexts have no ceiling: the voice numbers (`[modules.agent.voice]`) apply as before.

import type { ContextKey } from "@miyoria/types";
import type { ChannelMode } from "./config.js";

const MINUTE_MS = 60_000;

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
  /** Ambient turns scoring below this are ignored (on top of `gray_low`). */
  minScore: number;
  /** Upper bound of her share of recent messages for ambient turns (with the profile's). */
  maxShare: number;
  /**
   * At least this long between two conversations she starts herself here (0: none; the
   * Arbiter applies it as one of its rules).
   */
  startGapMs: number;
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
};

const NORMAL: Ceiling = {
  mode: "normal",
  // ×1 by default (the old `ambient`), ×2 at most.
  maxTalk: 0.75,
  defaultTalk: 0.5,
  minScore: 0,
  maxShare: 1,
  startGapMs: 0,
};

const LIVELY: Ceiling = {
  mode: "lively",
  // ×1.5 by default, up to ×4 when she wants.
  maxTalk: 1,
  defaultTalk: 0.65,
  minScore: 0,
  maxShare: 1,
  startGapMs: 0,
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

/**
 * Initiative reasons that are not her starting a conversation: the game director's live
 * commentary, the result of something she was asked to do, task notices, and what she says about
 * a stream she is watching (paced by the watch's own `speakGate`).
 */
export const UNCAPPED_INITIATIVES: readonly string[] = ["game", "action_result", "notice", "watch"];

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
export function levelHint(mode: ChannelMode, context: ContextKey): string | null {
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
