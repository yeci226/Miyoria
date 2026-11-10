// Data categories (`data.ts`): the registry's invariants and the node-wide parts of a wipe /
// factory reset. Node-wide categories (people, roles, `_global` settings) delete every row, so
// these cases run only on fresh in-memory SQLite databases, never on a shared Postgres; the
// per-profile categories run on every backend in `behaviour.test.ts`.

import { newId, toTimestamp } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import {
  categoryModules,
  DATA_CATEGORIES,
  GLOBAL_SETTINGS_PROFILE,
  RESET_CATEGORIES,
  type RoleDefinition,
  resolveCategories,
  SqliteStore,
  type Store,
} from "../src/index.js";

const P = "deepseek-chan";
const OTHER = "someone-else";
const T0 = Date.UTC(2026, 0, 1);

const stores: Store[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

async function open(): Promise<Store> {
  const store = await SqliteStore.open(":memory:");
  stores.push(store);
  return store;
}

const BUILTINS: RoleDefinition[] = [
  { name: "owner", rank: 100, grants: ["*"], denies: [], builtin: true },
  { name: "user", rank: 20, grants: ["chat.talk"], denies: [], builtin: true },
];

/** Something in every category, for `P` and (per-profile data) for `OTHER`. */
async function seed(store: Store) {
  const owen = await store.people.upsertAccount({ platform: "discord", id: "2" }, "Owen");
  await store.identity.createLinkCode("ABC123", { platform: "discord", id: "2" }, toTimestamp(T0));
  const ctx = { platform: "discord", scope: "g", channel: "c", kind: "channel" as const };
  for (const p of [P, OTHER]) {
    await store.memories.upsert({
      id: newId(),
      profile: p,
      kind: "fact",
      scope: { type: "global" },
      subjects: [owen],
      content: "Owen 喜歡拉麵",
      tokens: "owen 喜歡 拉麵",
      embedding: null,
      importance: 0.5,
      confidence: 0.8,
      created_at: toTimestamp(T0),
      updated_at: toTimestamp(T0),
      last_accessed: null,
      access_count: 0,
      source_context: null,
      source: null,
      due: null,
      done: false,
      superseded_by: null,
    });
    await store.relationships.upsert({
      profile: p,
      person: owen,
      affinity: 10,
      trust: 10,
      familiarity: 10,
      tags: [],
      notes: "",
      call_name: "歐文",
      interactions: 1,
      last_interaction: null,
      updated_at: toTimestamp(T0),
    });
    await store.messages.append({
      id: newId(),
      profile: p,
      context: ctx,
      author: { platform: "discord", id: "2" },
      author_name: "Owen",
      text: "嗨",
      is_self: false,
      ts: toTimestamp(T0),
      turn: null,
    });
    await store.personaOverrides.set(p, "style", "新的", "test");
    for (const key of [
      "memory_watermark:x",
      "mood:last",
      "self:state",
      "self:feeling:p",
      "channel_mode:x",
      "knowledge:doc:x",
      "reflect:lesson:x",
      "conversation:state:x",
      "zzz:unknown",
    ]) {
      await store.settings.set(p, key, 1);
    }
  }
  for (const key of [
    "initiative:state",
    "queue:state",
    "voice_consent:discord:2",
    "privacy:discord:2",
    "llm_usage:2026-01",
    "panel_session:abc",
    "future:thing",
  ]) {
    await store.settings.set(GLOBAL_SETTINGS_PROFILE, key, 1);
  }
  await store.auth.upsertRole({
    name: "owner",
    rank: 100,
    grants: ["x"],
    denies: [],
    builtin: true,
  });
  await store.auth.upsertRole({ name: "vip", rank: 50, grants: ["a"], denies: [], builtin: false });
  const scope = { type: "global" as const };
  await store.auth.assign({
    account: { platform: "discord", id: "2" },
    role: "vip",
    scope,
    granted_by: "test",
    at: toTimestamp(T0),
  });
  await store.auth.setMapping({ platform: "discord", guild: "g", platform_role: "r", role: "vip" });
  await store.auth.setOverride({ scope, role: "vip", node: "b", allow: true });
  await store.moduleState.set("agent", false);
  await store.audit.append({
    id: newId(),
    at: toTimestamp(T0),
    actor: "test",
    action: "seed",
    target: P,
    detail: {},
    ok: true,
  });
  return { owen, ctx };
}

describe("data categories", () => {
  it("never deletes watermarks without the log, and keeps the audit log", () => {
    const watermarks = DATA_CATEGORIES.filter((c) =>
      c.parts.some((p) => p.kind === "settings" && p.prefixes.includes("memory_watermark:")),
    );
    expect(watermarks.map((c) => c.id)).toEqual(["messages"]);
    expect(watermarks[0]?.parts.some((p) => p.kind === "table" && p.table === "message_log")).toBe(
      true,
    );
    expect(RESET_CATEGORIES).not.toContain("audit");
    expect(RESET_CATEGORIES).not.toContain("llm_usage");
    expect(RESET_CATEGORIES).not.toContain("panel_sessions");
    expect(() => resolveCategories(["audit"])).toThrow(/kept/);
    // Every part id is unique (counts and backups are keyed by it).
    const ids = DATA_CATEGORIES.flatMap((c) => c.parts.map((p) => p.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("deleting people takes what is keyed by person with it", () => {
    expect(resolveCategories(["people"])).toEqual([
      "relationships",
      "call_names",
      "inner",
      "knowledge",
      "learning",
      "people",
    ]);
    expect(categoryModules(resolveCategories(["people"]))).toEqual([
      "social",
      "agent",
      "self",
      "mind",
      "knowledge",
      "reflect",
      "world",
      "memory",
    ]);
    // Her conversation notes are made from the log and go with it; the EventLog repeats it.
    expect(resolveCategories(["messages"])).toEqual(["conversation", "messages", "event_log"]);
  });

  it("factory reset leaves a fresh install: audit, LLM usage and sessions kept", async () => {
    const store = await open();
    const { owen, ctx } = await seed(store);
    const before = await store.profileData.inventory(P);
    for (const c of before.categories) {
      const unseeded = ["decisions", "event_log", "directives", "proposed_tools", "extensions"];
      if (unseeded.includes(c.id)) continue;
      expect(c.count, c.id).toBeGreaterThan(0);
    }

    const counts = await store.profileData.wipe(P, RESET_CATEGORIES, { seedRoles: BUILTINS });
    expect(counts).toMatchObject({
      memory_records: 1,
      relationships: 1,
      call_names: 1,
      message_log: 1,
      memory_watermarks: 1,
      people: 1,
      accounts: 1,
      link_codes: 1,
      roles: 2,
      role_assignments: 1,
      role_mappings: 1,
      node_overrides: 1,
      module_state: 1,
      initiative: 1,
      queue: 1,
      voice_consent: 1,
      privacy: 1,
      persona_overrides: 1,
      // `zzz:unknown` of the profile and `future:thing` of `_global`.
      other_settings: 2,
    });

    const after = await store.profileData.inventory(P);
    for (const c of after.categories) {
      const expected =
        c.id === "audit" || c.id === "llm_usage" || c.id === "panel_sessions"
          ? 1
          : c.id === "roles"
            ? BUILTINS.length
            : 0;
      expect(c.count, c.id).toBe(expected);
    }
    // Built-in roles as given, nothing else.
    expect(await store.auth.roles()).toEqual(BUILTINS);
    expect(await store.auth.allAssignments()).toEqual([]);
    expect(await store.people.all()).toEqual([]);
    expect(await store.moduleState.list()).toEqual(new Map());
    expect((await store.audit.recent(9, null)).map((e) => e.action)).toEqual(["seed"]);
    expect([...(await store.settings.list(GLOBAL_SETTINGS_PROFILE, "")).keys()]).toEqual([
      "llm_usage:2026-01",
      "panel_session:abc",
    ]);
    expect((await store.settings.list(P, "")).size).toBe(0);

    // The other profile keeps its own data (people are shared and gone).
    expect(await store.messages.recent(OTHER, ctx, 9)).toHaveLength(1);
    expect((await store.relationships.get(OTHER, owen))?.call_name).toBe("歐文");
    expect((await store.settings.list(OTHER, "")).size).toBe(9);
    expect((await store.personaOverrides.current(OTHER)).size).toBe(1);
  });

  it("is all or nothing", async () => {
    const store = await open();
    const { ctx } = await seed(store);
    // A duplicate built-in role fails the last statement: nothing is deleted.
    const dup = [...BUILTINS, BUILTINS[0] as RoleDefinition];
    await expect(store.profileData.wipe(P, RESET_CATEGORIES, { seedRoles: dup })).rejects.toThrow(
      /cannot wipe/,
    );
    expect(await store.messages.recent(P, ctx, 9)).toHaveLength(1);
    expect(await store.people.all()).toHaveLength(1);
    expect((await store.auth.roles()).map((r) => r.name).sort()).toEqual(["owner", "vip"]);
  });

  it("exports node-wide categories and never the panel sessions", async () => {
    const store = await open();
    await seed(store);
    const backup = await store.profileData.export(P, [
      ...RESET_CATEGORIES,
      "audit",
      "panel_sessions",
    ]);
    expect(backup.categories).toContain("audit");
    expect(backup.categories).not.toContain("panel_sessions");
    expect(backup.parts).not.toHaveProperty("panel_sessions");
    expect(backup.parts.roles?.find((r) => r.name === "vip")).toEqual({
      name: "vip",
      rank: 50,
      grants: ["a"],
      denies: [],
      builtin: false,
    });
    expect(backup.parts.role_assignments?.[0]?.scope).toEqual({ type: "global" });
    expect(backup.parts.module_state).toEqual([
      { module_id: "agent", enabled: false, updated_at: expect.any(String) },
    ]);
    expect(backup.parts.other_settings?.map((r) => [r.profile_id, r.key])).toEqual([
      [GLOBAL_SETTINGS_PROFILE, "future:thing"],
      [P, "zzz:unknown"],
    ]);
    expect(backup.parts.audit_log?.[0]).toMatchObject({ action: "seed", ok: true, detail: {} });
  });
});
