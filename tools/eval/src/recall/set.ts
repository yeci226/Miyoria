// The recall set format: memories she holds and lines she answers, each line labelled with the
// memories that should come back. One JSON file; scopes and places use the engine's own shapes
// (`MemoryScope`, `ContextKey`, `AccountRef`), so a set says exactly where each memory may be seen.

import { readFileSync } from "node:fs";
import { z } from "zod";

const ID = z.string().regex(/^[A-Za-z0-9_.-]+$/);
/** An ISO 8601 time. */
const Time = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "not an ISO 8601 time");
const Unit = z.number().min(0).max(1);

export const RecallAccountSchema = z.object({ platform: z.string(), id: z.string() }).strict();

/** `ContextKey`: `scope` is the guild id, `null` in a DM. */
export const RecallContextSchema = z
  .object({
    platform: z.string(),
    scope: z.string().nullable(),
    channel: z.string(),
    kind: z.enum(["channel", "thread", "dm", "voice"]),
  })
  .strict();

/** `MemoryScope` (`packages/store/src/records.ts`). */
export const RecallScopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("global") }).strict(),
  z.object({ type: z.literal("guild"), platform: z.string(), guild: z.string() }).strict(),
  z.object({ type: z.literal("channel"), context: RecallContextSchema }).strict(),
  z.object({ type: z.literal("dm"), account: RecallAccountSchema }).strict(),
  z.object({ type: z.literal("person"), person: z.string() }).strict(),
]);
export type RecallScope = z.output<typeof RecallScopeSchema>;

export const RecallMemorySchema = z
  .object({
    id: ID,
    kind: z.enum(["episode", "fact", "self_note", "followup"]),
    content: z.string().trim().min(1),
    scope: RecallScopeSchema,
    /** Person ids the memory is about. */
    subjects: z.array(z.string()).default([]),
    /** When it was written (its `created_at` and `updated_at`). */
    at: Time,
    importance: Unit.default(0.5),
    confidence: Unit.default(0.8),
    /** The memory that replaced this one: it is stored as superseded and must never come back. */
    superseded_by: ID.nullable().default(null),
  })
  .strict();
export type RecallMemory = z.output<typeof RecallMemorySchema>;

/**
 * Where a turn happens: the context, and the accounts in it (the participants and speakers of a
 * prompt request). The accounts only matter in a DM, where they open the `dm` scopes.
 */
export const RecallPlaceSchema = z
  .object({ context: RecallContextSchema, accounts: z.array(RecallAccountSchema).default([]) })
  .strict();
export type RecallPlace = z.output<typeof RecallPlaceSchema>;

export const RecallQuerySchema = z
  .object({
    id: ID,
    /** The line she is answering. */
    text: z.string().trim().min(1),
    /** The lines before it, oldest first (a turn reads the last four). */
    context: z.array(z.string()).max(4).default([]),
    /** Person ids present. */
    people: z.array(z.string()).default([]),
    /** The ones she is talking with; absent: everyone present. */
    talking_with: z.array(z.string()).optional(),
    place: RecallPlaceSchema,
    /** The time of the turn. */
    at: Time,
    /** Memory ids that should come back. Empty: nothing should. */
    relevant: z.array(ID),
    note: z.string().optional(),
  })
  .strict();
export type RecallQuery = z.output<typeof RecallQuerySchema>;

export const RecallSetSchema = z
  .object({
    name: z.string().default(""),
    description: z.string().default(""),
    memories: z.array(RecallMemorySchema).min(1),
    queries: z.array(RecallQuerySchema).min(1),
  })
  .strict()
  .superRefine((set, ctx) => {
    const problem = (message: string) => ctx.addIssue({ code: "custom", message });
    const memories = new Map<string, RecallMemory>();
    let newest = Number.NEGATIVE_INFINITY;
    for (const m of set.memories) {
      if (memories.has(m.id)) problem(`duplicate memory id \`${m.id}\``);
      memories.set(m.id, m);
      newest = Math.max(newest, Date.parse(m.at));
    }
    for (const m of set.memories) {
      if (m.superseded_by === null) continue;
      if (m.superseded_by === m.id || !memories.has(m.superseded_by)) {
        problem(`memory \`${m.id}\` is superseded by unknown memory \`${m.superseded_by}\``);
      }
    }
    const queries = new Set<string>();
    for (const q of set.queries) {
      if (queries.has(q.id)) problem(`duplicate query id \`${q.id}\``);
      queries.add(q.id);
      if (new Set(q.relevant).size !== q.relevant.length) {
        problem(`query \`${q.id}\` lists a relevant memory twice`);
      }
      for (const id of q.relevant) {
        if (!memories.has(id)) problem(`query \`${q.id}\` expects unknown memory \`${id}\``);
      }
      for (const person of q.talking_with ?? []) {
        if (!q.people.includes(person)) {
          problem(`query \`${q.id}\` talks with \`${person}\`, who is not present`);
        }
      }
      // Every query runs against the whole set: a memory written after the turn would be there.
      if (Date.parse(q.at) < newest) {
        problem(`query \`${q.id}\` is earlier than the newest memory`);
      }
    }
  });
export type RecallSet = z.output<typeof RecallSetSchema>;

export class RecallSetError extends Error {
  override readonly name = "RecallSetError";

  constructor(
    message: string,
    readonly path: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** Reads and checks a set file. */
export function loadRecallSet(path: string): RecallSet {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new RecallSetError(`cannot read recall set \`${path}\``, path, { cause });
  }
  const parsed = RecallSetSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RecallSetError(
      `invalid recall set \`${path}\`: ${z.prettifyError(parsed.error)}`,
      path,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}
