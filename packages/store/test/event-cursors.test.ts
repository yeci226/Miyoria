// The positions of the event log's readers (`events/cursors.ts`): a consumer resumes where it
// stopped, also after the database was closed; batches end where they should; two consumers do
// not see each other; and a consumer's own rows commit or roll back with its position.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, toTimestamp } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  type Db,
  EventCursors,
  type EventStore,
  type LoggedEvent,
  SqliteStore,
  type StorePlugin,
} from "../src/index.js";

const T0 = Date.UTC(2026, 10, 1, 12);

/** A projection with a table of its own: the events it has seen, by id. */
interface Projection {
  db: Db;
  events: EventStore;
  cursors: EventCursors;
  seen(): string[];
  write(batch: readonly LoggedEvent[]): void;
}

const projection: StorePlugin<Projection> = {
  schema: {
    plugin: "proj",
    migrations: [
      {
        version: 1,
        name: "init",
        sql: "CREATE TABLE proj_seen (id TEXT PRIMARY KEY, n INTEGER NOT NULL) STRICT;",
      },
    ],
  },
  open: ({ db, events }) => ({
    db,
    events,
    cursors: new EventCursors(db, events),
    seen: () => db.all("SELECT id FROM proj_seen ORDER BY n").map((r) => String(r.id)),
    write: (batch) => {
      for (const e of batch) {
        db.run("INSERT INTO proj_seen (id, n) VALUES ($id, $n)", {
          id: e.envelope.id,
          n: e.envelope.seq,
        });
      }
    },
  }),
};

async function open(path = ":memory:") {
  const store = await SqliteStore.open(path, { plugins: [projection] });
  return { store, p: store.plugin(projection) };
}

/** Appends `n` events of `type` and returns their ids, in order. */
function emit(events: EventStore, n: number, type = "test.thing"): string[] {
  return events
    .append(
      Array.from({ length: n }, (_, i) => ({
        draft: { id: newId(), at: toTimestamp(T0 + i), type, data: { i } },
        source: "test",
      })),
    )
    .map((e) => e.id);
}

