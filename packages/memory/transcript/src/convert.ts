// Between a transcript and the model's message list. Pure: no store, no clock.
//
// `toMessages` turns what `TranscriptStore.tail` returns into the history part of a request:
//
//     [user]       <data source="transcript" title="先前對話的摘要"> ... </data>   the summary
//     [user]       Owen: ...\nAmy(語音): ...          other people's lines, consecutive ones joined
//     [assistant]  her line (with her reasoning, when it was kept)
//     [assistant]  tool_calls (+ text, + reasoning)
//     [tool]       one message per call, right after it, in the call's order
//
// The same entries always give the same messages, so a transcript that only grew gives a request
// whose prefix is the last one's. What changes an earlier message is listed in `store.ts`
// (`Amendment.effect`).
//
// Everything from outside is data: names go through `safeName`, other people's text, notes and
// tool results through `neutralize` (`@miyoria/types`). Her own text is hers and is left as it is.
//
// A line opens with the speaker's handle when `names` knows it (the one name she has for them,
// the one her tools take); when the name they went by then is another, it follows once, the first
// time that handle shows that name in what is rendered: `Nobu(顯示名「Model-9 Lumen」): …`, then
// `Nobu: …`. Each line depends only on the lines before it and on handles, which never change, so
// a transcript that grew still renders its old lines the same.
//
// The line format (`name(tags): text`, the `(bot)` / `(語音)` / `(回覆 X)` tags, the interruption
// mark, the flagged placeholder, the time-gap line) is the one `packages/brain/agent/src/prompt.ts`
// writes today (`otherLine`, `ownLine`, `replyTag`, `gapLine`, `FLAGGED_LINE`). Those helpers are
// private to `brain`, which depends on this package, so the minimum is repeated here; the turn
// runner (B4) is their one user from then on.

import {
  type ChatMessage,
  contentText,
  type ToolCall,
  toolResultMessage,
  userMessage,
} from "@miyoria/llm/llm";
import {
  type AccountRef,
  DATA_CLOSE,
  DATA_OPEN,
  dataBlock,
  escapeData,
  type Handle,
  type IncomingMessage,
  imageType,
  incomingText,
  nameKey,
  neutralize,
  type PersonId,
  safeName,
  type Timestamp,
  timestampMs,
  xmlAttrs,
} from "@miyoria/types";
import { REPLY_PARENT_LABEL } from "./store.js";
import type { EntryInput, ImageRef, TranscriptEntry, TranscriptTail } from "./types.js";

/** Name tag of a bot account. */
export const BOT_TAG = "(bot)";
/** Name tag of a spoken line. */
export const SPOKEN_TAG = "(語音)";
/** After a line of hers that was cut off. */
export const INTERRUPTED = "(被打斷)";
/** Title of the data block the runner puts the flagged messages in (`flaggedBody`). */
export const FLAGGED_TITLE = "可疑的訊息";
/** What stands in the transcript for a flagged message: it is data, not a line of conversation. */
export const FLAGGED_LINE = `[內容在參考資料「${FLAGGED_TITLE}」]`;
/** Title of the summary's data block. */
export const SUMMARY_TITLE = "先前對話的摘要";
/** What a quoted line of hers is attributed to. */
export const SELF_QUOTE_NAME = "你";
/** What stands for a tool result whose text was removed. */
export const REMOVED = "[已移除]";

/** Characters of the replied-to message quoted inside a reply tag. */
const MAX_REPLY_EXCERPT = 24;
/** Longest quoted parent line (characters of its text). */
const MAX_PARENT_CHARS = 300;

/** After a handle, the name its account went by then when that is another: `(顯示名「…」)`. */
export const SHOWN_AS = (name: string): string => `(顯示名「${name}」)`;

/**
 * Her handle for the speaker of an entry (`null`: not known, the name it was shown under stands).
 * Called for other people's lines and the lines they reply to; it must answer the same for the
 * same account every time (a handle never follows a rename).
 */
export type SpeakerNames = (who: {
  account: AccountRef | null;
  author: string | null;
  bot: boolean;
}) => Handle | null;

const NAMES = new WeakMap<object, SpeakerNames>();

