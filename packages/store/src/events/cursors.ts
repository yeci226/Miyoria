// Core migration 6 and the code over it: where each reader of the event log has got to
// (docs/design/v5-data.md §2.3: `seq` is the total order and the paging cursor).
//
// A projection (a table or a cache built from events) names itself (`consumer`) and, when it keeps
// one position per place or person, a `key`. Its position is the `seq` of the last event it has
// handled. `seq` is the commit order and is never reused, also after compaction or a wipe of the
// log, so a stored position stays good whatever happens to the rows behind it.
//
// - `drain` is for a consumer that writes to this same database: each batch is handled and the
//   position moved in one transaction, so its rows and its position never disagree. A handler that
//   throws rolls both back, and the next call starts from the same event.
// - `read` then `advance` is for a consumer whose work is elsewhere (a file, a model call): at
//   least once, so the handling has to be safe to repeat.
//
// Nothing uses it yet. The readers that replay the log at every start or keep their own position
// in settings (`memory_watermark:<ctx>`, the fold's `folded_up_to`, `project()` of the facts
// module) move here with the brain's rebuild.
//
// Hand-written SQL, like the rest of core's tables. Never edit it once a V5 database has it.

import { StoreError } from "../common.js";
import type { Db } from "../db.js";
import type { EventQuery, EventStore, LoggedEvent } from "./log.js";

export const EVENT_CURSORS_SQL = `-- Where each reader of the event log has got to.
CREATE TABLE event_cursors (
    -- The reader: a plugin or projection id.
    consumer   TEXT    NOT NULL,
    -- One position per key (a session, a person); '' for a reader with a single position.
    key        TEXT    NOT NULL DEFAULT '',
    -- The seq of the last event handled; 0: none yet.
    seq        INTEGER NOT NULL CHECK (seq >= 0),
    -- Microseconds since the epoch.
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (consumer, key)
) STRICT;
`;

/** Which events a consumer reads: any of the query's filters, never its paging. */
export type CursorFilter = Pick<
  EventQuery,
  "types" | "sources" | "session" | "context" | "personId" | "key" | "turn"
>;

export interface CursorRead {
  /** The next events after the position, oldest first. */
  events: LoggedEvent[];
  /** The position once these are handled (the stored one when there are none). */
  seq: number;
  /** Fewer than asked for came back: the consumer has caught up. */
  done: boolean;
}

export interface DrainOptions {
  /** Which events. Default: all of them. */
  filter?: CursorFilter;
  /** Events per transaction. Default 500. */
  batch?: number;
  /** Stop after this many batches (the rest waits for the next call). Default: until caught up. */
  maxBatches?: number;
}

export interface DrainResult {
  events: number;
  batches: number;
  /** The position afterwards. */
  seq: number;
  /** `false`: `maxBatches` stopped it before it caught up. */
  done: boolean;
}

/** A stored position, as `list` returns it. */
export interface EventCursor {
  consumer: string;
  key: string;
  seq: number;
  /** Microseconds since the epoch. */
  updated_at: number;
}

const DEFAULT_BATCH = 500;

/** The positions of the event log's readers on one database. */
export class EventCursors {
  readonly #db: Db;
  readonly #events: EventStore;

  constructor(db: Db, events: EventStore) {
    this.#db = db;
    this.#events = events;
  }

  /** The `seq` of the last event `consumer` handled for `key`; 0 when it has handled none. */
  get(consumer: string, key = ""): number {
    const row = this.#db.get(
      "SELECT seq FROM event_cursors WHERE consumer = $consumer AND key = $key",
      { consumer, key },
    );
    return row === undefined ? 0 : Number(row.seq);
  }

  /**
   * Moves the position forward to `seq`; a position at or past it stays (two overlapping runs
   * cannot move it back). Inside the caller's `db.tx` it commits or rolls back with it. Returns
   * the position afterwards.
   */
  advance(consumer: string, key: string, seq: number): number {
    if (consumer === "") throw new StoreError("a cursor needs its consumer's id");
    if (!Number.isInteger(seq) || seq < 0) throw new StoreError(`not an event seq: ${seq}`);
    this.#db.run(
      `INSERT INTO event_cursors (consumer, key, seq, updated_at) VALUES ($consumer, $key, $seq, $at)
       ON CONFLICT (consumer, key) DO UPDATE SET seq = excluded.seq, updated_at = excluded.updated_at
       WHERE excluded.seq > event_cursors.seq`,
      { consumer, key, seq, at: this.#db.nowMicros() },
    );
    return this.get(consumer, key);
  }

  /**
   * Forgets a position (or every position of `consumer`, without `key`): the consumer starts from
   * the beginning of the log again. For a projection that is rebuilt.
   */
  reset(consumer: string, key?: string): number {
    return key === undefined
      ? this.#db.run("DELETE FROM event_cursors WHERE consumer = $consumer", { consumer })
      : this.#db.run("DELETE FROM event_cursors WHERE consumer = $consumer AND key = $key", {
          consumer,
          key,
        });
  }

  /** The stored positions of `consumer` (or of every consumer), by consumer and key. */
  list(consumer?: string): EventCursor[] {
    const rows =
      consumer === undefined
        ? this.#db.all("SELECT * FROM event_cursors ORDER BY consumer, key")
        : this.#db.all(
            "SELECT * FROM event_cursors WHERE consumer = $consumer ORDER BY consumer, key",
            { consumer },
          );
    return rows.map((r) => ({
      consumer: String(r.consumer),
      key: String(r.key),
      seq: Number(r.seq),
      updated_at: Number(r.updated_at),
    }));
  }

  /** Up to `limit` events after the position, oldest first. Moves nothing. */
  read(consumer: string, key = "", limit = DEFAULT_BATCH, filter: CursorFilter = {}): CursorRead {
    const size = Math.max(1, Math.floor(limit));
    const from = this.get(consumer, key);
    const events = this.#events.query({ ...filter, afterSeq: from, order: "asc", limit: size });
    return { events, seq: events.at(-1)?.envelope.seq ?? from, done: events.length < size };
  }

  /**
   * Hands `consumer` the events after its position, batch by batch, oldest first. Each batch is
   * one transaction with the move of the position: what `handle` writes to this database commits
   * with it, and a `handle` that throws rolls its batch back (earlier batches stay) and rethrows.
   * `handle` must not await.
   */
  drain(
    consumer: string,
    key: string,
    handle: (events: readonly LoggedEvent[]) => void,
    options: DrainOptions = {},
  ): DrainResult {
    const size = Math.max(1, Math.floor(options.batch ?? DEFAULT_BATCH));
    const max = options.maxBatches ?? Number.POSITIVE_INFINITY;
    let events = 0;
    let batches = 0;
    let done = false;
    while (!done && batches < max) {
      const handled = this.#db.tx(() => {
        const batch = this.read(consumer, key, size, options.filter);
        if (batch.events.length > 0) {
          handle(batch.events);
          this.advance(consumer, key, batch.seq);
        }
        return batch;
      });
      done = handled.done;
      if (handled.events.length === 0) break;
      events += handled.events.length;
      batches++;
    }
    return { events, batches, seq: this.get(consumer, key), done };
  }
}
