// The migrations that retired features (phase 5, docs/design/v5-play.md §10): what a removed feature
// still held goes back to its owner as a ledger row that says so, then its tables are dropped.
// The database is brought to version 1, filled the way the old code left it, and migrated.

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

/** A database as version 1 left it, with two people. */
function oldDatabase() {
  const t = openTestDb({
    identity: true,
    config: true,
    plugins: [{ ...economySchema, migrations: economySchema.migrations.slice(0, 1) }],
  });
  open.push(t);
  const identity = t.identity;
  if (!identity) throw new Error("identity");
  const people = ["Alice", "Bob"].map((name, i) => {
    const ref = { platform: "discord", id: `u${i}` };
    const person = identity.see(ref, name).id;
    const account = identity.account(ref)?.id ?? "";
    return { person, account };
  });
  let ts = NOW;
  const row = (person: string, delta: number, reason: string, ref: string | null = null) => {
    const id = newId();
    ts += 1;
    t.db.run(
      `INSERT INTO economy_ledger (id, person_id, delta, reason, ref, idem_key, ts)
       VALUES ($id, $person, $delta, $reason, $ref, $key, $ts)`,
      { id, person, delta, reason, ref, key: `k:${id}`, ts },
    );
    return id;
  };
  const balance = (person: string) =>
    Number(
      t.db.all("SELECT SUM(delta) AS n FROM economy_ledger WHERE person_id = $person", {
        person,
      })[0]?.n,
    );
  return { t, people, row, balance };
}

function refunds(t: TestDb) {
  return t.db.all(
    "SELECT person_id, delta, reason, ref, idem_key FROM economy_ledger WHERE reason = 'refund_removed' ORDER BY seq",
  );
}

function tableExists(t: TestDb, name: string): boolean {
  return (
    t.db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = $name", { name })
      .length > 0
  );
}

describe("retiring deals", () => {
  it("returns the escrow of every deal still open, once, and drops the table", () => {
    const { t, people, row, balance } = oldDatabase();
    const [alice, bob] = people;
    if (!alice || !bob) throw new Error("people");
    row(alice.person, 100, "checkin");
    row(bob.person, 100, "checkin");
    const deal = (
      who: { account: string },
      status: string,
      prepaid: boolean,
      escrow: string | null,
    ) =>
      t.db.run(
        `INSERT INTO economy_deals (id, account_id, reward_item, reward_count, reward_value, task,
           prepaid, escrow_entry, status, created_at)
         VALUES ($id, $account, 'rice', 1, 10, 'meow', $prepaid, $escrow, $status, $ts)`,
        { id: newId(), account: who.account, status, prepaid: prepaid ? 1 : 0, escrow, ts: NOW },
      );
    // Held: two open prepaid deals, one each.
    const heldA = row(alice.person, -30, "deal_escrow");
    const heldB = row(bob.person, -10, "deal_escrow");
    deal(alice, "open", true, heldA);
    deal(bob, "open", true, heldB);
    // Not held: released to her, refunded already, unpaid.
    deal(alice, "settled", true, row(alice.person, -20, "deal_escrow"));
    const refunded = row(bob.person, -15, "deal_escrow");
    row(bob.person, 15, "refund", refunded);
    deal(bob, "refunded", true, refunded);
    deal(alice, "open", false, null);
    expect(balance(alice.person)).toBe(100 - 30 - 20);
    expect(balance(bob.person)).toBe(100 - 10 - 15 + 15);

    expect(
      migrate(t.db, [identitySchema, configSchema, economySchema]).map((m) => m.name),
    ).toContain("retire_deals");

    expect(refunds(t)).toEqual([
      {
        person_id: alice.person,
        delta: 30,
        reason: "refund_removed",
        ref: heldA,
        idem_key: `refund:${heldA}`,
      },
      {
        person_id: bob.person,
        delta: 10,
        reason: "refund_removed",
        ref: heldB,
        idem_key: `refund:${heldB}`,
      },
    ]);
    expect(balance(alice.person)).toBe(100 - 20);
    expect(balance(bob.person)).toBe(100);
    expect(tableExists(t, "economy_deals")).toBe(false);
    // Each refund is an `economy.posted` event too, with the balance after it.
    const events = t.db.all(
      "SELECT key, person_id, data FROM events WHERE type = 'economy.posted' ORDER BY seq",
    );
    expect(events).toHaveLength(2);
    const first = events[0];
    expect(first?.person_id).toBe(alice.person);
    expect(JSON.parse(String(first?.data))).toMatchObject({
      person_id: alice.person,
      delta: 30,
      reason: "refund_removed",
      ref: heldA,
      balance: 100 - 30 - 20 + 30,
    });
    // Nothing is left to apply, and a second run changes nothing.
    expect(migrate(t.db, [identitySchema, configSchema, economySchema])).toEqual([]);
    expect(refunds(t)).toHaveLength(2);
  });
});

