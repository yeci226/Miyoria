// Where a post could go: the channels she may post in, and those whose people would care, going
// by what she remembers of that server and channel and her notes on the conversation there.

import { tokenize, visibleScopes } from "@miyoria/memory";
import type { MemoryKind, MemoryScope } from "@miyoria/store";
import {
  type ContextKey,
  contextKeyString,
  type PersonId,
  type TalkCeiling,
  type Timestamp,
  toTimestamp,
} from "@miyoria/types";
import type { ShareConfig } from "./config.js";

/** A post she picked, with what is needed to share it. */
export interface Candidate {
  link: string;
  author: string;
  body: string;
  images: number;
  description: string | null;
  jpeg_path: string | null;
}

export interface ChannelMatch {
  context: ContextKey;
  name: string;
  memories: string[];
  notes: string;
  score: number;
}

export interface MatchDeps {
  recall(
    scopes: readonly MemoryScope[],
    present: readonly PersonId[],
    query: string,
    kinds: readonly MemoryKind[],
    limit: number,
    now: Timestamp,
  ): Promise<{ record: { content: string } }[]>;
  /** Her notes on the conversation there, as text. */
  notes(context: ContextKey): string;
  name(context: ContextKey): Promise<string | null>;
}

const CLOSED: readonly string[] = ["off", "mention-only"];
const KINDS: readonly MemoryKind[] = ["episode", "fact"];
const BEST = 3;
const MEMORIES = 3;
const MEMORY_POINTS = 2;
const MAX_NOTE_POINTS = 5;

/** The channels she may post in, each once, in the order given. */
export function eligibleChannels(
  contexts: readonly ContextKey[],
  ceiling: (context: ContextKey) => TalkCeiling | null,
  config: ShareConfig,
): ContextKey[] {
  const seen = new Set<string>();
  return contexts.filter((c) => {
    const key = contextKeyString(c);
    if (seen.has(key)) return false;
    seen.add(key);
    if (c.kind !== "channel" || c.scope === null) return false;
    if (config.exclude.includes(c.channel)) return false;
    if (config.channels.length > 0 && !config.channels.includes(c.channel)) return false;
    const level = ceiling(c);
    return level === null || (!CLOSED.includes(level.mode) && level.blocked === null);
  });
}

function sharedWords(a: string, b: string): number {
  const words = new Set(tokenize(a));
  return new Set(tokenize(b).filter((w) => words.has(w))).size;
}

/** Only what belongs to this server or channel: nothing from elsewhere reaches the decision. */
function placeScopes(context: ContextKey): MemoryScope[] {
  return visibleScopes(context, [], []).filter((s) => s.type === "guild" || s.type === "channel");
}

/** The channels that fit `query` best; none when nothing there has to do with it. */
export async function matchChannels(
  contexts: readonly ContextKey[],
  query: string,
  deps: MatchDeps,
  nowMs: number,
): Promise<ChannelMatch[]> {
  const now = toTimestamp(nowMs);
  const scored: ChannelMatch[] = [];
  for (const context of contexts) {
    const hits = await deps.recall(placeScopes(context), [], query, KINDS, MEMORIES, now);
    const notes = deps.notes(context);
    const score =
      hits.length * MEMORY_POINTS + Math.min(sharedWords(query, notes), MAX_NOTE_POINTS);
    if (score === 0) continue;
    const name = (await deps.name(context)) ?? context.channel;
    scored.push({ context, name, memories: hits.map((h) => h.record.content), notes, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, BEST);
}
