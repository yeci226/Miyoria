import {
  configureLogging,
  defineManifest,
  EventBus,
  type Module,
  type ModuleContext,
  ServiceRegistry,
  Supervisor,
  SupervisorKey,
} from "@miyoria/kernel";
import { type AuditEntry, type AuditLog, AuditLogKey } from "@miyoria/store";
import { type Authorizer, AuthorizerKey, type ModuleStateKind } from "@miyoria/types";
import { describe, expect, it, vi } from "vitest";
import {
  type CardBlock,
  CommandMount,
  type CommandRegistry,
  CommandRegistryKey,
  CommandReply,
  CommandsConfigSchema,
  CommandsModule,
  type ComponentInvocationData,
  commandSpec,
  formatModuleList,
  parseAccount,
  replyEphemeral,
} from "../src/index.js";
import { guildContext, inv } from "./helpers.js";

class Dummy implements Module {
  readonly manifest = defineManifest("dummy", "Dummy");

  async start(ctx: ModuleContext): Promise<void> {
    ctx.spawn(
      "idle",
      (signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve())),
    );
  }
}

/** A module that registers one command once at its start, through `CommandMount`. */
class Registers implements Module {
  readonly manifest = defineManifest("registers", "Registers", { optional: ["commands"] });
  readonly mount = new CommandMount(
    "registers",
    (registry) => registry.register(commandSpec("game status", "x"), () => CommandReply.text("ok")),
    (registry) => {
      registry.unregister("game status");
    },
  );

  async start(ctx: ModuleContext): Promise<void> {
    this.mount.attach(ctx);
  }

  async stop(): Promise<void> {
    this.mount.detach();
  }
}

async function boot(
  config: Record<string, unknown> = {},
): Promise<{ sup: Supervisor; reg: CommandRegistry }> {
  const services = new ServiceRegistry();
  const sup = new Supervisor({ bus: new EventBus(), services });
  services.provide("app", SupervisorKey, sup);
  await sup.register(new CommandsModule(), { owners: ["discord:1"], ...config }, true);
  await sup.register(new Dummy(), null, true);
  await sup.startAll();
  return { sup, reg: services.require(CommandRegistryKey) };
}

function state(sup: Supervisor, id: string): ModuleStateKind | undefined {
  return sup.list().find((s) => s.id === id)?.state;
}

const inGuild = (path: string, invoker: string, args: Record<string, string> = {}) =>
  inv(path, invoker, args, guildContext);

function click(customId: string, invoker: string, extra: Partial<ComponentInvocationData> = {}) {
  const base = inGuild("x", invoker);
  return {
    custom_id: customId,
    invoker: base.invoker,
    invoker_display_name: base.invoker_display_name,
    context: base.context,
    invoker_is_guild_admin: false,
    ...extra,
  } satisfies ComponentInvocationData;
}

function ids(blocks: readonly CardBlock[] | undefined): string[] {
  const out: string[] = [];
  for (const b of blocks ?? []) {
    if (b.type === "section") out.push(b.button.id);
    if (b.type === "buttons") out.push(...b.buttons.map((x) => x.id));
    if (b.type === "select") out.push(b.select.id);
  }
  return out;
}

