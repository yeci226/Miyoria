// The recall harness over her notes (`--memory-target notes`): the set's memories as lines of her
// documents, each query asked the way the knowledge section of a prompt asks
// (`NotesStore.searchLines` over what the place may see, with the query's vector when there is an
// embedder), and what came back scored by `metrics.ts` like the records' run.
//
// - A memory is a line: in the document of the first person it is about, otherwise in one topic
//   document. Its scope is the set's scope in the notes' words: `global` is `public`, a guild a
//   space, a channel a room, a DM account the DM of that account (one person per account), a person
//   the same person. A superseded memory is added and then marked outdated.
// - The query is the line answered alone (`text`), as the knowledge section searches; the lines
//   before it are not used.
// - The ranking is the notes' (`rank.ts`) with the run's `[modules.memory]` overrides; what comes
//   back is cut by the precision rules of `[modules.memory.notes_recall]` (`precision.ts`): the
//   floor and the stricter bar for meaning alone give what `recall` returns (the top-level
//   numbers), and the separation check too gives what the prompt's memory block shows (`block`).
// - The documents of the people present are not searched first, as `recall` does (`NotesRecall`):
//   every query searches every document the place may see.
//
// Not covered: a DM place with several accounts is read as the DM of the first one.

import { type MemoryConfig, memoryConfig, PROMPT_KINDS } from "@miyoria/memory/memory";
import {
  modelOf,
  type NoteScope,
  NotesStore,
  type NotesViewer,
  notesTables,
  personSubject,
  precise,
  type QueryVector,
  rankingOf,
} from "@miyoria/memory/notes";
import { SqliteStore, type StorePlugin } from "@miyoria/store";
import { type PersonId, toTimestamp } from "@miyoria/types";
import { DEFAULT_KS, type Returned, scoreRecall } from "./metrics.js";
import { CachedEmbedder, type RecallOptions, type RecallResult } from "./run.js";
import type { RecallMemory, RecallQuery, RecallScope, RecallSet } from "./set.js";

/** Memories embedded per call when they are stored. */
const EMBED_BATCH = 16;
/** One topic document for the memories about nobody in particular. */
const TOPIC = "topic:recall-eval";

/** The notes without the store's limits on lines: a set may hold any number about one person. */
function notesWithoutLimits(): StorePlugin<NotesStore> {
  return {
    ...notesTables,
    open: ({ db, events }) =>
      new NotesStore(
        db,
        {
          lineChars: 100_000,
          linesPerDocument: 1_000_000,
          linesPerSection: 1_000_000,
          selfLines: 1_000_000,
        },
        events,
      ),
  };
}

const space = (platform: string, guild: string) => `${platform}:${guild}`;
const room = (platform: string, channel: string) => `${platform}:${channel}`;
/** The person a DM account stands for. */
const accountPerson = (platform: string, id: string) => `account:${platform}:${id}` as PersonId;

/** A set's scope in the notes' words. */
export function noteScopeOf(scope: RecallScope): NoteScope {
  switch (scope.type) {
    case "global":
      return { type: "public" };
    case "guild":
      return { type: "space", space: space(scope.platform, scope.guild) };
    case "channel":
      return { type: "room", room: room(scope.context.platform, scope.context.channel) };
    case "dm":
      return { type: "dm", person: accountPerson(scope.account.platform, scope.account.id) };
    case "person":
      return { type: "person", person: scope.person as PersonId };
  }
}

/** Who reads where a query happens. */
export function viewerAt(query: RecallQuery): NotesViewer {
  const here = query.place.context;
  const dm = here.kind === "dm" || here.scope === null;
  const partner = query.place.accounts[0];
  return {
    space: dm || here.scope === null ? null : space(here.platform, here.scope),
    room: room(here.platform, here.channel),
    dm: dm && partner !== undefined ? accountPerson(partner.platform, partner.id) : null,
    present: query.people as PersonId[],
  };
}

const subjectOf = (memory: RecallMemory) => {
  const person = memory.subjects[0];
  return person === undefined ? TOPIC : personSubject(person as PersonId);
};

