// Turn records on the event log (docs/design/v5-data.md §2.7, §8 step 6): her attention decisions
// (`agent.decision`) and how each turn ended (`agent.turn.outcome`), and `DecisionLog` read back
// from them.
//
// - Writing: the facts writer records both from the bus, with the turn's cause in `parent` and
//   the person it answered (`facts/src/envelope.ts`). `append` and `appendOutcome` here write the
//   same events for callers of the interface. The place is resolved through identity from the
//   payload's context; scope comes from the session, the tier from the type (`short`).
// - Reading: the interface is unchanged. Newest first by the time the record names (`at`), ties by
//   id (a decision) or turn (an outcome), the larger first. One place is one session (a DM's is
//   its person's); a decision or outcome whose place did not resolve (a DM nobody has written in)
//   is found by the context in its payload. An outcome is one per turn: a turn written again
//   reads as its latest event. The profile argument is ignored: one database belongs to one
//   character (decision D6).

import {
  AgentDecision,
  AgentTurnOutcome,
  DecisionTraceSchema,
  type EventEnvelope,
  TurnOutcomeRecordSchema,
} from "@miyoria/contracts/events";
import { getLogger } from "@miyoria/runtime/kernel";
import {
  type ContextKey,
  type DecisionTrace,
  newId,
  type ProfileId,
  type Timestamp,
  type TurnOutcomeRecord,
} from "@miyoria/types";
import { fromMicros, parseJson, StoreError, sqlLimit, toMicros } from "../common.js";
import type { Db, Params, Row } from "../db.js";
import type { Identity } from "../identity/identity.js";
import type { DecisionRecord } from "../records.js";
import type { DecisionLog } from "../stores.js";
import type { EventStore, EventWrite } from "./log.js";

const log = getLogger("store.turns");

/** Where a turn record is stored from, when it comes through the interface. */
const SOURCE = "store.decisions";

/** The payload's context matches `$platform`, `$scope`, `$channel` and `$kind`. */
const PAYLOAD_PLACE =
  "json_extract(data, '$.context.platform') = $platform AND " +
  "json_extract(data, '$.context.scope') IS $scope AND " +
  "json_extract(data, '$.context.channel') = $channel AND " +
  "json_extract(data, '$.context.kind') = $kind";

// Fixed statement texts: `Db` prepares each once. The type conditions are the partial indexes'
// (core migration 4), written out so the planner may use them. Without statistics it prefers
// `(type, seq)` and sorts every row of the type; `INDEXED BY` names the index that reads newest
// first and stops at the limit. A place's reads find their session index on their own.
const DECISIONS = "SELECT id, at, data FROM events";
const OF_TYPE = "WHERE type = 'agent.decision' AND redacted_at IS NULL";
const DECISION_ORDER = "ORDER BY at DESC, id DESC";
const DECISIONS_RECENT = `${DECISIONS} INDEXED BY events_decision_idx ${OF_TYPE} ${DECISION_ORDER} LIMIT $limit`;
const DECISIONS_OF_SESSION = `${DECISIONS} ${OF_TYPE} AND session = $session ${DECISION_ORDER} LIMIT $limit`;
const DECISIONS_PLACELESS = `${DECISIONS} ${OF_TYPE} AND session IS NULL AND ${PAYLOAD_PLACE} ${DECISION_ORDER} LIMIT $limit`;
const DECISIONS_SINCE = `${DECISIONS} INDEXED BY events_decision_idx ${OF_TYPE} AND at >= $since ${DECISION_ORDER}`;

/** The latest outcome of each turn (`n`: a later outcome of the same turn). */
const OUTCOMES = "SELECT e.data FROM events e";
const LATEST =
  "WHERE e.type = 'agent.turn.outcome' AND e.redacted_at IS NULL AND NOT EXISTS " +
  "(SELECT 1 FROM events n WHERE n.type = 'agent.turn.outcome' AND n.turn = e.turn " +
  "AND n.seq > e.seq)";
const OUTCOME_ORDER = "ORDER BY e.at DESC, e.turn DESC";
const OUTCOMES_RECENT = `${OUTCOMES} INDEXED BY events_outcome_idx ${LATEST} ${OUTCOME_ORDER} LIMIT $limit`;
const OUTCOMES_OF_SESSION = `${OUTCOMES} ${LATEST} AND e.session = $session ${OUTCOME_ORDER} LIMIT $limit`;
const OUTCOMES_PLACELESS = `${OUTCOMES} ${LATEST} AND e.session IS NULL AND ${PAYLOAD_PLACE.replaceAll(
  "json_extract(data",
  "json_extract(e.data",
)} ${OUTCOME_ORDER} LIMIT $limit`;
const OUTCOMES_SINCE = `${OUTCOMES} INDEXED BY events_outcome_idx ${LATEST} AND e.at >= $since ${OUTCOME_ORDER}`;

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

function limitOf(limit: number): number {
  return sqlLimit(limit) ?? -1;
}

