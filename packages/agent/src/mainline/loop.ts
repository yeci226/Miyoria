// The tool loop inside a turn (docs/design/v4-plan.md §4.2).
//
// V3 made one call a turn: every tool went to the hands and its result came back in a turn of its
// own, with a prompt built again from scratch, so a lookup in three steps was three turns that did
// not know what the step before had thought. Now the tools that answer at once (`loop_tools`: a
// search, a page, a memory, a wallet, a note, a short program) run inside the turn: her call and
// its result stay in the messages and she goes on in the same chain, up to `max_tool_steps` rounds.
// Activities that take minutes (a game, a song, going live, joining voice) stay with the hands.
//
// The outer walls do not move: the tools on offer are still the Directives' list, every call still
// goes through `#tryTool` (whose permission it is), every line still through the gate, the ledger
// and moderation, and the decision of the turn is still logged once, with every tool it used.

import type { ToolCall } from "@miyoria/llm";
import { REASONING_LEVELS, type ReasoningLevel } from "@miyoria/types";
import { charCount } from "../util.js";
import { COMMIT_TOOL } from "./output.js";

/** Sentences of `text`, punctuation kept. */
export function sentences(text: string): string[] {
  return (text.match(/[^。!?!?\n]+[。!?!?\n]*/g) ?? []).filter((s) => s.trim() !== "");
}

/** `[llm.reasoning]` purpose of a call that reads what her tools brought back (v4 §4.4). */
export const TOOL_STEP_PURPOSE = "chat_tools";
/** `[llm.reasoning]` purpose of a text reply to a real question (v4 §4.4). */
export const QUESTION_PURPOSE = "chat_question";

/** What a call left to the hands answers in the loop: it is out, not done. */
export const HANDED_OVER = "交出去了,還沒完成;結果回來會再叫你。";
/** What `commit` answers in the loop. */
export const COMMITTED = "記下了,到期會提醒你。";
/** Said after a loop tool that only got something started. */
export const STILL_RUNNING = "(受理了,還沒完成;結果回來會再叫你)";

/** What a call of a tool that was not on offer answers (the Directives' filter, her state). */
export const NOT_OFFERED = "這個工具現在不能用。";
/** What a call of the loop past `loop_calls` in one response answers. */
export const TOO_MANY = "這一輪叫太多工具了,這個沒有執行;還需要的話下一輪再叫。";
/** What a call of the loop answers once the turn's time for tools is spent. */
export const OUT_OF_TIME = "這回合查東西的時間用完了,這個沒有執行。";
/** What a call of the loop answers when she was cut off before it ran. */
export const CUT_OFF = "你被打斷了,這個沒有執行。";
/** After a result cut to what was left of the round (`mainline.loop_round_chars`). */
export const ROUND_CUT = "\n…(這一輪的結果加起來太長,後面截掉了;需要的話下一輪再讀)";
/** Even late in a full round, a result keeps at least this much. */
export const ROUND_MIN_CHARS = 600;

/**
 * The calls that go to the hands, each once: a call she makes again in a later response (round
 * one `voice_join`, the last response `voice_join` again) would join twice. Promises are told apart
 * by what they say.
 */
export function handOver(calls: readonly ToolCall[]): ToolCall[] {
  const seen = new Set<string>();
  return calls.filter((c) => {
    const key = c.name === COMMIT_TOOL ? `${c.name}:${c.arguments}` : c.name;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The tool message for a call of this round that is not the loop's. */
export function handedOver(tool: string): string {
  return tool === COMMIT_TOOL ? COMMITTED : HANDED_OVER;
}

/** The higher of two reasoning levels. */
export function higher(a: ReasoningLevel, b: ReasoningLevel): ReasoningLevel {
  return REASONING_LEVELS.indexOf(a) >= REASONING_LEVELS.indexOf(b) ? a : b;
}

/** What is asked, not just said: a question mark, a question word, a request to explain. */
const QUESTION =
  /[??]|[嗎呢]\s*$|為什麼|為何|怎麼|如何|什麼是|是什麼|差在哪|差別|比較|解釋|請問|教我|幫我(?:查|算|看|想)/;
/** Shorter than this is small talk (「你在幹嘛?」), not a question to think about. */
const QUESTION_CHARS = 12;

/** A message that asks her something worth thinking about (v4 §4.4: text replies, `low`). */
export function asksSeriously(text: string): boolean {
  const t = text.trim();
  return charCount(t) >= QUESTION_CHARS && QUESTION.test(t);
}

/** A sentence as compared for repeats: no tags, spaces or punctuation. */
function plain(text: string): string {
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .toLowerCase();
}

/** The sentences of `texts`, as compared for repeats (code blocks left out). */
function plainSentences(texts: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const text of texts) {
    for (const part of prose(text)) {
      if (part.code) continue;
      for (const s of sentences(part.text)) {
        const p = plain(s);
        if (p !== "") out.add(p);
      }
    }
  }
  return out;
}

/** `text` cut into prose and code blocks (an unclosed block runs to the end). */
function prose(text: string): { text: string; code: boolean }[] {
  return text
    .split(/(```[\s\S]*?(?:```|$))/)
    .filter((t) => t !== "")
    .map((t) => ({ text: t, code: t.startsWith("```") }));
}

/**
 * `text` without the sentences she already said in an earlier round of the turn (`earlier`). The
 * model sees its own words in the transcript and still starts the next round with 「我查一下」
 * again; people would read or hear it twice. Only a whole sentence that is the same counts, and a
 * code block is never touched: a corrected program repeats most of its lines on purpose.
 */
export function withoutRepeats(text: string, earlier: readonly string[]): string {
  const said = plainSentences(earlier);
  if (said.size === 0) return text;
  return prose(text)
    .map((part) =>
      part.code
        ? part.text
        : sentences(part.text)
            .filter((s) => {
              const p = plain(s);
              return p === "" || !said.has(p);
            })
            .join(""),
    )
    .join("");
}

/**
 * Of `lines` (what the gate held, released at the end of the turn), the ones that are not the
 * same sentence again: as one another, or as what she already said (`said`). Lines held in two
 * rounds of the loop come out together, and 「記下來了」 would go out twice.
 */
export function freshLines<T extends { text: string }>(
  lines: readonly T[],
  said: readonly string[],
): T[] {
  const seen = plainSentences(said);
  const out: T[] = [];
  for (const line of lines) {
    const left = withoutRepeats(line.text, [...seen]);
    if (left.trim() === "") continue;
    for (const p of plainSentences([line.text])) seen.add(p);
    out.push(left === line.text ? line : { ...line, text: left });
  }
  return out;
}
