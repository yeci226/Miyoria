// `Db.afterCommit`: what tells in-memory listeners about a write waits for the write to be kept.

import { DatabaseSync } from "node:sqlite";
import { systemClock } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { Db } from "../src/db.js";

function open(): Db {
  return new Db(new DatabaseSync(":memory:"), systemClock);
}

describe("afterCommit", () => {
  it("runs at once outside a transaction", () => {
    const db = open();
    const told: string[] = [];
    db.afterCommit(() => told.push("a"));
    expect(told).toEqual(["a"]);
    db.close();
  });

  it("waits for the outermost transaction to commit, in the order queued", () => {
    const db = open();
    const told: string[] = [];
    db.tx(() => {
      db.afterCommit(() => told.push("a"));
      db.tx(() => db.afterCommit(() => told.push("b")));
      expect(told).toEqual([]);
    });
    expect(told).toEqual(["a", "b"]);
    db.close();
  });

  it("never runs what a rolled back transaction queued", () => {
    const db = open();
    const told: string[] = [];
    expect(() =>
      db.tx(() => {
        db.afterCommit(() => told.push("a"));
        throw new Error("no");
      }),
    ).toThrow("no");
    db.tx(() => undefined);
    expect(told).toEqual([]);
    db.close();
  });

  it("drops what a rolled back savepoint queued and keeps the rest", () => {
    const db = open();
    const told: string[] = [];
    db.tx(() => {
      db.afterCommit(() => told.push("a"));
      try {
        db.tx(() => {
          db.afterCommit(() => told.push("b"));
          throw new Error("no");
        });
      } catch {
        // the outer transaction goes on
      }
      db.afterCommit(() => told.push("c"));
    });
    expect(told).toEqual(["a", "c"]);
    db.close();
  });
});
