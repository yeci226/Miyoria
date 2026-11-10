// Her own description of how she feels about each person, and the rest of a person's card that
// only she owns (handle, call name, the numbers as last seen, the day's bond ledger and what
// the migration carried over). One settings record per person (`self:feeling:<person id>`) of
// the active profile, cached in memory so the prompt reads it without I/O.
//
// The record keeps its old shape (`text`, `updated_at`, `by`), so what only knows feelings
// keeps working, and adds `card` for the rest:
//
//   { text, updated_at, by, card: { v, handle, call_name, public_feeling, stance, stance_level, snapshot, ledger, legacy,
//     migrated_at } }
//
// A person without a feeling text has `text: ""` (readers of feelings skip those).

import type { SettingsStore } from "@miyoria/store";
import {
  ephemeralHandlesIn,
  type Feeling,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type PersonId,
  type ProfileId,
  toTimestamp,
} from "@miyoria/types";

/** Settings key prefix of feelings records. */
export const FEELING_PREFIX = "self:feeling:";

export function feelingKey(person: PersonId): string {
  return `${FEELING_PREFIX}${person}`;
}

/** The numbers of a person as the social module last had them. */
export interface BondSnapshot {
  affinity: number;
  trust: number;
  familiarity: number;
  owner: boolean;
  blocked: boolean;
  interactions: number;
  last_interaction: string | null;
}

/** How much of each bond number changed on one local day (for the daily caps). */
export interface BondLedger {
  day: number;
  attachment: number;
  affinity: number;
  trust: number;
  familiarity: number;
}

/** What the migration carried over from the older places (nothing is deleted from them). */
export interface CardLegacy {
  /** Her romance for them as it was (it became `attachment`). */
  romance?: number;
  /** The social module's impression notes. */
  notes?: string;
  /** Knowledge documents about them (references; the documents stay where they are). */
  knowledge?: { id: string; kind: string; title: string }[];
}

/** The per-person parts of a card that `self` stores itself. */
export interface CardExtras {
  v: 1;
  handle: string | null;
  call_name: string | null;
  /** The line shown to the person themselves (`PersonCard.public_feeling`). */
  public_feeling: string | null;
  /** How she acts with them (`PersonCard.stance`), prompt-only. */
  stance: string | null;
  /** The affinity level the stance was written at. */
  stance_level: number | null;
  snapshot: BondSnapshot | null;
  ledger: BondLedger;
  legacy: CardLegacy;
  /** When the migration filled this card in; `null` while it has not. */
  migrated_at: string | null;
}

export function emptyExtras(): CardExtras {
  return {
    v: 1,
    handle: null,
    call_name: null,
    public_feeling: null,
    stance: null,
    stance_level: null,
    snapshot: null,
    ledger: { day: 0, attachment: 0, affinity: 0, trust: 0, familiarity: 0 },
    legacy: {},
    migrated_at: null,
  };
}

/** One person's stored card parts and feeling. */
export interface CardRecord {
  person: PersonId;
  /** Her feeling about them (`""`: none). */
  text: string;
  updated_at: string;
  by: string;
  extras: CardExtras;
}

const num = (v: JsonValue | undefined, fallback = 0) =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const strOrNull = (v: JsonValue | undefined) => (typeof v === "string" ? v : null);

function parseSnapshot(v: JsonValue | undefined): BondSnapshot | null {
  if (!isJsonObject(v)) return null;
  return {
    affinity: num(v.affinity),
    trust: num(v.trust),
    familiarity: num(v.familiarity),
    owner: v.owner === true,
    blocked: v.blocked === true,
    interactions: num(v.interactions),
    last_interaction: strOrNull(v.last_interaction),
  };
}

function parseLedger(v: JsonValue | undefined): BondLedger {
  if (!isJsonObject(v)) return emptyExtras().ledger;
  return {
    day: num(v.day),
    attachment: num(v.attachment),
    affinity: num(v.affinity),
    trust: num(v.trust),
    familiarity: num(v.familiarity),
  };
}

function parseLegacy(v: JsonValue | undefined): CardLegacy {
  if (!isJsonObject(v)) return {};
  const out: CardLegacy = {};
  if (typeof v.romance === "number") out.romance = v.romance;
  if (typeof v.notes === "string") out.notes = v.notes;
  if (Array.isArray(v.knowledge)) {
    out.knowledge = v.knowledge.flatMap((k) =>
      isJsonObject(k) && typeof k.id === "string"
        ? [{ id: k.id, kind: strOrNull(k.kind) ?? "", title: strOrNull(k.title) ?? "" }]
        : [],
    );
  }
  return out;
}

function parseExtras(v: JsonValue | undefined): CardExtras {
  if (!isJsonObject(v)) return emptyExtras();
  return {
    v: 1,
    handle: strOrNull(v.handle),
    call_name: strOrNull(v.call_name),
    public_feeling: strOrNull(v.public_feeling),
    stance: strOrNull(v.stance),
    stance_level:
      typeof v.stance_level === "number" && Number.isFinite(v.stance_level) ? v.stance_level : null,
    snapshot: parseSnapshot(v.snapshot),
    ledger: parseLedger(v.ledger),
    legacy: parseLegacy(v.legacy),
    migrated_at: strOrNull(v.migrated_at),
  };
}

