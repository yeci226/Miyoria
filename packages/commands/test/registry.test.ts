import { ServiceRegistry } from "@miyoria/kernel";
import { type AuditEntry, type AuditLog, AuditLogKey } from "@miyoria/store";
import { type Authorizer, AuthorizerKey, type Subject } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  ArgKind,
  type ArgValue,
  AuthorizerPreloadKey,
  argSpec,
  CommandError,
  CommandRegistry,
  CommandReply,
  type CommandSpec,
  commandSpec,
  Invocation,
  normalizeArgs,
  Permissions,
  parseAccount,
  replyEphemeral,
} from "../src/index.js";
import { inv } from "./helpers.js";

function registry(): CommandRegistry {
  return new CommandRegistry(Permissions.fromStrings(["discord:1"]));
}

function echoSpec(): CommandSpec {
  return commandSpec("echo", "Repeats text", {
    args: [
      argSpec("text", "What to say", ArgKind.string),
      argSpec("times", "How often", ArgKind.integer, { required: false }),
      argSpec("loud", "Shout", ArgKind.boolean, { required: false }),
      argSpec("mood", "Mood", ArgKind.choice(["happy", "grumpy"]), { required: false }),
    ],
  });
}

function registerEcho(reg: CommandRegistry): void {
  reg.register(echoSpec(), (i) => {
    const text = i.str("text") ?? "";
    const times = i.int("times") ?? 1;
    let out = Array(Math.max(times, 0)).fill(text).join(" ");
    if (i.bool("loud") === true) out = out.toUpperCase();
    return CommandReply.public(out);
  });
}

const ok = () => CommandReply.public("");