describe("commands module", () => {
  it("builtins_are_registered", async () => {
    const { sup, reg } = await boot();
    expect(reg.specs().map((s) => s.path.join(" "))).toEqual([
      "admin module disable",
      "admin module enable",
      "admin module list",
      "admin module restart",
      "help",
      "me card",
      "me fortune",
    ]);
    expect(reg.groupDescription("admin module")).toBe("管理模組");
    expect(reg.get(["admin", "module", "enable"])?.args[0]?.autocomplete).toBe(true);
    const auth = sup.services.require(AuthorizerKey);
    expect(auth.allows(parseAccount("discord:1"), "admin.x")).toBe(true);
    expect(auth.allows(parseAccount("discord:5"), "admin.x")).toBe(false);
    await sup.stopAll();
    expect(sup.services.get(AuthorizerKey)).toBeUndefined();
  });

  it("help_lists_only_permitted_commands_by_category", async () => {
    const { sup, reg } = await boot();
    reg.register(commandSpec("voice join", "讓她加入語音", { permission: "voice.join" }), () =>
      CommandReply.text("ok"),
    );
    const help = await reg.dispatch(inGuild("help", "5"));
    // `/help` answers the channel (a warning or error would still be ephemeral).
    expect(replyEphemeral(reg.get(["help"])?.ephemeral ?? true, help)).toBe(false);
    expect(help.text).toContain("/voice");
    expect(help.text).not.toContain("/admin");
    const forOwner = await reg.dispatch(inGuild("help", "1"));
    expect(forOwner.text).toContain("/admin");
    // Picking a category shows its commands.
    const page = await reg.dispatchComponent(click("mi:help:category", "5", { values: ["voice"] }));
    expect(page?.result.type).toBe("update");
    if (page?.result.type === "update") expect(page.result.reply.text).toContain("/voice join");
    await sup.stopAll();
  });

  it("help_names_the_panels_by_their_interactive_subcommand", async () => {
    const { sup, reg } = await boot();
    reg.register(commandSpec("me profile", "看她對你的印象"), () => CommandReply.text("ok"));
    const member = await reg.dispatch(inGuild("help", "5"));
    expect(member.text).toContain("/miyo");
    expect(member.text).toContain("/song");
    expect(member.text).toContain("/me");
    const me = await reg.dispatchComponent(click("mi:help:category", "5", { values: ["me"] }));
    const text = me?.result.type === "update" ? me.result.reply.text : "";
    // `i` leads the list, and a member does not see `/admin i`.
    expect(text.indexOf("/me i")).toBeGreaterThan(-1);
    expect(text.indexOf("/me i")).toBeLessThan(text.indexOf("/me profile"));
    expect(member.text).not.toContain("/admin");
    const owner = await reg.dispatchComponent(
      click("mi:help:category", "1", { values: ["admin"] }),
    );
    const adminText = owner?.result.type === "update" ? owner.result.reply.text : "";
    expect(adminText.indexOf("/admin i")).toBeGreaterThan(-1);
    expect(adminText.indexOf("/admin i")).toBeLessThan(adminText.indexOf("/admin module"));
    await sup.stopAll();
  });

  it("visibility_comes_from_the_config", async () => {
    expect(CommandsConfigSchema.parse({}).visibility).toEqual({});
    expect(() => CommandsConfigSchema.parse({ visibility: { "me wallet": "hidden" } })).toThrow();
    const { sup, reg } = await boot({
      visibility: { help: "private", "admin module list": "public" },
    });
    expect(reg.get(["help"])?.ephemeral).toBe(true);
    expect(reg.get(["admin", "module", "list"])?.ephemeral).toBe(false);
    // Untouched commands keep their declaration.
    expect(reg.get(["admin", "module", "enable"])?.ephemeral).toBe(true);
    expect(reg.get(["admin", "i"])?.ephemeral).toBe(true);
    expect(reg.get(["miyo"])?.ephemeral).toBe(false);
    await sup.stopAll();
  });

  it("unknown_visibility_paths_are_warned_about_once_the_registry_is_quiet", async () => {
    const lines: string[] = [];
    configureLogging({
      level: "warn",
      destination: { write: (line: string) => void lines.push(line) },
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let sup: Supervisor | undefined;
    try {
      ({ sup } = await boot({ visibility: { "me wallett": "private", help: "private" } }));
      await vi.advanceTimersByTimeAsync(12_000);
    } finally {
      vi.useRealTimers();
      configureLogging({ level: "silent" });
    }
    const warned = lines.filter((l) => l.includes("modules.commands.visibility"));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("me wallett");
    expect(warned[0]).not.toContain('"help"');
    await sup?.stopAll();
  });

  it("admin_module_commands", async () => {
    const { sup, reg } = await boot();

    const denied = await reg.dispatch(inGuild("admin module disable", "5", { id: "dummy" }));
    expect(denied.tone).toBe("error");
    expect(denied.text).toContain("權限");
    expect(state(sup, "dummy")).toBe("running");

    const list = await reg.dispatch(inGuild("admin module list", "1"));
    expect(reg.get(["admin", "module", "list"])?.ephemeral).toBe(true);
    expect(list.text).toContain("`dummy` Dummy　執行中");
    expect(ids(list.card?.blocks)).toContain("mi:admin:module:restart:dummy:0");

    // Disabling asks first (a red confirm card), then disables on confirm.
    const asked = await reg.dispatch(inGuild("admin module disable", "1", { id: "dummy" }));
    expect(asked.card?.accent).toBe("danger");
    expect(state(sup, "dummy")).toBe("running");
    const confirmId = ids(asked.card?.blocks)[0] as string;
    expect(confirmId).toBe("mi:admin:module:confirm-disable:dummy:-");
    // Someone without the node cannot confirm it.
    const sneaky = await reg.dispatchComponent(click(confirmId, "5"));
    expect(sneaky?.result.type).toBe("reply");
    expect(state(sup, "dummy")).toBe("running");
    const done = await reg.dispatchComponent(click(confirmId, "1"));
    expect(done?.result.type).toBe("update");
    expect(state(sup, "dummy")).toBe("disabled");

    const admin = inGuild("admin module enable", "5", { id: "dummy" });
    admin.invoker_is_guild_admin = true;
    const enabled = await reg.dispatch(admin);
    expect(enabled.text).toBe("已啟用模組 `dummy`。");
    expect(state(sup, "dummy")).toBe("running");

    // The list's restart button restarts and refreshes the list in place.
    const restarted = await reg.dispatchComponent(click("mi:admin:module:restart:dummy:0", "1"));
    expect(restarted?.result.type).toBe("update");
    expect(state(sup, "dummy")).toBe("running");

    const unknown = await reg.dispatch(inGuild("admin module enable", "1", { id: "ghost" }));
    expect(unknown.tone).toBe("error");
    expect(unknown.text).toContain("unknown module `ghost`");

    const protectedModule = await reg.dispatch(
      inGuild("admin module disable", "1", { id: "commands" }),
    );
    expect(protectedModule.text).toContain("CLI");
    expect(state(sup, "commands")).toBe("running");

    const missingArg = await reg.dispatch(inGuild("admin module enable", "1"));
    expect(missingArg.text).toContain("缺少「id」");

    const suggestions = await reg.autocomplete(inGuild("admin module restart", "1"), "id", "dum");
    expect(suggestions).toEqual([{ name: "dummy（執行中）", value: "dummy" }]);
    expect(await reg.autocomplete(inGuild("admin module restart", "5"), "id", "")).toEqual([]);
    await sup.stopAll();
  });

  it("restarting_commands_keeps_the_registry_and_everyones_commands", async () => {
    const services = new ServiceRegistry();
    const sup = new Supervisor({ bus: new EventBus(), services });
    services.provide("app", SupervisorKey, sup);
    const registers = new Registers();
    await sup.register(new CommandsModule(), { owners: ["discord:1"] }, true);
    await sup.register(registers, null, true);
    await sup.startAll();
    const reg = services.require(CommandRegistryKey);
    expect(reg.get(["game", "status"])).toBeDefined();
    await reg.dispatch(inGuild("admin module restart", "1", { id: "commands" }));
    const after = services.require(CommandRegistryKey);
    expect(after).toBe(reg);
    expect(after.get(["game", "status"])).toBeDefined();
    expect(after.get(["help"])).toBeDefined();
    // Disabled, then enabled again: the mount is still in the same registry.
    await sup.disable("commands");
    await sup.enable("commands");
    expect(services.require(CommandRegistryKey).get(["game", "status"])).toBeDefined();
    expect(registers.mount.registry).toBe(reg);
    await sup.stopAll();
    expect(reg.get(["game", "status"])).toBeUndefined();
  });

  it("uses_the_authorizer_service_and_audits", async () => {
    const services = new ServiceRegistry();
    const audit: AuditEntry[] = [];
    const log: AuditLog = {
      append: async (entry) => {
        audit.push(entry);
      },
      recent: async () => audit,
    };
    // Allows only `help` and `admin.module.list`, and only in guild `10` with role `r1`.
    const guildOnly: Authorizer = {
      allows: () => false,
      allowsSubject: (subject, node) =>
        subject.context?.scope === "10" &&
        subject.platform_roles.length === 1 &&
        subject.platform_roles[0] === "r1" &&
        (node === "help" || node === "admin.module.list"),
    };
    services.provide("app", AuthorizerKey, guildOnly);
    services.provide("app", AuditLogKey, log);
    const sup = new Supervisor({ bus: new EventBus(), services });
    await sup.register(new CommandsModule(), { owners: ["discord:1"] }, true);
    await sup.startAll();
    const reg = services.require(CommandRegistryKey);

    // The owner is denied: the service decides, not the fallback.
    const denied = await reg.dispatch(inGuild("admin module list", "1"));
    expect(denied.text).toContain("權限");
    const withRole = inGuild("admin module list", "5");
    withRole.platform_roles = ["r1"];
    const listed = await reg.dispatch(withRole);
    // Reached the handler (no supervisor in this test).
    expect(listed.text).toContain("supervisor");
    const help = inGuild("help", "5");
    help.platform_roles = ["r1"];
    expect((await reg.dispatch(help)).text).toContain("/admin");

    // Only admin nodes are audited, denials too.
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({
      action: "admin module list",
      actor: "discord:1",
      ok: false,
      detail: { outcome: "denied" },
    });
    expect(audit[1]).toMatchObject({ actor: "discord:5", ok: true });
    // The app's authorizer was kept.
    expect(services.require(AuthorizerKey).allows(parseAccount("discord:1"), "x")).toBe(false);
    await sup.stopAll();
  });

  it("owners_come_from_the_config_and_the_app", async () => {
    const services = new ServiceRegistry();
    const sup = new Supervisor({ bus: new EventBus(), services });
    await sup.register(
      new CommandsModule({ owners: ["discord:9"] }),
      { owners: ["discord:1"] },
      true,
    );
    await sup.startAll();
    const perms = services.require(CommandRegistryKey).permissions();
    expect(perms.isOwner(parseAccount("discord:1"))).toBe(true);
    expect(perms.isOwner(parseAccount("discord:9"))).toBe(true);
    await sup.stopAll();
  });

  it("rejects_bad_owner_config", async () => {
    const bus = new EventBus();
    const states = bus.subscribe("system.module.state");
    const sup = new Supervisor({ bus, services: new ServiceRegistry() });
    await sup.register(new CommandsModule(), { owners: ["123"] }, true);
    await sup.startAll();
    for (;;) {
      const env = await states.recv();
      if (env?.event.type === "module_state_changed" && env.event.data.state === "failed") {
        expect(env.event.data.reason).toContain("invalid account `123`");
        break;
      }
    }
    expect(CommandsConfigSchema.parse({}).owners).toEqual([]);
    await sup.stopAll();
  });

  it("fallback_authorizer_returns_after_the_auth_module_stops", async () => {
    const services = new ServiceRegistry();
    const sup = new Supervisor({ bus: new EventBus(), services });
    // Stand-in for the `auth` module: provides an Authorizer while running.
    const auth: Authorizer = { allows: () => true, allowsSubject: () => true };
    class FakeAuth implements Module {
      readonly manifest = defineManifest("auth", "Auth");
      async start(ctx: ModuleContext): Promise<void> {
        ctx.provide(AuthorizerKey, auth);
      }
    }
    await sup.register(new CommandsModule(), { owners: ["discord:1"] }, true);
    await sup.register(new FakeAuth(), null, true);
    await sup.startAll();
    // Whoever provided last wins; after `auth` stops, the fallback must be back.
    await sup.disable("auth");
    const fallback = services.require(AuthorizerKey);
    expect(fallback).not.toBe(auth);
    expect(fallback.allows(parseAccount("discord:1"), "owner.x")).toBe(true);
    expect(fallback.allows(parseAccount("discord:2"), "owner.x")).toBe(false);
    await sup.stopAll();
  });

  it("format_module_list", () => {
    expect(formatModuleList([])).toBe("目前沒有任何模組。");
    expect(
      formatModuleList([
        {
          id: "llm",
          name: "LLM",
          description: "",
          enabled: true,
          state: "failed",
          reason: "boom",
          recent_restarts: 2,
        },
      ]),
    ).toBe("模組狀態：\n`llm` LLM：失敗，最近重啟 2 次（boom）");
  });
});