async function inTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "miyoria-cursors-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("event cursors", () => {
  it("is core migration 6, a STRICT table", async () => {
    const { store, p } = await open();
    try {
      const row = p.db.get("SELECT name FROM _migrations WHERE plugin = 'core' AND version = 6");
      expect(row?.name).toBe("event_cursors");
      expect(p.db.get("SELECT strict FROM pragma_table_list WHERE name = 'event_cursors'")).toEqual(
        {
          strict: 1,
        },
      );
    } finally {
      await store.close();
    }
  });

  it("starts at 0 and only moves forward", async () => {
    const { store, p } = await open();
    try {
      expect(p.cursors.get("a")).toBe(0);
      expect(p.cursors.advance("a", "", 7)).toBe(7);
      expect(p.cursors.advance("a", "", 3)).toBe(7);
      expect(p.cursors.advance("a", "", 7)).toBe(7);
      expect(p.cursors.get("a")).toBe(7);
      expect(() => p.cursors.advance("a", "", -1)).toThrow(/not an event seq/);
      expect(() => p.cursors.advance("", "", 1)).toThrow(/consumer/);
      expect(p.cursors.reset("a")).toBe(1);
      expect(p.cursors.get("a")).toBe(0);
    } finally {
      await store.close();
    }
  });

  it("hands over everything after the position in batches, in order", async () => {
    const { store, p } = await open();
    try {
      const ids = emit(p.events, 7);
      const sizes: number[] = [];
      const result = p.cursors.drain(
        "proj",
        "",
        (batch) => {
          sizes.push(batch.length);
          p.write(batch);
        },
        { batch: 3 },
      );
      expect(sizes).toEqual([3, 3, 1]);
      expect(result).toMatchObject({ events: 7, batches: 3, done: true });
      expect(p.seen()).toEqual(ids);
      expect(result.seq).toBe(p.events.get(ids.at(-1) as string)?.envelope.seq);
      // Caught up: nothing more, until something new is appended.
      expect(p.cursors.drain("proj", "", p.write)).toMatchObject({ events: 0, batches: 0 });
      const more = emit(p.events, 2);
      expect(p.cursors.drain("proj", "", p.write, { batch: 3 })).toMatchObject({ events: 2 });
      expect(p.seen()).toEqual([...ids, ...more]);
    } finally {
      await store.close();
    }
  });

  it("ends a batch exactly at the batch size, and stops at maxBatches", async () => {
    const { store, p } = await open();
    try {
      const ids = emit(p.events, 6);
      const sizes: number[] = [];
      const first = p.cursors.drain("proj", "", (b) => sizes.push(b.length), {
        batch: 3,
        maxBatches: 1,
      });
      expect(first).toMatchObject({ events: 3, batches: 1, done: false });
      expect(first.seq).toBe(p.events.get(ids[2] as string)?.envelope.seq);
      // A full last batch does not know it was the last: one more, empty, read settles it.
      const rest = p.cursors.drain("proj", "", (b) => sizes.push(b.length), { batch: 3 });
      expect(rest).toMatchObject({ events: 3, batches: 1, done: true });
      expect(sizes).toEqual([3, 3]);
    } finally {
      await store.close();
    }
  });

  it("reads only the events its filter names, and moves past the rest it saw", async () => {
    const { store, p } = await open();
    try {
      emit(p.events, 2, "test.other");
      const wanted = emit(p.events, 2, "test.thing");
      emit(p.events, 1, "test.other");
      const got: string[] = [];
      p.cursors.drain("proj", "", (b) => got.push(...b.map((e) => e.envelope.id)), {
        filter: { types: ["test.thing"] },
      });
      expect(got).toEqual(wanted);
      expect(p.cursors.get("proj")).toBe(p.events.get(wanted[1] as string)?.envelope.seq);
      const read = p.cursors.read("proj", "", 10, { types: ["test.thing"] });
      expect(read).toMatchObject({ events: [], done: true, seq: p.cursors.get("proj") });
    } finally {
      await store.close();
    }
  });

  it("keeps consumers, and the keys of one consumer, apart", async () => {
    const { store, p } = await open();
    try {
      const ids = emit(p.events, 4);
      const a: string[] = [];
      const b: string[] = [];
      p.cursors.drain("a", "", (batch) => a.push(...batch.map((e) => e.envelope.id)), {
        batch: 2,
        maxBatches: 1,
      });
      p.cursors.drain("b", "", (batch) => b.push(...batch.map((e) => e.envelope.id)));
      expect(a).toEqual(ids.slice(0, 2));
      expect(b).toEqual(ids);
      p.cursors.advance("a", "room-1", 1);
      expect(p.cursors.get("a")).toBe(p.events.get(ids[1] as string)?.envelope.seq);
      expect(p.cursors.get("a", "room-1")).toBe(1);
      expect(p.cursors.list().map((c) => [c.consumer, c.key])).toEqual([
        ["a", ""],
        ["a", "room-1"],
        ["b", ""],
      ]);
      expect(p.cursors.reset("a", "room-1")).toBe(1);
      expect(p.cursors.list("a").map((c) => c.key)).toEqual([""]);
    } finally {
      await store.close();
    }
  });

  it("rolls a failing batch back with its position, and keeps the batches before it", async () => {
    const { store, p } = await open();
    try {
      const ids = emit(p.events, 5);
      let calls = 0;
      const failing = () =>
        p.cursors.drain(
          "proj",
          "",
          (batch) => {
            p.write(batch);
            if (++calls === 2) throw new Error("the consumer's write failed");
          },
          { batch: 2 },
        );
      expect(failing).toThrow("the consumer's write failed");
      // The first batch stays; the second left neither its rows nor a moved position.
      expect(p.seen()).toEqual(ids.slice(0, 2));
      expect(p.cursors.get("proj")).toBe(p.events.get(ids[1] as string)?.envelope.seq);
      // The next run starts with the event the failed batch started with, and sees each once.
      expect(p.cursors.drain("proj", "", p.write, { batch: 2 })).toMatchObject({ events: 3 });
      expect(p.seen()).toEqual(ids);
    } finally {
      await store.close();
    }
  });

  it("moves with the caller's transaction", async () => {
    const { store, p } = await open();
    try {
      expect(() =>
        p.db.tx(() => {
          p.cursors.advance("proj", "", 9);
          throw new Error("rolled back");
        }),
      ).toThrow("rolled back");
      expect(p.cursors.get("proj")).toBe(0);
      p.db.tx(() => p.cursors.advance("proj", "", 9));
      expect(p.cursors.get("proj")).toBe(9);
    } finally {
      await store.close();
    }
  });

  it("resumes after the database was closed and opened again", () =>
    inTempDir(async (dir) => {
      const path = join(dir, "core.db");
      const first = await open(path);
      const ids = emit(first.p.events, 5);
      first.p.cursors.drain("proj", "", first.p.write, { batch: 2, maxBatches: 1 });
      await first.store.close();

      const second = await open(path);
      try {
        expect(second.p.cursors.get("proj")).toBe(
          second.p.events.get(ids[1] as string)?.envelope.seq,
        );
        const more = emit(second.p.events, 1);
        const got: string[] = [];
        second.p.cursors.drain("proj", "", (batch) => {
          got.push(...batch.map((e) => e.envelope.id));
          second.p.write(batch);
        });
        expect(got).toEqual([...ids.slice(2), ...more]);
        expect(second.p.seen()).toEqual([...ids, ...more]);
      } finally {
        await second.store.close();
      }
    }));
});
