// The migration from the old places her feelings about people live in to `heart_person` rows
// (docs/design/v5-heart.md §2.2, H8). It reads what the caller loaded and returns the rows and one
// `heart.changed` (cause `migrate`) per person; the caller writes them. Nothing old is deleted.
//
// What goes where:
// - `relationships`: bond (the old affinity), trust, familiarity, tags, call name, interactions,
//   last interaction; its `notes` (the social module's impression notes, which no prompt read)
//   stay in `legacy.notes`, and become the impression only when she wrote no feeling.
// - `relationship_deltas`: not moved one by one (one event per person is enough); how many there
//   were and when stays in `legacy.deltas`, and the newest is the last interaction when the
//   relationship has none.
// - `self:feeling:<person>` cards: her feeling text is the impression; stance, public line and
//   call name are carried over; the card's numbers stand in when there is no relationship.
// - the `hearts` of `self:state`: missing (想念) is longing and resentment (不爽) is grudge; her
//   `romance` stays in `legacy.romance`, kept and never read (H5: 在意 is computed now), and
//   jealousy and gratitude stay in `legacy.emotions`.
//
// Warmth starts where the daily pass would take it for the bond (its baseline), the other numbers
// at their neutral start. Every tier from 知心 up that the bond has already reached gets an anchor
// marked `migrate`, so nobody is held back by H4 for a tier they had before it existed. A person
// who already has a row is skipped, so running it twice changes nothing.

import type { Relationship, RelationshipDelta } from "@miyoria/store";
import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
  PERSON_EMOTION_NAMES,
  type PersonEmotionName,
  type PersonId,
  type Timestamp,
  toTimestamp,
} from "@miyoria/types";
import type { HeartPersonConfig } from "./config.js";
import {
  BLOCKED_TAG,
  clampField,
  type HeartPerson,
  newPerson,
  OWNER_TAG,
  type TierAnchor,
} from "./model.js";
import type { CardRecord } from "./old-cards.js";
import {
  ANCHORED_TIERS,
  type HeartChange,
  settle,
  startingEase,
  startingRapport,
  warmthBaseline,
} from "./rules.js";

/** One person of the `hearts` part of `self:state`. */
export interface LegacyHearts {
  name: string | null;
  /** 0..1, her 在意 for them (the old crush grew from it). */
  romance: number;
  emotions: Partial<Record<PersonEmotionName, number>>;
  last_seen: Timestamp | null;
  last_together: Timestamp | null;
  /** They were her crush (暗戀) when the state was saved. */
  crush: boolean;
}

/** What the migration reads, as the caller loaded it. */
export interface LegacyInput {
  /** Every `relationships` row of the profile. */
  relationships: readonly Relationship[];
  /** `relationship_deltas` by person. */
  deltas: ReadonlyMap<PersonId, readonly RelationshipDelta[]>;
  /** Every `self:feeling:<person>` record (`readOldCards`). */
  cards: readonly CardRecord[];
  /** `self:state` as saved; `null` when there is none. */
  selfState: JsonValue | null;
}

export interface LegacyResult {
  /** New rows, by person id. */
  rows: HeartPerson[];
  /** One `heart.changed` per new row (cause `migrate`, field `bond`). */
  changes: HeartChange[];
  /** People that already had a row, left as they are. */
  skipped: PersonId[];
}

const unit = (v: JsonValue | undefined) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0;

function timestampOrNull(v: JsonValue | undefined): Timestamp | null {
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : toTimestamp(ms);
}

/** The `hearts` part of a saved `self:state` (`HeartBook.toJson`), by person. */
export function parseLegacyHearts(selfState: JsonValue | null): Map<PersonId, LegacyHearts> {
  const out = new Map<PersonId, LegacyHearts>();
  if (selfState === null || !isJsonObject(selfState)) return out;
  const hearts = selfState.hearts;
  if (hearts === undefined || !isJsonObject(hearts) || !isJsonObject(hearts.people)) return out;
  const crush =
    isJsonObject(hearts.crush) && typeof hearts.crush.person === "string"
      ? hearts.crush.person
      : null;
  for (const [person, raw] of Object.entries(hearts.people)) {
    if (!isJsonObject(raw)) continue;
    const emotions: Partial<Record<PersonEmotionName, number>> = {};
    if (isJsonObject(raw.emotions)) {
      for (const name of PERSON_EMOTION_NAMES) {
        const v = raw.emotions[name];
        if (typeof v === "number" && Number.isFinite(v) && v > 0) emotions[name] = unit(v);
      }
    }
    out.set(person, {
      name: typeof raw.name === "string" ? raw.name : null,
      romance: unit(raw.romance),
      emotions,
      last_seen: timestampOrNull(raw.last_seen),
      last_together: timestampOrNull(raw.last_together),
      crush: crush === person,
    });
  }
  return out;
}

