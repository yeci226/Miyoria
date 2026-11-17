// The old per-person cards of module `self` (`self:feeling:<person id>` in the settings store),
// read once by the migration to `heart_person` (`legacy.ts`, H8). Nothing writes them any more
// since phase 4 step 5; they stay where they are (archived data is never deleted), read-only.
//
// A record is `{ text, updated_at, by, card: { v, handle, call_name, public_feeling, stance,
// stance_level, snapshot, ledger, legacy, migrated_at } }`; `text` is her feeling about them.

import type { SettingsStore } from "@miyoria/store";
import {
  isJsonObject,
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

/** A card with nothing in it (the shape the migration reads). */
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

/** Every old card of `profile` (read-only). */
export async function readOldCards(
  store: SettingsStore,
  profile: ProfileId,
): Promise<CardRecord[]> {
  const out: CardRecord[] = [];
  for (const [key, value] of await store.list(profile, FEELING_PREFIX)) {
    const person = key.slice(FEELING_PREFIX.length);
    const record = person === "" ? null : parseRecord(person, value);
    if (record) out.push(record);
  }
  return out;
}
