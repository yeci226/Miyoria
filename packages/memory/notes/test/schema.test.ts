// The `notes` schema by itself: it applies to an empty database, applying it again changes
// nothing, its names pass the runner's lint, and the constraints hold. That the checked-in SQL is
// what the Drizzle tables generate is the store's drift test (`drizzle-schemas.test.ts`).

import { coreSchema, lintSchemas, migrate, orderSchemas } from "@miyoria/store";
import { openTestDb } from "@miyoria/store/testing";
import { describe, expect, it } from "vitest";
import { notesSchema } from "../src/index.js";

describe("the notes schema", () => {
  it("applies to an empty database, and a second run applies nothing", () => {
    const t = openTestDb({ plugins: [notesSchema] });
    try {
      expect(
        t.applied.filter((m) => m.plugin === "notes").map((m) => `${m.version}:${m.name}`),
      ).toEqual(["1:init", "2:vectors"]);
      expect(migrate(t.db, [notesSchema])).toEqual([]);
      const tables = t.db
        .all("SELECT name, strict FROM pragma_table_list WHERE name LIKE 'notes_%'")
        .map((r) => [r.name, r.strict]);
      expect(tables.sort()).toEqual([
        ["notes_documents", 1],
        ["notes_evidence", 1],
        ["notes_history", 1],
        ["notes_lines", 1],
        ["notes_vectors", 1],
      ]);
    } finally {
      t.close();
    }
  });

  it("passes the naming lint and needs no other plugin", () => {
    expect(lintSchemas(orderSchemas([coreSchema, notesSchema]))).toEqual([]);
    expect(notesSchema.requires ?? []).toEqual([]);
  });

  it("refuses a document whose kind and subject disagree, and a second document of a subject", () => {
    const t = openTestDb({ plugins: [notesSchema] });
    try {
      const insert = (id: string, subject: string, kind: string, person: string | null) =>
        t.db.run(
          `INSERT INTO notes_documents (id, subject, kind, person_id, created_at, updated_at)
           VALUES ($id, $subject, $kind, $person, 1, 1)`,
          { id, subject, kind, person },
        );
      expect(() => insert("a", "person:p", "person", null)).toThrow(/CHECK/);
      expect(() => insert("b", "topic:x", "self", null)).toThrow(/CHECK/);
      expect(() => insert("c", "x", "gossip", null)).toThrow(/CHECK/);
      expect(insert("d", "person:p", "person", "p")).toBe(1);
      expect(() => insert("e", "person:p", "person", "p")).toThrow(/UNIQUE/);
      expect(insert("f", "self", "self", null)).toBe(1);
      expect(() => insert("g", "self", "self", null)).toThrow(/UNIQUE/);
    } finally {
      t.close();
    }
  });

  it("refuses a line whose scope names nothing, a redacted line in use, a bad confidence", () => {
    const t = openTestDb({ plugins: [notesSchema] });
    try {
      const insert = (
        id: string,
        scope: string,
        scopeId: string | null,
        fields: { confidence?: number; redacted?: number | null; outdated?: number | null } = {},
      ) =>
        t.db.run(
          `INSERT INTO notes_lines (id, document_id, section, text, provenance, scope, scope_id,
             confidence, author, created_at, updated_at, outdated_at, redacted_at)
           VALUES ($id, 'd', 'misc', 'x', 'observed', $scope, $scopeId, $confidence, 'segment', 1, 1,
             $outdated, $redacted)`,
          {
            id,
            scope,
            scopeId,
            confidence: fields.confidence ?? 0.5,
            redacted: fields.redacted ?? null,
            outdated: fields.outdated ?? null,
          },
        );
      expect(() => insert("a", "dm", null)).toThrow(/CHECK/);
      expect(() => insert("b", "public", "x")).toThrow(/CHECK/);
      expect(() => insert("c", "owner", null)).toThrow(/CHECK/);
      expect(() => insert("d", "space", "s", { confidence: 1.5 })).toThrow(/CHECK/);
      expect(() => insert("e", "space", "s", { redacted: 2 })).toThrow(/CHECK/);
      expect(insert("f", "space", "s", { redacted: 2, outdated: 2 })).toBe(1);
      expect(insert("g", "self", null)).toBe(1);
    } finally {
      t.close();
    }
  });
});
