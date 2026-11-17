// What she wrote in a `<feel>` block (docs/design/v5-heart.md §2.1), read line by line. The parser
// (`ExpressionParser`) has already taken the block out of what people see; this reads its inside:
//
//     我: 開心 中
//     小明: 羈絆 + 「他記得我上次說想吃的東西」
//
// The first kind of line is her own emotion now and how strong; the second a proposal about
// someone: a value, a direction, and a quote as the reason. A line that does not read is dropped
// with why, never an error. Who a name is, and the caps of a turn (two people, three lines), are
// the host's: it knows who is there (`limitProposals`).

import {
  type AppraisalStrength,
  type EmotionName,
  FEEL_EMOTION_WORDS,
  FEEL_FIELD_WORDS,
  FEEL_STRENGTH_WORDS,
  type FeelField,
} from "@miyoria/types";

/** Her own emotion line. */
export interface FeelSelf {
  /** The word as she wrote it. */
  word: string;
  /** The engine's emotion; `null`: she feels nothing in particular (平靜). */
  emotion: EmotionName | null;
  strength: AppraisalStrength;
}

/** One proposal line, its name not yet matched to anyone. */
export interface FeelLine {
  name: string;
  field: FeelField;
  direction: "up" | "down";
  quote: string;
}

export type FeelDropReason =
  /** An emotion word the engine has no emotion for. */
  | "unknown_emotion"
  /** A value word that is none of the seven. */
  | "unknown_field"
  /** A proposal without a reason. */
  | "no_quote"
  /** Not a line of either kind. */
  | "malformed"
  /** A second line about her own emotion. */
  | "repeated"
  /**
   * A proposal cut off (the token limit ends a block mid-line): a quote whose bracket never
   * closes, or a last line without brackets that the block did not end after.
   */
  | "cut";

export interface ParsedFeel {
  self: FeelSelf | null;
  lines: FeelLine[];
  dropped: { line: string; why: FeelDropReason }[];
}

/** The longest quote kept (characters). */
const MAX_QUOTE = 80;

const FIELD_BY_WORD = new Map<string, FeelField>(
  Object.entries(FEEL_FIELD_WORDS).map(([field, word]) => [word, field as FeelField]),
);

const SELF_LINE = /^(?:我自己|我|自己)\s*[:：]\s*(.*)$/u;
const PERSON_LINE = /^(.+?)\s*[:：]\s*([^\s+＋\-－−]+)\s*([+＋\-－−])\s*(.*)$/u;
/** Bullets she may put in front of a line. */
const BULLET = /^(?:[-*•・]\s+)/u;

function strengthOf(word: string): AppraisalStrength | undefined {
  return FEEL_STRENGTH_WORDS[word];
}

