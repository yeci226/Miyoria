// From the text of one model step to the lines that may leave, as it streams. These are the
// screens the new runner keeps from today's turn (docs/design/v4-patches.md §2, owner decision
// Q8), each of them today's code:
//
// - #11 `<emo:thinking>…</emo:thinking>` is her reasoning and is never shown; #18 a tool written
//   as a tag, DeepSeek's tool-call markup and HTML tags are taken out (`ExpressionParser`);
// - #9 a response that turns out to be reasoning is dropped from the line that shows it, the held
//   first line included (`ReplyScreen`);
// - #19 a line she wrote to herself about how to answer is left out, the rest stays (`isSelfTalk`).
//
// One line of text is one message; a ``` block stays one message whatever its line breaks
// (`FenceSplitter`). Nothing here knows where a line goes.
//
// Spoken (`unit: "sentence"`, the voice profile), the text is cut into sentences as it streams
// (`SentenceSplitter`), so each can be said while the rest is written, and each sentence is judged
// on its own (#10, today's `Speech`): one that is reasoning or a note to herself is not said, the
// others are; nothing is held back waiting for the next. Links and ``` blocks are never read out:
// each comes as a line of its own (`asideLine`), for the outlet to put in writing.
//
// Her `<feel>` blocks (docs/design/v5-heart.md §2.1) never go out: the parser swallows them and
// they are kept apart (`feel`) for the host to apply; a line that reads like one written without
// its tags is left out too (`isFeelLine`). A step that is only a feel block is silent, as with
// `<silence/>`, and its feel still counts.

import {
  ExpressionParser,
  FenceSplitter,
  isSelfTalk,
  isSpeakable,
  LinkSplitter,
  looksLikeReasoning,
  ReplyScreen,
  type Segment,
  SentenceSplitter,
} from "../../agent/src/index.js";
import { isFeelLine } from "./feel.js";

export interface ScreenedLine {
  text: string;
  /** The emotion she last marked before the line ended. */
  emotion: string | null;
}

/** What one line of her text is: a message (text), or a sentence that is said (voice). */
export type TextUnit = "line" | "sentence";

/** A line of spoken text that is not said: a link or a ``` block (`unit: "sentence"`). */
export function asideLine(text: string): boolean {
  const t = text.trim();
  return (t.startsWith("```") && t.endsWith("```")) || /^https?:\/\/\S+$/.test(t);
}

/**
 * The output checks the runner keeps, each of them switchable for debugging
 * (`[modules.agent.corrections]`). All on is how she runs.
 */
export interface OutputChecks {
  /** #9: a text response that turns out to be reasoning is dropped. */
  leakScreen: boolean;
  /** #10: a spoken sentence that is reasoning is not said. */
  leakScreenSpoken: boolean;
  /** #11: `<emo:thinking>…</emo:thinking>` is never shown. */
  thinkingBlock: boolean;
  /** #15: someone left waiting gets one fixed line when the run gave them nothing. */
  fallbackLine: boolean;
  /** #18: tools written as tags, DeepSeek's markup and HTML tags are taken out. */
  tagStrip: boolean;
  /** #19: a line she wrote to herself about how to answer is left out. */
  selfTalk: boolean;
}

export const ALL_CHECKS: OutputChecks = {
  leakScreen: true,
  leakScreenSpoken: true,
  thinkingBlock: true,
  fallbackLine: true,
  tagStrip: true,
  selfTalk: true,
};

export class StepText {
  readonly #checks: OutputChecks;
  readonly #parser: ExpressionParser;
  readonly #fence = new FenceSplitter();
  readonly #screen: ReplyScreen<ScreenedLine>;
  readonly #sentences: boolean;
  readonly #splitter = new SentenceSplitter();
  readonly #links = new LinkSplitter();
  #buffer = "";
  #emotion: string | null = null;
  #seenText = false;
  #silence = false;
  /** The inside of each feel block of the step. */
  readonly #feel: string[] = [];
  /** A line (a sentence, spoken) passed the feel check: she wrote words for people. */
  #kept = false;
  /** Sentences left out, spoken (`unit: "sentence"`). */
  #leakSentences = 0;
  #selfTalkSentences = 0;
  /** Tools written as tags that were taken out of her text. */
  tagsStripped = 0;
  /** Lines (sentences, spoken) left out because they read like a feel block without its tags. */
  feelCut = 0;

