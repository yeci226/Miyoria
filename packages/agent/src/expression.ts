// Streaming parser for the tagged reply format.
//
//     <emo:happy>欸你回來啦!<pause 300/>今天的考試怎麼樣?
//
// Recognised tags: `<emo:name>` (or `<emo:name 0.5>` with an intensity 0..1), `<pause N/>`
// (milliseconds) and `<silence/>`. Tags may be split across chunks; anything that does not form
// a valid tag is passed through as text.
//
// One span: `<voice>…</voice>`, the words she says out loud for the text that follows, when she
// is heard in another language than she writes (`VoiceSink.speaksIn`):
//
//     <voice>えっ、本当に?</voice>欸,真的嗎?
//
// It is not part of her text (subtitles, chat log and history keep the written line).

import { asciiLower, utf8Len } from "./util.js";

/** Longest tag (bytes) the parser waits for before giving up and treating `<` as text. */
const MAX_TAG_LEN = 48;
const VOICE_OPEN = "<voice>";
const VOICE_CLOSE = "</voice>";
/** Longest `<voice>` span (UTF-16 units) the parser waits for its closing tag. */
const MAX_VOICE_LEN = 600;
const MAX_EMOTION_LEN = 32;
/**
 * `<emo:thinking>` (or `think`, `thought`) is an emotion name she may use, and a model that
 * thinks aloud reads it as a thinking block: `<emo:thinking>the plan</emo:thinking>the reply`.
 * Text up to such a closing tag is her reasoning and is never shown (2026-11-09, five times in
 * the log). The parser waits this many UTF-16 units for the closing tag before it gives up and
 * takes the tag as the emotion it names.
 */
const MAX_THINK_LEN = 1200;
const THINK_OPEN = /^<emo:(thinking|think|thought)(?: [0-9.]+)?>/;
/** A closing emotion tag never says anything: `</emo:thinking>`. */
const EMO_CLOSE = /^<\/emo:[a-z0-9_-]{1,32}>/;
const EMO_CLOSE_PARTIAL = /^<\/(?:e(?:m(?:o(?::[a-z0-9_-]{0,32})?)?)?)?$/;
export const DEFAULT_PAUSE_MS = 300;
export const MAX_PAUSE_MS = 10_000;

export type Segment =
  /** Clean text. Consecutive text segments belong together. */
  | { type: "text"; text: string }
  /** Lower-cased emotion name, with the intensity (0..1) when the tag gave one. */
  | { type: "emotion"; emotion: string; intensity?: number }
  | { type: "pause"; ms: number }
  | { type: "silence" }
  /** `<voice>…</voice>`: what she says out loud for the text that follows. */
  | { type: "spoken"; text: string }
  /** `<sing_start>`: a tool written as text instead of called. */
  | { type: "tool"; name: string }
  /** Markup nobody should see (`<span>`, `</span>`): dropped. */
  | { type: "markup" };

/**
 * Incremental parser: feed chunks with `push`, then call `finish` once the stream ends.
 */
export class ExpressionParser {
  /** Unconsumed input that may be the start of a tag. */
  #held = "";

  push(chunk: string): Segment[] {
    this.#held += chunk;
    return this.#drain(false);
  }

  /** Flushes held input; an unterminated tag becomes text. */
  finish(): Segment[] {
    return this.#drain(true);
  }

