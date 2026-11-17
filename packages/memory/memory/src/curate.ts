// `MemoryCurator` (provided as `MemoryCuratorKey`): what her reflection may do to her memory.
// It sees memories outside DMs only, merges notes of one privacy scope into an insight that
// supersedes them, and marks a note outdated by a newer one of the same scope.

import type { MemoryRecord } from "@miyoria/store";
import type { CuratedNote, InsightInput, MemoryCurator, Timestamp } from "@miyoria/types";
import { type MemoryEngine, MemoryError, memoryFilter, storedId, weakerOrigin } from "./engine.js";
import { mergeRefs } from "./evidence.js";
import { isPrivate, scopeEquals, scopeLabel } from "./scope.js";

const ms = (t: Timestamp) => Date.parse(t);

/** Memories reflection may look at: not in a DM (or a guild-less context), not superseded. */
function curatable(r: MemoryRecord): boolean {
  if (r.superseded_by !== null || r.done) return false;
  if (r.scope.type === "dm") return false;
  if (r.scope.type === "channel" && isPrivate(r.scope.context)) return false;
  return r.kind !== "followup";
}

function note(r: MemoryRecord): CuratedNote {
  return {
    id: r.id,
    kind: r.kind,
    content: r.content,
    subjects: [...r.subjects],
    scope: scopeLabel(r.scope),
    importance: r.importance,
    confidence: r.confidence,
    created_at: r.created_at,
    said_by: r.source?.name ?? null,
  };
}

export class Curator implements MemoryCurator {
  constructor(private readonly engine: MemoryEngine) {}

  async notes(since: Timestamp, limit: number): Promise<CuratedNote[]> {
    const records = await this.engine.records.list(
      this.engine.profile,
      memoryFilter(Math.max(limit, 1) * 4),
    );
    return records
      .filter((r) => curatable(r) && ms(r.updated_at) >= ms(since))
      .slice(0, Math.max(limit, 0))
      .map(note);
  }

  async #load(ids: readonly string[]): Promise<MemoryRecord[]> {
    const out: MemoryRecord[] = [];
    for (const id of new Set(ids)) {
      const r = await this.engine.records.get(id);
      if (!r || r.profile !== this.engine.profile || !curatable(r)) {
        throw new MemoryError(`unknown memory \`${id}\``);
      }
      out.push(r);
    }
    return out;
  }

  async insight(input: InsightInput, now: Timestamp, signal?: AbortSignal): Promise<string> {
    const from = await this.#load(input.from);
    const first = from[0];
    if (!first) throw new MemoryError("an insight needs the memories it is drawn from");
    if (!from.every((r) => scopeEquals(r.scope, first.scope))) {
      throw new MemoryError("memories of different privacy scopes are never merged");
    }
    const subjects = [...new Set(from.flatMap((r) => r.subjects))];
    // An insight claims no more provenance than its weakest source, and keeps all the evidence.
    const origin = from.reduce(
      (o, r) => weakerOrigin(o, r.origin ?? "unknown"),
      first.origin ?? "unknown",
    );
    const sameSource = from.every(
      (r) =>
        r.source?.account.platform === first.source?.account.platform &&
        r.source?.account.id === first.source?.account.id,
    );
    const stored = await this.engine.store(
      {
        kind: input.kind,
        scope: first.scope,
        subjects,
        content: input.content,
        importance: Math.max(input.importance, ...from.map((r) => r.importance)),
        confidence: Math.max(...from.map((r) => r.confidence)),
        source_context: first.source_context,
        source: sameSource ? first.source : null,
        origin,
        source_events: mergeRefs(
          this.engine.config.evidence.max_events,
          ...from.map((r) => r.source_events),
        ),
        due: null,
      },
      now,
      signal,
    );
    const id = storedId(stored);
    for (const r of from) {
      if (r.id === id) continue;
      const fresh = await this.engine.records.get(r.id);
      if (fresh && fresh.superseded_by === null) {
        await this.engine.records.upsert({ ...fresh, superseded_by: id, updated_at: now });
      }
    }
    return id;
  }

  async supersede(old: string, by: string, now: Timestamp): Promise<boolean> {
    if (old === by) return false;
    const [a, b] = await this.#load([old, by]);
    if (!a || !b || !scopeEquals(a.scope, b.scope)) return false;
    if (ms(b.created_at) < ms(a.created_at)) return false;
    await this.engine.records.upsert({ ...a, superseded_by: b.id, updated_at: now });
    return true;
  }
}
