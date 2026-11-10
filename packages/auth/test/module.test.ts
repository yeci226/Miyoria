import {
  type CommandRegistry,
  CommandRegistryKey,
  CommandReply,
  CommandsModule,
  commandSpec,
  Invocation,
  type ResolvedUser,
} from "@miyoria/commands";
import { EventBus, ServiceRegistry, Supervisor } from "@miyoria/kernel";
import { AuditLogKey, AuthStoreKey } from "@miyoria/store";
import {
  type AccountRef,
  type Authorizer,
  AuthorizerKey,
  type ContextKey,
  type Subject,
} from "@miyoria/types";
import { afterEach, describe, expect, test } from "vitest";
import { AuthModule, AuthService, AuthServiceKey } from "../src/index.js";
import { FakeAudit, FakeAuthStore } from "./fake.js";

const acc = (id: string): AccountRef => ({ platform: "discord", id });

const ctx = (guild: string): ContextKey => ({
  platform: "discord",
  scope: guild,
  channel: `${guild}-chan`,
  kind: "channel",
});

const subject = (id: string, guild: string, roles: string[] = []): Subject => ({
  account: acc(id),
  context: ctx(guild),
  platform_roles: roles,
  is_guild_admin: false,
});

/** `path` with `args`, by `who` in guild `g1`. */
function inv(path: string, who: string, args: Record<string, string> = {}): Invocation {
  const invocation = Invocation.create(path, acc(who), ctx("g1"));
  for (const [k, v] of Object.entries(args)) invocation.withArg(k, v);
  return invocation;
}

function asGuildAdmin(invocation: Invocation): Invocation {
  invocation.invoker_is_guild_admin = true;
  return invocation;
}

async function eventually(f: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (f()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not reached");
}

class Harness {
  readonly services = new ServiceRegistry();
  readonly sup: Supervisor;

  private constructor(
    readonly store: FakeAuthStore,
    readonly audit: FakeAudit,
  ) {
    this.sup = new Supervisor({ bus: new EventBus(), services: this.services });
  }

  static async boot(store = new FakeAuthStore()): Promise<Harness> {
    const h = new Harness(store, new FakeAudit());
    h.services.provide("app", AuthStoreKey, store);
    h.services.provide("app", AuditLogKey, h.audit);
    await h.sup.register(new CommandsModule(), { owners: ["discord:1"] }, true);
    await h.sup.register(new AuthModule(), null, true);
    await h.sup.startAll();
    return h;
  }

  registry(): CommandRegistry {
    return this.services.require(CommandRegistryKey);
  }

  authorizer(): Authorizer {
    return this.services.require(AuthorizerKey);
  }

  async run(invocation: Invocation): Promise<string> {
    return (await this.registry().dispatch(invocation)).text;
  }
}

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.sup.stopAll();
  harness = undefined;
});

async function boot(store?: FakeAuthStore): Promise<Harness> {
  harness = await Harness.boot(store);
  return harness;
}