describe("command registry", () => {
  it("dispatches_with_typed_args", async () => {
    const reg = registry();
    registerEcho(reg);
    const reply = await reg.dispatch(inv("echo", "5", { text: "hi", times: "2", loud: true }));
    expect(reply).toEqual(CommandReply.public("HI HI"));
  });

  it("rejects_bad_args", async () => {
    const reg = registry();
    registerEcho(reg);
    const cases: Record<string, ArgValue>[] = [
      {},
      { text: "a", times: "x" },
      { text: 3 },
      { text: "a", mood: "sad" },
      { text: "a", nope: true },
    ];
    for (const args of cases) {
      const reply = await reg.dispatch(inv("echo", "5", args));
      expect(replyEphemeral(false, reply), JSON.stringify(args)).toBe(true);
      expect(reply.text, JSON.stringify(args)).toContain("參數");
    }
  });

  it("unknown_command_and_denial", async () => {
    const reg = registry();
    reg.register(commandSpec("admin secret", "Secret", { permission: "admin.secret" }), () =>
      CommandReply.public("ok"),
    );
    const unknown = await reg.dispatch(inv("nope", "5"));
    expect(unknown.tone).toBe("warn");
    expect(unknown.text).toContain("nope");

    const denied = await reg.dispatch(inv("admin secret", "5"));
    expect(denied.tone).toBe("error");
    expect(denied.text).toBe("你沒有使用這個指令的權限。\n需要權限：admin.secret");

    const asAdmin = inv("admin secret", "5");
    asAdmin.invoker_is_guild_admin = true;
    expect((await reg.dispatch(asAdmin)).text).toBe("ok");
    expect((await reg.dispatch(inv("admin secret", "1"))).text).toBe("ok");
  });

  it("owner_only_denial_names_the_node", async () => {
    const reg = registry();
    reg.register(commandSpec("shutdown", "x", { permission: "owner.shutdown" }), ok);
    const denied = await reg.dispatch(inv("shutdown", "5"));
    expect(denied.text).toContain("owner.shutdown");
    expect(replyEphemeral(false, denied)).toBe(true);
  });

  it("normalizes_user_and_role_args", () => {
    const spec = commandSpec("x", "x", {
      args: [
        argSpec("user", "u", ArgKind.user),
        argSpec("role", "r", ArgKind.role, { required: false }),
      ],
    });
    for (const [raw, id] of [
      ["<@12>", "12"],
      ["<@!12>", "12"],
      [" 12 ", "12"],
      ["twitch:ab", "twitch:ab"],
    ] as const) {
      expect(normalizeArgs(spec, { user: raw }).user, raw).toBe(id);
    }
    expect(normalizeArgs(spec, { user: "1", role: "<@&34>" }).role).toBe("34");
    for (const [key, value] of [
      ["user", ""],
      ["user", "a b"],
      ["user", "<@&34>"],
      ["role", "<@34>"],
    ] as const) {
      expect(() => normalizeArgs(spec, { user: "1", [key]: value }), `${key}=${value}`).toThrow();
    }
  });

  it("invocation_helpers", () => {
    const i = inv("x", "5", { user: "7" });
    i.platform_roles = ["r1"];
    i.invoker_is_guild_admin = true;
    const me = i.subject();
    expect(me.platform_roles).toEqual(["r1"]);
    expect(me.is_guild_admin).toBe(true);
    expect(me.context).not.toBeNull();
    const target = i.account("user");
    expect(target).toEqual(parseAccount("discord:7"));
    expect(i.subjectFor(target as NonNullable<typeof target>).is_guild_admin).toBe(false);
    i.resolved_users["7"] = {
      display_name: "seven",
      platform_roles: ["r2"],
      is_guild_admin: true,
    };
    const other = i.subjectFor(target as NonNullable<typeof target>);
    expect(other.platform_roles).toEqual(["r2"]);
    expect(other.is_guild_admin).toBe(true);
    expect(i.subjectFor({ ...i.invoker })).toEqual(me);
    expect(i.account("missing")).toBeNull();
  });

  it("invocation_account_accepts_platform_prefixed_ids_and_new_defaults", () => {
    const base = Invocation.create("ping", parseAccount("discord:5"), inv("x", "5").context);
    expect(base).toMatchObject({
      path: ["ping"],
      args: {},
      invoker_display_name: "5",
      invoker_is_guild_admin: false,
      platform_roles: [],
      resolved_users: {},
    });
    base.withArg("who", "twitch:abc").withArg("n", 3).withArg("flag", false);
    expect(base.account("who")).toEqual({ platform: "twitch", id: "abc" });
    expect(base.int("n")).toBe(3);
    expect(base.bool("flag")).toBe(false);
    expect(base.str("n")).toBeNull();
    // Resolved details only apply to accounts of the context's platform.
    base.resolved_users.abc = { display_name: "x", platform_roles: ["r"], is_guild_admin: true };
    expect(base.subjectFor({ platform: "twitch", id: "abc" }).is_guild_admin).toBe(false);
  });

  it("handler_errors_propagate", async () => {
    const reg = registry();
    reg.register(commandSpec("fail", "Fails"), () => {
      throw new Error("broken");
    });
    await expect(reg.dispatch(inv("fail", "5"))).rejects.toThrow("broken");
    reg.register(commandSpec("fail-async", "Fails"), async () => {
      throw new Error("broken async");
    });
    await expect(reg.dispatch(inv("fail-async", "5"))).rejects.toThrow("broken async");
  });

  it("validates_specs_and_conflicts", () => {
    const reg = registry();
    expect(() => reg.register(commandSpec("Bad", "x"), ok)).toThrow("invalid name `Bad`");
    expect(() => reg.register(commandSpec("a b c d", "x"), ok)).toThrow("1 to 3 words");
    expect(() => reg.register(commandSpec("empty", " "), ok)).toThrow("description is empty");
    expect(() =>
      reg.register(
        commandSpec("dup", "x", {
          args: [argSpec("a", "a", ArgKind.string), argSpec("a", "a", ArgKind.string)],
        }),
        ok,
      ),
    ).toThrow("duplicate argument `a`");
    expect(() =>
      reg.register(
        commandSpec("nochoice", "x", { args: [argSpec("a", "a", ArgKind.choice([]))] }),
        ok,
      ),
    ).toThrow("has no choices");
    reg.register(commandSpec("admin module list", "x"), ok);
    expect(() => reg.register(commandSpec("admin module", "x"), ok)).toThrow(
      "command `admin module` conflicts with `admin module list`",
    );
    expect(() => reg.register(commandSpec("admin", "x"), ok)).toThrow(CommandError);
    reg.register(commandSpec("admin block", "x"), ok);
    // Replacing the same path is fine.
    reg.register(commandSpec("admin block", "y"), ok);
    expect(reg.specs()).toHaveLength(2);
    expect(reg.get(["admin", "block"])?.description).toBe("y");
  });

  it("version_changes_are_observable", async () => {
    const reg = registry();
    const sub = reg.subscribe();
    const before = reg.version();
    registerEcho(reg);
    const first = await sub.changed();
    expect(first).toBeGreaterThan(before);
    expect(reg.unregister("echo")).toBe(true);
    expect(reg.unregister("echo")).toBe(false);
    expect(await sub.changed()).toBeGreaterThan(first as number);
    expect(reg.specs()).toEqual([]);
    sub.close();
    expect(await sub.changed()).toBeNull();
  });

  it("subscription_waits_for_the_next_change_and_coalesces", async () => {
    const reg = registry();
    const sub = reg.subscribe();
    let seen: number | null = null;
    const waiting = sub.changed().then((v) => {
      seen = v;
    });
    await Promise.resolve();
    expect(seen).toBeNull();
    reg.setGroupDescription("admin", "管理指令");
    await waiting;
    expect(seen).toBe(1);
    // Two changes without a waiter are reported once.
    registerEcho(reg);
    reg.unregister("echo");
    expect(await sub.changed()).toBe(3);
    const controller = new AbortController();
    const aborted = reg.subscribe(controller.signal);
    const pending = aborted.changed();
    controller.abort();
    expect(await pending).toBeNull();
  });

  it("group_descriptions", () => {
    const reg = registry();
    reg.setGroupDescription("admin module", "管理模組");
    expect(reg.groupDescription(["admin", "module"])).toBe("管理模組");
    expect(reg.groupDescription("admin module")).toBe("管理模組");
    expect(reg.groupDescription("admin")).toBe("管理：模組、角色權限、她認識的人與資料");
    // No Manage Server gate: nodes decide what a member may do in `/admin`.
    expect(reg.groupInfo("admin")?.member_permission).toBeNull();
    expect(reg.groupDescription("nothing")).toBeUndefined();
  });

  it("specs_are_ordered_by_path_and_serialize_like_legacy", () => {
    const reg = registry();
    for (const path of ["ping", "admin x", "admin a b"]) reg.register(commandSpec(path, "x"), ok);
    expect(reg.specs().map((s) => s.path.join(" "))).toEqual(["admin a b", "admin x", "ping"]);
    expect(JSON.parse(JSON.stringify(echoSpec().args[3]))).toEqual({
      name: "mood",
      description: "Mood",
      kind: { type: "choice", choices: ["happy", "grumpy"] },
      required: false,
    });
    expect(JSON.stringify(ArgKind.user)).toBe('{"type":"user"}');
  });

  it("argument_coercion_edge_cases", () => {
    const spec = echoSpec();
    expect(normalizeArgs(spec, { text: "a", times: " +5 " }).times).toBe(5);
    expect(() => normalizeArgs(spec, { text: "a", times: "1.5" })).toThrow("「times」必須是整數");
    expect(() => normalizeArgs(spec, { text: "a", times: 1.5 })).toThrow("「times」的型別不正確");
    expect(normalizeArgs(spec, { text: "a", loud: " Yes " }).loud).toBe(true);
    expect(normalizeArgs(spec, { text: "a", loud: "OFF" }).loud).toBe(false);
    expect(() => normalizeArgs(spec, { text: "a", loud: "maybe" })).toThrow("必須是 true 或 false");
    expect(() => normalizeArgs(spec, { text: "a", mood: "sad" })).toThrow(
      "「mood」只能是 happy、grumpy 其中之一",
    );
    expect(() => normalizeArgs(spec, {})).toThrow("缺少「text」");
    expect(() => normalizeArgs(spec, { text: "a", zzz: 1, aaa: 2 })).toThrow(
      "「aaa」不是這個指令的參數",
    );
    expect(normalizeArgs(spec, { text: "a" })).toEqual({ text: "a" });
  });
});

