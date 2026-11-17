// Who a line is for (docs/design/v2-architecture.md §3.3): what of the old attention prefilter the
// runner's triage still reads.
//
// * direct address: a mention, a reply to her, her name, a DM (`directReason`); in voice a Latin
//   name speech recognition mangled (`vocativeName`);
// * who a line is for, beyond who it replies to (`saidToOthers`, `reactionOnly`): a reply to her
//   that opens by calling someone else, or talks about her to others, is about her, said to them;
//   a reply that is only a laugh or an emoji is a reaction for the room. Neither is direct: the
//   runner gets them as lines it may pass (`Aside`).

import type { IncomingMessage } from "@miyoria/types";
import { isAlphanumeric, isWhitespace } from "./util.js";

/**
 * Why `msg` is said to her, or `null`: a DM, a mention, a reply to her, one of her names.
 *
 * Being a reply to her is not enough (2026-11-10: someone replied to her line with "@someone-else
 * she keeps skipping like a broken record, six times now", the log said `addressed_to_her` and she
 * answered it): a reply that is said to someone else (`saidToOthers`) or is only a reaction for
 * the room (`reactionOnly`) does not address her, and neither does her name inside a line said to
 * someone else. A line that @-mentions her and others together is still to her.
 */
export function directReason(
  msg: IncomingMessage,
  names: readonly string[],
  roster: readonly string[] = [],
): string | null {
  const kind = msg.id.context.kind;
  if (kind === "dm") return "dm";
  if (msg.mentions_self) return "mention";
  const elsewhere = saidToOthers(msg, names, roster);
  if (msg.reply_to_self) return elsewhere === null && !reactionOnly(msg) ? "reply" : null;
  if (elsewhere !== null) return null;
  // Transcripts space and punctuate names arbitrarily ("deep seek chan"), so voice compares
  // letters and digits only.
  const voice = kind === "voice";
  const normalize = (s: string): string => {
    const lower = s.toLowerCase();
    return voice ? [...lower].filter(isAlphanumeric).join("") : lower;
  };
  const text = normalize(msg.text);
  const found = names.find((n) => {
    const name = normalize(n);
    return name !== "" && text.includes(name);
  });
  if (found !== undefined) return `name \`${found}\``;
  const heard = voice ? vocativeName(msg.text, names) : null;
  return heard === null ? null : `name \`${heard.name}\` (heard \`${heard.word}\`)`;
}

/**
 * Speech recognition mangles short English names ("miyo" → "mo", "meo"). A Latin word that
 * opens an utterance on its own ("mo,你好", "meo 你在嗎") and sounds like one of her Latin names —
 * same first letter, at most two letters off — is taken as calling her. Only the opening word,
 * so "mode" or "more" inside a sentence never counts.
 */
export function vocativeName(
  text: string,
  names: readonly string[],
): { name: string; word: string } | null {
  const m = /^\s*([a-z]{2,10})(?=[\s,，、.。!！?？~～]|$)/i.exec(text);
  const word = m?.[1]?.toLowerCase();
  if (word === undefined) return null;
  for (const n of names) {
    const name = n.toLowerCase();
    if (!/^[a-z]{3,12}$/.test(name) || name[0] !== word[0]) continue;
    if (Math.abs(name.length - word.length) > 2) continue;
    if (editDistance(word, name) <= Math.min(2, name.length - 2)) return { name: n, word };
  }
  return null;
}

/**
 * In voice, the participant an utterance opens by calling (`roster`: display names of the others),
 * if it calls one of them and not her. Latin names are matched like hers (`vocativeName`: speech
 * recognition mangles them); other names (Chinese, Japanese) must open the utterance as they are.
 */
export function openingCall(
  text: string,
  roster: readonly string[],
  names: readonly string[],
): string | null {
  if (vocativeName(text, names) !== null) return null;
  const head = letters(text);
  if (names.some((n) => letters(n) !== "" && head.startsWith(letters(n)))) return null;
  const latin = vocativeName(text, roster);
  if (latin !== null) return latin.name;
  for (const n of roster) {
    const name = letters(n);
    // Only names with more than ASCII in them: an ASCII prefix like "mo" would match "more".
    if ([...name].length >= 2 && !/^[a-z0-9]+$/.test(name) && head.startsWith(name)) return n;
  }
  return null;
}

/** Lower-cased letters and digits of `s` (how transcripts are compared). */
function letters(s: string): string {
  return [...s.toLowerCase()].filter(isAlphanumeric).join("");
}