  constructor(unit: TextUnit = "line", checks: OutputChecks = ALL_CHECKS) {
    this.#checks = checks;
    this.#parser = new ExpressionParser({
      thinkingBlock: checks.thinkingBlock,
      tagStrip: checks.tagStrip,
    });
    this.#screen = new ReplyScreen<ScreenedLine>(checks.leakScreen, checks.selfTalk);
    this.#sentences = unit === "sentence";
  }

  /**
   * `<silence/>` came before any text (she chose not to speak, and the rest is ignored), or all
   * she wrote was a feel block.
   */
  get silence(): boolean {
    return this.#silence || ((this.#feel.length > 0 || this.feelCut > 0) && !this.#kept);
  }

  /** The inside of each feel block of the step so far, in order. */
  get feel(): readonly string[] {
    return this.#feel;
  }

  /** The response was judged a reasoning leak (#9), or one of its sentences was (#10). */
  get leaked(): boolean {
    return this.#sentences ? this.#leakSentences > 0 : this.#screen.dropped;
  }

  /** Lines (sentences, spoken) the leak screen dropped. */
  get leakDropped(): number {
    return this.#sentences ? this.#leakSentences : this.#screen.droppedLines;
  }

  /** Lines (sentences, spoken) left out as notes to herself (#19). */
  get selfTalkCut(): number {
    return this.#sentences ? this.#selfTalkSentences : this.#screen.selfTalk;
  }

  /** Whether she wrote any text that is not markup. */
  get wroteText(): boolean {
    return this.#seenText;
  }

  /** A piece of the step's text; returns the lines that may go out now. */
  push(delta: string): ScreenedLine[] {
    return this.#take(this.#parser.push(delta));
  }

  /**
   * What she wrote so far is complete (her tool calls begin): a finished sentence still held for
   * the end marks that might follow goes out now (spoken; a line waits for its line break).
   */
  settle(): ScreenedLine[] {
    if (!this.#sentences || this.#silence) return [];
    const done = this.#splitter.flushComplete();
    return done === null ? [] : this.#sentence(done);
  }

  /** The step's text ended: what was still held. */
  finish(): ScreenedLine[] {
    const out = this.#take(this.#parser.finish());
    if (!this.#silence) {
      for (const piece of this.#fence.flush()) out.push(...this.#piece(piece.code, piece.text));
      if (this.#sentences) {
        for (const part of this.#links.flush()) out.push(...this.#spoken(part.code, part.text));
        const rest = this.#splitter.flush();
        if (rest !== null) out.push(...this.#sentence(rest));
      } else {
        out.push(...this.#line(this.#buffer));
      }
    }
    this.#buffer = "";
    out.push(...this.#screen.flush());
    return out;
  }

  #take(segments: readonly Segment[]): ScreenedLine[] {
    const out: ScreenedLine[] = [];
    for (const segment of segments) {
      // A feel block counts even after `<silence/>`: she said nothing, and still felt something.
      if (segment.type === "feel") {
        this.#feel.push(segment.text);
        continue;
      }
      if (this.#silence) continue;
      switch (segment.type) {
        case "text":
          if (segment.text.trim() !== "") this.#seenText = true;
          for (const piece of this.#fence.push(segment.text)) {
            out.push(...this.#piece(piece.code, piece.text));
          }
          break;
        case "emotion":
          // Spoken, a finished sentence still held is said with the emotion it was written under.
          if (this.#sentences) {
            const done = this.#splitter.flushComplete();
            if (done !== null) out.push(...this.#sentence(done));
          }
          this.#emotion = segment.emotion;
          break;
        case "silence":
          if (!this.#seenText) this.#silence = true;
          break;
        case "tool":
          this.tagsStripped += 1;
          break;
        case "feel_start":
          // She writes the block after her words: the last of them goes out now, not after it.
          out.push(...this.#flushWords());
          break;
        default:
          break;
      }
    }
    return out;
  }

  /** The words held for the end marks or the line break that might follow, as they are. */
  #flushWords(): ScreenedLine[] {
    if (!this.#sentences) {
      const out = this.#line(this.#buffer);
      this.#buffer = "";
      return out;
    }
    const out = this.#links.flush().flatMap((part) => this.#spoken(part.code, part.text));
    const rest = this.#splitter.flush();
    if (rest !== null) out.push(...this.#sentence(rest));
    return out;
  }

  #piece(code: boolean, text: string): ScreenedLine[] {
    if (this.#sentences) {
      if (code) return text.trim() === "" ? [] : this.#aside(`\`\`\`${text}\`\`\``);
      return this.#links.push(text).flatMap((part) => this.#spoken(part.code, part.text));
    }
    if (code) {
      const out = this.#line(this.#buffer);
      this.#buffer = "";
      return text.trim() === "" ? out : [...out, ...this.#line(`\`\`\`${text}\`\`\``)];
    }
    const lines = (this.#buffer + text).split("\n");
    this.#buffer = lines.pop() ?? "";
    return lines.flatMap((line) => this.#line(line));
  }

  /** Spoken text outside code blocks: a link aside, the rest cut into sentences. */
  #spoken(link: boolean, text: string): ScreenedLine[] {
    if (link) return this.#aside(text);
    return this.#splitter.push(text).flatMap((s) => this.#sentence(s));
  }

  /** A link or a code block on its own, after the words written before it. */
  #aside(text: string): ScreenedLine[] {
    const t = text.trim();
    if (t === "") return [];
    const before = this.#splitter.flush();
    this.#kept = true;
    return [
      ...(before === null ? [] : this.#sentence(before)),
      { text: t, emotion: this.#emotion },
    ];
  }

  /** One spoken sentence, judged alone: reasoning (#10) and notes to herself (#19) are not said. */
  #sentence(raw: string): ScreenedLine[] {
    const text = raw.trim();
    if (!isSpeakable(text)) return [];
    if (isFeelLine(text)) {
      this.feelCut += 1;
      return [];
    }
    this.#kept = true;
    if (this.#checks.selfTalk && isSelfTalk(text)) {
      this.#selfTalkSentences += 1;
      return [];
    }
    if (this.#checks.leakScreenSpoken && looksLikeReasoning(text)) {
      this.#leakSentences += 1;
      return [];
    }
    return [{ text, emotion: this.#emotion }];
  }

  #line(raw: string): ScreenedLine[] {
    const text = raw.trim();
    if (text === "") return [];
    if (isFeelLine(text)) {
      this.feelCut += 1;
      return [];
    }
    this.#kept = true;
    return this.#screen.push({ text, emotion: this.#emotion }).send;
  }
}
