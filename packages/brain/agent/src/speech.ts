// Cuts streamed reply text into sentences, so each one can be sent to TTS as soon as it is
// complete.
//
// Sentences end at `。！？!?…~～` and line breaks (a run such as `……` or `?!` stays together,
// as do closing quotes and brackets after it). A clause that grew past `LONG_CLAUSE_CHARS` is
// also cut at the next comma.

import { isAlphanumeric } from "./util.js";

/** Characters that end a sentence. */
const SENTENCE_ENDS = new Set(["。", "！", "？", "!", "?", "…", "~", "～", "\n"]);
/** Commas that end a clause once it is long. */
const CLAUSE_BREAKS = new Set(["，", ","]);
/** Kept with the sentence they follow. */
const CLOSERS = new Set(["」", "』", "）", ")", "】", '"', "”", "’", "'"]);

/** A clause this long (in characters) is cut at the next comma. */
export const LONG_CLAUSE_CHARS = 40;

/** Incremental splitter: `push` text as it streams in, then `flush` the rest at the end. */
export class SentenceSplitter {
  #buf = "";

  /** Adds text; returns the sentences it completed (trimmed, non-empty). */
  push(text: string): string[] {
    this.#buf += text;
    const out: string[] = [];
    for (let end = this.#cut(); end !== null; end = this.#cut()) {
      const sentence = this.#buf.slice(0, end).trim();
      this.#buf = this.#buf.slice(end);
      if (sentence !== "") out.push(sentence);
    }
    return out;
  }

  /**
   * Takes the held text if it is a finished sentence (it ends with an end mark that was waiting
   * for more input), e.g. before a new emotion starts.
   */
  flushComplete(): string | null {
    const last = [...this.#buf.trimEnd()].at(-1);
    if (last === undefined) return null;
    return SENTENCE_ENDS.has(last) || CLOSERS.has(last) ? this.flush() : null;
  }

  /** Takes the unfinished rest as a sentence, if there is any text. */
  flush(): string | null {
    const rest = this.#buf.trim();
    this.#buf = "";
    return rest === "" ? null : rest;
  }

  /**
   * Index just past the first complete sentence in the buffer. A sentence end at the very end
   * of the buffer is not complete yet: more end marks (`…` after `…`) may follow in the next
   * chunk.
   */
  #cut(): number | null {
    const leading = this.#buf.length - this.#buf.trimStart().length;
    const body = this.#buf.slice(leading);
    let n = 0;
    let i = 0;
    for (const c of body) {
      const ends = SENTENCE_ENDS.has(c) || (n >= LONG_CLAUSE_CHARS && CLAUSE_BREAKS.has(c));
      if (ends) {
        let end = i + c.length;
        for (const next of body.slice(end)) {
          if (SENTENCE_ENDS.has(next) || CLOSERS.has(next)) end += next.length;
          else break;
        }
        return end < body.length ? leading + end : null;
      }
      n++;
      i += c.length;
    }
    return null;
  }
}

/**
 * Whether `text` has anything a TTS engine can say (letters or digits in any script, not just
 * punctuation or symbols).
 */
export function isSpeakable(text: string): boolean {
  for (const c of text) if (isAlphanumeric(c)) return true;
  return false;
}

/** A piece of streamed text: inside a ``` code block or not. */
export interface FencedPiece {
  code: boolean;
  text: string;
}

const FENCE = "```";

/**
 * Separates ``` code blocks from the text around them as it streams in, so code is never read
 * out. A fence split across chunks is held until it is complete.
 */
export class FenceSplitter {
  #inside = false;
  #held = "";
  #code = "";

  push(text: string): FencedPiece[] {
    let buf = this.#held + text;
    this.#held = "";
    const out: FencedPiece[] = [];
    for (;;) {
      const at = buf.indexOf(FENCE);
      if (at === -1) {
        // Trailing backticks may be the start of a fence.
        const keep = /`{1,2}$/.exec(buf)?.[0].length ?? 0;
        const body = buf.slice(0, buf.length - keep);
        this.#held = buf.slice(buf.length - keep);
        if (this.#inside) this.#code += body;
        else if (body !== "") out.push({ code: false, text: body });
        return out;
      }
      const before = buf.slice(0, at);
      buf = buf.slice(at + FENCE.length);
      if (this.#inside) {
        out.push({ code: true, text: this.#code + before });
        this.#code = "";
      } else if (before !== "") {
        out.push({ code: false, text: before });
      }
      this.#inside = !this.#inside;
    }
  }

  /** The rest at the end of the response; an unclosed block counts as code. */
  flush(): FencedPiece[] {
    const rest = this.#held;
    this.#held = "";
    if (this.#inside) {
      const code = this.#code + rest;
      this.#code = "";
      this.#inside = false;
      return code === "" ? [] : [{ code: true, text: code }];
    }
    return rest === "" ? [] : [{ code: false, text: rest }];
  }
}

/** A URL (ASCII only, so text right after it in another script is not swallowed). */
const LINK = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'*+,;=%]+/;
const SCHEMES = ["https://", "http://"];

/** A link without the punctuation that ends the sentence around it. */
function trimLink(match: string): string {
  return match.replace(/[.,!?;:)\]]+$/, "");
}

/**
 * Takes links out of streamed text before it is cut into sentences (a `?` in a URL would end
 * the sentence). A link that reaches the end of the text so far, or a possible start of one
 * (`htt`), is held until more text arrives. Pieces with `code: true` are the links.
 */
export class LinkSplitter {
  #buf = "";

  push(text: string): FencedPiece[] {
    this.#buf += text;
    const out: FencedPiece[] = [];
    for (;;) {
      const buf = this.#buf;
      const m = LINK.exec(buf);
      if (m === null) {
        let keep = 0;
        for (let k = Math.min(buf.length, 8); k > 0; k--) {
          const tail = buf.slice(-k);
          if (SCHEMES.some((s) => s.startsWith(tail))) {
            keep = k;
            break;
          }
        }
        const body = buf.slice(0, buf.length - keep);
        if (body !== "") out.push({ code: false, text: body });
        this.#buf = buf.slice(buf.length - keep);
        return out;
      }
      if (m.index > 0) out.push({ code: false, text: buf.slice(0, m.index) });
      // It may go on in the next chunk.
      if (m.index + m[0].length === buf.length) {
        this.#buf = buf.slice(m.index);
        return out;
      }
      const link = trimLink(m[0]);
      out.push({ code: true, text: link });
      this.#buf = buf.slice(m.index + link.length);
    }
  }

  /** The held rest at the end of the response. */
  flush(): FencedPiece[] {
    const out = this.push("");
    const rest = this.#buf;
    this.#buf = "";
    if (rest === "") return out;
    // Held: a link that reached the end, or the start of a scheme.
    if (LINK.exec(rest)?.index === 0) {
      const link = trimLink(rest);
      out.push({ code: true, text: link });
      if (link.length < rest.length) out.push({ code: false, text: rest.slice(link.length) });
    } else {
      out.push({ code: false, text: rest });
    }
    return out;
  }
}
