// What members said, made safe to put in a public issue. Everything in a report is text a member
// typed (through her words): it is data, and here it loses whatever could reach anyone or anything
// from the issue. Links and addresses go, Discord's mention and channel markup goes, an `@name`
// cannot ping anyone and a `#123` cannot cross-link (both become full-width), long ids and the
// reporter's own names are replaced, control and invisible characters are dropped, and every field
// has a length cap. `markdownText` then escapes what is left for the issue body, so nothing a member
// wrote is read as Markdown or HTML.

/** Longest field, in characters (code points). */
export const LIMITS = {
  title: 100,
  happened: 2000,
  expected: 1000,
  steps: 2000,
  /** An owner's reason for a rejection. */
  reason: 500,
  /** A body the owner edited before approving. */
  body: 20_000,
} as const;

/** What a removed piece is replaced with. */
export const REMOVED = {
  link: "(連結已移除)",
  email: "(email 已移除)",
  id: "(id 已移除)",
  mention: "＠某人",
  channel: "(某個頻道)",
  time: "(某個時間)",
  name: "回報者",
} as const;

// Control characters (but newline), zero-width and direction marks, BOM, the soft hyphen.
const INVISIBLE: readonly (readonly [number, number])[] = [
  [0x00, 0x09],
  [0x0b, 0x1f],
  [0x7f, 0x9f],
  [0xad, 0xad],
  [0x61c, 0x61c],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0xfeff, 0xfeff],
];

function visible(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return !INVISIBLE.some(([from, to]) => code >= from && code <= to);
}

const DISCORD_USER = /<@[!&]?\d+>/g;
const DISCORD_CHANNEL = /<#\d+>/g;
const DISCORD_EMOJI = /<a?:([A-Za-z0-9_~]{1,64}):\d+>/g;
const DISCORD_TIME = /<t:-?\d+(?::[A-Za-z])?>/g;
/** `[text](target)`: the text stays, the target goes. */
const MD_LINK = /!?\[([^\]\n]{0,300})\]\([^)\n]*\)/g;
/** A URI with a scheme, or one in angle brackets. */
const SCHEME_URL = /<?\b[A-Za-z][A-Za-z0-9+.-]{1,20}:\/\/[^\s<>]*>?/g;
/** Schemes that work without `//`. */
const BARE_SCHEME = /\b(?:mailto|javascript|data|vbscript|file|tel|sms|discord|steam):[^\s<>]+/gi;
const WWW = /\bwww\.[^\s<>]+/gi;
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[A-Za-z]{2,}/gu;
/** A host name with a path or a well-known ending: `example.com/x`, `foo.gg`. */
const BARE_HOST =
  /\b(?:[A-Za-z0-9-]+\.)+(?:com|net|org|io|gg|me|tv|app|dev|xyz|co|tw|jp|ly|be|info|site|link|cc|ai|so|to|gl|us|uk|cn|hk)\b(?:\/[^\s<>]*)?/gi;
/** Discord ids and other long numbers that point at someone or something. */
const LONG_ID = /\d{15,}/g;
/** `@name`, `@everyone`, `@here`. */
const MENTION = /@[\p{L}\p{N}_.-]+/gu;

function capChars(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface PlainOptions {
  /** Longest result, in characters. */
  max: number;
  /** One line (a title): every run of whitespace becomes one space. */
  singleLine?: boolean;
  /** Names to replace (the reporter's), compared without case. Shorter than two characters: kept. */
  redact?: readonly string[];
}

/**
 * Member text as plain, harmless text: no links, addresses, ids, mentions or issue references,
 * no invisible characters, the reporter's names replaced, whitespace tidied, at most `max`
 * characters. Not yet escaped for Markdown (`markdownText`).
 */
export function plainText(raw: string, options: PlainOptions): string {
  // NFKC first: a full-width `＠` or `＃` typed to get past this is the ASCII one again here.
  let text = raw.normalize("NFKC").replace(/\r\n?/g, "\n").replace(/\t/g, " ");
  text = [...text].filter(visible).join("");
  text = text
    .replace(DISCORD_USER, REMOVED.mention)
    .replace(DISCORD_CHANNEL, REMOVED.channel)
    .replace(DISCORD_EMOJI, ":$1:")
    .replace(DISCORD_TIME, REMOVED.time);
  text = text
    .replace(MD_LINK, (_, label: string) => `${label} ${REMOVED.link}`)
    .replace(SCHEME_URL, REMOVED.link)
    .replace(BARE_SCHEME, REMOVED.link)
    .replace(WWW, REMOVED.link)
    .replace(EMAIL, REMOVED.email)
    .replace(BARE_HOST, REMOVED.link)
    .replace(LONG_ID, REMOVED.id);
  for (const name of options.redact ?? []) {
    const trimmed = name.normalize("NFKC").trim();
    if ([...trimmed].length < 2) continue;
    text = text.replace(new RegExp(escapeRegExp(trimmed), "giu"), REMOVED.name);
  }
  // What could still reach someone: no `@` and no `#` stays ASCII.
  text = text.replace(MENTION, REMOVED.mention).replace(/@/g, "＠").replace(/#/g, "＃");
  // `GH-12` links like `#12` does.
  text = text.replace(/\bGH-(\d)/gi, "GH－$1");
  if (options.singleLine) {
    text = text.replace(/\s+/g, " ");
  } else {
    text = text
      .split("\n")
      .map((line) => line.replace(/ {2,}/g, " ").trimEnd())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n");
  }
  return capChars(text.trim(), options.max);
}

/** ASCII punctuation Markdown gives a meaning to anywhere in a line. */
const MD_INLINE = /[\\`*_[\]{}()!|~]/g;

/**
 * `plainText`'s output escaped for a Markdown body: HTML is shown as text, no emphasis, code,
 * link, image, table or strike-through, and no line starts a heading, list, quote or rule.
 */
export function markdownText(plain: string): string {
  return plain
    .split("\n")
    .map((line) => {
      let out = line.replace(MD_INLINE, "\\$&");
      // A line that would start a list, a rule or a setext heading.
      out = out.replace(/^(\s*)([-+=])/, "$1\\$2").replace(/^(\s*\d+)([.)])/, "$1\\$2");
      return out.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    })
    .join("\n");
}

/** A title compared with others: lower case, without spaces or punctuation. */
export function normalizeTitle(title: string): string {
  return title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}
