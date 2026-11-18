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
//
// One block: `<feel>…</feel>`, what she felt in the exchange (docs/design/v5-heart.md §2.1), meant
// for the heart and never for people. It is swallowed whole, whatever shape it comes in: split
// over chunks, in the middle of a reply, never closed (the rest of the reply is the block), with
// attributes, self-closing, or a stray closing tag; its inside comes out as one `feel` segment.

import { asciiLower, utf8Len } from "./util.js";

/** Longest tag (bytes) the parser waits for before giving up and treating `<` as text. */
const MAX_TAG_LEN = 48;
/**
 * Longest tag with quoted attributes (bytes): `<react emoji="<:miyo_smug:112233445566778899>"/>`
 * holds a Discord emoji reference.
 */
const MAX_ATTR_TAG_LEN = 128;
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
const FEEL_OPEN = "<feel";
const FEEL_CLOSE = "</feel";
/**
 * How far the `>` of `<feel …>` is looked for. A `<feel` with no `>` before a line break or within
 * this many characters is taken as the opening all the same (she forgot the `>`).
 */
const MAX_FEEL_TAG = 64;
/**
 * The react tool imitated as a block (2026-11-17: `<react><emoji>🍚</emoji></react>` went out as
 * `<emoji>🍚</emoji>` and `</react>`): from the opening tag to its closing one is a tool written
 * as text, never words. The parser waits this many UTF-16 units for the closing tag.
 */
const MAX_TOOL_BLOCK_LEN = 200;
const TOOL_BLOCK_OPEN = /^<(react|emoji)>/;
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
  /**
   * A `<voice>` span opened and its end is not here yet: the text before it is complete. Once
   * per span, and only when the span arrives in pieces.
   */
  | { type: "spoken_start" }
  /** `<sing_start>`: a tool written as text instead of called. */
  | { type: "tool"; name: string }
  /** The inside of a `<feel>` block, as she wrote it. Never shown, never said. */
  | { type: "feel"; text: string }
  /**
   * A `<feel>` block opened and its end is not here yet: the words before it are complete (they
   * may be said now, not after the block).
   */
  | { type: "feel_start" }
  /** Markup nobody should see (`<span>`, `</span>`): dropped. */
  | { type: "markup" };

/** What the parser takes out of the text; each is a check that can be switched off. */
export interface ParserChecks {
  /** `<emo:thinking>…</emo:thinking>` is her reasoning and is never shown. */
  thinkingBlock: boolean;
  /** Tools written as tags, DeepSeek's tool-call markup and HTML tags are taken out. */
  tagStrip: boolean;
}

/**
 * Incremental parser: feed chunks with `push`, then call `finish` once the stream ends.
 */
export class ExpressionParser {
  readonly #checks: ParserChecks;
  /** Unconsumed input that may be the start of a tag. */
  #held = "";
  /** The `<voice>` span being held was announced (`spoken_start`). */
  #announced = false;
  /** A DSML tool call began: everything after it is dropped. */
  #dropRest = false;
  /** The inside of the `<feel>` block being read; `null`: not in one. */
  #feel: string | null = null;

  constructor(checks: Partial<ParserChecks> = {}) {
    this.#checks = { thinkingBlock: true, tagStrip: true, ...checks };
  }

  push(chunk: string): Segment[] {
    this.#held += chunk;
    return this.#drain(false);
  }

  /** Flushes held input; an unterminated tag becomes text. */
  finish(): Segment[] {
    return this.#drain(true);
  }