/** `text` speaks of her in the third person: one of her names, 她, she / her. */
export function aboutHerInThirdPerson(text: string, names: readonly string[]): boolean {
  const lower = text.toLowerCase();
  if (names.some((n) => n.trim() !== "" && lower.includes(n.trim().toLowerCase()))) return true;
  return /她/.test(text) || /\b(?:she|her|hers|this bot|the bot)\b/i.test(text);
}

/**
 * Whom a message is said to, when its words say it is someone other than her: it opens with an
 * @-mention of someone else, it @-mentions only others and talks about her in the third person,
 * or (voice) it opens by calling another participant (`openingCall`). `null`: nothing says so.
 * A message that @-mentions her is never said to others, whoever else it mentions.
 */
export function saidToOthers(
  msg: IncomingMessage,
  names: readonly string[],
  roster: readonly string[] = [],
): string | null {
  if (msg.mentions_self) return null;
  const others = msg.mentions_others ?? [];
  const first = others[0]?.display_name ?? "別人";
  if (msg.opens_with_other_mention === true) return first;
  if (msg.id.context.kind === "voice") {
    const called = openingCall(msg.text, roster, names);
    if (called !== null) return called;
  }
  return others.length > 0 && aboutHerInThirdPerson(msg.text, names) ? first : null;
}

/** Laughter and cheers that are a reaction, not something said (letters only, lower-cased). */
const REACTION_WORDS =
  /^(?:l+o+l+|lmf?a+o+|rofl|x+d+|w{2,}|草+|笑死(?:我了)?|哈+|呵+|嘻+|嘿+|23{2,}|6{3,}|好耶+|讚+)+$/;

/**
 * The message is only a reaction for the room: laughter ("LOL", 「哈哈哈」, 「笑死」), emoji or a
 * sticker, with nothing asked and nothing attached.
 */
export function reactionOnly(msg: IncomingMessage): boolean {
  if (msg.attachments.length > 0 || (msg.forwarded?.length ?? 0) > 0) return false;
  if (/[?？]/.test(msg.text)) return false;
  const stripped = msg.text
    .replace(/<a?:[\w~-]+:\d+>/g, "")
    .replace(/:[\w~-]+:/g, "")
    .replace(/\p{Extended_Pictographic}|\p{Emoji_Modifier}|‍|️|⃣/gu, "")
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .toLowerCase();
  if (stripped === "") return msg.text.trim() !== "" || (msg.stickers?.length ?? 0) > 0;
  return REACTION_WORDS.test(stripped);
}

/** A line answering her line that is not said to her (the runner may pass on it). */
export type Aside =
  /** About her, said to someone else (`to`). */
  | { kind: "about_her"; to: string }
  /** Only a reaction for the room. */
  | { kind: "reaction" };

/**
 * Whether `msg`, a reply to her or a line that follows hers (`followsHer`), is not said to her:
 * in text, about her but said to someone else (a voice line that calls someone else is simply
 * theirs); anywhere, only a reaction. `null` for lines that address her and for the rest.
 */
export function asideOf(
  msg: IncomingMessage,
  names: readonly string[],
  roster: readonly string[],
  followsHer: boolean,
): Aside | null {
  if (!msg.reply_to_self && !followsHer) return null;
  if (directReason(msg, names, roster) !== null) return null;
  if (msg.id.context.kind !== "voice") {
    const to = saidToOthers(msg, names, roster);
    if (to !== null) return { kind: "about_her", to };
  }
  return reactionOnly(msg) ? { kind: "reaction" } : null;
}

/** Levenshtein distance. */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = row;
  }
  return prev[b.length] ?? 0;
}

const QUESTION_WORDS = [
  "什麼",
  "怎麼",
  "幹嘛",
  "為什麼",
  "為啥",
  "誰",
  "哪裡",
  "哪個",
  "how ",
  "what ",
  "why ",
];

/** `text` (lower-cased) asks something. */
export function isQuestion(text: string): boolean {
  const chars = [...text];
  while (chars.length > 0) {
    const c = chars.at(-1) as string;
    if (isWhitespace(c) || "~～!！。.…".includes(c)) chars.pop();
    else break;
  }
  const t = chars.join("");
  return (
    t.includes("?") ||
    t.endsWith("嗎") ||
    t.endsWith("呢") ||
    t.endsWith("吧") ||
    QUESTION_WORDS.some((w) => t.includes(w))
  );
}
