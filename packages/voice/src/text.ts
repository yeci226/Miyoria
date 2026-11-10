// Text clean-up around ASR and TTS.

import { Converter } from "opencc-js/cn2t";

// OpenCC tables (Apache-2.0): Simplified (mainland) to Traditional (Taiwan) with Taiwan phrasing.
const toTw = Converter({ from: "cn", to: "twp" });

/** Converts Simplified Chinese to Traditional Chinese (Taiwan phrasing). */
export function toTraditional(text: string): string {
  return toTw(text);
}

/**
 * Phrases ASR models (Whisper-style) invent on silence or noise. Compared after Traditional
 * conversion, lower-cased, without spaces and punctuation.
 */
const HALLUCINATION_EXACT = [
  "謝謝觀看",
  "謝謝大家觀看",
  "感謝觀看",
  "謝謝收看",
  "請訂閱",
  "記得訂閱",
  "thankyouforwatching",
  "thanksforwatching",
  "pleasesubscribe",
  "ご視聴ありがとうございました",
];

const HALLUCINATION_CONTAINS = [
  "字幕由",
  "字幕提供",
  "字幕製作",
  "字幕志願者",
  "中文字幕",
  "請不吝點贊",
  "點贊訂閱",
  "訂閱轉發",
  "打賞支持",
  "明鏡與點點",
  "優優獨播劇場",
  "amaraorg",
  "subtitlesby",
];

/** Rust `char::is_alphanumeric`. */
const ALPHANUMERIC = /[\p{Alphabetic}\p{N}]/u;
const NOT_ALPHANUMERIC = /[^\p{Alphabetic}\p{N}]/gu;

function normalize(text: string): string {
  return text.replace(NOT_ALPHANUMERIC, "").toLowerCase();
}

/** Rust `split_whitespace().join(" ")`. */
function collapseWhitespace(text: string): string {
  return text
    .split(/[\s\u0085]+/u)
    .filter((w) => w !== "")
    .join(" ");
}

/** No letters, digits or CJK characters at all. */
export function isPunctuationOnly(text: string): boolean {
  return !ALPHANUMERIC.test(text);
}

/** Known ASR hallucination (`extra` adds configured phrases, matched as substrings). */
export function isHallucination(text: string, extra: readonly string[]): boolean {
  const n = normalize(toTraditional(text));
  if (n === "") return true;
  return (
    HALLUCINATION_EXACT.includes(n) ||
    HALLUCINATION_CONTAINS.some((p) => n.includes(p)) ||
    extra.map((p) => normalize(toTraditional(p))).some((p) => p !== "" && n.includes(p))
  );
}

/** Cleans an ASR transcript. Returns `null` when it should be dropped. */
export function cleanTranscript(
  text: string,
  traditional: boolean,
  extra: readonly string[],
): string | null {
  const t = collapseWhitespace(text);
  if (t === "" || isPunctuationOnly(t) || isHallucination(t, extra)) return null;
  return traditional ? toTraditional(t) : t;
}

/** A compiled `asr_aliases` table. */
export type AsrAliases = readonly (readonly [RegExp, string])[];

const LATIN_WORD = "[\\p{Script=Latin}\\p{N}]";
const LATIN_EDGE = new RegExp(`^${LATIN_WORD}|${LATIN_WORD}$`, "u");

/**
 * Compiles `asr_aliases` (what ASR hears → what was said). Longest first, so a long form is not
 * eaten by a short one. A Latin alias matches whole words only and any case: "meo" must not hit
 * "someone"; CJK has no word boundaries, there the characters are enough.
 */
export function compileAliases(
  table: Readonly<Record<string, string>>,
  traditional: boolean,
): AsrAliases {
  return Object.entries(table)
    .map(([heard, said]): [string, string] => [
      (traditional ? toTraditional(heard) : heard).trim(),
      said,
    ])
    .filter(([heard]) => heard !== "")
    .sort(([a], [b]) => b.length - a.length)
    .map(([heard, said]) => {
      const body = heard.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const latin = LATIN_EDGE.test(heard);
      const source = latin ? `(?<!${LATIN_WORD})${body}(?!${LATIN_WORD})` : body;
      return [new RegExp(source, latin ? "giu" : "gu"), said] as const;
    });
}

/** `text` with what ASR misheard put right. */
export function applyAliases(text: string, aliases: AsrAliases): string {
  let out = text;
  for (const [pattern, said] of aliases) out = out.replace(pattern, () => said);
  return out;
}

/** Longest `<...>` treated as a markup tag. */
const MAX_TAG_LEN = 48;

/**
 * Removes expression markup the agent may have left in (`<emo:happy>`, `<pause 300/>`,
 * `<silence/>`, other short `<word ...>` tags) and collapses whitespace.
 */
export function stripTags(text: string): string {
  let out = "";
  let rest = text;
  for (;;) {
    const start = rest.indexOf("<");
    if (start < 0) break;
    out += rest.slice(0, start);
    const after = rest.slice(start + 1);
    const end = after.indexOf(">");
    if (end >= 0 && end <= MAX_TAG_LEN && looksLikeTag(after.slice(0, end))) {
      out += " ";
      rest = after.slice(end + 1);
    } else {
      out += "<";
      rest = after;
    }
  }
  out += rest;
  return collapseWhitespace(out);
}

const TAG_CHAR = /^[A-Za-z0-9 :=_\-/."']*$/;

function looksLikeTag(body: string): boolean {
  const b = body.replace(/^\/+/, "");
  return /^[A-Za-z]/.test(b) && !b.includes("<") && TAG_CHAR.test(b);
}

/** Separators of an ASR hint's terms (`Miyo、米優、Minecraft`, names after a space). */
const HINT_SEPARATORS = /[、,，;；\s]+/u;

/**
 * The transcript only repeats the ASR hint (her names, game terms, the people in the channel):
 * some models (Qwen3-ASR) print their context back when the audio holds no clear speech. True
 * when it has at least three terms and most of them are hint terms.
 */
export function echoesHint(text: string, prompt: string | null): boolean {
  if (prompt === null || prompt.trim() === "") return false;
  const norm = (s: string) =>
    s
      .replace(/[。.!！?？]+$/u, "")
      .trim()
      .toLowerCase();
  const hint = new Set(
    prompt
      .split(HINT_SEPARATORS)
      .map(norm)
      .filter((t) => t !== ""),
  );
  const terms = text
    .split(HINT_SEPARATORS)
    .map(norm)
    .filter((t) => t !== "");
  if (terms.length < 3) return false;
  const known = terms.filter((t) => hint.has(t)).length;
  return known / terms.length >= 0.6;
}