  #drain(eof: boolean): Segment[] {
    if (this.#dropRest) {
      this.#held = "";
      return [];
    }
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
    if (this.#feel !== null) {
      pos = this.#feelBody(input, lower, 0, eof, out);
      if (pos < 0) return out;
    }
    for (let start = input.indexOf("<", pos); start !== -1; start = input.indexOf("<", pos)) {
      text += input.slice(pos, start);
      const feel = feelTag(input, lower, start, eof);
      if (feel !== null) {
        flush();
        if (feel.kind === "hold") {
          this.#held = input.slice(start);
          return out;
        }
        if (feel.kind === "empty") out.push({ type: "feel", text: "" });
        if (feel.kind !== "open") {
          pos = feel.end;
          continue;
        }
        this.#feel = "";
        out.push({ type: "feel_start" });
        pos = this.#feelBody(input, lower, feel.end, eof, out);
        if (pos < 0) return out;
        continue;
      }
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
          this.#announced = false;
          pos = close === -1 ? end : close + VOICE_CLOSE.length;
          continue;
        }
        if (input.length - from <= MAX_VOICE_LEN) {
          flush();
          if (!this.#announced) out.push({ type: "spoken_start" });
          this.#announced = true;
          this.#held = input.slice(start);
          return out;
        }
        // Too long to be a spoken line: plain text.
        this.#announced = false;
      }
      const rest = lower.slice(start);
      const closing = this.#checks.thinkingBlock ? EMO_CLOSE.exec(rest) : null;
      if (closing !== null) {
        // What came before it in this stretch was written inside a block that ends here.
        text = "";
        pos = start + closing[0].length;
        continue;
      }
      if (this.#checks.thinkingBlock && !eof && EMO_CLOSE_PARTIAL.test(rest)) {
        flush();
        this.#held = input.slice(start);
        return out;
      }
      const thinking = this.#checks.thinkingBlock ? THINK_OPEN.exec(rest) : null;
      if (thinking !== null) {
        const from = start + thinking[0].length;
        const close = lower.indexOf(`</emo:${thinking[1]}>`, from);
        if (close !== -1) {
          flush();
          pos = close + (thinking[1] ?? "").length + 7;
          continue;
        }
        if (!eof && input.length - from <= MAX_THINK_LEN) {
          flush();
          this.#held = input.slice(start);
          return out;
        }
        // No closing tag in sight: the emotion it names.
      }
      const block = this.#checks.tagStrip ? TOOL_BLOCK_OPEN.exec(rest) : null;
      if (block !== null) {
        const from = start + block[0].length;
        const closeTag = `</${block[1]}>`;
        const close = lower.indexOf(closeTag, from);
        if (close !== -1 && close - from <= MAX_TOOL_BLOCK_LEN) {
          flush();
          out.push({ type: "tool", name: "react" });
          pos = close + closeTag.length;
          continue;
        }
        if (close === -1 && !eof && input.length - from <= MAX_TOOL_BLOCK_LEN) {
          flush();
          this.#held = input.slice(start);
          return out;
        }
        // No closing tag in sight: the opening tag alone is taken out below.
      }
      const scan = scanTag(input.slice(start));
      if (
        scan.kind === "tag" &&
        !this.#checks.tagStrip &&
        (scan.segment.type === "markup" || scan.segment.type === "tool")
      ) {
        text += input.slice(start, start + scan.len);
        pos = start + scan.len;
      } else if (scan.kind === "tag") {
        flush();
        if (scan.segment.type !== "markup") out.push(scan.segment);
        // A tool call written out in DeepSeek's syntax: what follows is its arguments, not words.
        if (
          DSML_OPEN.test(
            input
              .slice(start + 1, start + scan.len - 1)
              .trim()
              .toLowerCase(),
          )
        ) {
          this.#dropRest = true;
          return out;
        }
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

  /**
   * Reads the inside of the open `<feel>` block from `from`: up to its closing tag, the position
   * after it; `-1` when the input ran out first (what may be a closing tag in pieces is held;
   * at the end of the stream the block ends there).
   */
  #feelBody(input: string, lower: string, from: number, eof: boolean, out: Segment[]): number {
    let p = from;
    for (;;) {
      const close = lower.indexOf(FEEL_CLOSE, p);
      if (close === -1) {
        const lt = input.lastIndexOf("<");
        const partial = lt >= p && FEEL_CLOSE.startsWith(lower.slice(lt));
        this.#feel = (this.#feel ?? "") + input.slice(p, partial ? lt : input.length);
        if (partial && !eof) {
          this.#held = input.slice(lt);
          return -1;
        }
        if (eof) this.#endFeel(out);
        return -1;
      }
      const after = close + FEEL_CLOSE.length;
      let i = after;
      while (i < input.length && (input[i] === " " || input[i] === "\t")) i++;
      if (i >= input.length && !eof) {
        this.#feel = (this.#feel ?? "") + input.slice(p, close);
        this.#held = input.slice(close);
        return -1;
      }
      if (i >= input.length || input[i] === ">") {
        this.#feel = (this.#feel ?? "") + input.slice(p, close);
        this.#endFeel(out);
        return Math.min(i + 1, input.length);
      }
      // `</feeling…`: words of the block, not its end.
      this.#feel = (this.#feel ?? "") + input.slice(p, after);
      p = after;
    }
  }

