// The one-off, idempotent migration into person cards (docs/design/v2-architecture.md §3.1,
// §3.6): what was spread over several places becomes one card per person, and nothing is
// deleted from where it was.
//
//   social relationships  → card.snapshot (numbers, owner / blocked, call name), the notes
//                           become her feeling when she has none (and stay in `legacy.notes`)
//   self:state hearts     → attachment (the old romance; people with none get a small one
//                           from how much she likes them, below the crush threshold)
//   self:feeling:*        → card.text (the record keeps its shape)
//   knowledge person docs → references in `legacy.knowledge` (the documents stay in place)
//   mood:last             → kept in the marker (the mood is derived now and stores nothing)
//
// Per person, `migrated_at` says it is done, so a second run (or one that crashed halfway)
// changes nothing it already did. Sentences with per-call reference codes (`u1`) are dropped,
// never guessed at.

import type { RelationshipStore, SettingsStore } from "@miyoria/store";
import {
  assignHandle,
  type Handle,
  isJsonObject,
  isValidHandle,
  type JsonValue,
  type PersonId,
  type ProfileId,
  safeName,
  toTimestamp,
} from "@miyoria/types";
import { type CardRecord, type FeelingsBook, stripEphemeral } from "./feelings.js";
import type { HeartBook } from "./heart.js";

/** Settings key of the migration marker. */
export const MIGRATION_KEY = "self:cards:migration";
/** Where the knowledge module keeps its documents (read only). */
const KNOWLEDGE_PREFIX = "knowledge:doc:";
const MOOD_KEY = "mood:last";
/** Attachment from affinity alone stays below the crush threshold. */
const MAX_SEED_ATTACHMENT = 0.3;
const SEED_FROM_AFFINITY = 25;

export interface MigrationDeps {
  store: SettingsStore;
  profile: ProfileId;
  feelings: FeelingsBook;
  hearts: HeartBook;
  /** The social relationships (read only); `null` when there is no social store. */
  relationships: RelationshipStore | null;
  /** The handle directory's handle, when it has one. */
  handleOf: (person: PersonId) => Handle | null;
  /** Display names by person (from the people store). */
  names: ReadonlyMap<PersonId, string>;
  /** Saves the hearts (`self:state`) when the migration gave someone an attachment. */
  persist?: () => Promise<void>;
  now: number;
}

export interface MigrationReport {
  /** People found in any of the places. */
  people: number;
  /** Cards filled in by this run. */
  migrated: number;
  /** Cards already done before this run. */
  skipped: number;
  /** Sentences dropped for carrying reference codes. */
  dropped: number;
}

interface KnowledgeRef {
  id: string;
  kind: string;
  title: string;
}

function personDocs(records: Iterable<[string, JsonValue]>): Map<PersonId, KnowledgeRef[]> {
  const out = new Map<PersonId, KnowledgeRef[]>();
  for (const [key, value] of records) {
    if (!isJsonObject(value)) continue;
    const subject = value.subject;
    if (!isJsonObject(subject) || subject.type !== "person" || typeof subject.person !== "string") {
      continue;
    }
    const list = out.get(subject.person) ?? [];
    list.push({
      id: typeof value.id === "string" ? value.id : key.slice(KNOWLEDGE_PREFIX.length),
      kind: typeof value.kind === "string" ? value.kind : "",
      title: typeof value.title === "string" ? value.title : "",
    });
    out.set(subject.person, list);
  }
  return out;
}

/** Attachment a person gets from how much she likes them alone (never a crush). */
export function seedAttachment(affinity: number): number {
  if (affinity <= SEED_FROM_AFFINITY) return 0;
  return Math.min(
    (MAX_SEED_ATTACHMENT * (affinity - SEED_FROM_AFFINITY)) / (100 - SEED_FROM_AFFINITY),
    MAX_SEED_ATTACHMENT,
  );
}

