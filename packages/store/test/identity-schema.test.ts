// The `identity` schema: the constraints Drizzle declares (or the migration adds) hold in the
// database. That its checked-in migration and its Drizzle tables agree is `drizzle-schemas.test.ts`.

import { describe, expect, it } from "vitest";
import { migrated } from "../scripts/schema-sql.js";
import { identitySchema } from "../src/index.js";

describe("identity schema", () => {
  it("holds its constraints: types, checks, keys, the handle ignoring case", () => {
    const { raw, db } = migrated(identitySchema);
    try {
      const person = (id: string, handle: string) =>
        raw
          .prepare("INSERT INTO persons (id, name, handle, created_at) VALUES (?, 'n', ?, 1)")
          .run(id, handle);
      person("p1", "Owen");
      // Unique ignoring case (an index on `handle COLLATE NOCASE`).
      expect(() => person("p2", "owen")).toThrow(/UNIQUE/);
      // STRICT: an integer column takes no text.
      expect(() =>
        raw
          .prepare(
            "INSERT INTO persons (id, name, handle, created_at) VALUES ('p3', 'n', 'x', 'soon')",
          )
          .run(),
      ).toThrow(/cannot store TEXT value in INTEGER column/);
      // A STRICT table's text primary key is NOT NULL (drizzle-kit does not write NOT NULL).
      expect(() =>
        raw
          .prepare("INSERT INTO persons (id, name, handle, created_at) VALUES (NULL, 'n', 'y', 1)")
          .run(),
      ).toThrow(/NOT NULL/);
      // CHECK and foreign keys.
      expect(() =>
        raw
          .prepare("INSERT INTO sessions (key, lane, created_at, last_at) VALUES ('k', 'x', 1, 1)")
          .run(),
      ).toThrow(/CHECK/);
      expect(() =>
        raw
          .prepare(
            "INSERT INTO accounts (id, platform, external_id, person_id, display_name, first_seen, last_seen) " +
              "VALUES ('a1', 'discord', '1', 'ghost', 'x', 1, 1)",
          )
          .run(),
      ).toThrow(/FOREIGN KEY/);
      raw
        .prepare(
          "INSERT INTO accounts (id, platform, external_id, person_id, display_name, first_seen, last_seen) " +
            "VALUES ('a1', 'discord', '1', 'p1', 'x', 1, 1)",
        )
        .run();
      // `link_codes` go with their account.
      raw.prepare("INSERT INTO link_codes VALUES ('h', 'a1', 1)").run();
      raw.prepare("DELETE FROM accounts WHERE id = 'a1'").run();
      expect(raw.prepare("SELECT COUNT(*) AS n FROM link_codes").get()).toEqual({ n: 0 });
      // The defaults Drizzle declared.
      expect(raw.prepare("SELECT prefs, legacy FROM persons WHERE id = 'p1'").get()).toEqual({
        prefs: "{}",
        legacy: null,
      });
    } finally {
      db.close();
    }
  });
});