  #endFeel(out: Segment[]): void {
    out.push({ type: "feel", text: this.#feel ?? "" });
    this.#feel = null;
  }
}

/** What a `<` at `start` is as far as a feel block goes. */
type FeelTag =
  /** Not a feel tag. */
  | null
  /** May become one once more input arrives. */
  | { kind: "hold" }
  /** `<feel>` (or `<feel …>`): the block starts at `end`. */
  | { kind: "open"; end: number }
  /** `<feel/>`, or a `<feel` cut off by the end of the stream: an empty block. */
  | { kind: "empty"; end: number }
  /** `</feel>` with no block open: dropped. */
  | { kind: "close"; end: number };

function isSpace(c: string | undefined): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r";
}

function feelTag(input: string, lower: string, start: number, eof: boolean): FeelTag {
  // The stream ended in the middle of the tag (`<fee`, `</fe`): what there is goes too.
  const rest = lower.slice(start);
  if (eof && rest.length >= 3 && (FEEL_OPEN.startsWith(rest) || FEEL_CLOSE.startsWith(rest))) {
    return { kind: rest.startsWith("</") ? "close" : "empty", end: input.length };
  }
  if (lower.startsWith(FEEL_CLOSE, start)) {
    let i = start + FEEL_CLOSE.length;
    const next = input[i];
    if (next !== undefined && next !== ">" && !isSpace(next)) return null;
    while (i < input.length && (input[i] === " " || input[i] === "\t")) i++;
    if (i >= input.length) return eof ? { kind: "close", end: input.length } : { kind: "hold" };
    return input[i] === ">" ? { kind: "close", end: i + 1 } : null;
  }
  if (!lower.startsWith(FEEL_OPEN, start)) return null;
  const after = start + FEEL_OPEN.length;
  const next = input[after];
  if (next === undefined) return eof ? { kind: "empty", end: input.length } : { kind: "hold" };
  if (next === ">") return { kind: "open", end: after + 1 };
  if (next !== "/" && !isSpace(next)) return null;
  for (let i = after; i < input.length; i++) {
    const c = input[i];
    if (c === ">") {
      const inside = input.slice(after, i).trimEnd();
      return inside.endsWith("/") ? { kind: "empty", end: i + 1 } : { kind: "open", end: i + 1 };
    }
    // No `>` on the tag's line, or none for a while: she forgot it; the block starts here.
    if (c === "\n" || i - start >= MAX_FEEL_TAG) return { kind: "open", end: after };
  }
  return eof ? { kind: "open", end: after } : { kind: "hold" };
}

type Scan =
  /** A complete tag of `len` UTF-16 units (including `<` and `>`). */
  | { kind: "tag"; segment: Segment; len: number }
  /** Could still become a tag once more input arrives. */
  | { kind: "partial" }
  | { kind: "not_a_tag" };

/** `s` starts with `<`. */
function scanTag(s: string): Scan {
  // `<name key="…">`: a `>` inside the quotes does not end the tag (`emoji="<:smug:1>"`).
  const quoted = ATTR_START.test(s);
  const max = quoted ? MAX_ATTR_TAG_LEN : MAX_TAG_LEN;
  const end = quoted ? (tagEnd(s) ?? s.indexOf(">")) : s.indexOf(">");
  if (end !== -1) {
    if (utf8Len(s.slice(0, end)) > max) return { kind: "not_a_tag" };
    const segment = parseTag(s.slice(1, end));
    if (segment) return { kind: "tag", segment, len: end + 1 };
    if (quoted && tagEnd(s) === null && utf8Len(s) <= max && isTagPrefix(s.slice(1))) {
      return { kind: "partial" };
    }
    return { kind: "not_a_tag" };
  }
  if (utf8Len(s) <= max && isTagPrefix(s.slice(1))) return { kind: "partial" };
  return { kind: "not_a_tag" };
}

/** A tag name followed by whitespace: its attributes may be quoted. */
const ATTR_START = /^<\/?[a-z][a-z0-9_]*\s/i;

