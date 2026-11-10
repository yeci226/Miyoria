// Context she did not see live: earlier messages of a session that started cold (after a
// restart, or once an idle session was forgotten), and the parents of a reply that are not in
// the history.
//
// Sources: the platform's `PlatformHistory` (`PlatformHistoriesKey`); without one, the message
// log (`MessageLogKey`) for the backfill. Everything here is best effort and bounded: the fetch
// starts when the session is created (so it mostly runs during the debounce), a turn waits for
// it at most `history.timeout_ms` from its start, and failures only cost the context.

import { errorMessage, sleep } from "@miyoria/kernel";
import { MessageLogKey } from "@miyoria/store";
import {
  type IncomingMessage,
  type MessageRef,
  PlatformHistoriesKey,
  type PlatformHistory,
  timestampMs,
} from "@miyoria/types";
import type { Agent } from "./runtime.js";
import { type HistoryEntry, historyEntry, type Session } from "./session.js";
import { contextId, timeout } from "./util.js";

/** How many earlier messages a cold session fetches. */
export function backfillLimit(agent: Agent): number {
  const cfg = agent.config;
  return Math.min(cfg.history.backfill, cfg.prompt_history, cfg.history_limit);
}

function historyFor(agent: Agent, platform: string): PlatformHistory | undefined {
  return agent.ctx.services.get(PlatformHistoriesKey)?.get(platform);
}

/**
 * Starts filling a new text session with the messages before `first` (the message that
 * created it). Voice sessions are not backfilled (utterances are not kept by the platform).
 */
export function startBackfill(agent: Agent, session: Session, first: IncomingMessage): void {
  const limit = backfillLimit(agent);
  if (limit <= 0 || session.context.kind === "voice") return;
  const signal = agent.ctx.signal;
  const run = async (): Promise<void> => {
    const fetched = await timeout(agent.config.history.timeout_ms, signal, (s) =>
      earlier(agent, session, first, limit, s),
    );
    const added = session.backfill(fetched);
    if (added > 0) {
      agent.log.debug(
        { context: contextId(session.context), added },
        "backfilled earlier messages",
      );
    }
  };
  const done = run().catch((error: unknown) => {
    if (signal.aborted) return;
    agent.log.debug(
      { context: contextId(session.context), error: errorMessage(error) },
      "could not backfill history",
    );
  });
  session.warmup = { done, startedAt: agent.ctx.clock.now() };
}

/** Earlier messages, oldest first, each with whether it is hers. */
async function earlier(
  agent: Agent,
  session: Session,
  first: IncomingMessage,
  limit: number,
  signal: AbortSignal,
): Promise<[IncomingMessage, boolean][]> {
  const context = session.context;
  const history = historyFor(agent, context.platform);
  if (history) {
    const messages = await history.recent(context, { before: first.id.id, limit }, signal);
    return messages.map((m) => [m, agent.isSelf(m.author.account)]);
  }
  const log = agent.ctx.services.get(MessageLogKey);
  if (!log) return [];
  const profile = agent.persona.read((p) => p.id);
  const before = timestampMs(first.ts);
  // One more than needed: the message log may already hold `first` itself.
  const entries = await log.recent(profile, context, limit + 1);
  signal.throwIfAborted();
  return entries
    .filter((e) => Date.parse(e.ts) < before)
    .slice(-limit)
    .map((e): [IncomingMessage, boolean] => [
      {
        // Log entries have their own ids, never a platform message's.
        id: { context, id: `log:${e.id}` },
        author: { account: e.author, display_name: e.author_name, is_bot: false },
        text: e.text,
        mentions_self: false,
        reply_to_self: false,
        attachments: [],
        ts: e.ts,
      },
      e.is_self,
    ]);
}

/**
 * Waits for the session's backfill, but not past `history.timeout_ms` from its start (or when
 * `signal` aborts). Never throws for the backfill's sake.
 */