  #drain(eof: boolean): Segment[] {
    const input = this.#held;
    this.#held = "";
    const out: Segment[] = [];
    let text = "";
    const flush = (): void => {
      if (text !== "") {
        out.push({ type: "text", text });
        text = "";
      }
    };
    let pos = 0;
    const lower = asciiLower(input);
    for (let start = input.indexOf("<", pos); start !== -1; start = input.indexOf("<", pos)) {
      text += input.slice(pos, start);
      if (lower.startsWith(VOICE_CLOSE, start)) {
        // A closing tag without its opening one says nothing.
        pos = start + VOICE_CLOSE.length;
        continue;
      }
      if (lower.startsWith(VOICE_OPEN, start)) {
        const from = start + VOICE_OPEN.length;
        const close = lower.indexOf(VOICE_CLOSE, from);
        if (close !== -1 || eof) {
          flush();
          const end = close === -1 ? input.length : close;
          out.push({ type: "spoken", text: input.slice(from, end) });
          pos = close === -1 ? end : close + VOICE_CLOSE.length;
          continue;
        }
        if (input.length - from <= MAX_VOICE_LEN) {
          flush();
          this.#held = input.slice(start);
          return out;
        }
        // Too long to be a spoken line: plain text.
      }
      const rest = lower.slice(start);
      const closing = EMO_CLOSE.exec(rest);
      if (closing !== null) {
        // What came before it in this stretch was written inside a block that ends here.
        text = "";
        pos = start + closing[0].length;
        continue;
      }
      if (!eof && EMO_CLOSE_PARTIAL.test(rest)) {
        flush();
        this.#held = input.slice(start);
        return out;
      }
      const thinking = THINK_OPEN.exec(rest);
      if (thinking !== null) {
        const from = start + thinking[0].length;
        const close = lower.indexOf(`</emo:${thinking[1]}>`, from);
        if (close !== -1) {
          flush();
          pos = close + thinking[1]!.length + 7;
          continue;
        }
        if (!eof && input.length - from <= MAX_THINK_LEN) {
          flush();
          this.#held = input.slice(start);
          return out;
        }
        // No closing tag in sight: the emotion it names.
      }
      const scan = scanTag(input.slice(start));
      if (scan.kind === "tag") {
        flush();
        if (scan.segment.type !== "markup") out.push(scan.segment);
        pos = start + scan.len;
      } else if (scan.kind === "partial" && !eof) {
        flush();
        this.#held = input.slice(start);
        return out;
      } else {
        text += "<";
        pos = start + 1;
      }
    }
    text += input.slice(pos);
    flush();
    return out;
  }
}

type Scan =
  /** A complete tag of `len` UTF-16 units (including `<` and `>`). */
  | { kind: "tag"; segment: Segment; len: number }
  /** Could still become a tag once more input arrives. */
  | { kind: "partial" }
  | { kind: "not_a_tag" };

/** `s` starts with `<`. */
function scanTag(s: string): Scan {
  const end = s.indexOf(">");
  if (end !== -1) {
    if (utf8Len(s.slice(0, end)) > MAX_TAG_LEN) return { kind: "not_a_tag" };
    const segment = parseTag(s.slice(1, end));
    return segment ? { kind: "tag", segment, len: end + 1 } : { kind: "not_a_tag" };
  }
  if (utf8Len(s) <= MAX_TAG_LEN && isTagPrefix(s.slice(1))) return { kind: "partial" };
  return { kind: "not_a_tag" };
}

function trimEndSpaces(s: string): string {
  return s.trimEnd();
}