/** Index of the `>` that ends the tag at the start of `s`, skipping quoted values; `null` if none. */
function tagEnd(s: string): number | null {
  let quote: string | null = null;
  for (let i = 1; i < s.length; i++) {
    const c = s[i] as string;
    if (quote !== null) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return i;
    }
  }
  return null;
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
  if (HTML_TAG.test(tag)) return { type: "markup" };
  if (DSML_TAG.test(tag)) return { type: "markup" };
  if (STRAY_TAG.test(tag)) return { type: "markup" };
  // `<react emoji="👍"/>`: the react tool imitated as a tag (2026-11-12). Hidden from the text and
  // logged as a tool written as text, so she is asked once to call it for real.
  if (REACT_TAG.test(tag)) return { type: "tool", name: "react" };
  if (TOOL_TAG.test(tag)) return { type: "tool", name: tag };
  const call = TOOL_CALL_TAG.exec(tag);
  if (call !== null) return { type: "tool", name: call[1] as string };
  return null;
}

/**
 * HTML she writes as if the chat rendered it (2026-11-10/11: `<p>`, `</p>`, `<section>`,
 * `<h>我沒有亂…`): the tag is dropped, the text stays. Only these names, with their attributes:
 * `a < b 和 c > d`, `vector<int>`, `a<i>b`, `<Sakana2486>` and Discord's `<@id>`, `<#id>`,
 * `<:name:id>`, `<t:…>` are not tags.
 */
const HTML_TAG =
  /^\/?(?:h[1-6]?|p|section|div|span|br|hr|em|strong|small|ul|ol|li|article|header|footer|blockquote|center|font|mark)(?:\s[a-z0-9_ ="'-]*)?\s*\/?$/;
/**
 * DeepSeek's own tool-call syntax written into the text (`<｜｜DSML｜｜ invoke name=…>`,
 * `</｜DSML｜ parameter>`, 2026-11-08/11): never words for people. Bars full or half width.
 */
const DSML_TAG = /^\/?[｜|]+\s*dsml/;
const DSML_OPEN = /^[｜|]+\s*dsml/;
/**
 * What is left of her own tags when they come apart: a closing tag without its opening one
 * (`</react>`, `</emo>`), or the react tool's `<emoji>` on its own (2026-11-16/17).
 */
const STRAY_TAG = /^(?:\/(?:react|emoji|emo)|emoji)$/;
const REACT_TAG = /^react(?:\s[^<>]*)?$/;
/** Tool names are snake_case; an ordinary word in brackets stays text. */
const TOOL_TAG = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
/**
 * A tool written as a tag with its arguments as attributes, any value in the quotes
 * (2026-11-11: `<react emoji="👍"/>` went out as text), or as a bare self-closing tag
 * (`<react/>`). The name needs no underscore here: the quoted attribute or the `/` marks it.
 */
const TOOL_CALL_TAG =
  /^([a-z][a-z0-9_]*)(?:(?:\s+[a-z_][a-z0-9_-]*\s*=\s*(?:"[^"]*"|'[^']*'))+\s*\/?|\s*\/)$/u;
/**
 * What a tag above can look like before its `>` arrives. A quoted value may hold anything
 * (an emoji), and may still be open.
 */
const MARKUP_PREFIX =
  /^\/?[a-z][a-z0-9_]*(?:\s(?:[a-z0-9_ =/-]|"[^"]*"|'[^']*')*(?:"[^"]*|'[^']*)?)?\/?$/u;

/** A letter of any script: `<emo:開心>` is an emotion tag too, never words (2026-11-17). */
function isNameChar(c: string): boolean {
  return /^[\p{L}0-9_-]$/u.test(c);
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
  if (/^\/?[｜|]/.test(lower)) return true;
  if (/^react\s/.test(lower)) return !/[<]/.test(lower);
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
  /** The inside of each `<feel>` block, in order (never part of `text`). */
  feel: string[] = [];

  static parse(s: string): Expression {
    const parser = new ExpressionParser();
    const out = new Expression();
    for (const segment of [...parser.push(s), ...parser.finish()]) out.apply(segment);
    return out;
  }

  /** Folds one segment in. Once silent, the rest of the reply is ignored but her feel blocks. */
  apply(segment: Segment): void {
    if (segment.type === "feel") {
      this.feel.push(segment.text);
      return;
    }
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
      case "spoken_start":
      case "feel_start":
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
