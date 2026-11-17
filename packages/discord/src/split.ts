// Splitting long text into Discord-sized messages.

/** Discord's message length limit. */
export const MAX_MESSAGE_LEN = 2000;

/** Sentence and clause punctuation after which CJK text may be broken. */
const CJK_BREAKS: ReadonlySet<string> = new Set([
  "。",
  "！",
  "？",
  "，",
  "、",
  "；",
  "：",
  "」",
  "』",
  "）",
  "…",
]);

const WHITESPACE = /^\p{White_Space}$/u;

/** UTF-8 byte length of one code point. */
function utf8Length(ch: string): number {
  const cp = ch.codePointAt(0) as number;
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}

/**
 * Splits `text` into chunks of at most `limit` UTF-16 code units (which is never more than
 * Discord's character count, even for emoji).
 *
 * Breaks preferably at a newline, then at whitespace, then after CJK punctuation, and only cuts
 * mid-word when nothing else is found in the second half of a chunk. Never splits inside a
 * character (code point). The break character itself is dropped; whitespace-only chunks are
 * skipped.
 */
export function splitMessage(text: string, limit: number): string[] {
  const max = Math.max(limit, 2);
  const chars = Array.from(text);
  const out: string[] = [];
  let pos = 0;
  while (pos < chars.length) {
    const fit = fittingPrefix(chars, pos, max);
    if (pos + fit === chars.length) {
      pushChunk(out, chars.slice(pos).join(""));
      break;
    }
    const head = chars.slice(pos, pos + fit);
    const [end, next] = breakPoint(head) ?? [fit, fit];
    pushChunk(out, head.slice(0, end).join(""));
    pos += next;
  }
  return out;
}

/** Number of code points from `start` that fit in `limit` UTF-16 units (at least one). */
function fittingPrefix(chars: readonly string[], start: number, limit: number): number {
  let units = 0;
  let count = 0;
  for (let i = start; i < chars.length; i++) {
    units += (chars[i] as string).length;
    if (units > limit) return Math.max(count, 1);
    count++;
  }
  return count;
}

/**
 * `[chunk end, next chunk start]` as code point indexes within `head`, searched in its second
 * half (by UTF-8 bytes).
 */
function breakPoint(head: readonly string[]): [number, number] | null {
  const offsets: number[] = [];
  let bytes = 0;
  for (const ch of head) {
    offsets.push(bytes);
    bytes += utf8Length(ch);
  }
  const min = Math.floor(bytes / 2);
  const find = (pred: (ch: string) => boolean): number => {
    for (let i = head.length - 1; i >= 0 && (offsets[i] as number) >= min; i--) {
      if (pred(head[i] as string)) return i;
    }
    return -1;
  };
  let i = find((ch) => ch === "\n");
  if (i < 0) i = find((ch) => WHITESPACE.test(ch));
  if (i >= 0) return [i, i + 1];
  i = find((ch) => CJK_BREAKS.has(ch));
  return i >= 0 ? [i + 1, i + 1] : null;
}

function pushChunk(out: string[], chunk: string): void {
  const trimmed = chunk.trimEnd();
  if (trimmed.trimStart().length > 0) out.push(trimmed);
}
