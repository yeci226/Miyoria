// Context menu entries: the mapping to application commands, the sync, and the interaction.

import {
  CommandRegistry,
  commandSpec,
  MENU_FORGET,
  MENU_PERSON,
  MENU_REPLY,
  MENU_TEXT,
  type MenuSpec,
  notice,
  PanelSessions,
  Permissions,
  registerMenus,
} from "@miyoria/commands";
import { ServiceRegistry } from "@miyoria/kernel";
import { type MessageActionRequest, MessageActionsKey } from "@miyoria/types";
import { ApplicationCommandType, ComponentType, MessageFlags } from "discord.js";
import { describe, expect, test } from "vitest";
import {
  type ContextMenuInteractionLike,
  handleContextMenuInteraction,
  type InteractionEnv,
  invocationFromMenu,
  MENU_GONE_TEXT,
} from "../src/interaction.js";
import { toContextMenuCommands, validateCommand, validCommands } from "../src/slash.js";
import { currentCommands } from "../src/sync.js";

function menus(): MenuSpec[] {
  return [
    { id: "a", name: "要她回這則", target: "message", permission: "", ephemeral: true },
    { id: "b", name: "她對這個人的印象", target: "user", permission: "", ephemeral: true },
  ];
}

function setup() {
  const services = new ServiceRegistry();
  const requests: MessageActionRequest[] = [];
  services.provide("test", MessageActionsKey, {
    replyTo: async (r) => {
      requests.push(r);
      return { ok: true };
    },
    dontRemember: async (r) => {
      requests.push(r);
      return { ok: true };
    },
  });
  const registry = new CommandRegistry(Permissions.fromStrings(["discord:99"])).withServices(
    services,
  );
  registerMenus(registry, { services });
  return { registry, requests };
}

type Sent = { call: string; options?: Record<string, unknown> };

function interaction(overrides: Partial<ContextMenuInteractionLike> = {}) {
  const sent: Sent[] = [];
  const self = {
    user: { id: "42", username: "alice_w", globalName: "Alice" },
    guildId: "300" as string | null,
    channelId: "200",
    member: { nickname: "Ali", roles: ["70"], permissions: "0" } as unknown,
    replied: false,
    deferred: false,
    commandName: "要她回這則",
    commandType: ApplicationCommandType.Message,
    targetId: "900",
    targetMessage: { author: { id: "55", username: "bob" } },
    async reply(options: unknown) {
      sent.push({ call: "reply", options: options as Record<string, unknown> });
      self.replied = true;
      return { resource: { message: { id: "m1" } } };
    },
    async deferReply() {
      sent.push({ call: "deferReply" });
      self.deferred = true;
    },
    async editReply(options: unknown) {
      sent.push({ call: "editReply", options: options as Record<string, unknown> });
      return { id: "m1" };
    },
    async followUp(options: unknown) {
      sent.push({ call: "followUp", options: options as Record<string, unknown> });
      return { id: "f1" };
    },
    async deleteReply() {},
    ...overrides,
  } as unknown as ContextMenuInteractionLike;
  return { i: self, sent };
}

function textOf(options: Record<string, unknown> | undefined): string {
  const out: string[] = [];
  const walk = (c: unknown) => {
    if (typeof c !== "object" || c === null) return;
    const o = c as Record<string, unknown>;
    if (o.type === ComponentType.TextDisplay) out.push(String(o.content));
    if (Array.isArray(o.components)) for (const x of o.components) walk(x);
  };
  for (const c of (options?.components as unknown[]) ?? []) walk(c);
  return out.join("\n");
}

const env = (registry: CommandRegistry): InteractionEnv => ({
  registry,
  sessions: new PanelSessions(),
});

describe("context menu commands", () => {
  test("become_message_and_user_application_commands_for_servers_only", () => {
    const json = toContextMenuCommands(menus());
    expect(json).toEqual([
      expect.objectContaining({
        type: ApplicationCommandType.Message,
        name: "要她回這則",
        description: "",
        options: [],
        contexts: [0],
        integration_types: [0],
        default_member_permissions: null,
      }),
      expect.objectContaining({ type: ApplicationCommandType.User, name: "她對這個人的印象" }),
    ]);
    expect(validCommands(json)).toHaveLength(2);
  });

  test("a_menu_name_may_have_spaces_and_capitals_but_not_be_empty_or_long", () => {
    const [ok] = toContextMenuCommands([
      { id: "x", name: "Reply Here", target: "message", permission: "", ephemeral: true },
    ]);
    expect(ok && validateCommand(ok)).toEqual([]);
    for (const name of ["", "x".repeat(33)]) {
      const [bad] = toContextMenuCommands([
        { id: "x", name, target: "message", permission: "", ephemeral: true },
      ]);
      expect(bad && validateCommand(bad)).not.toEqual([]);
    }
  });

  test("a_menu_and_a_slash_command_may_share_a_name_but_two_menus_of_a_type_may_not", () => {
    const slash = {
      name: "ping",
      description: "x",
      options: [],
      default_member_permissions: null,
      contexts: [0],
      integration_types: [0],
    };
    const [menu] = toContextMenuCommands([
      { id: "x", name: "ping", target: "message", permission: "", ephemeral: true },
    ]);
    if (!menu) throw new Error("no menu");
    expect(validCommands([slash, menu])).toHaveLength(2);
    expect(validCommands([menu, menu])).toHaveLength(1);
  });

  test("the_sync_carries_menus_beside_the_slash_tree", () => {
    const { registry } = setup();
    const body = currentCommands(registry);
    expect(body.map((c) => [c.type, c.name])).toEqual([
      [ApplicationCommandType.Message, "不要記住這個"],
      [ApplicationCommandType.Message, "要她回這則"],
      [ApplicationCommandType.User, "她對這個人的印象"],
    ]);
  });
});