export async function awaitBackfill(
  agent: Agent,
  session: Session,
  signal: AbortSignal,
): Promise<void> {
  const warmup = session.warmup;
  if (warmup === null) return;
  const left = warmup.startedAt + agent.config.history.timeout_ms - agent.ctx.clock.now();
  if (left <= 0) return;
  const timer = new AbortController();
  const stop = () => timer.abort();
  signal.addEventListener("abort", stop, { once: true });
  try {
    await Promise.race([warmup.done, sleep(left, timer.signal).catch(() => undefined)]);
  } finally {
    timer.abort();
    signal.removeEventListener("abort", stop);
  }
  signal.throwIfAborted();
}

/**
 * The direct parent as it came with the reply (`msg.referenced`: author and text), or `null`.
 * No network: what a reply always has, even when fetching the parent fails or times out.
 */
export function quotedParent(agent: Agent, msg: IncomingMessage): HistoryEntry | null {
  const ref = msg.reply_to ?? null;
  const quoted = msg.referenced ?? null;
  if (ref === null || quoted === null) return null;
  const account = quoted.author ?? { platform: msg.id.context.platform, id: "unknown" };
  return {
    // Its time is unknown; quoted parents are not part of the time-gap lines.
    ...historyEntry(msg, agent.isSelf(account), false),
    id: ref.id,
    replyTo: null,
    author: quoted.author_name,
    account,
    isBot: false,
    text: quoted.text,
    attachments: [],
    undated: true,
  };
}

/**
 * The lines around message `id` in `context`, read from the platform: `before` earlier and
 * `after` later ones, oldest first. Empty on any failure (context only).
 */
export async function fetchAround(
  agent: Agent,
  context: IncomingMessage["id"]["context"],
  id: string,
  before: number,
  after: number,
  signal: AbortSignal,
): Promise<{ before: HistoryEntry[]; after: HistoryEntry[] }> {
  const history = historyFor(agent, context.platform);
  if (!history || (before <= 0 && after <= 0)) return { before: [], after: [] };
  const read = async (query: { before: string | null; after?: string | null; limit: number }) =>
    query.limit <= 0 ? [] : await history.recent(context, query, signal).catch(() => []);
  const [earlier, later] = await Promise.all([
    read({ before: id, limit: before }),
    read({ before: null, after: id, limit: after }),
  ]);
  const entry = (m: IncomingMessage) => historyEntry(m, agent.isSelf(m.author.account), false);
  return {
    before: earlier.slice(-before).map(entry),
    after: later
      .filter((m) => m.id.id !== id)
      .slice(0, after)
      .map(entry),
  };
}

/**
 * The parents of `msg` that are not in the session, oldest first: the direct parent (from the
 * reply itself when the platform sent it along, else fetched) and up to `history.reply_chain`
 * ancestors in all. Stops at the first parent that is in the session or cannot be read.
 */
export async function replyParents(
  agent: Agent,
  session: Session,
  msg: IncomingMessage,
  signal: AbortSignal,
): Promise<HistoryEntry[]> {
  const max = agent.config.history.reply_chain;
  let ref: MessageRef | null = msg.reply_to ?? null;
  if (ref === null || session.entry(ref.id) !== undefined) return [];
  const history = historyFor(agent, msg.id.context.platform);
  const chain: HistoryEntry[] = [];
  const seen = new Set<string>([msg.id.id]);
  while (ref !== null && chain.length < Math.max(max, 1) && !seen.has(ref.id)) {
    seen.add(ref.id);
    if (session.entry(ref.id) !== undefined) break;
    const parent: IncomingMessage | null =
      max > 0 && history ? await history.fetch(ref, signal) : null;
    if (parent === null) {
      // Only what came with the reply: its direct parent's author and text.
      const quoted = chain.length === 0 ? quotedParent(agent, msg) : null;
      if (quoted !== null) chain.push(quoted);
      break;
    }
    chain.push(historyEntry(parent, agent.isSelf(parent.author.account), false));
    ref = parent.reply_to ?? null;
  }
  return chain.reverse();
}
