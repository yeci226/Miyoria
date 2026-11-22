// The lines around the message a reply answers, when she cannot see it: the old turn's
// `fetchAround` (agent/history.ts) and the `前文` / `被回覆` / `後文` lines it quoted with the
// parent (agent/prompt.ts `transcriptBlocks`).
//
// For each line of a run that replies to a message the transcript she sees does not have (as a
// line, not a note), the parent (remembered, fetched, or as the platform quoted it) and up to
// `history.reply_context_before` lines before it and `reply_context_after` after it are read from
// the platform, all within one `history.timeout_ms` (the parent only once there are lines around
// it). They go to block 7 of this run only, never
// into the transcript. Lines the transcript has, the reply itself and people she ignores are left
// out; with nothing around the parent there is nothing to add (the transcript notes the parent).

import { SELF_QUOTE_NAME, type TranscriptStore } from "@miyoria/memory/transcript";
import { errorMessage } from "@miyoria/runtime/kernel";
import {
  type AccountRef,
  dataBlock,
  type IncomingMessage,
  type MessageRef,
  neutralize,
  PlatformHistoriesKey,
  safeName,
  timestampMs,
} from "@miyoria/types";
import { type Agent, timeout } from "../../agent/src/index.js";
import type { RecentLines } from "./around.js";
import {
  REPLY_AROUND_TAGS,
  REPLY_AROUND_TITLE,
  REPLY_AROUND_UNDATED,
  replyAroundHead,
} from "./texts.js";

/** Characters of the replied-to message (the old `MAX_PARENT_CHARS`). */
const PARENT_CHARS = 300;
/** Characters of a line around it (the old `MAX_CONTEXT_CHARS`). */
const AROUND_CHARS = 120;
/** Runs whose block is remembered while they go. */
const RUNS = 32;

/** One run's lines, as the reply context needs them. */
export interface ReplyRun {
  session: string;
  turn: string;
  /** The lines the run is about, oldest first. */
  inputs: readonly IncomingMessage[];
  signal: AbortSignal;
}

/** A line as quoted around a parent. */
interface Quoted {
  id: string | null;
  author: string;
  own: boolean;
  text: string;
  /** Clock ms; `null`: unknown (only the platform's quote). */
  at: number | null;
}