/** `runRecall` over her notes (the file comment). */
export async function runNotesRecall(
  set: RecallSet,
  options: RecallOptions = {},
): Promise<RecallResult> {
  const config: MemoryConfig = memoryConfig(options.config ?? {});
  const ks = [...(options.ks ?? DEFAULT_KS)];
  const limit = Math.max(config.recall_limit, ...ks);
  const embedder =
    options.embedder === undefined || !options.embedder.enabled
      ? null
      : options.embedder instanceof CachedEmbedder
        ? options.embedder
        : new CachedEmbedder(options.embedder);
  const failuresBefore = embedder?.failures ?? 0;
  const model = embedder === null ? "" : modelOf(embedder);

  let now = 0;
  const clock = { now: () => now };
  const plugin = notesWithoutLimits();
  const store = await SqliteStore.open(":memory:", { plugins: [plugin], clock });
  try {
    const notes = store.plugin(plugin);
    const kept = set.memories.filter((m) => PROMPT_KINDS.includes(m.kind));
    const memoryOf = new Map<string, string>();
    const lineOf = new Map<string, string>();
    for (const memory of [...kept].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
      now = Date.parse(memory.at);
      const line = notes.add(
        subjectOf(memory),
        {
          section: "misc",
          text: memory.content,
          provenance: "observed",
          scope: noteScopeOf(memory.scope),
          confidence: memory.confidence,
        },
        { author: "import" },
      );
      memoryOf.set(line.id, memory.id);
      lineOf.set(memory.id, line.id);
    }
    for (const memory of kept) {
      const line = lineOf.get(memory.id);
      if (memory.superseded_by !== null && line !== undefined) {
        notes.outdate(subjectOf(memory), line, "superseded", { author: "import" });
      }
    }
    if (embedder !== null) {
      for (let i = 0; i < kept.length; i += EMBED_BATCH) {
        const batch = kept.slice(i, i + EMBED_BATCH);
        const made = await embedder.embed(
          batch.map((m) => m.content),
          options.signal,
        );
        batch.forEach((m, n) => {
          const line = lineOf.get(m.id);
          const v = made[n];
          if (line !== undefined && v !== undefined) notes.putVector(line, model, v);
        });
      }
    }

    // No cut in the search itself: the notes' own precision rules decide what comes back.
    const ranking = rankingOf(config);
    const returned = new Map<string, Returned[]>();
    const shown = new Map<string, Returned[]>();
    for (const query of set.queries) {
      let vector: QueryVector | null = null;
      if (embedder !== null) {
        try {
          const [v] = await embedder.embedQuery([query.text], options.signal);
          if (v !== undefined && v.length > 0) vector = { values: v, model };
        } catch {
          // Counted by the embedder; the query goes on by words.
        }
      }
      const hits = notes.searchLines(query.text, viewerAt(query), {
        limit,
        ranking,
        now: toTimestamp(Date.parse(query.at)),
        ...(vector === null ? {} : { vector }),
      });
      const kept = precise(hits, config.notes_recall, config.min_vector);
      const found = kept.hits.flatMap((h) => {
        const id = memoryOf.get(h.line.id);
        return id === undefined ? [] : [{ id, score: h.score }];
      });
      returned.set(query.id, found);
      shown.set(query.id, kept.weak ? [] : found);
    }
    const block = scoreRecall(set, shown, ks);

    return {
      set: set.name,
      target: "notes",
      memories: set.memories.length,
      embedder: embedder === null ? null : model,
      embedding_failures: embedder === null ? 0 : embedder.failures - failuresBefore,
      limit,
      config: {
        min_score: config.notes_recall.min_score,
        min_vector: config.min_vector,
        recall_limit: config.recall_limit,
        weights: { ...config.weights },
      },
      ...scoreRecall(set, returned, ks),
      block: {
        recall_at: block.recall_at,
        mrr: block.mrr,
        nothing_returned_rate: block.nothing_returned_rate,
        nothing_mean_returned: block.nothing_mean_returned,
      },
    };
  } finally {
    await store.close();
  }
}