function parseRecord(person: PersonId, value: JsonValue): CardRecord | null {
  if (!isJsonObject(value)) return null;
  const text = typeof value.text === "string" ? value.text : "";
  const card = value.card;
  if (text.trim() === "" && !isJsonObject(card)) return null;
  return {
    person,
    text,
    updated_at: typeof value.updated_at === "string" ? value.updated_at : toTimestamp(0),
    by: typeof value.by === "string" ? value.by : "self",
    extras: parseExtras(isJsonObject(card) ? card : undefined),
  };
}

function toJson(r: CardRecord): JsonObject {
  return {
    text: r.text,
    updated_at: r.updated_at,
    by: r.by,
    card: JSON.parse(JSON.stringify(r.extras)) as JsonObject,
  };
}

function clone(r: CardRecord): CardRecord {
  return { ...r, extras: structuredClone(r.extras) };
}

/**
 * `text` without the sentences that mention a per-call reference code (`u1`): a code means a
 * different person every call, so a sentence with one cannot be kept (we do not guess who).
 */
export function stripEphemeral(text: string): string {
  if (ephemeralHandlesIn(text).length === 0) return text;
  const parts = text.split(/(?<=[。.!?!?\n])/u);
  return parts
    .filter((part) => ephemeralHandlesIn(part).length === 0)
    .join("")
    .trim();
}

/** The longest stance line (characters). */
export const MAX_STANCE = 60;

/**
 * Her stance line as it is stored: one line, cut to `MAX_STANCE`, sentences with a per-call
 * code dropped (names are fine, as in `feeling`). `""` when nothing is left.
 */
export function cleanStance(text: string): string {
  const one = stripEphemeral(text).replace(/\s+/gu, " ").trim();
  return [...one].slice(0, MAX_STANCE).join("").trim();
}

export class FeelingsBook {
  readonly #items = new Map<PersonId, CardRecord>();

  constructor(
    private readonly store: SettingsStore | null,
    private readonly profile: ProfileId,
    private readonly maxChars: number,
  ) {}

  async load(): Promise<void> {
    if (!this.store) return;
    const records = await this.store.list(this.profile, FEELING_PREFIX);
    this.#items.clear();
    for (const [key, value] of records) {
      const person = key.slice(FEELING_PREFIX.length);
      const record = person === "" ? null : parseRecord(person, value);
      if (record) this.#items.set(person, record);
    }
  }

  /** Her feeling about `person` (`null` when she has none). */
  get(person: PersonId): Feeling | null {
    const f = this.#items.get(person);
    if (!f || f.text.trim() === "") return null;
    return { person, text: f.text, updated_at: f.updated_at, by: f.by };
  }

  /** Most recently updated first. */
  all(): Feeling[] {
    return [...this.#items.values()]
      .filter((f) => f.text.trim() !== "")
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
      .map((f) => ({ person: f.person, text: f.text, updated_at: f.updated_at, by: f.by }));
  }

  /** The stored card parts of `person`, if any. */
  record(person: PersonId): CardRecord | null {
    const r = this.#items.get(person);
    return r ? clone(r) : null;
  }

  /** Every stored card record. */
  records(): CardRecord[] {
    return [...this.#items.values()].map(clone);
  }

  #clean(text: string): string {
    const chars = [...text.trim()];
    return chars.slice(0, Math.max(this.maxChars, 1)).join("");
  }

  /**
   * Stores `text` (trimmed, limited); empty text deletes the feeling (the card parts stay).
   * Sentences with a per-call reference code (`u1`) are dropped (feelings use names); when
   * nothing is left the old feeling stays. Writes through to the store.
   */
  async set(person: PersonId, text: string, by: string, now: number): Promise<Feeling | null> {
    const asked = this.#clean(text);
    const existing = this.#items.get(person);
    const body = this.#clean(stripEphemeral(asked));
    if (body === "" && asked !== "") return existing ? this.get(person) : null;
    if (body === "") {
      if (!existing) return null;
      if (hasExtras(existing.extras)) {
        const next: CardRecord = { ...existing, text: "", updated_at: toTimestamp(now), by };
        this.#items.set(person, next);
        await this.store?.set(this.profile, feelingKey(person), toJson(next));
      } else {
        this.#items.delete(person);
        await this.store?.set(this.profile, feelingKey(person), null);
      }
      return null;
    }
    const next: CardRecord = {
      person,
      text: body,
      updated_at: toTimestamp(now),
      by,
      extras: existing?.extras ?? emptyExtras(),
    };
    this.#items.set(person, next);
    await this.store?.set(this.profile, feelingKey(person), toJson(next));
    return { person, text: body, updated_at: next.updated_at, by };
  }

  /**
   * Changes the card parts of `person` (creating the record). Returns whether anything
   * differed (nothing is written when not).
   */
  async patch(person: PersonId, f: (extras: CardExtras) => void, now: number): Promise<boolean> {
    const existing = this.#items.get(person);
    const before = JSON.stringify(existing?.extras ?? null);
    const next: CardRecord = existing
      ? clone(existing)
      : { person, text: "", updated_at: toTimestamp(now), by: "self", extras: emptyExtras() };
    f(next.extras);
    if (JSON.stringify(next.extras) === before) return false;
    this.#items.set(person, next);
    await this.store?.set(this.profile, feelingKey(person), toJson(next));
    return true;
  }
}

function hasExtras(e: CardExtras): boolean {
  return (
    e.handle !== null ||
    e.call_name !== null ||
    e.public_feeling !== null ||
    e.stance !== null ||
    e.snapshot !== null ||
    e.migrated_at !== null ||
    Object.keys(e.legacy).length > 0
  );
}