class MemoryAudit implements AuditLog {
  readonly entries: AuditEntry[] = [];
  async append(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
  }
  async recent(): Promise<AuditEntry[]> {
    return this.entries;
  }
}

describe("command registry services", () => {
  it("uses_the_authorizer_preload_and_audits_admin_nodes", async () => {
    const services = new ServiceRegistry();
    const audit = new MemoryAudit();
    const preloaded: Subject[] = [];
    let loaded = false;
    const authorizer: Authorizer = {
      allows: () => false,
      allowsSubject: (_subject, node) => loaded && node === "admin.x",
    };
    services.provide("app", AuthorizerKey, authorizer);
    services.provide("app", AuditLogKey, audit);
    services.provide("app", AuthorizerPreloadKey, {
      async preload(subject) {
        preloaded.push(subject);
        loaded = true;
      },
    });
    const reg = registry().withServices(services);
    reg.register(
      commandSpec("admin x", "x", {
        permission: "admin.x",
        args: [argSpec("b", "b", ArgKind.integer)],
      }),
      ok,
    );
    reg.register(commandSpec("open", "x", { permission: "open" }), ok);

    const reply = await reg.dispatch(inv("admin x", "1", { b: "7" }));
    expect(reply.ephemeral).toBe(false);
    expect(preloaded).toHaveLength(1);
    expect(preloaded[0]?.account).toEqual(parseAccount("discord:1"));
    // `open` is not an admin node: not audited (and denied by this authorizer).
    expect((await reg.dispatch(inv("open", "1"))).tone).toBe("error");
    expect(audit.entries).toHaveLength(1);
    const [entry] = audit.entries;
    expect(entry).toMatchObject({
      actor: "discord:1",
      action: "admin x",
      target: "discord:dm:9",
      detail: { args: { b: 7 }, context: "discord:dm:9" },
      ok: true,
    });
    expect(entry?.id).toHaveLength(26);
    expect(Number.isNaN(Date.parse(entry?.at ?? ""))).toBe(false);
  });

  it("audits_failing_handlers_and_survives_audit_failures", async () => {
    const services = new ServiceRegistry();
    const audit = new MemoryAudit();
    services.provide("app", AuditLogKey, audit);
    const reg = registry().withServices(services);
    reg.register(commandSpec("admin boom", "x", { permission: "admin.boom" }), () => {
      throw new Error("kaput");
    });
    const asOwner = inv("admin boom", "1");
    await expect(reg.dispatch(asOwner)).rejects.toThrow("kaput");
    expect(audit.entries.map((e) => e.ok)).toEqual([false]);
    expect(audit.entries[0]?.detail).not.toHaveProperty("outcome");

    audit.append = async () => {
      throw new Error("disk full");
    };
    reg.register(commandSpec("admin fine", "x", { permission: "admin.fine" }), () =>
      CommandReply.public("fine"),
    );
    expect((await reg.dispatch(inv("admin fine", "1"))).text).toBe("fine");
  });
});
