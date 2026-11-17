import type { AuthScope, NodeOverride, RoleAssignment } from "@miyoria/store";
import type { AccountRef, ContextKey, Subject } from "@miyoria/types";
import { describe, expect, test } from "vitest";
import {
  ADMIN,
  BLOCKED,
  builtinRoles,
  MODERATOR,
  OWNER,
  RESTRICTED,
  TRUSTED,
  USER,
} from "../src/builtin.js";
import { outranks, type Resolution, Snapshot, sourceEquals } from "../src/resolve.js";

const acc = (id: string): AccountRef => ({ platform: "discord", id });

const ctx = (guild: string, channel: string): ContextKey => ({
  platform: "discord",
  scope: guild,
  channel,
  kind: "channel",
});

const guild = (g: string): AuthScope => ({ type: "guild", platform: "discord", guild: g });
const global: AuthScope = { type: "global" };

function subject(id: string, context: ContextKey | null, roles: string[], admin: boolean): Subject {
  return { account: acc(id), context, platform_roles: roles, is_guild_admin: admin };
}

function assign(id: string, role: string, scope: AuthScope): RoleAssignment {
  return {
    account: acc(id),
    role,
    scope,
    granted_by: "test",
    at: "2026-11-01T00:00:00.000Z",
  };
}

function snapshot(): Snapshot {
  const s = new Snapshot();
  s.roles = new Map(builtinRoles().map((r) => [r.name, r]));
  s.setOwners([acc("1")]);
  s.defaultRole = USER;
  s.setAssignments([
    assign("2", TRUSTED, global),
    assign("2", MODERATOR, guild("g1")),
    assign("3", MODERATOR, { type: "channel", context: ctx("g1", "c1") }),
    assign("4", BLOCKED, guild("g1")),
    assign("5", RESTRICTED, global),
    assign("6", "ghost", global),
  ]);
  s.mappings.set("discord\u0000g1", [
    { platform: "discord", guild: "g1", platform_role: "r-mod", role: MODERATOR },
  ]);
  return s;
}

const roleOf = (s: Snapshot, sub: Subject): string => s.resolve(sub).effective.role;
const allowed = (s: Snapshot, sub: Subject, node: string): boolean =>
  s.check(sub, s.resolve(sub), node);

