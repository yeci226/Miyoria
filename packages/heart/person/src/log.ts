// The heart's events on the event log: how a change and a piece of evidence are written, a
// person's history (newest first, paged) and the day's ledger for the caps. There is no delta
// table (docs/design/v5-heart.md §2.2): both reads are queries of `heart.changed`.
//
// Writing a change goes with writing the `heart_person` row, in one transaction
// (`EventStore.appendNow` inside `Db.tx`), as the coin ledger does with `economy.posted`; this
// file only builds the event, so the row's store and this log share it.

import {
  type EventStore,
  type EventWrite,
  HeartChanged,
  HeartEvidence,
  type HeartEvidenceData,
} from "@miyoria/store";
import { Events, newId, type PersonId, type Timestamp, toTimestamp } from "@miyoria/types";
import type { HeartPersonConfig } from "./config.js";
import { type DayLedger, dayStart, type HeartChange, ledgerFrom, localDay } from "./rules.js";

/** What the heart writes to the log as (its module's id once there is one). */
export const HEART_SOURCE = "heart";

/** At most this many changes of one person in one day are read for the ledger. */
const DAY_LIMIT = 10_000;
/** At most this many events of each kind are read to rank who to reflect on. */
const ACTIVITY_LIMIT = 50_000;
/** The chat lines of a person on the log (the types `facts` writes with the author's person). */
const LINE_TYPES: readonly string[] = [
  Events.PlatformMessageCreated.type,
  Events.VoiceUtteranceEvent.type,
];

/** One change as the history shows it. */
export interface HeartHistoryEntry {
  /** The event's id: the cursor for the next page (`before`). */
  id: string;
  at: Timestamp;
  change: HeartChange;
}

/** One piece of evidence as the reflection reads it. */
export interface HeartEvidenceEntry {
  id: string;
  evidence: HeartEvidenceData;
}

/** The log write of one change. */
export function changeWrite(
  change: HeartChange,
  at: Timestamp,
  turn: string | null = null,
): EventWrite {
  return {
    draft: {
      id: newId(),
      at,
      type: HeartChanged.type,
      v: HeartChanged.v,
      person_id: change.person,
      turn,
      data: change,
    },
    source: HEART_SOURCE,
  };
}

/** The log write of one piece of evidence; the session decides its scope. */
export function evidenceWrite(
  evidence: HeartEvidenceData,
  session: string | null = null,
): EventWrite {
  return {
    draft: {
      id: newId(),
      at: evidence.at,
      type: HeartEvidence.type,
      v: HeartEvidence.v,
      person_id: evidence.person,
      session,
      data: evidence,
    },
    source: HEART_SOURCE,
  };
}

/** Reads the heart's events of the log. */
export class HeartLog {
  constructor(
    private readonly events: EventStore,
    private readonly rules: HeartPersonConfig,
  ) {}

  /**
   * The changes of `person`, newest first, `limit` at a time; pass the last entry's `id` as
   * `before` for the next page. A change whose content was redacted is left out.
   */
  history(
    person: PersonId,
    options: { before?: string; limit?: number } = {},
  ): HeartHistoryEntry[] {
    const rows = this.events.query({
      types: [HeartChanged.type],
      personId: person,
      ...(options.before === undefined ? {} : { before: options.before }),
      order: "desc",
      limit: options.limit ?? 50,
    });
    const out: HeartHistoryEntry[] = [];
    for (const row of rows) {
      const parsed = HeartChanged.data.safeParse(row.envelope.data);
      if (parsed.success)
        out.push({ id: row.envelope.id, at: row.envelope.at, change: parsed.data });
    }
    return out;
  }

  /** The ledger of `person` for the local day of `now`, from that day's changes. */
  dayLedger(person: PersonId, now: number): DayLedger {
    const day = localDay(now, this.rules);
    const rows = this.events.query({
      types: [HeartChanged.type],
      personId: person,
      since: toTimestamp(dayStart(day, this.rules)),
      until: toTimestamp(dayStart(day + 1, this.rules)),
      order: "asc",
      limit: DAY_LIMIT,
    });
    const changes: { at: Timestamp; change: HeartChange }[] = [];
    for (const row of rows) {
      const parsed = HeartChanged.data.safeParse(row.envelope.data);
      if (parsed.success) changes.push({ at: row.envelope.at, change: parsed.data });
    }
    return ledgerFrom(day, changes, this.rules);
  }