/** Parses the inside of `<...>`. */
function parseTag(raw: string): Segment | null {
  let body = raw.trim();
  if (body.endsWith("/")) body = trimEndSpaces(body.slice(0, -1));
  const lower = asciiLower(body);
  if (lower.startsWith("emo:")) {
    // `<emo:name>` or `<emo:name 0.5>` (intensity 0..1).
    const [name = "", level, ...extra] = lower.slice(4).trim().split(/ +/);
    const valid = name !== "" && utf8Len(name) <= MAX_EMOTION_LEN && [...name].every(isNameChar);
    if (!valid || extra.length > 0) return null;
    if (level === undefined) return { type: "emotion", emotion: name };
    if (!/^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/.test(level)) return null;
    return { type: "emotion", emotion: name, intensity: Math.min(Number(level), 1) };
  }
  if (lower === "silence") return { type: "silence" };
  if (lower.startsWith("pause")) {
    const rest = lower.slice(5);
    if (rest === "") return { type: "pause", ms: DEFAULT_PAUSE_MS };
    if (!rest.startsWith(" ") && !rest.startsWith("=")) return null;
    let digits = rest.replace(/^[ =]+/, "");
    if (digits.endsWith("ms")) digits = digits.slice(0, -2);
    digits = digits.trimEnd();
    if (digits === "" || !/^[0-9]+$/.test(digits)) return null;
    const parsed = Number(digits);
    const ms = Number.isSafeInteger(parsed) ? Math.min(parsed, MAX_PAUSE_MS) : MAX_PAUSE_MS;
    return { type: "pause", ms };
  }
  // Models imitate the tags they know: an emotion as an HTML attribute, a tool as a tag. Both are
  // kept out of what people see. `Expression.tools` is for the log: text never runs a tool.
  const tag = asciiLower(raw);
  const emotion = /^span\s+emo\s*=\s*["']?([a-z0-9_-]+)["']?$/.exec(tag);
  if (emotion !== null) return { type: "emotion", emotion: emotion[1] as string };
  if (SPAN_TAG.test(tag)) return { type: "markup" };
  if (TOOL_TAG.test(tag)) return { type: "tool", name: tag };
  return null;
}

/** `<span>` and `</span>`, exactly: `a < b 和 c > d` is not a tag. */
const SPAN_TAG = /^\/?span(?:\s[a-z0-9_ ="'-]*)?$/;
/** Tool names are snake_case; an ordinary word in brackets stays text. */
const TOOL_TAG = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
/** What a tag above can look like before its `>` arrives. */
const MARKUP_PREFIX = /^\/?[a-z][a-z0-9_]*(?:\s[a-z0-9_ ="'-]*)?$/;

function isNameChar(c: string): boolean {
  return /^[A-Za-z0-9_-]$/.test(c);
}

const PREFIXES: readonly [string, (c: string) => boolean][] = [
  ["emo:", (c) => isNameChar(c) || c === " " || c === "." || c === "/"],
  [
    "pause",
    (c) => /^[0-9]$/.test(c) || c === " " || c === "=" || c === "m" || c === "s" || c === "/",
  ],
  ["silence", (c) => c === " " || c === "/"],
  ["voice", () => false],
  ["/voice", () => false],
];

/** Whether `rest` (input after `<`, no `>` yet) can still grow into a tag. */
function isTagPrefix(rest: string): boolean {
  const lower = asciiLower(rest);
  if (MARKUP_PREFIX.test(lower)) return true;
  return PREFIXES.some(
    ([keyword, ok]) =>
      keyword.startsWith(lower) ||
      (lower.startsWith(keyword) && [...lower.slice(keyword.length)].every(ok)),
  );
}

/** Everything a complete reply expressed, folded from segments. */
export class Expression {
  text = "";
  emotions: string[] = [];
  /** Tools written as tags, in order. */
  tools: string[] = [];
  /** `<silence/>` came before any visible text: she chose not to reply. */
  silence = false;

  static parse(s: string): Expression {
    const parser = new ExpressionParser();
    const out = new Expression();
    for (const segment of [...parser.push(s), ...parser.finish()]) out.apply(segment);
    return out;
  }

  /** Folds one segment in. Once silent, the rest of the reply is ignored. */
  apply(segment: Segment): void {
    if (this.silence) return;
    switch (segment.type) {
      case "text":
        this.text += segment.text;
        break;
      case "emotion":
        this.emotions.push(segment.emotion);
        break;
      case "tool":
        this.tools.push(segment.name);
        break;
      case "pause":
      case "spoken":
      case "markup":
        break;
      case "silence":
        if (this.text.trim() === "") this.silence = true;
        break;
    }
  }

  /** Nothing should be sent. */
  isSilent(): boolean {
    return this.silence || this.text.trim() === "";
  }
}