describe("auth module", () => {
  test("seeds_roles_and_replaces_the_fallback", async () => {
    const h = await boot();
    expect(h.store.roleList).toHaveLength(7);
    const auth = h.authorizer();
    expect(auth.allows(acc("1"), "owner.shutdown")).toBe(true);
    // The fallback would allow unknown non-admin nodes; RBAC does not.
    expect(auth.allows(acc("5"), "zzz.unknown")).toBe(false);
    expect(auth.allows(acc("5"), "voice.join")).toBe(true);
    const admin = { ...subject("2", "g1"), is_guild_admin: true };
    expect(auth.allowsSubject(admin, "admin.module.toggle")).toBe(true);
    expect(auth.allowsSubject(admin, "owner.shutdown")).toBe(false);
    expect(h.registry().get(["admin", "role", "list"])).toBeDefined();

    const list = await h.run(inv("admin role list", "1"));
    expect(list, list).toContain("**owner**　等級 100");
    expect(list, list).toContain("**blocked**　等級 0");
    const denied = await h.run(inv("admin role list", "5"));
    expect(denied, denied).toContain("權限");
  });

  test("assign_revoke_and_rank_limits", async () => {
    const h = await boot();
    const auth = h.authorizer();

    let reply = await h.run(
      asGuildAdmin(inv("admin role assign", "2", { user: "<@5>", role: "moderator" })),
    );
    expect(reply, reply).toContain("的角色設為 `moderator`");
    expect(auth.allowsSubject(subject("5", "g1"), "admin.channel.mode")).toBe(true);
    expect(auth.allowsSubject(subject("5", "g2"), "admin.channel.mode")).toBe(false);

    // Same rank as the guild admin: refused.
    reply = await h.run(asGuildAdmin(inv("admin role assign", "2", { user: "5", role: "admin" })));
    expect(reply, reply).toContain("等級不低於你的角色");
    // Global changes need global authority.
    reply = await h.run(
      asGuildAdmin(inv("admin role assign", "2", { user: "5", role: "trusted", scope: "global" })),
    );
    expect(reply, reply).toContain("沒有進行這項變更的權限");

    // The owner may grant admin globally; the guild admin cannot then block them.
    reply = await h.run(
      inv("admin role assign", "1", { user: "6", role: "admin", scope: "global" }),
    );
    expect(reply, reply).toContain("在全域的角色設為 `admin`");
    expect(auth.allows(acc("6"), "admin.module.toggle")).toBe(true);
    reply = await h.run(
      asGuildAdmin(inv("admin role assign", "2", { user: "6", role: "blocked" })),
    );
    expect(reply, reply).toContain("的角色等級不低於你");

    reply = await h.run(
      asGuildAdmin(inv("admin role revoke", "2", { user: "5", role: "moderator" })),
    );
    expect(reply, reply).toContain("已收回");
    expect(auth.allowsSubject(subject("5", "g1"), "admin.channel.mode")).toBe(false);
    reply = await h.run(
      asGuildAdmin(inv("admin role revoke", "2", { user: "5", role: "moderator" })),
    );
    expect(reply, reply).toContain("沒有被指派");

    const unknown = await h.run(inv("admin role assign", "1", { user: "5", role: "ghost" }));
    expect(unknown, unknown).toContain("找不到角色 `ghost`");

    const actions = h.audit.actions();
    expect(actions).toContainEqual(["role.assign", true]);
    expect(actions).toContainEqual(["role.revoke", true]);
    // The commands framework audits `admin.*` commands too, including denials.
    expect(actions).toContainEqual(["admin role assign", true]);
  });

  test("mappings_are_preloaded_and_managed", async () => {
    const store = new FakeAuthStore();
    store.mappingList.push({
      platform: "discord",
      guild: "g1",
      platform_role: "r-trusted",
      role: "trusted",
    });
    const h = await boot(store);
    h.registry().register(
      commandSpec("probe", "Needs a trusted node", { permission: "tools.probe" }),
      () => CommandReply.public("ok"),
    );

    // Not cached yet: dispatch preloads the guild's mappings first.
    const probe = inv("probe", "7");
    probe.platform_roles = ["r-trusted"];
    expect(await h.run(probe)).toBe("ok");
    expect(await h.run(inv("probe", "7"))).not.toBe("ok");

    let reply = await h.run(
      asGuildAdmin(inv("admin role map", "2", { discord_role: "<@&r-mod>", role: "moderator" })),
    );
    expect(reply, reply).toContain("對應到角色 `moderator`");
    const auth = h.authorizer();
    expect(auth.allowsSubject(subject("8", "g1", ["r-mod"]), "admin.channel.mode")).toBe(true);
    reply = await h.run(
      asGuildAdmin(inv("admin role map", "2", { discord_role: "r-adm", role: "admin" })),
    );
    expect(reply, reply).toContain("等級不低於你的角色");

    const whois = inv("admin role whois", "1", { user: "8" });
    const resolved: ResolvedUser = {
      display_name: "eight",
      platform_roles: ["r-mod", "r-trusted"],
      is_guild_admin: false,
    };
    whois.resolved_users["8"] = resolved;
    reply = await h.run(whois);
    expect(reply, reply).toContain("的角色是 `moderator`");
    expect(reply, reply).toContain("<@&r-mod> 的對應");
    expect(reply, reply).toContain("`trusted`");

    const unmap = () => asGuildAdmin(inv("admin role unmap", "2", { discord_role: "r-mod" }));
    expect(await h.run(unmap())).toContain("已取消");
    expect(await h.run(unmap())).toContain("目前沒有對應");
    expect(auth.allowsSubject(subject("8", "g1", ["r-mod"]), "admin.channel.mode")).toBe(false);
  });

  test("node_overrides", async () => {
    const h = await boot();
    const auth = h.authorizer();
    let reply = await h.run(
      asGuildAdmin(inv("admin perm deny", "2", { role: "user", node: "voice.join" })),
    );
    expect(reply, reply).toContain("已禁止 `user` 在這個伺服器使用 `voice.join`");
    expect(auth.allowsSubject(subject("9", "g1"), "voice.join")).toBe(false);
    expect(auth.allowsSubject(subject("9", "g2"), "voice.join")).toBe(true);

    reply = await h.run(
      asGuildAdmin(inv("admin perm allow", "2", { role: "user", node: "owner.shutdown" })),
    );
    expect(reply, reply).toContain("你本身沒有");
    reply = await h.run(
      asGuildAdmin(inv("admin perm allow", "2", { role: "user", node: "Bad Node" })),
    );
    expect(reply, reply).toContain("格式不正確");

    reply = await h.run(
      asGuildAdmin(inv("admin perm clear", "2", { role: "user", node: "voice.join" })),
    );
    expect(reply, reply).toContain("已移除");
    expect(auth.allowsSubject(subject("9", "g1"), "voice.join")).toBe(true);
    expect(h.audit.actions()).toContainEqual(["perm.set", true]);
  });

  test("survives_commands_restart_and_restores_fallback_on_stop", async () => {
    const h = await boot();
    const path = ["admin", "role", "list"];
    await h.sup.restart("commands");
    await eventually(() => h.services.get(CommandRegistryKey)?.get(path) !== undefined);
    // Still the RBAC authorizer.
    expect(h.services.get(AuthorizerKey)).toBeInstanceOf(AuthService);
    expect(h.services.get(AuthServiceKey)).toBeInstanceOf(AuthService);

    await h.sup.disable("auth");
    await eventually(() => !(h.services.get(AuthorizerKey) instanceof AuthService));
    expect(h.registry().get(path)).toBeUndefined();

    await h.sup.enable("auth");
    expect(h.services.get(AuthorizerKey)).toBeInstanceOf(AuthService);
    expect(h.registry().get(path)).toBeDefined();
  });
});

