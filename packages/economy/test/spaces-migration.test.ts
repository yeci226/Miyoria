// economy v6 (phase 6, many servers): bounties, predictions and bets get the Space they belong to.
// A database is brought to version 5, filled the way the code before left it, and migrated: every
// row is still there, the old bounties, predictions and bets belong to the primary Space, and what
// belongs to no Space (her room) stays without one.

import { configSchema, identitySchema, migrate } from "@miyoria/store";
import { openTestDb, type TestDb } from "@miyoria/store/testing";
import { newId } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { economySchema } from "../src/migrations.js";

const open: TestDb[] = [];
afterEach(() => {
  for (const t of open.splice(0)) t.close();
});

const NOW = 1_700_000_000_000_000;

/** A database as version 5 left it, with `spaces` servers she had seen (the first is primary). */
function oldDatabase(spaces: readonly string[]) {
  const t = openTestDb({
    identity: true,
    config: true,
    plugins: [{ ...economySchema, migrations: economySchema.migrations.slice(0, 5) }],
  });
  open.push(t);
  const identity = t.identity;
  if (!identity) throw new Error("identity");
  const ids = spaces.map((guild) => identity.seenSpace("discord", guild, guild));
  identity.see({ platform: "discord", id: "u1" }, "Alice");
  const account = identity.account({ platform: "discord", id: "u1" })?.id ?? null;
  t.db.run(
    `INSERT INTO economy_bounties (id, task, reward, hold_entry, status, created_at, expires_at)
     VALUES ('b1', '畫一張貓', 10, 'h1', 'open', $at, $at)`,
    { at: NOW },
  );
  const doc = (kind: string, id: string, owner: string | null) =>
    t.db.run(
      `INSERT INTO economy_docs (kind, id, owner_account_id, status, version, data, created_at, updated_at)
       VALUES ($kind, $id, $owner, 'open', 1, '{}', $at, $at)`,
      { kind, id, owner, at: NOW },
    );
  doc("prediction", newId(), null);
  doc("bet", "bet:p:1", account);
  doc("room", "plant", null);
  return { t, ids };
}

const count = (t: TestDb, table: string) =>
  Number(t.db.all(`SELECT COUNT(*) AS n FROM ${table}`)[0]?.n);

const spaceOf = (t: TestDb, sql: string) =>
  t.db.all(sql).map((r) => (r as { space_id: string | null }).space_id);

describe("economy v6", () => {
  it("gives the old bounties, predictions and bets the primary Space, and loses no row", () => {
    const { t, ids } = oldDatabase(["guild-a", "guild-b"]);
    const [primary] = ids;
    const before = { bounties: count(t, "economy_bounties"), docs: count(t, "economy_docs") };

    expect(migrate(t.db, [identitySchema, configSchema, economySchema]).map((m) => m.name)).toEqual(
      ["spaces"],
    );

    expect({ bounties: count(t, "economy_bounties"), docs: count(t, "economy_docs") }).toEqual(
      before,
    );
    expect(spaceOf(t, "SELECT space_id FROM economy_bounties")).toEqual([primary]);
    expect(
      spaceOf(t, "SELECT space_id FROM economy_docs WHERE kind IN ('prediction', 'bet')"),
    ).toEqual([primary, primary]);
    expect(spaceOf(t, "SELECT space_id FROM economy_docs WHERE kind = 'room'")).toEqual([null]);
    // Nothing is left to apply.
    expect(migrate(t.db, [identitySchema, configSchema, economySchema])).toEqual([]);
  });

  it("leaves them of no Space on a database that has none (open to everyone she knows)", () => {
    const { t } = oldDatabase([]);
    migrate(t.db, [identitySchema, configSchema, economySchema]);
    expect(spaceOf(t, "SELECT space_id FROM economy_bounties")).toEqual([null]);
    expect(spaceOf(t, "SELECT space_id FROM economy_docs")).toEqual([null, null, null]);
  });
});