describe("resolution", () => {
  test("resolution_order", () => {
    const s = snapshot();
    const g1 = ctx("g1", "c1");
    const g2 = ctx("g2", "c9");
    // Config owner beats everything, even a guild-admin flag.
    const owner = s.resolve(subject("1", g1, [], true));
    expect(owner.effective.role).toBe(OWNER);
    expect(owner.effective.source.type).toBe("config_owner");
    // Assignments by scope.
    expect(roleOf(s, subject("2", g1, [], false))).toBe(MODERATOR);
    expect(roleOf(s, subject("2", g2, [], false))).toBe(TRUSTED);
    expect(roleOf(s, subject("2", null, [], false))).toBe(TRUSTED);
    expect(roleOf(s, subject("3", g1, [], false))).toBe(MODERATOR);
    expect(roleOf(s, subject("3", ctx("g1", "c2"), [], false))).toBe(USER);
    // Platform role mapping only in its guild.
    expect(roleOf(s, subject("9", g1, ["r-mod"], false))).toBe(MODERATOR);
    expect(roleOf(s, subject("9", g2, ["r-mod"], false))).toBe(USER);
    // Guild admins are at least admin; higher assignments still win.
    expect(roleOf(s, subject("9", g1, [], true))).toBe(ADMIN);
    // Restricted assignment replaces the default.
    expect(roleOf(s, subject("5", g1, [], false))).toBe(RESTRICTED);
    // Unknown roles are ignored.
    expect(roleOf(s, subject("6", null, [], false))).toBe(USER);
    const r = s.resolve(subject("9", null, [], false));
    expect(r.effective.source).toEqual({ type: "default" });
  });

  test("explicit_block_beats_guild_admin", () => {
    const s = snapshot();
    const r = s.resolve(subject("4", ctx("g1", "c1"), ["r-mod"], true));
    expect(r.effective.role).toBe(BLOCKED);
    expect(r.candidates).toHaveLength(3);
    expect((r.candidates[0] as { role: string }).role).toBe(ADMIN);
    expect(roleOf(s, subject("4", ctx("g2", "c1"), [], true))).toBe(ADMIN);
  });

  test("missing_mappings_are_reported", () => {
    const s = snapshot();
    expect(s.resolve(subject("9", ctx("g2", "c1"), ["x"], false)).mappings_missing).toBe(true);
    expect(s.resolve(subject("9", ctx("g1", "c1"), ["x"], false)).mappings_missing).toBe(false);
    // Nothing to map: nothing missing.
    expect(s.resolve(subject("9", ctx("g2", "c1"), [], false)).mappings_missing).toBe(false);
  });

  test("overrides_by_scope", () => {
    const s = snapshot();
    const ov = (scope: AuthScope, role: string, node: string, allow: boolean): NodeOverride => ({
      scope,
      role,
      node,
      allow,
    });
    s.overrides = [
      ov(global, USER, "queue.skip", true),
      ov(guild("g1"), USER, "queue.*", false),
      ov({ type: "channel", context: ctx("g1", "c1") }, USER, "queue.skip", true),
      // Same level: deny beats grant.
      ov(guild("g2"), USER, "voice.*", true),
      ov(guild("g2"), USER, "voice.join", false),
    ];
    const at = (g: string, c: string) => subject("9", ctx(g, c), [], false);
    expect(allowed(s, at("g1", "c1"), "queue.skip")).toBe(true);
    expect(allowed(s, at("g1", "c2"), "queue.skip")).toBe(false);
    expect(allowed(s, at("g1", "c2"), "queue.request")).toBe(false);
    expect(allowed(s, at("g3", "c2"), "queue.skip")).toBe(true);
    expect(allowed(s, subject("9", null, [], false), "queue.skip")).toBe(true);
    expect(allowed(s, at("g2", "c1"), "voice.join")).toBe(false);
    expect(allowed(s, at("g2", "c1"), "voice.mute")).toBe(true);
    // Overrides of other roles do not apply.
    expect(allowed(s, subject("2", null, [], false), "voice.mute")).toBe(false);
  });

  test("owners_blocked_and_empty_nodes", () => {
    const s = snapshot();
    const owner = subject("1", null, [], false);
    expect(allowed(s, owner, "owner.shutdown")).toBe(true);
    expect(allowed(s, owner, "")).toBe(true);
    const user = subject("9", null, [], false);
    expect(allowed(s, user, "")).toBe(true);
    expect(allowed(s, user, "help")).toBe(true);
    expect(allowed(s, user, "admin.module.toggle")).toBe(false);
    const blocked = subject("4", ctx("g1", "c1"), [], false);
    expect(allowed(s, blocked, "")).toBe(false);
    expect(allowed(s, blocked, "help")).toBe(false);
    const admin = subject("9", ctx("g1", "c1"), [], true);
    expect(allowed(s, admin, "admin.module.toggle")).toBe(true);
    expect(allowed(s, admin, "owner.shutdown")).toBe(false);
  });

  test("outranks", () => {
    const s = snapshot();
    const owner: Resolution = s.resolve(subject("1", null, [], false));
    expect(outranks(owner, 100)).toBe(true);
    const admin = s.resolve(subject("9", ctx("g1", "c1"), [], true));
    expect(outranks(admin, 60)).toBe(true);
    expect(outranks(admin, 80)).toBe(false);
  });

  test("resolution_serializes_as_tagged_json", () => {
    const s = snapshot();
    const r = s.resolve(subject("2", ctx("g1", "c1"), [], false));
    expect(JSON.parse(JSON.stringify(r.effective))).toEqual({
      role: MODERATOR,
      rank: 60,
      source: { type: "assignment", scope: guild("g1"), granted_by: "test" },
    });
    expect(Object.keys(r).sort()).toEqual(["candidates", "effective", "mappings_missing"]);
    expect(sourceEquals(r.effective.source, r.effective.source)).toBe(true);
  });
});
