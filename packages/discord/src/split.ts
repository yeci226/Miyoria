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

/** The marker of a code block. */
const FENCE = "```";
/** What closes a block left open at the end of a chunk. */
const FENCE_CLOSE = `\n${FENCE}`;
/** A language after an opening fence (` ```ts `); anything else is the block's first line. */
const FENCE_LANG = /^[\w+#.-]{1,24}$/;
/** Below this limit a chunk has no room for the fences added around a cut block. */
const MIN_FENCED_LIMIT = 64;

/**
 * Text that only means something whole: a code fence, a custom emoji, a mention of a user, role
 * or channel, a timestamp, a link. A cut inside one would show its two halves as plain text.
 */
const ATOMIC =
  /```|<a?:\w{2,32}:\d{1,20}>|<(?:@[!&]?|#)\d{1,20}>|<t:-?\d{1,16}(?::[A-Za-z])?>|https?:\/\/[^\s<>]+/g;

/** `[start, end)` in code points of every `ATOMIC` match no longer than `maxLength`. */
function atomicSpans(text: string, maxLength: number): [number, number][] {
  const spans: [number, number][] = [];
  let unit = 0;
  let point = 0;
  // Matches come in order, so one walk turns their UTF-16 offsets into code point indexes.
  const pointAt = (offset: number): number => {
    while (unit < offset) {
      unit += (text.codePointAt(unit) as number) > 0xffff ? 2 : 1;
      point++;
    }
    return point;
  };
  for (const m of text.matchAll(ATOMIC)) {
    const start = pointAt(m.index);
    const end = pointAt(m.index + m[0].length);
    if (end - start <= maxLength) spans.push([start, end]);
  }
  return spans;
}

/**
 * The code block open after `body`: its opening fence with the language (` ```ts `), or `null`
 * when every block is closed. `open`: the block `body` starts in.
 */
function fenceAfter(body: string, open: string | null): string | null {
  let state = open;
  for (let at = body.indexOf(FENCE); at !== -1; at = body.indexOf(FENCE, at + FENCE.length)) {
    if (state !== null) {
      state = null;
      continue;
    }
    const rest = body.slice(at + FENCE.length);
    const line = rest.indexOf("\n");
    const lang = (line === -1 ? rest : rest.slice(0, line)).trim();
    state = FENCE_LANG.test(lang) ? `${FENCE}${lang}` : FENCE;
  }
  return state;
}

/**
 * Splits `text` into chunks of at most `limit` UTF-16 code units (which is never more than
 * Discord's character count, even for emoji).
 *
 * Breaks preferably at a newline, then at whitespace, then after CJK punctuation, and only cuts
 * mid-word when nothing else is found in the second half of a chunk. Never splits inside a
 * character (code point), nor inside a custom emoji, a mention, a timestamp or a link (unless
 * one is longer than half a chunk). The break character itself is dropped; whitespace-only
 * chunks are skipped.
 *
 * A code block cut by a break is closed at the end of its chunk and opened again, with its
 * language, at the start of the next one, so every chunk shows as the whole message would.
 */
export function splitMessage(text: string, limit: number): string[] {
  const max = Math.max(limit, 2);
  const chars = Array.from(text);
  const fenced = max >= MIN_FENCED_LIMIT && text.includes(FENCE);
  const atoms = atomicSpans(text, Math.floor(max / 2));
  const out: string[] = [];
  let pos = 0;
  /** The code block the next chunk starts in. */
  let open: string | null = null;
  while (pos < chars.length) {
    const prefix = open === null ? "" : `${open}\n`;
    const budget = fenced ? max - prefix.length - FENCE_CLOSE.length : max;
    const fit = fittingPrefix(chars, pos, budget);
    let end = fit;
    let next = fit;
    if (pos + fit < chars.length) {
      [end, next] = breakPoint(chars.slice(pos, pos + fit)) ?? [fit, fit];
      const cut = pos + end;
      const atom = atoms.find(([from, to]) => from < cut && cut < to);
      if (atom !== undefined && atom[0] > pos) {
        end = atom[0] - pos;
        next = end;
      }
    }
    const body = chars.slice(pos, pos + end).join("");
    open = pushChunk(out, body, fenced ? open : null, fenced);
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

/**
 * Adds `body` as a chunk unless it is blank, inside the fences of the block it starts in
 * (`open`) and ends in. Returns the block open after it.
 */
function pushChunk(
  out: string[],
  body: string,
  open: string | null,
  fenced: boolean,
): string | null {
  if (!fenced) {
    const trimmed = body.trimEnd();
    if (trimmed.trimStart().length > 0) out.push(trimmed);
    return null;
  }
  let text = body.trimEnd();
  let prefix = open === null ? "" : `${open}\n`;
  // The block ends right here: its closing fence alone needs no block opened for it.
  if (open !== null && text.trimStart().startsWith(FENCE)) {
    text = text
      .trimStart()
      .slice(FENCE.length)
      .replace(/^[^\S\n]*\n?/, "");
    prefix = "";
    open = null;
  }
  const after = fenceAfter(text, open);
  let close = after === null ? "" : FENCE_CLOSE;
  // The chunk ends on an opening fence: the block opens in the next chunk instead.
  if (
    after !== null &&
    text.endsWith(after) &&
    fenceAfter(text.slice(0, -after.length), open) === null
  ) {
    text = text.slice(0, -after.length).trimEnd();
    close = "";
  }
  if (text.trim().length > 0) out.push(`${prefix}${text}${close}`);
  return after;
}