const OPENING = /^[「『“"'‘]/u;
const CLOSING = /[」』”"'’]$/u;

/**
 * The quote of a proposal: inside its brackets when it has them, else the rest of the line.
 * `null` when it was cut off: an opening bracket that never closes, or no brackets on the line
 * the block may have been cut in (`complete` false: its last line, with no line break after it).
 */
function quoteOf(rest: string, complete: boolean): string | null {
  const t = rest.trim();
  let inside: string;
  if (OPENING.test(t)) {
    const chars = [...t];
    if (chars.length < 2 || !CLOSING.test(t)) return null;
    inside = chars.slice(1, -1).join("");
  } else {
    if (!complete) return null;
    inside = t;
  }
  const text = inside.replace(/\s+/gu, " ").trim();
  const chars = [...text];
  return chars.length > MAX_QUOTE ? `${chars.slice(0, MAX_QUOTE).join("")}…` : text;
}

function selfOf(rest: string): FeelSelf | null {
  const tokens = rest
    .trim()
    .split(/\s+/u)
    .filter((t) => t !== "");
  let strength: AppraisalStrength = "medium";
  let word = tokens.join("");
  const last = tokens.at(-1);
  if (tokens.length > 1 && last !== undefined && strengthOf(last) !== undefined) {
    strength = strengthOf(last) as AppraisalStrength;
    word = tokens.slice(0, -1).join("");
  } else if (!Object.hasOwn(FEEL_EMOTION_WORDS, word)) {
    // 「開心中」: the strength written onto the word.
    const tail = [...word].at(-1) ?? "";
    const head = [...word].slice(0, -1).join("");
    if (strengthOf(tail) !== undefined && Object.hasOwn(FEEL_EMOTION_WORDS, head)) {
      strength = strengthOf(tail) as AppraisalStrength;
      word = head;
    }
  }
  if (!Object.hasOwn(FEEL_EMOTION_WORDS, word)) return null;
  return { word, emotion: FEEL_EMOTION_WORDS[word] ?? null, strength };
}

/** Reads the inside of one or more feel blocks. */
export function parseFeel(raw: string): ParsedFeel {
  const out: ParsedFeel = { self: null, lines: [], dropped: [] };
  const lines = raw.split(/\r?\n/u);
  // A block that does not end with a line break may have been cut in its last line.
  const last = /\n\s*$/u.test(raw) ? -1 : lines.findLastIndex((l) => l.trim() !== "");
  for (const [index, original] of lines.entries()) {
    const line = original.trim().replace(BULLET, "").trim();
    if (line === "") continue;
    const own = SELF_LINE.exec(line);
    if (own !== null) {
      const self = selfOf(own[1] ?? "");
      if (self === null) out.dropped.push({ line, why: "unknown_emotion" });
      else if (out.self !== null) out.dropped.push({ line, why: "repeated" });
      else out.self = self;
      continue;
    }
    const person = PERSON_LINE.exec(line);
    if (person === null) {
      out.dropped.push({ line, why: "malformed" });
      continue;
    }
    const name = (person[1] ?? "").replace(/^@+/u, "").trim();
    const field = FIELD_BY_WORD.get((person[2] ?? "").trim());
    if (field === undefined) {
      out.dropped.push({ line, why: "unknown_field" });
      continue;
    }
    const quote = quoteOf(person[4] ?? "", index !== last);
    if (quote === null) {
      out.dropped.push({ line, why: "cut" });
      continue;
    }
    if (name === "" || quote === "") {
      out.dropped.push({ line, why: name === "" ? "malformed" : "no_quote" });
      continue;
    }
    const sign = person[3] ?? "+";
    out.lines.push({
      name,
      field,
      direction: sign === "+" || sign === "＋" ? "up" : "down",
      quote,
    });
  }
  return out;
}

/** At most this many people get a proposal in one turn... */
export const MAX_FEEL_PEOPLE = 2;
/** ...and at most this many proposal lines in all. */
export const MAX_FEEL_LINES = 3;

/**
 * The proposals a turn keeps, in the order written: the same value of the same person in the same
 * direction once, at most `MAX_FEEL_PEOPLE` people and `MAX_FEEL_LINES` lines. `over`: how many
 * were left out.
 */
export function limitProposals<T extends { person: string; field: string; direction: string }>(
  lines: readonly T[],
): { kept: T[]; over: number } {
  const kept: T[] = [];
  const people = new Set<string>();
  for (const line of lines) {
    if (kept.length >= MAX_FEEL_LINES) continue;
    const same = kept.some(
      (k) => k.person === line.person && k.field === line.field && k.direction === line.direction,
    );
    if (same) continue;
    if (!people.has(line.person) && people.size >= MAX_FEEL_PEOPLE) continue;
    people.add(line.person);
    kept.push(line);
  }
  return { kept, over: lines.length - kept.length };
}

const FIELD_WORDS = Object.values(FEEL_FIELD_WORDS).join("|");
const LEAKED_SELF = new RegExp(
  `^(?:我自己|我|自己)\\s*[:：]\\s*\\S{1,6}?\\s*(?:${Object.keys(FEEL_STRENGTH_WORDS).join("|")})\\s*$`,
  "u",
);
const LEAKED_PROPOSAL = new RegExp(`^[^\\n]{1,40}?[:：]\\s*(?:${FIELD_WORDS})\\s*[+＋\\-－−]`, "u");
const LEAKED_TAG = /<\/?\s*feel\b/iu;

/**
 * Whether a line of her text reads like part of a feel block written without its tags (「我: 開心
 * 中」, 「小明: 羈絆 + …」) or a remnant of the tag: such a line is never shown or said.
 */
export function isFeelLine(text: string): boolean {
  const t = text.trim();
  return LEAKED_TAG.test(t) || LEAKED_SELF.test(t) || LEAKED_PROPOSAL.test(t);
}
