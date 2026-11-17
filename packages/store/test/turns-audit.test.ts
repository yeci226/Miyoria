// Decisions, turn outcomes and audit entries as events: the envelope each one gets (type, tier,
// scope, place, person, turn), and the family rule that gives every `audit.<area>.<action>` its
// tier and scope. What the adapters read back is pinned in decision-log.test.ts and
// audit-log.test.ts.

import { EventRegistry } from "@miyoria/contracts/events";
import { type ContextKey, toTimestamp } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { coreEventRegistry, SqliteStore, typeDefaults } from "../src/index.js";

const T0 = Date.UTC(2026, 10, 1, 12);
const TEXT: ContextKey = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" };
const DM: ContextKey = { platform: "discord", scope: null, channel: "d1", kind: "dm" };

const stores: SqliteStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

async function open(): Promise<SqliteStore> {
  const store = await SqliteStore.open(":memory:");
  stores.push(store);
  return store;
}

describe("turn records", () => {
  it("are kept 90 days, in their place, under their turn", async () => {
    const store = await open();
    const owen = store.persons.see({ platform: "discord", id: "100" }, "Owen");
    const trace = { turn: "T1", context: TEXT, respond: true, score: 1, reasons: ["mention"] };
    await store.decisions.append({ id: "d1", profile: "p", ts: toTimestamp(T0), trace });
    await store.decisions.appendOutcome("p", {
      turn: "T1",
      context: TEXT,
      reason: "addressed",
      outcome: { type: "sent", parts: 1 },
      addressed_by: [owen.handle],
      focus: [],
      restarts: 0,
      reasoning: null,
      latency_ms: null,
      at: toTimestamp(T0 + 1000),
    });
    const [outcome, decision] = store.events.query({ turn: "T1" });
    expect(decision?.envelope).toMatchObject({
      id: "d1",
      type: "agent.decision",
      tier: "short",
      scope: "room",
      session: "discord:g1:c1",
      turn: "T1",
      source: "store.decisions",
      data: trace,
    });
    expect(outcome?.envelope).toMatchObject({
      type: "agent.turn.outcome",
      tier: "short",
      scope: "room",
      session: "discord:g1:c1",
      turn: "T1",
      // `addressed_by` names a handle: the store finds its person.
      person_id: owen.id,
    });
  });

  it("in a DM nobody has written in keep no place, and are found by their payload", async () => {
    const store = await open();
    const trace = { turn: "T1", context: DM, respond: false, score: 0, reasons: [] };
    await store.decisions.append({ id: "d1", profile: "p", ts: toTimestamp(T0), trace });
    expect(store.events.get("d1")?.envelope).toMatchObject({ session: null, scope: "dm" });
    expect((await store.decisions.recent("p", DM, 5)).map((d) => d.id)).toEqual(["d1"]);
    expect(await store.decisions.recent("p", { ...DM, channel: "d2" }, 5)).toEqual([]);
  });
});

describe("audit entries", () => {
  it("are `audit.<action>` events for the owner, kept, naming the actor's person", async () => {
    const store = await open();
    const owen = store.persons.see({ platform: "discord", id: "100" }, "Owen");
    const entry = {
      id: "a1",
      at: toTimestamp(T0),
      actor: "discord:100",
      action: "admin memory wipe",
      target: "p",
      detail: { counts: { memory_records: 2 } },
      ok: true,
    };
    await store.audit.append(entry);
    await store.audit.append({ ...entry, id: "a2", actor: "api", action: "persona.set" });
    expect(store.events.get("a1")?.envelope).toMatchObject({
      type: "audit.admin.memory.wipe",
      tier: "keep",
      scope: "owner",
      session: null,
      person_id: owen.id,
      source: "store.audit",
      data: {
        actor: "discord:100",
        action: "admin memory wipe",
        target: "p",
        detail: { counts: { memory_records: 2 } },
        ok: true,
      },
    });
    expect(store.events.get("a2")?.envelope).toMatchObject({
      type: "audit.persona.set",
      tier: "keep",
      scope: "owner",
      person_id: null,
      account_id: null,
    });
    // Nobody is created for an actor identity does not know.
    await store.audit.append({ ...entry, id: "a3", actor: "discord:404" });
    expect(store.persons.personOf({ platform: "discord", id: "404" })).toBeNull();
  });

  it("take their family's tier and scope; a type's own definition comes first", () => {
    const registry = coreEventRegistry();
    expect(typeDefaults(registry, "audit.module.disable")).toEqual({
      scope: "owner",
      tier: "keep",
    });
    expect(typeDefaults(registry, "agent.decision")).toEqual({ scope: null, tier: "short" });
    expect(typeDefaults(registry, "unknown.type")).toEqual({ scope: null, tier: "short" });
    expect(typeDefaults(new EventRegistry(), "audit.x")).toEqual({ scope: null, tier: "short" });
  });
});