/** Runs the migration. Safe to run again (and after a crash): finished cards are skipped. */
export async function migrateCards(d: MigrationDeps): Promise<MigrationReport> {
  const report: MigrationReport = { people: 0, migrated: 0, skipped: 0, dropped: 0 };
  const relRows = (await d.relationships?.list(d.profile).catch(() => [])) ?? [];
  const rels = new Map(relRows.map((r) => [r.person, r] as const));
  const docs = personDocs(await d.store.list(d.profile, KNOWLEDGE_PREFIX).catch(() => new Map()));
  const records = new Map(d.feelings.records().map((r) => [r.person, r] as const));
  const people = new Set<PersonId>([
    ...rels.keys(),
    ...records.keys(),
    ...d.hearts.people(),
    ...docs.keys(),
  ]);
  report.people = people.size;

  // Handles already taken, so two people with one name get `Owen` and `Owen#2`.
  const taken = new Set<Handle>();
  for (const r of records.values()) if (r.extras.handle) taken.add(r.extras.handle);

  let seeded = false;
  for (const person of [...people].sort()) {
    const record: CardRecord | undefined = records.get(person);
    if (record?.extras.migrated_at) {
      report.skipped++;
      continue;
    }
    const rel = rels.get(person) ?? null;
    const heart = d.hearts.heart(person, d.now);
    const name = d.names.get(person) ?? heart?.name ?? null;

    let handle: Handle | null = record?.extras.handle ?? null;
    if (handle === null) {
      const known = d.handleOf(person);
      if (known !== null && isValidHandle(known)) handle = known;
      else if (name !== null && name.trim() !== "") {
        handle = assignHandle(safeName(name).replace(/…$/, ""), (h) => taken.has(h));
      }
      if (handle !== null) taken.add(handle);
    }

    // Her feeling: what she wrote stays; the social impression fills in when she wrote none.
    const notes = rel?.notes.trim() ?? "";
    if ((record?.text.trim() ?? "") === "" && notes !== "") {
      const kept = stripEphemeral(notes);
      if (kept !== notes) report.dropped++;
      if (kept !== "") await d.feelings.set(person, kept, "migration", d.now);
    } else if (record && stripEphemeral(record.text) !== record.text) {
      report.dropped++;
      await d.feelings.set(person, record.text, record.by, Date.parse(record.updated_at) || d.now);
    }

    if (!d.hearts.has(person) && rel) {
      seeded = d.hearts.seed(person, seedAttachment(rel.affinity), name, d.now) || seeded;
      // Saved before the card says it is done, so a crash in between redoes the seed.
      if (seeded) await d.persist?.();
    }

    await d.feelings.patch(
      person,
      (x) => {
        x.handle = handle;
        x.call_name = rel?.call_name ?? x.call_name;
        if (rel) {
          x.snapshot = {
            affinity: rel.affinity,
            trust: rel.trust,
            familiarity: rel.familiarity,
            owner: rel.tags.includes("owner"),
            blocked: rel.tags.includes("blocked"),
            interactions: rel.interactions,
            last_interaction: rel.last_interaction,
          };
        }
        if (heart && heart.romance > 0) x.legacy.romance = heart.romance;
        if (notes !== "") x.legacy.notes = stripEphemeral(notes);
        const refs = docs.get(person);
        if (refs && refs.length > 0) x.legacy.knowledge = refs;
        x.migrated_at = toTimestamp(d.now);
      },
      d.now,
    );
    report.migrated++;
  }

  const legacyMood = await d.store.get(d.profile, MOOD_KEY).catch(() => null);
  const marker = await d.store.get(d.profile, MIGRATION_KEY).catch(() => null);
  if (report.migrated > 0 || marker === null) {
    await d.store.set(d.profile, MIGRATION_KEY, {
      version: 1,
      at: isJsonObject(marker) && typeof marker.at === "string" ? marker.at : toTimestamp(d.now),
      people: report.people,
      legacy_mood: legacyMood,
    });
  }
  return report;
}