/**
 * How the speakers of `store`'s entries are named in what is made of them (the summary of a
 * compaction, `compactIfNeeded`, `compactIdle`). Set by whoever renders its prompts; unset: by
 * the name they were shown under.
 */
export function nameSpeakers(store: object, names: SpeakerNames | null): void {
  if (names === null) NAMES.delete(store);
  else NAMES.set(store, names);
}

/** What `nameSpeakers` set for `store`, or `null`. */
export function speakerNamesOf(store: object): SpeakerNames | null {
  return NAMES.get(store) ?? null;
}

/** Speaker labels within one rendering: the name each handle was last shown with. */
class Labels {
  readonly #names: SpeakerNames | null;
  readonly #shown = new Map<string, string>();

  constructor(names: SpeakerNames | null) {
    this.#names = names;
  }

  /** The handle of `entry`'s speaker, made inert, or `null`. */
  handle(entry: TranscriptEntry): string | null {
    if (this.#names === null || entry.account === null) return null;
    const handle = this.#names({ account: entry.account, author: entry.author, bot: entry.bot });
    return handle === null || handle.trim() === "" ? null : safeName(handle);
  }

  /** What a line of `entry` opens with: the handle, and the name shown then the first time. */
  speaker(entry: TranscriptEntry): string {
    const author = safeName(entry.author ?? "");
    const handle = this.handle(entry);
    if (handle === null) return author;
    if (entry.author === null || nameKey(entry.author) === nameKey(handle)) return handle;
    if (this.#shown.get(handle) === author) return handle;
    this.#shown.set(handle, author);
    return `${handle}${SHOWN_AS(author)}`;
  }

  /** How a quoted speaker is named (a reply's parent): the handle alone when known. */
  quoted(entry: TranscriptEntry): string {
    return this.handle(entry) ?? safeName(entry.author ?? "");
  }
}

export interface RenderOptions {
  /** A time-gap line is written between entries further apart than this. Default 30 minutes; 0: never. */
  gapMs?: number;
  /** One entry's text is cut to this many characters. Default 0: no limit. */
  maxEntryChars?: number;
  /** Her handles for the speakers (`SpeakerNames`); unset: the names they were shown under. */
  names?: SpeakerNames | null;
}

function cut(text: string, max: number): string {
  if (max <= 0) return text;
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
}

/** `—— 過了 2 小時 ——`. */
function gapLine(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  const span =
    minutes < 60
      ? `${minutes} 分鐘`
      : minutes < 48 * 60
        ? `${Math.round(minutes / 60)} 小時`
        : `${Math.round(minutes / (24 * 60))} 天`;
  return `—— 過了 ${span} ——`;
}

/** The described images of a line, after its text. */
function imageNotes(images: readonly ImageRef[]): string {
  return images
    .filter((i) => i.alt !== null && i.alt.trim() !== "")
    .map(
      (i) =>
        ` [圖片: ${neutralize(i.alt ?? "")
          .replace(/\s+/g, " ")
          .trim()}]`,
    )
    .join("");
}

/** What a transcript shows of someone else's entry. */
function shownText(entry: TranscriptEntry): string {
  return entry.flagged === null
    ? `${neutralize(entry.content)}${imageNotes(entry.images)}`
    : FLAGGED_LINE;
}

/** `(回覆 X「…」)`: the entry replies to a line that is in the transcript. */
function replyTag(
  entry: TranscriptEntry,
  byMessage: ReadonlyMap<string, TranscriptEntry>,
  labels: Labels,
): string {
  if (entry.reply_to === null) return "";
  const parent = byMessage.get(entry.reply_to);
  if (parent === undefined) return "";
  const own = parent.kind === "self" || parent.kind === "tool_calls";
  const name = own ? SELF_QUOTE_NAME : labels.quoted(parent);
  const text = own ? parent.content : shownText(parent);
  const quote = cut(text.replace(/\s+/g, " ").trim(), MAX_REPLY_EXCERPT);
  return quote === "" ? `(回覆 ${name})` : `(回覆 ${name}「${quote}」)`;
}

function otherLine(
  entry: TranscriptEntry,
  reply: string,
  maxChars: number,
  labels: Labels,
): string {
  let tags = "";
  if (entry.bot) tags += BOT_TAG;
  if (entry.spoken) tags += SPOKEN_TAG;
  tags += reply;
  return `${labels.speaker(entry)}${tags}: ${cut(shownText(entry), maxChars)}`;
}

/** A note as the model reads it: a quoted reply parent, or a data block named by its label. */
function noteLine(entry: TranscriptEntry, maxChars: number, labels: Labels): string {
  if (entry.label === REPLY_PARENT_LABEL) {
    const text = cut(shownText(entry).replace(/\s+/g, " ").trim(), MAX_PARENT_CHARS);
    return `> (被回覆) ${labels.speaker(entry)}: ${text}`;
  }
  const attrs = xmlAttrs({ source: safeName(entry.label ?? "note", 40) });
  return `${DATA_OPEN}${attrs}>\n${cut(escapeData(entry.content), maxChars).trim()}\n${DATA_CLOSE}`;
}

/** What she said, as the transcript keeps it: only what was heard of a line that was cut off. */
function ownText(entry: TranscriptEntry, maxChars: number): string {
  if (!entry.interrupted) return cut(entry.content, maxChars);
  const heard = entry.heard ?? entry.content;
  return heard.trim() === "" ? "" : `${cut(heard, maxChars)}${INTERRUPTED}`;
}

function assistant(content: string, calls: ToolCall[], reasoning: string | null): ChatMessage {
  return {
    role: "assistant",
    content,
    name: null,
    tool_calls: calls,
    tool_call_id: null,
    ...(reasoning !== null && reasoning !== "" && { reasoning }),
  };
}

/**
 * The messages of a transcript tail, oldest first: the summary, then the entries. Nothing before
 * (the persona, the tools) and nothing after (the turn's data) is here.
 *
 * `tail.entries` is expected paired, as `TranscriptStore.tail` returns it; a call without a result
 * here would be sent as it is.
 */
export function toMessages(tail: TranscriptTail, options: RenderOptions = {}): ChatMessage[] {
  const gapMs = options.gapMs ?? 30 * 60 * 1000;
  const maxChars = options.maxEntryChars ?? 0;
  const labels = new Labels(options.names ?? null);
  const out: ChatMessage[] = [];
  const summary = tail.summary?.summary.trim() ?? "";
  if (summary !== "") out.push(userMessage(dataBlock("transcript", SUMMARY_TITLE, summary)));

  const byMessage = new Map<string, TranscriptEntry>();
  const results = new Map<string, TranscriptEntry>();
  for (const e of tail.entries) {
    if (e.kind === "tool_result" && e.tool_call_id !== null) results.set(e.tool_call_id, e);
    else if (e.kind !== "note" && e.message_id !== null && e.redacted_at === null) {
      byMessage.set(e.message_id, e);
    }
  }

  // Lines of other people (and notes) waiting to be joined into one user message.
  let lines: string[] = [];
  const flush = () => {
    if (lines.length > 0) out.push(userMessage(lines.join("\n")));
    lines = [];
  };
  let previousAt: number | null = null;
  const gap = (entry: TranscriptEntry) => {
    const at = timestampMs(entry.at);
    if (previousAt !== null && gapMs > 0 && at - previousAt > gapMs) {
      lines.push(gapLine(at - previousAt));
    }
    previousAt = at;
  };

  for (const entry of tail.entries) {
    switch (entry.kind) {
      case "other":
      case "note": {
        // A tombstone has nothing to show.
        if (entry.redacted_at !== null) break;
        gap(entry);
        lines.push(
          entry.kind === "note"
            ? noteLine(entry, maxChars, labels)
            : otherLine(entry, replyTag(entry, byMessage, labels), maxChars, labels),
        );
        break;
      }
      case "self": {
        const text = entry.redacted_at === null ? ownText(entry, maxChars) : "";
        if (text === "") break;
        gap(entry);
        const last = lines.length === 0 ? out.at(-1) : undefined;
        const reasoning = entry.reasoning ?? "";
        // Two lines of hers in a row read as one message, unless either carries reasoning: that
        // belongs to its own message.
        if (
          last?.role === "assistant" &&
          last.tool_calls.length === 0 &&
          (last.reasoning ?? "") === "" &&
          reasoning === "" &&
          typeof last.content === "string"
        ) {
          last.content = `${last.content}\n${text}`;
          break;
        }
        flush();
        out.push(assistant(text, [], entry.reasoning));
        break;
      }
      case "tool_calls": {
        gap(entry);
        flush();
        const calls = entry.tool_calls.map((c) => ({ ...c }));
        out.push(assistant(ownText(entry, maxChars), calls, entry.reasoning));
        // The results go right after the calls, whatever was said in between.
        for (const call of calls) {
          const result = results.get(call.id);
          if (result === undefined) continue;
          const text = result.redacted_at === null ? neutralize(result.content) : REMOVED;
          out.push(toolResultMessage(call.id, text));
        }
        break;
      }
      case "tool_result":
        // Written with its call.
        break;
    }
  }
  flush();
  return out;
}

/** The flagged messages of `entries`, each with what the input defence noticed: a data block's body. */
export function flaggedBody(
  entries: readonly TranscriptEntry[],
  names: SpeakerNames | null = null,
): string {
  const labels = new Labels(names);
  return entries
    .filter((e) => e.flagged !== null && e.redacted_at === null)
    .map((e) => `${labels.speaker(e)}:${neutralize(e.content)}\n${e.flagged}`)
    .join("\n");
}

/** What goes on every entry a model step made. */
export interface StepMeta {
  turn?: string | null;
  /** When the step ended; default: when it is appended. */
  at?: Timestamp;
  /** Her text was said out loud. */
  spoken?: boolean;
}

/**
 * What a model step produced, as entries to append: each assistant message (her text, her calls
 * with their arguments exactly as written, her reasoning) and each tool message. An assistant
 * message with neither text nor calls adds nothing. Other roles are not a step's output.
 */
export function entriesOfMessages(
  messages: readonly ChatMessage[],
  meta: StepMeta = {},
): EntryInput[] {
  const common = {
    turn: meta.turn ?? null,
    ...(meta.at !== undefined && { at: meta.at }),
  };
  const out: EntryInput[] = [];
  for (const m of messages) {
    const content = contentText(m.content);
    if (m.role === "assistant") {
      const reasoning = m.reasoning == null || m.reasoning === "" ? null : m.reasoning;
      if (m.tool_calls.length > 0) {
        out.push({
          ...common,
          kind: "tool_calls",
          content,
          reasoning,
          tool_calls: m.tool_calls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })),
          spoken: meta.spoken ?? false,
        });
      } else if (content !== "") {
        out.push({ ...common, kind: "self", content, reasoning, spoken: meta.spoken ?? false });
      }
    } else if (m.role === "tool") {
      if (m.tool_call_id === null) throw new TypeError("a tool message names the call it answers");
      out.push({ ...common, kind: "tool_result", content, tool_call_id: m.tool_call_id });
    } else {
      throw new TypeError(`a \`${m.role}\` message is not the output of a model step`);
    }
  }
  return out;
}

