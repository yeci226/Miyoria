// Runtime edits of her persona sections (`config_persona_overrides`, the `config` plugin): every
// edit is the next version of its section, nothing is rewritten, and the highest version of a
// section is the one in force. Core applies them over the profile's sections at start.
//
// One database is one character, so the `profile` the interface takes is not part of the key; a
// version read back carries the profile it was asked for.

import { type ProfileId, toTimestamp } from "@miyoria/types";
import { asc, eq, max, sql } from "drizzle-orm";
import type { Db } from "../db.js";
import type { PersonaOverride } from "../records.js";
import type { PersonaOverrideStore } from "../stores.js";
import { configPersonaOverrides as overrides } from "./schema.js";

/** `PersonaOverrideStore` on `config_persona_overrides`. */
export class PersonaOverrides implements PersonaOverrideStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async set(_profile: ProfileId, key: string, body: string, editedBy: string): Promise<number> {
    const orm = this.#db.orm;
    // The next version is read and written in one write transaction.
    return this.#db.tx(() => {
      const last = orm
        .select({ version: max(overrides.version) })
        .from(overrides)
        .where(eq(overrides.section_key, key))
        .get();
      const version = (last?.version ?? 0) + 1;
      const at = toTimestamp(this.#db.clock.now());
      orm
        .insert(overrides)
        .values({ section_key: key, version, body, edited_by: editedBy, edited_at: at })
        .run();
      return version;
    });
  }

  async current(_profile: ProfileId): Promise<Map<string, string>> {
    const latest = sql`(SELECT MAX(o.version) FROM ${overrides} o WHERE o.section_key = ${overrides.section_key})`;
    const rows = this.#db.orm
      .select({ key: overrides.section_key, body: overrides.body })
      .from(overrides)
      .where(eq(overrides.version, latest))
      .orderBy(asc(overrides.section_key))
      .all();
    return new Map(rows.map((r) => [r.key, r.body]));
  }

  async history(profile: ProfileId, key: string): Promise<PersonaOverride[]> {
    const rows = this.#db.orm
      .select()
      .from(overrides)
      .where(eq(overrides.section_key, key))
      .orderBy(asc(overrides.version))
      .all();
    return rows.map((r) => ({
      profile,
      key,
      version: r.version,
      body: r.body,
      edited_by: r.edited_by,
      edited_at: r.edited_at,
    }));
  }
}