function latest(a: Timestamp | null, b: Timestamp | null): Timestamp | null {
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function deltaSummary(deltas: readonly RelationshipDelta[]): JsonObject | null {
  if (deltas.length === 0) return null;
  const times = deltas.map((d) => Date.parse(d.at)).filter((ms) => !Number.isNaN(ms));
  if (times.length === 0) return { count: deltas.length, first_at: null, last_at: null };
  return {
    count: deltas.length,
    first_at: toTimestamp(Math.min(...times)),
    last_at: toTimestamp(Math.max(...times)),
  };
}

function migrateOne(
  person: PersonId,
  rel: Relationship | undefined,
  card: CardRecord | undefined,
  heart: LegacyHearts | undefined,
  deltas: readonly RelationshipDelta[],
  rules: HeartPersonConfig,
  at: Timestamp,
): HeartPerson {
  const extras = card?.extras;
  const snapshot = extras?.snapshot ?? null;
  const row = newPerson(person, at, rules.default_trust);
  row.bond = clampField("bond", rel?.affinity ?? snapshot?.affinity ?? 0);
  row.trust = clampField("trust", rel?.trust ?? snapshot?.trust ?? rules.default_trust);
  row.familiarity = clampField("familiarity", rel?.familiarity ?? snapshot?.familiarity ?? 0);

  const tags = new Set(rel?.tags ?? []);
  if (snapshot?.owner) tags.add(OWNER_TAG);
  if (snapshot?.blocked) tags.add(BLOCKED_TAG);
  row.tags = [...tags];

  const feeling = card?.text.trim() ?? "";
  const notes = rel?.notes.trim() ?? "";
  row.impression = feeling !== "" ? feeling : notes;
  row.stance = extras?.stance ?? "";
  row.public_feeling = extras?.public_feeling ?? null;
  row.call_name = rel?.call_name ?? extras?.call_name ?? null;

  row.warmth = warmthBaseline(row.bond);
  row.ease = startingEase(row.bond, row.familiarity);
  row.rapport = startingRapport(row.bond, row.familiarity);
  row.longing = heart?.emotions.missing ?? 0;
  row.grudge = heart?.emotions.resentment ?? 0;

  const summary = deltaSummary(deltas);
  row.interactions = rel?.interactions ?? snapshot?.interactions ?? 0;
  row.last_interaction =
    rel?.last_interaction ??
    timestampOrNull(snapshot?.last_interaction ?? undefined) ??
    (summary === null ? null : timestampOrNull(summary.last_at));
  row.last_seen = latest(heart?.last_seen ?? null, row.last_interaction);
  row.last_together = heart?.last_together ?? null;

  const legacy: JsonObject = { migrated_at: at };
  const romance = heart?.romance ?? extras?.legacy.romance;
  if (romance !== undefined) legacy.romance = romance;
  const oldNotes = notes !== "" ? notes : (extras?.legacy.notes ?? "");
  if (oldNotes !== "") legacy.notes = oldNotes;
  if (extras?.legacy.knowledge && extras.legacy.knowledge.length > 0) {
    legacy.knowledge = extras.legacy.knowledge.map((k) => ({ ...k }));
  }
  const kept: JsonObject = {};
  for (const name of ["jealousy", "gratitude"] as const) {
    const v = heart?.emotions[name];
    if (v !== undefined) kept[name] = v;
  }
  if (Object.keys(kept).length > 0) legacy.emotions = kept;
  if (heart?.crush) legacy.crush = true;
  if (heart?.name) legacy.name = heart.name;
  if (extras?.handle) legacy.handle = extras.handle;
  if (extras?.stance_level !== null && extras?.stance_level !== undefined) {
    legacy.stance_level = extras.stance_level;
  }
  if (summary !== null) legacy.deltas = summary;
  legacy.from = [
    ...(rel ? ["relationships"] : []),
    ...(summary ? ["relationship_deltas"] : []),
    ...(card ? ["self:feeling"] : []),
    ...(heart ? ["self:state"] : []),
  ];
  row.legacy = legacy;

  // The owner's floor first, so the tiers grandfathered are the ones the row really is in.
  const settled = settle(row, rules);
  const anchors: TierAnchor[] = ANCHORED_TIERS.filter((tier) => tier <= settled.bond).map(
    (tier) => ({ tier, note_ref: null, quote: "", at, by: "migrate" }),
  );
  return { ...settled, anchors };
}

/**
 * The `heart_person` rows for everyone in the old records who has none yet, and one `migrate`
 * change each. `has(person)`: whether a row exists already (those are skipped).
 */
export function migrateLegacy(
  input: LegacyInput,
  has: (person: PersonId) => boolean,
  rules: HeartPersonConfig,
  now: number,
): LegacyResult {
  const at = toTimestamp(now);
  const hearts = parseLegacyHearts(input.selfState);
  const rels = new Map(input.relationships.map((r) => [r.person, r]));
  const cards = new Map(input.cards.map((c) => [c.person, c]));
  const people = [...new Set([...rels.keys(), ...cards.keys(), ...hearts.keys()])].sort();
  const result: LegacyResult = { rows: [], changes: [], skipped: [] };
  for (const person of people) {
    if (has(person)) {
      result.skipped.push(person);
      continue;
    }
    const row = migrateOne(
      person,
      rels.get(person),
      cards.get(person),
      hearts.get(person),
      input.deltas.get(person) ?? [],
      rules,
      at,
    );
    result.rows.push(row);
    result.changes.push({
      person,
      field: "bond",
      delta: row.bond,
      value_after: row.bond,
      proposed: null,
      reason_quote: "",
      cause: "migrate",
    });
  }
  return result;
}