/** The parameters naming `context` in a payload. */
function placeParams(context: ContextKey): Params {
  return {
    platform: context.platform,
    scope: context.scope,
    channel: context.channel,
    kind: context.kind,
  };
}

/** The decisions and turn outcomes of one database (one character), as `DecisionLog`. */
export class TurnLog implements DecisionLog {
  readonly #db: Db;
  readonly #events: EventStore;
  readonly #identity: Identity;

  constructor(db: Db, events: EventStore, identity: Identity) {
    this.#db = db;
    this.#events = events;
    this.#identity = identity;
  }

  // ---- writing ------------------------------------------------------------------------------

  /** Appends `write` unless an event has its id already. */
  #write(what: string, write: EventWrite): EventEnvelope {
    const id = write.draft.id;
    try {
      return this.#db.tx(() => {
        if (this.#db.get("SELECT 1 AS x FROM events WHERE id = $id", { id })) {
          throw new StoreError(`${what} \`${id}\` already exists`);
        }
        return this.#events.appendNow(write);
      });
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      throw new StoreError(`cannot append ${what}`, { cause });
    }
  }

  async append(record: DecisionRecord): Promise<void> {
    const trace = record.trace;
    this.#write("decision", {
      draft: {
        id: record.id,
        at: record.ts,
        type: AgentDecision.type,
        v: AgentDecision.v,
        turn: trace.turn,
        data: trace,
      },
      source: SOURCE,
      context: trace.context,
    });
  }

  /** A turn's outcome; writing a turn again adds its latest (the earlier ones stay in the log). */
  async appendOutcome(_profile: ProfileId, record: TurnOutcomeRecord): Promise<void> {
    this.#write("turn outcome", {
      draft: {
        id: newId(),
        at: record.at,
        type: AgentTurnOutcome.type,
        v: AgentTurnOutcome.v,
        turn: record.turn,
        data: record,
      },
      source: SOURCE,
      context: record.context,
      handle: record.addressed_by[0] ?? null,
    });
  }

  // ---- reading ------------------------------------------------------------------------------

  /** The statement and parameters reading `context`'s records: by session, else by payload. */
  #place(context: ContextKey, bySession: string, placeless: string): [string, Params] {
    const session = this.#identity.sessionOf(context);
    return session === null ? [placeless, placeParams(context)] : [bySession, { session }];
  }

  #decisions(profile: ProfileId, rows: readonly Row[]): DecisionRecord[] {
    const out: DecisionRecord[] = [];
    for (const row of rows) {
      const data = parseJson<unknown>(text(row, "data"), "decision trace");
      if (!DecisionTraceSchema.safeParse(data).success) {
        log.warn({ event: row.id }, "a stored decision does not fit its type: left out");
        continue;
      }
      out.push({
        id: text(row, "id"),
        profile,
        ts: fromMicros(int(row, "at")),
        trace: data as DecisionTrace,
      });
    }
    return out;
  }

  #outcomes(rows: readonly Row[]): TurnOutcomeRecord[] {
    const out: TurnOutcomeRecord[] = [];
    for (const row of rows) {
      const data = parseJson<unknown>(text(row, "data"), "turn outcome");
      if (!TurnOutcomeRecordSchema.safeParse(data).success) {
        log.warn("a stored turn outcome does not fit its type: left out");
        continue;
      }
      // As written: what the schema does not name (a newer field) stays.
      out.push(data as TurnOutcomeRecord);
    }
    return out;
  }

  async recent(
    profile: ProfileId,
    context: ContextKey | null,
    limit: number,
  ): Promise<DecisionRecord[]> {
    const n = limitOf(limit);
    if (n === 0) return [];
    const [sql, params] =
      context === null
        ? [DECISIONS_RECENT, {}]
        : this.#place(context, DECISIONS_OF_SESSION, DECISIONS_PLACELESS);
    return this.#decisions(profile, this.#db.all(sql, { ...params, limit: n }));
  }

  async decisionsSince(profile: ProfileId, sinceTs: Timestamp): Promise<DecisionRecord[]> {
    return this.#decisions(profile, this.#db.all(DECISIONS_SINCE, { since: toMicros(sinceTs) }));
  }

  async recentOutcomes(
    _profile: ProfileId,
    context: ContextKey | null,
    limit: number,
  ): Promise<TurnOutcomeRecord[]> {
    const n = limitOf(limit);
    if (n === 0) return [];
    const [sql, params] =
      context === null
        ? [OUTCOMES_RECENT, {}]
        : this.#place(context, OUTCOMES_OF_SESSION, OUTCOMES_PLACELESS);
    return this.#outcomes(this.#db.all(sql, { ...params, limit: n }));
  }

  async outcomesSince(_profile: ProfileId, sinceTs: Timestamp): Promise<TurnOutcomeRecord[]> {
    return this.#outcomes(this.#db.all(OUTCOMES_SINCE, { since: toMicros(sinceTs) }));
  }
}