describe("auth module config", () => {
  test("owners_come_from_auth_and_commands_config", async () => {
    const services = new ServiceRegistry();
    services.provide("app", AuthStoreKey, new FakeAuthStore());
    const sup = new Supervisor({ bus: new EventBus(), services });
    await sup.register(new CommandsModule(), { owners: ["discord:1"] }, true);
    await sup.register(new AuthModule(), { owners: ["discord:2"] }, true);
    await sup.startAll();
    try {
      const auth = services.require(AuthorizerKey);
      expect(auth.allows(acc("1"), "owner.shutdown")).toBe(true);
      expect(auth.allows(acc("2"), "owner.shutdown")).toBe(true);
      expect(auth.allows(acc("3"), "owner.shutdown")).toBe(false);
    } finally {
      await sup.stopAll();
    }
  });

  test("invalid_owner_fails_the_start", async () => {
    const bus = new EventBus();
    const states = bus.subscribe("system.module.state");
    const services = new ServiceRegistry();
    services.provide("app", AuthStoreKey, new FakeAuthStore());
    const sup = new Supervisor({ bus, services });
    await sup.register(new AuthModule(), { owners: ["nope"] }, true);
    await sup.startAll();
    try {
      for (;;) {
        const env = await states.recv();
        if (env?.event.type === "module_state_changed" && env.event.data.state === "failed") {
          expect(env.event.data.reason).toContain("invalid account `nope`");
          break;
        }
      }
    } finally {
      await sup.stopAll();
    }
  });

  test("works_without_commands_and_audit", async () => {
    const services = new ServiceRegistry();
    services.provide("app", AuthStoreKey, new FakeAuthStore());
    const sup = new Supervisor({ bus: new EventBus(), services });
    await sup.register(new AuthModule(), null, true);
    await sup.startAll();
    try {
      expect(services.require(AuthorizerKey).allows(acc("5"), "voice.join")).toBe(true);
      expect(services.has(CommandRegistryKey)).toBe(false);
    } finally {
      await sup.stopAll();
    }
  });
});