/** `剛剛`, `5 分鐘前`, `3 小時前`, `2 天前` (the old `agoLabel`). */
export function agoLabel(ms: number): string {
  const minutes = Math.round(Math.max(ms, 0) / 60_000);
  if (minutes < 1) return "剛剛";
  if (minutes < 60) return `${minutes} 分鐘前`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} 小時前`;
  return `${Math.round(minutes / (24 * 60))} 天前`;
}

function cut(text: string, max: number): string {
  const flat = neutralize(text).replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : flat;
}

function quoteLine(q: Quoted, tag: string, max: number): string {
  const name = q.own ? SELF_QUOTE_NAME : safeName(q.author);
  return `(${tag}) ${name}: ${cut(q.text, max)}`;
}

export class ReplyContext {
  readonly #agent: Agent;
  readonly #transcript: TranscriptStore;
  readonly #recent: RecentLines;
  readonly #runs = new Map<string, Promise<string | null>>();

  constructor(agent: Agent, transcript: TranscriptStore, recent: RecentLines) {
    this.#agent = agent;
    this.#transcript = transcript;
    this.#recent = recent;
  }

  /** Block 7's part for `run`, read once per run; `null`: nothing to add. Never rejects. */
  block(run: ReplyRun): Promise<string | null> {
    const known = this.#runs.get(run.turn);
    if (known !== undefined) return known;
    const read = this.#read(run).catch((error: unknown) => {
      if (!run.signal.aborted) {
        this.#agent.log.debug({ err: errorMessage(error) }, "no lines around a reply's parent");
      }
      return null;
    });
    this.#runs.set(run.turn, read);
    while (this.#runs.size > RUNS) {
      const oldest = this.#runs.keys().next().value;
      if (oldest === undefined) break;
      this.#runs.delete(oldest);
    }
    return read;
  }

  async #read(run: ReplyRun): Promise<string | null> {
    const agent = this.#agent;
    const h = agent.config.history;
    if (h.reply_context_before <= 0 && h.reply_context_after <= 0) return null;
    const entries = this.#transcript.tail(run.session).entries;
    const shown = new Set<string>();
    for (const e of entries) {
      if (e.kind !== "note" && e.message_id !== null) shown.add(e.message_id);
    }
    const asked = new Set<string>();
    const wanted: IncomingMessage[] = [];
    for (const input of run.inputs) {
      const ref = input.reply_to ?? null;
      if (ref === null || shown.has(ref.id) || asked.has(ref.id)) continue;
      asked.add(ref.id);
      wanted.push(input);
    }
    if (wanted.length === 0) return null;
    const read = await timeout(h.timeout_ms, run.signal, (signal) =>
      Promise.all(wanted.map((input) => this.#around(input, shown, signal))),
    );
    const blocks = read.filter((b): b is string => b !== null);
    return blocks.length === 0 ? null : blocks.join("\n");
  }

  /** The parent of `input` and the lines around it, rendered; `null`: none around it. */
  async #around(
    input: IncomingMessage,
    shown: ReadonlySet<string>,
    signal: AbortSignal,
  ): Promise<string | null> {
    const agent = this.#agent;
    const h = agent.config.history;
    const ref = input.reply_to as MessageRef;
    const history = agent.ctx.services.get(PlatformHistoriesKey)?.get(ref.context.platform);
    if (history === undefined) return null;
    const read = async (query: { before: string | null; after?: string | null; limit: number }) =>
      query.limit <= 0
        ? []
        : await history.recent(ref.context, query, signal).catch(() => [] as IncomingMessage[]);
    const [earlier, later] = await Promise.all([
      read({ before: ref.id, limit: h.reply_context_before }),
      read({ before: null, after: ref.id, limit: h.reply_context_after }),
    ]);
    const keep = (m: IncomingMessage) =>
      m.id.id !== ref.id &&
      m.id.id !== input.id.id &&
      !shown.has(m.id.id) &&
      (agent.isSelf(m.author.account) || !agent.isBlocked(m.author.account));
    const before = earlier.filter(keep).slice(-h.reply_context_before);
    const after = later.filter(keep).slice(0, h.reply_context_after);
    if (before.length === 0 && after.length === 0) return null;
    // Only with something around it: the look around (`around.ts`) fetches the parent as well.
    const fetched =
      this.#recent.get(ref.context, ref.id) ?? (await history.fetch(ref, signal).catch(() => null));
    const parent = this.#parent(input, fetched);
    if (parent === null) return null;
    const quoted = (m: IncomingMessage): Quoted => ({
      id: m.id.id,
      author: this.#name(m.author.account, m.author.display_name),
      own: agent.isSelf(m.author.account),
      text: m.text,
      at: timestampMs(m.ts),
    });
    const when =
      parent.at === null ? REPLY_AROUND_UNDATED : agoLabel(timestampMs(input.ts) - parent.at);
    const lines = [
      ...before.map((m) => quoteLine(quoted(m), REPLY_AROUND_TAGS.before, AROUND_CHARS)),
      quoteLine(parent, `${when},${REPLY_AROUND_TAGS.replied}`, PARENT_CHARS),
      ...after.map((m) => quoteLine(quoted(m), REPLY_AROUND_TAGS.after, AROUND_CHARS)),
    ];
    const head = replyAroundHead(this.#name(input.author.account, input.author.display_name));
    return `${head}\n${dataBlock("reply_context", REPLY_AROUND_TITLE, lines.join("\n"))}`;
  }

  /** Someone by her handle for them, as the transcript names them (her own accounts as shown). */
  #name(account: AccountRef, shown: string): string {
    return this.#agent.isSelf(account) ? shown : this.#agent.handleOf(account, shown);
  }

  /** The replied-to message: fetched or remembered, else as the platform quoted it. */
  #parent(input: IncomingMessage, fetched: IncomingMessage | null): Quoted | null {
    const agent = this.#agent;
    if (fetched !== null) {
      const own = agent.isSelf(fetched.author.account);
      if (!own && agent.isBlocked(fetched.author.account)) return null;
      return {
        id: fetched.id.id,
        author: this.#name(fetched.author.account, fetched.author.display_name),
        own,
        text: fetched.text,
        at: timestampMs(fetched.ts),
      };
    }
    const quote = input.referenced ?? null;
    if (quote === null) return null;
    const account = quote.author ?? null;
    if (account !== null && !agent.isSelf(account) && agent.isBlocked(account)) return null;
    return {
      id: input.reply_to?.id ?? null,
      author: account === null ? quote.author_name : this.#name(account, quote.author_name),
      own: account !== null && agent.isSelf(account),
      text: quote.text,
      at: null,
    };
  }
}
