// Signals from other modules that shape her behaviour: how she feels about people
// (`SocialSignals`), her mood (`MoodSignals`) and the LLM budget (`llm.budget` events).

import { type HerStatus, neutralize, type RaisedTopic, type ShownEmotion } from "@miyoria/types";
import { ParseError } from "./config.js";

/**
 * Topic of the `custom` event the LLM layer publishes when its budget state changes; the
 * payload is `{"state": "ok" | "degraded" | "exhausted", ...}`.
 */
export const BUDGET_TOPIC = "llm.budget";

/**
 * What she says (at most once per context per notice interval) when the LLM budget is
 * exhausted. Constant: no model is involved.
 */
export const EXHAUSTED_LINE = "今天的能量用完了……伺服器繁忙,明天再陪你們聊。";

/**
 * State of the LLM budget as reported on `llm.budget`.
 * `degraded`: save tokens (ambient channels act like mention-only, no initiative).
 * `exhausted`: no generation at all; a canned line now and then instead.
 */
export type BudgetState = "ok" | "degraded" | "exhausted";

/** Throws `ParseError`. */
export function parseBudgetState(s: string): BudgetState {
  const v = s.trim().toLowerCase();
  if (v === "ok" || v === "degraded" || v === "exhausted") return v;
  throw new ParseError(`unknown budget state \`${v}\``);
}

/** Her actual voice / stream / game state, for the situation (so she never claims otherwise). */
export function herStatusHint(her: HerStatus): string {
  const voice =
    her.voice === null ? "不在語音頻道" : `在語音頻道 ${her.voice_name ?? her.voice.channel}`;
  const live =
    her.golive === "live" || her.golive === "starting"
      ? "正在 Go Live 直播"
      : her.streaming
        ? "OBS 正在直播"
        : "沒有在直播";
  const game = her.game === null ? "沒有在玩遊戲" : `正在玩 ${her.game}`;
  return `你現在${voice}、${live}、${game}。`;
}

/** Topics listed at most. */
const MAX_UNANSWERED = 3;

/**
 * What she raised here on her own recently and nobody picked up (her own lines, short), with
 * the rule not to bring it up again; empty when there is nothing.
 */
export function unansweredHint(topics: readonly RaisedTopic[]): string {
  const lines = topics
    .slice(0, MAX_UNANSWERED)
    .map((t) => {
      const chars = [...neutralize(t.text).replace(/\s+/g, " ").trim()];
      return chars.length > 40 ? `${chars.slice(0, 40).join("")}…` : chars.join("");
    })
    .filter((t) => t !== "");
  if (lines.length === 0) return "";
  return `你最近在這裡自己提過、沒人接的話題:${lines.map((l) => `「${l}」`).join("、")}。一陣子內不要再提(換句話說也一樣);沒人接就放下,跟著大家現在聊的事,或換個話題。`;
}

/** The feelings she would rather keep to herself when her display rules mask them. */
const KEPT_TO_HERSELF: ReadonlySet<string> = new Set([
  "shy",
  "missing",
  "lonely",
  "gratitude",
  "jealousy",
  "guilt",
]);

/**
 * What she shows of her emotion (the `self` module's display rules), as a fact about her: only
 * that she would rather not show a soft feeling, when the rules mask one. Never how it shows (the
 * rules' `style`) nor which `<emo:…>` it is: in the last system message every turn, 「兇回去、嫌棄
 * 對方,但臉紅了」 or 「接近 <emo:smug>」 was a script she played on every line, the very formula
 * the persona dropped (persona-v4.md §7). Joy, pride, anger and surprise show as they are: the
 * mood line already names them. Only fixed text: no names. Empty when there is nothing to say.
 */
export function shownHint(shown: ShownEmotion): string {
  return shown.masked && KEPT_TO_HERSELF.has(shown.from) ? "這份感受你不太想讓人看出來。" : "";
}