describe("invocationFromMenu", () => {
  test("a_message_menu_passes_the_message_and_its_author", () => {
    const { registry } = setup();
    const { i } = interaction();
    expect(invocationFromMenu(registry, i, "channel")).toEqual({
      path: ["menu", MENU_REPLY],
      args: { target: "900", author: "55" },
      invoker: { platform: "discord", id: "42" },
      invoker_display_name: "Ali",
      context: { platform: "discord", scope: "300", channel: "200", kind: "channel" },
      invoker_is_guild_admin: false,
      platform_roles: ["70"],
    });
    const noAuthor = interaction({ targetMessage: null }).i;
    expect(invocationFromMenu(registry, noAuthor, "channel")?.args).toEqual({ target: "900" });
  });

  test("a_user_menu_passes_the_person_with_their_roles", () => {
    const { registry } = setup();
    const { i } = interaction({
      commandName: "她對這個人的印象",
      commandType: ApplicationCommandType.User,
      targetId: "55",
      targetUser: { id: "55", username: "bob", globalName: "Bob" },
      targetMember: { nickname: "Bobby", roles: ["9"], permissions: "32" },
    });
    expect(invocationFromMenu(registry, i, "channel")).toMatchObject({
      path: ["menu", MENU_PERSON],
      args: { target: "55" },
      resolved_users: {
        "55": { display_name: "Bobby", platform_roles: ["9"], is_guild_admin: true },
      },
    });
  });

  test("an_unknown_name_or_the_wrong_type_finds_no_menu", () => {
    const { registry } = setup();
    expect(
      invocationFromMenu(registry, interaction({ commandName: "nope" }).i, "channel"),
    ).toBeNull();
    const wrong = interaction({ commandType: ApplicationCommandType.User }).i;
    expect(invocationFromMenu(registry, wrong, "channel")).toBeNull();
  });
});

describe("handleContextMenuInteraction", () => {
  test("runs_the_entry_and_answers_privately_with_a_neutral_notice", async () => {
    const { registry, requests } = setup();
    // The member needs `chat.talk`: the fallback roles give it to everyone not blocked.
    const { i, sent } = interaction();
    await handleContextMenuInteraction(env(registry), i, "channel");
    expect(requests).toEqual([
      {
        message: {
          context: { platform: "discord", scope: "300", channel: "200", kind: "channel" },
          id: "900",
        },
        author: { platform: "discord", id: "55" },
        requested_by: { platform: "discord", id: "42" },
      },
    ]);
    expect(sent.map((s) => s.call)).toEqual(["reply"]);
    expect(textOf(sent[0]?.options)).toBe(MENU_TEXT.replyAsked);
    expect(Number(sent[0]?.options?.flags) & MessageFlags.Ephemeral).toBeTruthy();
  });

  test("somebody_elses_message_is_refused_for_dont_remember", async () => {
    const { registry, requests } = setup();
    const { i, sent } = interaction({ commandName: "不要記住這個" });
    await handleContextMenuInteraction(env(registry), i, "channel");
    expect(requests).toEqual([]);
    expect(textOf(sent[0]?.options)).toBe(MENU_TEXT.forgetNotYours);
    expect(Number(sent[0]?.options?.flags) & MessageFlags.Ephemeral).toBeTruthy();
    expect(MENU_FORGET).toBe("dont-remember");
  });

  test("an_entry_that_is_gone_answers_with_a_notice", async () => {
    const { registry } = setup();
    const { i, sent } = interaction({ commandName: "removed" });
    await handleContextMenuInteraction(env(registry), i, "channel");
    expect(textOf(sent[0]?.options)).toBe(MENU_GONE_TEXT);
    expect(notice("warn", MENU_GONE_TEXT).tone).toBe("warn");
  });
});

describe("a crowded /me", () => {
  const ME = [
    "profile call link privacy wallet checkin feed give board screen goals pledge bounties",
    "quests draw album giveitem predictions bet titles commission commissions room shop",
    "memory show",
    "memory export",
    "memory forget",
  ]
    .join(" ")
    .split(" ");

  test("keeps_every_command_reachable_by_regrouping_the_surplus_instead_of_cutting_it", () => {
    const registry = new CommandRegistry(Permissions.fromStrings(["discord:99"]));
    // 26 subcommands once the panel's `i` is counted: one over Discord's limit.
    const paths: string[] = [];
    const words = ME.filter(
      (w) => w !== "memory" && w !== "show" && w !== "export" && w !== "forget",
    );
    for (const w of words) paths.push(`me ${w}`);
    for (const w of ["show", "export", "forget"]) paths.push(`me memory ${w}`);
    for (const path of paths) registry.register(commandSpecOf(path), () => notice("info", "x"));
    registry.registerPanel(commandSpecOf("me"), () => notice("info", "x"));
    const me = currentCommands(registry).find((c) => c.name === "me");
    const top = me?.options ?? [];
    expect(top.length).toBeLessThanOrEqual(25);
    const reachable = top.flatMap((o) =>
      o.options?.length && o.type === 2 ? o.options.map((s) => `${o.name} ${s.name}`) : [o.name],
    );
    for (const path of paths) {
      expect(reachable).toContain(registry.slashPath(path.split(" ")).slice(1).join(" "));
    }
    expect(reachable).toContain("wallet");
    expect(reachable).toContain("play quests");
    expect(reachable).toContain("i");
  });
});

function commandSpecOf(path: string) {
  return commandSpec(path, `desc of ${path}`);
}
