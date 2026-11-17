// The `transcript` schema by itself: it applies to an empty database, applying it again changes
// nothing, its names pass the runner's lint, and the constraints hold. That the checked-in SQL is
// what the Drizzle tables generate is the store's drift test (`drizzle-schemas.test.ts`).

import { coreSchema, lintSchemas, migrate, orderSchemas } from "@miyoria/store";
import { openTestDb } from "@miyoria/store/testing";
import { describe, expect, it } from "vitest";
import { transcriptSchema } from "../src/index.js";

describe("the transcript schema", () => {
  it("applies to an empty database, and a second run applies nothing", () => {
    const t = openTestDb({ plugins: [transcriptSchema] });
    try {
      expect(
        t.applied.filter((m) => m.plugin === "transcript").map((m) => `${m.version}:${m.name}`),
      ).toEqual(["1:init"]);
      expect(migrate(t.db, [transcriptSchema])).toEqual([]);
      const tables = t.db
        .all("SELECT name, strict FROM pragma_table_list WHERE name LIKE 'transcript_%'")
        .map((r) => [r.name, r.strict]);
      expect(tables.sort()).toEqual([
        ["transcript_entries", 1],
        ["transcript_sessions", 1],
        ["transcript_summaries", 1],
      ]);
    } finally {
      t.close();
    }
  });

  it("passes the naming lint and needs no other plugin", () => {
    expect(lintSchemas(orderSchemas([coreSchema, transcriptSchema]))).toEqual([]);
    expect(transcriptSchema.requires ?? []).toEqual([]);
  });

  it("refuses an entry whose kind and tool columns disagree, and a second entry at a sequence", () => {
    const t = openTestDb({ plugins: [transcriptSchema] });
    try {
      const insert = (kind: string, calls: string | null, callId: string | null, seq = 1) =>
        t.db.run(
          `INSERT INTO transcript_entries (session, seq, kind, tool_calls, tool_call_id, at)
           VALUES ('s', $seq, $kind, $calls, $callId, 1)`,
          { seq, kind, calls, callId },
        );
      expect(() => insert("gossip", null, null)).toThrow(/CHECK/);
      expect(() => insert("self", "[]", null)).toThrow(/CHECK/);
      expect(() => insert("tool_calls", null, null)).toThrow(/CHECK/);
      expect(() => insert("tool_result", null, null)).toThrow(/CHECK/);
      expect(() => insert("other", null, "c1")).toThrow(/CHECK/);
      expect(insert("tool_result", null, "c1")).toBe(1);
      expect(() => insert("other", null, null)).toThrow(/UNIQUE|PRIMARY/);
      expect(() => insert("other", null, null, 0)).toThrow(/CHECK/);
    } finally {
      t.close();
    }
  });
});