  /** The changes of `person` from `since` until `until`, oldest first (a redacted one is left out). */
  changesBetween(
    person: PersonId,
    since: Timestamp,
    until: Timestamp,
    limit = DAY_LIMIT,
  ): HeartHistoryEntry[] {
    const rows = this.events.query({
      types: [HeartChanged.type],
      personId: person,
      since,
      until,
      order: "asc",
      limit,
    });
    const out: HeartHistoryEntry[] = [];
    for (const row of rows) {
      const parsed = HeartChanged.data.safeParse(row.envelope.data);
      if (parsed.success)
        out.push({ id: row.envelope.id, at: row.envelope.at, change: parsed.data });
    }
    return out;
  }

  /**
   * Per person, from `since` until `until`: the chat lines they said (the log's `platform.message.
   * created` and `voice.utterance`), her `feel` changes about them and the evidence about them.
   */
  activity(
    since: Timestamp,
    until: Timestamp,
    limit = ACTIVITY_LIMIT,
  ): Map<PersonId, { lines: number; changes: number; evidence: number }> {
    const out = new Map<PersonId, { lines: number; changes: number; evidence: number }>();
    const of = (p: PersonId) => {
      let c = out.get(p);
      if (c === undefined) {
        c = { lines: 0, changes: 0, evidence: 0 };
        out.set(p, c);
      }
      return c;
    };
    const window = { since, until, order: "asc" as const, limit };
    for (const row of this.events.query({ types: LINE_TYPES, ...window })) {
      const p = row.envelope.person_id;
      if (p !== null) of(p).lines += 1;
    }
    for (const row of this.events.query({ types: [HeartChanged.type], ...window })) {
      const parsed = HeartChanged.data.safeParse(row.envelope.data);
      if (parsed.success && parsed.data.cause === "feel") of(parsed.data.person).changes += 1;
    }
    for (const row of this.events.query({ types: [HeartEvidence.type], ...window })) {
      const parsed = HeartEvidence.data.safeParse(row.envelope.data);
      if (parsed.success) of(parsed.data.person).evidence += 1;
    }
    return out;
  }

  /** The newest evidence about `person`, newest first (the panel's person page). */
  recentEvidence(person: PersonId, limit = 30): HeartEvidenceEntry[] {
    const rows = this.events.query({
      types: [HeartEvidence.type],
      personId: person,
      order: "desc",
      limit,
    });
    const out: HeartEvidenceEntry[] = [];
    for (const row of rows) {
      const parsed = HeartEvidence.data.safeParse(row.envelope.data);
      if (parsed.success) out.push({ id: row.envelope.id, evidence: parsed.data });
    }
    // By when it happened, as `evidence` sorts it.
    return out.sort((a, b) => Date.parse(b.evidence.at) - Date.parse(a.evidence.at));
  }

  /** The evidence about `person` from `since` until `until`, oldest first (the reflection's day). */
  evidence(
    person: PersonId,
    since: Timestamp,
    until: Timestamp,
    limit = 200,
  ): HeartEvidenceEntry[] {
    const rows = this.events.query({
      types: [HeartEvidence.type],
      personId: person,
      since,
      until,
      order: "asc",
      limit,
    });
    const out: HeartEvidenceEntry[] = [];
    for (const row of rows) {
      const parsed = HeartEvidence.data.safeParse(row.envelope.data);
      if (parsed.success) out.push({ id: row.envelope.id, evidence: parsed.data });
    }
    // By when it happened: a span (time in voice) is written when it ends, after what came later.
    return out.sort((a, b) => Date.parse(a.evidence.at) - Date.parse(b.evidence.at));
  }
}