describe("retiring goals", () => {
  it("returns the pledges of a goal nobody funded, and keeps those of a funded one", () => {
    const { t, people, row, balance } = oldDatabase();
    const [alice, bob] = people;
    if (!alice || !bob) throw new Error("people");
    row(alice.person, 200, "checkin");
    row(bob.person, 200, "checkin");
    // Open goal "g1": both pledged. Expired goal "g2": pledged, then returned at the time.
    // Reached goal "g3": pledged, and the purse took the funds.
    const openA = row(alice.person, -30, "goal_pledge", "g1");
    const openB = row(bob.person, -50, "goal_pledge", "g1");
    const gone = row(alice.person, -20, "goal_pledge", "g2");
    row(alice.person, 20, "refund", gone);
    row(bob.person, -40, "goal_pledge", "g3");
    row("self", 40, "goal_funds", "g3");
    // An expired goal whose pledge was never returned (the old code would have): still given back.
    const stuck = row(bob.person, -10, "goal_pledge", "g4");
    expect(balance(alice.person)).toBe(200 - 30);
    expect(balance(bob.person)).toBe(200 - 50 - 40 - 10);

    expect(
      migrate(t.db, [identitySchema, configSchema, economySchema]).map((m) => m.name),
    ).toContain("retire_goals");

    expect(refunds(t).map((r) => [r.person_id, r.delta, r.ref])).toEqual([
      [alice.person, 30, openA],
      [bob.person, 50, openB],
      [bob.person, 10, stuck],
    ]);
    expect(balance(alice.person)).toBe(200);
    expect(balance(bob.person)).toBe(200 - 40);
    expect(tableExists(t, "economy_goals")).toBe(false);
    expect(tableExists(t, "economy_goal_pledges")).toBe(false);
    expect(
      t.db.all("SELECT 1 FROM events WHERE type = 'economy.posted' AND key LIKE 'ledger:%'"),
    ).toHaveLength(3);
    expect(migrate(t.db, [identitySchema, configSchema, economySchema])).toEqual([]);
    expect(refunds(t)).toHaveLength(3);
  });
});