/** What the platform message itself does not say. */
export interface IncomingMeta {
  person_id?: PersonId | null;
  /** Said to her; default: a mention of her or a reply to her. */
  addressed?: boolean;
  /** A voice transcript. */
  spoken?: boolean;
}

/**
 * Someone else's platform message as an entry: its text with stickers, embeds, attachments and
 * forwards noted inline (`incomingText`), its images as references (the attachment's platform id,
 * else its URL; alt text when the author wrote one).
 */
export function entryOfIncoming(msg: IncomingMessage, meta: IncomingMeta = {}): EntryInput {
  const attachments = [...msg.attachments, ...(msg.forwarded ?? []).flatMap((f) => f.attachments)];
  return {
    kind: "other",
    person_id: meta.person_id ?? null,
    account: { ...msg.author.account },
    author: msg.author.display_name,
    content: incomingText(msg),
    images: attachments
      .filter((a) => imageType(a) !== null)
      .map((a) => ({ ref: a.id ?? a.url, alt: a.description ?? null })),
    message_id: msg.id.id,
    reply_to: msg.reply_to?.id ?? null,
    addressed: meta.addressed ?? (msg.mentions_self || msg.reply_to_self),
    bot: msg.author.is_bot,
    spoken: meta.spoken ?? false,
    at: msg.ts,
  };
}
