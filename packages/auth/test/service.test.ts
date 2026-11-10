import { DIRECTIVE_MODERATE } from "@miyoria/commands";
import type { RoleDefinition } from "@miyoria/store";
import type { AccountRef, ContextKey, Subject } from "@miyoria/types";
import { afterEach, describe, expect, test, vi } from "vitest";
import { builtinRoles, builtinStatus, LEGACY_BUILTIN_GRANTS, USER } from "../src/builtin.js";
import { AuthError, AuthService } from "../src/service.js";
import { FakeAudit, FakeAuthStore } from "./fake.js";

const acc = (id: string): AccountRef => ({ platform: "discord", id });
const ctx = (guild: string): ContextKey => ({
  platform: "discord",
  scope: guild,
  channel: "c",
  kind: "channel",
});
const subject = (id: string, guild: string, roles: string[] = []): Subject => ({
  account: acc(id),
  context: ctx(guild),
  platform_roles: roles,
  is_guild_admin: false,
});

afterEach(() => {
  vi.useRealTimers();
});

async function load(store = new FakeAuthStore(), audit: FakeAudit | null = new FakeAudit()) {
  const service = await AuthService.load(store, audit, [acc("1")], USER);
  return { service, store, audit };
}

describe("AuthService", () => {
  test("an_unedited_role_from_before_the_rules_gets_them", () => {
    for (const name of ["moderator", "admin"]) {
      const current = builtinRoles().find((r) => r.name === name);
      if (current === undefined) throw new Error(name);
      for (const grants of LEGACY_BUILTIN_GRANTS[name] ?? []) {
        expect(builtinStatus({ ...current, grants: [...grants] })).toBe("upgrade");
      }
      expect(current.grants).toContain(DIRECTIVE_MODERATE);
    }
    const trusted = builtinRoles().find((r) => r.name === "trusted");
    expect(trusted?.grants).not.toContain(DIRECTIVE_MODERATE);
  });

  test("upgrades_unedited_builtins_from_an_earlier_version", async () => {
    const store = new FakeAuthStore();
    for (const name of ["user", "moderator"] as const) {
      const legacy = LEGACY_BUILTIN_GRANTS[name]?.[0] ?? [];
      const current = builtinRoles().find((r) => r.name === name);
      store.roleList.push({
        name,
        rank: current?.rank ?? 0,
        grants: [...legacy],
        denies: [...(current?.denies ?? [])],
        builtin: true,
      });
    }
    const { service } = await load(store);
    expect(service.role("user")?.grants).toContain("queue.vote");
    expect(service.role("user")?.grants).not.toContain("ping");
    expect(service.role("moderator")?.grants).toContain("admin.person.block");
    expect(service.role("moderator")?.grants).not.toContain("memory.view.others");
  });

  test("seeds_missing_builtins_and_keeps_edited_ones", async () => {
    const store = new FakeAuthStore();
    store.roleList.push({ name: "user", rank: 20, grants: ["ping"], denies: [], builtin: true });
    const { service } = await load(store);
    expect(store.roleList).toHaveLength(7);
    expect(service.role("user")?.grants).toEqual(["ping"]);
    expect(service.roles().map((r) => r.name)).toEqual([
      "owner",
      "admin",
      "moderator",
      "trusted",
      "user",
      "restricted",
      "blocked",
    ]);
    expect(await service.seedBuiltins()).toBe(0);
  });

  test("custom_roles_are_validated_and_audited", async () => {
    const { service, audit } = await load();
    const role: RoleDefinition = {
      name: "helper",
      rank: 30,
      grants: ["queue.list"],
      denies: [],
      builtin: true, // ignored: custom roles are never built in
    };
    await service.upsertRole("cli", role);
    expect(service.role("helper")?.builtin).toBe(false);
    expect(service.roles().map((r) => r.name)).toContain("helper");

    await expect(service.upsertRole("cli", { ...role, name: "Bad Name" })).rejects.toThrow(
      "invalid role name `Bad Name` (1-32 of a-z 0-9 _ -)",
    );
    await expect(service.upsertRole("cli", { ...role, grants: ["a..b"] })).rejects.toThrow(
      "invalid permission node `a..b`",
    );
    await expect(service.deleteRole("cli", "owner")).rejects.toThrow(
      "built-in role `owner` cannot be deleted",
    );
    expect(await service.deleteRole("cli", "helper")).toBe(true);
    expect(await service.deleteRole("cli", "helper")).toBe(false);
    expect(audit?.actions()).toEqual([
      ["role.upsert", true],
      ["role.upsert", false],
      ["role.upsert", false],
      ["role.delete", false],
      ["role.delete", true],
      ["role.delete", true],
    ]);
  });

  test("the_default_role_cannot_be_deleted", async () => {
    const store = new FakeAuthStore();
    store.roleList.push({ name: "base", rank: 5, grants: [], denies: [], builtin: false });
    const service = await AuthService.load(store, null, [], "base");
    await expect(service.deleteRole("cli", "base")).rejects.toThrow("`base` is the default role");
    await expect(service.deleteRole("cli", "base")).rejects.toBeInstanceOf(AuthError);
  });

  test("assign_requires_a_known_role_and_audits_detail", async () => {
    const { service, audit } = await load();
    await expect(service.assign("cli", acc("5"), "ghost", { type: "global" })).rejects.toThrow(
      "unknown role `ghost`",
    );
    await service.assign("discord:2", acc("5"), "trusted", { type: "global" });
    expect(service.assignmentsFor(acc("5"))).toHaveLength(1);
    expect(service.assignmentsFor(acc("5"))[0]?.granted_by).toBe("discord:2");
    const entry = audit?.entries.at(-1);
    expect(entry).toMatchObject({
      actor: "discord:2",
      action: "role.assign",
      target: "discord:5",
      detail: { role: "trusted", scope: { type: "global" } },
      ok: true,
    });
    expect(entry?.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(await service.revoke("cli", acc("5"), "trusted", { type: "global" })).toBe(true);
    expect(service.assignmentsFor(acc("5"))).toEqual([]);
  });

  test("works_without_an_audit_log", async () => {
    const { service } = await load(new FakeAuthStore(), null);
    await service.assign("cli", acc("5"), "trusted", { type: "global" });
    expect(service.check({ ...subject("5", "g1") }, "tools.web.search")).toBe(true);
  });

  test("mappings_load_in_the_background_when_missing", async () => {
    const store = new FakeAuthStore();
    store.mappingList.push({ platform: "discord", guild: "g1", platform_role: "r", role: "admin" });
    const { service } = await load(store);
    const sub = subject("9", "g1", ["r"]);
    // First check: mappings not cached, answered without them.
    expect(service.check(sub, "admin.module.toggle")).toBe(false);
    await vi.waitFor(() => expect(service.check(sub, "admin.module.toggle")).toBe(true));
    const reads = store.mappingReads;
    service.check(sub, "ping");
    expect(store.mappingReads).toBe(reads);
  });

  test("preload_makes_the_first_check_correct", async () => {
    const store = new FakeAuthStore();
    store.mappingList.push({ platform: "discord", guild: "g1", platform_role: "r", role: "admin" });
    const { service } = await load(store);
    const sub = subject("9", "g1", ["r"]);
    await service.preload(sub);
    expect(service.check(sub, "admin.module.toggle")).toBe(true);
    // DMs and cached guilds are no-ops.
    await service.preload({ ...sub, context: null });
    const reads = store.mappingReads;
    await service.preload(sub);
    expect(store.mappingReads).toBe(reads);
  });

  test("preload_gives_up_after_the_timeout", async () => {
    vi.useFakeTimers();
    const store = new FakeAuthStore();
    const { service } = await load(store);
    store.mappings = () => new Promise(() => undefined);
    const sub = subject("9", "g1", ["r"]);
    const done = service.preload(sub);
    await vi.advanceTimersByTimeAsync(2_000);
    await done;
    expect(service.resolve(sub).mappings_missing).toBe(true);
  });

  test("reload_picks_up_external_changes", async () => {
    const { service, store } = await load();
    store.assignmentList.push({
      account: acc("5"),
      role: "admin",
      scope: { type: "global" },
      granted_by: "other",
      at: "2026-11-01T00:00:00.000Z",
    });
    expect(service.check(subject("5", "g1"), "admin.module.toggle")).toBe(false);
    await service.reload();
    expect(service.check(subject("5", "g1"), "admin.module.toggle")).toBe(true);
    service.setOwners([acc("5")]);
    expect(service.isConfigOwner(acc("5"))).toBe(true);
    expect(service.allows(acc("5"), "owner.shutdown")).toBe(true);
  });

  test("store_failures_are_audited_and_rethrown", async () => {
    const { service, store, audit } = await load();
    store.assign = async () => {
      throw new Error("disk full");
    };
    await expect(service.assign("cli", acc("5"), "trusted", { type: "global" })).rejects.toThrow(
      "disk full",
    );
    expect(audit?.actions()).toEqual([["role.assign", false]]);
  });

  test("builtin_roles_are_cloned_per_call", () => {
    const a = builtinRoles();
    const b = builtinRoles();
    a[0]?.grants.push("x");
    expect(b[0]?.grants).toEqual(["*"]);
  });
});