describe("retiring song tickets and dedications", () => {
  it("returns what the stored set list still holds for songs not yet sung", () => {
    const { t, people, row, balance } = oldDatabase();
    const [alice, bob] = people;
    if (!alice || !bob) throw new Error("people");
    row(alice.person, 200, "checkin");
    row(bob.person, 200, "checkin");
    const ticketA = row(alice.person, -25, "song_ticket", "song:a");
    const dedicationA = row(alice.person, -15, "dedication", "song:a");
    const ticketB = row(bob.person, -25, "song_ticket", "song:b");
    const sung = row(bob.person, -15, "dedication", "song:c");
    const skipped = row(bob.person, -25, "song_ticket", "song:d");
    row(bob.person, 25, "refund", skipped);
    const entry = (state: string, ticket: string | null, dedication: string | null) => ({
      no: 1,
      state,
      ticket_entry: ticket,
      dedication_entry: dedication,
    });
    const setlist = {
      version: 1,
      next: 6,
      entries: [
        entry("preparing", ticketA, dedicationA),
        entry("playing", ticketB, null),
        entry("done", null, sung),
        entry("failed", skipped, null),
        entry("ready", null, null),
      ],
    };
    t.db.run(
      "INSERT INTO plugin_state (plugin, key, value, v, updated_at) VALUES ('settings', 'sing:setlist', $value, 1, $ts)",
      { value: JSON.stringify(setlist), ts: NOW },
    );
    expect(balance(alice.person)).toBe(200 - 25 - 15);
    expect(balance(bob.person)).toBe(200 - 25 - 15 - 25 + 25);

    expect(
      migrate(t.db, [identitySchema, configSchema, economySchema]).map((m) => m.name),
    ).toContain("retire_song_extras");

    expect(
      refunds(t)
        .map((r) => [r.person_id, r.delta, r.ref])
        .sort((a, b) => String(a[2]).localeCompare(String(b[2]))),
    ).toEqual(
      [
        [alice.person, 25, ticketA],
        [alice.person, 15, dedicationA],
        [bob.person, 25, ticketB],
      ].sort((a, b) => String(a[2]).localeCompare(String(b[2]))),
    );
    expect(balance(alice.person)).toBe(200);
    expect(balance(bob.person)).toBe(200 - 15);
    expect(migrate(t.db, [identitySchema, configSchema, economySchema])).toEqual([]);
    expect(refunds(t)).toHaveLength(3);
  });

  it("has nothing to give back when no set list was stored", () => {
    const { t, people, row } = oldDatabase();
    const [alice] = people;
    if (!alice) throw new Error("people");
    row(alice.person, 50, "checkin");
    migrate(t.db, [identitySchema, configSchema, economySchema]);
    expect(refunds(t)).toEqual([]);
  });
});

describe("retiring commissions", () => {
  it("returns the price of every commission still waiting, and keeps the rest", () => {
    const { t, people, row, balance } = oldDatabase();
    const [alice, bob] = people;
    if (!alice || !bob) throw new Error("people");
    row(alice.person, 200, "checkin");
    row(bob.person, 200, "checkin");
    const doc = (who: { account: string }, id: string, status: string) =>
      t.db.run(
        `INSERT INTO economy_docs (kind, id, owner_account_id, status, version, data, created_at, updated_at)
         VALUES ('commission', $id, $account, $status, 1, $data, $ts, $ts)`,
        {
          id,
          account: who.account,
          status,
          data: JSON.stringify({ kind: "poem", brief: "rain", price: 40, entry: id, note: null }),
          ts: NOW,
        },
      );
    // Waiting: one each. Delivered, declined (refunded at the time) and expired are not held.
    const waitingA = row(alice.person, -40, "commission", "poem");
    const waitingB = row(bob.person, -120, "commission", "tool");
    doc(alice, waitingA, "open");
    doc(bob, waitingB, "open");
    doc(alice, row(alice.person, -30, "commission", "name"), "delivered");
    const declined = row(bob.person, -80, "commission", "song");
    row(bob.person, 80, "refund", declined);
    doc(bob, declined, "declined");
    expect(balance(alice.person)).toBe(200 - 40 - 30);
    expect(balance(bob.person)).toBe(200 - 120);

    expect(
      migrate(t.db, [identitySchema, configSchema, economySchema]).map((m) => m.name),
    ).toContain("retire_commissions");

    expect(refunds(t).map((r) => [r.person_id, r.delta, r.ref])).toEqual([
      [alice.person, 40, waitingA],
      [bob.person, 120, waitingB],
    ]);
    expect(balance(alice.person)).toBe(200 - 30);
    expect(balance(bob.person)).toBe(200);
    const docs = t.db.all(
      "SELECT id, status, version, data FROM economy_docs WHERE kind = 'commission' ORDER BY created_at, id",
    );
    expect(docs).toHaveLength(4);
    const waiting = docs.find((d) => d.id === waitingA);
    expect(waiting).toMatchObject({ status: "declined", version: 2 });
    expect(JSON.parse(String(waiting?.data)).note).toContain("退回");
    expect(
      docs
        .filter((d) => d.version === 1)
        .map((d) => d.status)
        .sort(),
    ).toEqual(["declined", "delivered"]);
    expect(
      t.db.all("SELECT 1 FROM events WHERE type = 'economy.posted' AND key LIKE 'ledger:%'"),
    ).toHaveLength(2);
  });
});
