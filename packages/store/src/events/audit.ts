// Audit entries on the event log (docs/design/v5-data.md §2.7, §8 step 6): who changed what, one
// `audit.<area>.<action>` event each (`auditType`), for the owner, kept forever; and `AuditLog`
// read back from them.
//
// - Writing: every writer goes through `AuditLog.append` (the `AuditLogKey` service), so the
//   writers do not change. The payload keeps the action as written beside actor, target, detail
//   and ok. An actor that names an account (`discord:<id>`) gives the event that account and its
//   person when identity knows them; nobody is created for an audit entry. An entry has no place.
// - Reading: `recent` is unchanged: newest first, ties by id (the larger first), for everyone or
//   one actor, over partial indexes (core migration 4).

import {
  AuditEntrySchema,
  AuditRecorded,
  auditType,
  type EventEnvelope,
} from "@miyoria/contracts/events";
import { getLogger } from "@miyoria/runtime/kernel";
import type { AccountRef, JsonValue } from "@miyoria/types";
import { fromMicros, parseJson, StoreError, sqlLimit } from "../common.js";
import type { Db, Row } from "../db.js";
import type { Identity } from "../identity/identity.js";
import type { AuditEntry } from "../records.js";
import type { AuditLog } from "../stores.js";
import type { EventStore } from "./log.js";

const log = getLogger("store.audit");

/** Where an audit entry is stored from: the `AuditLog` service. */
const SOURCE = "store.audit";

/** The audit types, as the partial indexes of core migration 4 name them. */
export const AUDIT_TYPES_SQL = "type GLOB 'audit.*'";

// Fixed statement texts: `Db` prepares each once. Without statistics the planner prefers the
// `(type, seq)` range of `audit.*` and sorts it; `INDEXED BY` names the partial index that reads
// newest first (for everyone, or one actor) and stops at the limit.
const SELECT = "SELECT id, at, data FROM events";
const WHERE = `WHERE ${AUDIT_TYPES_SQL} AND redacted_at IS NULL`;
const ORDER = "ORDER BY at DESC, id DESC LIMIT $limit";
const RECENT = `${SELECT} INDEXED BY events_audit_idx ${WHERE} ${ORDER}`;
const RECENT_OF_ACTOR = `${SELECT} INDEXED BY events_audit_actor_idx ${WHERE} AND json_extract(data, '$.actor') = $actor ${ORDER}`;

function text(row: Row, column: string): string {
  const v = row[column];
  if (typeof v !== "string") throw new StoreError(`events column \`${column}\` is not text`);
  return v;
}

function int(row: Row, column: string): number {
  const v = row[column];
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  throw new StoreError(`events column \`${column}\` is not a number`);
}

/** The account an actor names (`<platform>:<id>`), if it names one. */
function actorAccount(actor: string): AccountRef | null {
  const colon = actor.indexOf(":");
  if (colon <= 0 || colon === actor.length - 1) return null;
  return { platform: actor.slice(0, colon), id: actor.slice(colon + 1) };
}

/** The audit entries of one database (one character), as `AuditLog`. */
export class AuditTrail implements AuditLog {
  readonly #db: Db;
  readonly #events: EventStore;
  readonly #identity: Identity;

  constructor(db: Db, events: EventStore, identity: Identity) {
    this.#db = db;
    this.#events = events;
    this.#identity = identity;
  }

  async append(entry: AuditEntry): Promise<void> {
    try {
      this.#db.tx((): EventEnvelope => {
        if (this.#db.get("SELECT 1 AS x FROM events WHERE id = $id", { id: entry.id })) {
          throw new StoreError(`audit entry \`${entry.id}\` already exists`);
        }
        const ref = actorAccount(entry.actor);
        const account = ref === null ? null : this.#identity.account(ref);
        return this.#events.appendNow({
          draft: {
            id: entry.id,
            at: entry.at,
            type: auditType(entry.action),
            v: AuditRecorded.v,
            person_id: account?.person_id ?? null,
            account_id: account?.id ?? null,
            data: {
              actor: entry.actor,
              action: entry.action,
              target: entry.target,
              detail: entry.detail,
              ok: entry.ok,
            },
          },
          source: SOURCE,
        });
      });
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      throw new StoreError("cannot append audit entry", { cause });
    }
  }

  async recent(limit: number, actor: string | null): Promise<AuditEntry[]> {
    const n = sqlLimit(limit) ?? -1;
    if (n === 0) return [];
    const rows =
      actor === null
        ? this.#db.all(RECENT, { limit: n })
        : this.#db.all(RECENT_OF_ACTOR, { actor, limit: n });
    const out: AuditEntry[] = [];
    for (const row of rows) {
      const data = AuditEntrySchema.safeParse(parseJson<unknown>(text(row, "data"), "audit entry"));
      if (!data.success) {
        log.warn({ event: row.id }, "a stored audit entry does not fit its type: left out");
        continue;
      }
      out.push({
        id: text(row, "id"),
        at: fromMicros(int(row, "at")),
        actor: data.data.actor,
        action: data.data.action,
        target: data.data.target,
        detail: data.data.detail as JsonValue,
        ok: data.data.ok,
      });
    }
    return out;
  }
}
