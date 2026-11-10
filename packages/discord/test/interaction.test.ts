import {
  ArgKind,
  type ArgSpec,
  argSpec,
  CommandRegistry,
  CommandReply,
  ComponentResult,
  type ComponentRoute,
  cardReply,
  commandSpec,
  componentId,
  type Invocation,
  notice,
  PanelSessions,
  Permissions,
  registerPanels,
} from "@miyoria/commands";
import { ApplicationCommandOptionType, ComponentType, MessageFlags } from "discord.js";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  type AutocompleteInteractionLike,
  type CommandInteractionLike,
  type ComponentInteractionLike,
  DEFER_AFTER_MS,
  HANDLER_FAILED_TEXT,
  handleAutocomplete,
  handleCommandInteraction,
  handleComponentInteraction,
  type InteractionEnv,
  invocationFromInteraction,
} from "../src/interaction.js";

afterEach(() => {
  vi.useRealTimers();
});

type Call =
  | "reply"
  | "deferReply"
  | "editReply"
  | "followUp"
  | "deleteReply"
  | "update"
  | "deferUpdate"
  | "showModal"
  | "webhookEdit";

interface Sent {
  call: Call;
  options?: Record<string, unknown>;
}

function base(sent: Sent[], prefix = "m") {
  let n = 0;
  const push = (call: Call, options?: unknown) =>
    sent.push({ call, options: options as Record<string, unknown> | undefined });
  const self = {
    user: { id: "42", username: "alice_w", globalName: "Alice" },
    guildId: "300" as string | null,
    channelId: "200",
    member: { nickname: "Ali", roles: ["70", "71"], permissions: "8" } as unknown,
    replied: false,
    deferred: false,
    async reply(options: unknown) {
      push("reply", options);
      self.replied = true;
      n += 1;
      return { resource: { message: { id: `${prefix}${n}` } } };
    },
    async deferReply(options: unknown) {
      push("deferReply", options);
      self.deferred = true;
    },
    async editReply(options: unknown) {
      push("editReply", options);
      return { id: "m-edited" };
    },
    async followUp(options: unknown) {
      push("followUp", options);
      n += 1;
      return { id: `f${n}` };
    },
    async deleteReply() {
      push("deleteReply");
    },
    webhook: {
      async editMessage(message: string, options: unknown) {
        push("webhookEdit", { message, ...(options as object) });
      },
    },
  };
  return self;
}

function command(overrides: Partial<CommandInteractionLike> = {}) {
  const sent: Sent[] = [];
  const i = Object.assign(base(sent), {
    commandName: "ping",
    options: { data: [] },
    ...overrides,
  }) as CommandInteractionLike;
  return { i, sent };
}

function component(
  customId: string,
  overrides: Partial<ComponentInteractionLike> = {},
  idPrefix = "m",
) {
  const sent: Sent[] = [];
  const b = base(sent, idPrefix);
  const i = Object.assign(b, {
    customId,
    message: { id: "panel", flags: { has: (f: number) => f === MessageFlags.Ephemeral } },
    async update(options: unknown) {
      sent.push({ call: "update", options: options as Record<string, unknown> });
      b.replied = true;
      return { resource: { message: { id: "panel" } } };
    },
    async deferUpdate() {
      sent.push({ call: "deferUpdate" });
      b.deferred = true;
    },
    async showModal(modal: unknown) {
      sent.push({ call: "showModal", options: modal as Record<string, unknown> });
    },
    ...overrides,
  }) as ComponentInteractionLike;
  return { i, sent };
}

function env(registry: CommandRegistry, sessions = new PanelSessions()): InteractionEnv {
  return { registry, sessions };
}

function registryWith(
  path: string,
  handler: (inv: Invocation) => CommandReply | Promise<CommandReply>,
  options: { ephemeral?: boolean; args?: ArgSpec[]; components?: ComponentRoute[] } = {},
): CommandRegistry {
  const registry = new CommandRegistry(Permissions.fromStrings(["discord:42"]));
  const { components, ...spec } = options;
  registry.register(commandSpec(path, "test", spec), handler, {
    components: components as never,
  });
  return registry;
}

/** All text displays of a rendered payload, joined. */
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

const isEphemeral = (options: Record<string, unknown> | undefined) =>
  ((Number(options?.flags) || 0) & MessageFlags.Ephemeral) !== 0;

describe("invocationFromInteraction", () => {
  test("maps_the_interaction_to_an_invocation", () => {
    const { i } = command({
      commandName: "admin",
      options: {
        data: [
          {
            name: "role",
            type: ApplicationCommandOptionType.SubcommandGroup,
            options: [
              {
                name: "assign",
                type: ApplicationCommandOptionType.Subcommand,
                options: [
                  { name: "user", type: ApplicationCommandOptionType.User, value: "5" },
                  { name: "role", type: ApplicationCommandOptionType.String, value: "moderator" },
                ],
              },
            ],
          },
        ],
        resolved: {
          users: new Map([["5", { id: "5", username: "eve", globalName: "Eve" }]]),
          members: new Map([["5", { nick: "Evie", roles: ["9"], permissions: "32" }]]),
        },
      },
    });
    expect(invocationFromInteraction(i, "channel")).toEqual({
      path: ["admin", "role", "assign"],
      args: { user: "5", role: "moderator" },
      invoker: { platform: "discord", id: "42" },
      invoker_display_name: "Ali",
      context: { platform: "discord", scope: "300", channel: "200", kind: "channel" },
      invoker_is_guild_admin: true,
      platform_roles: ["70", "71"],
      resolved_users: {
        "5": { display_name: "Evie", platform_roles: ["9"], is_guild_admin: true },
      },
    });
  });

  test("dm_invocations_have_no_guild_details", () => {
    const { i } = command({ guildId: null, member: null });
    const inv = invocationFromInteraction(i, "dm");
    expect(inv.context).toEqual({ platform: "discord", scope: null, channel: "200", kind: "dm" });
    expect(inv.invoker_is_guild_admin).toBe(false);
    expect(inv.platform_roles).toEqual([]);
    expect(inv.invoker_display_name).toBe("Alice");
  });
});

describe("handleCommandInteraction", () => {
  test("replies_are_components_v2_without_embeds_or_content", async () => {
    const registry = registryWith("ping", () => CommandReply.text("pong"));
    const { i, sent } = command();
    await handleCommandInteraction(env(registry), i, "channel");
    expect(sent.map((s) => s.call)).toEqual(["reply"]);
    const options = sent[0]?.options ?? {};
    expect(textOf(options)).toBe("pong");
    expect(Number(options.flags) & MessageFlags.IsComponentsV2).toBeTruthy();
    expect(isEphemeral(options)).toBe(false);
    expect(options).not.toHaveProperty("embeds");
    expect(options).not.toHaveProperty("content");
    expect(options.allowedMentions).toEqual({ parse: [] });
  });

  test("visibility_follows_the_declaration_and_errors_are_ephemeral", async () => {
    const registry = registryWith("me", () => CommandReply.public("only you"), {
      ephemeral: true,
    });
    const { i, sent } = command({ commandName: "me" });
    await handleCommandInteraction(env(registry), i, "channel");
    expect(isEphemeral(sent[0]?.options)).toBe(true);

    const publicCommand = registryWith("queue", () => notice("warn", "沒有人在排隊。"));
    const second = command({ commandName: "queue" });
    await handleCommandInteraction(env(publicCommand), second.i, "channel");
    expect(isEphemeral(second.sent[0]?.options)).toBe(true);
  });

  test("slow_commands_are_deferred_with_the_declared_visibility_and_edited", async () => {
    vi.useFakeTimers();
    let release: (r: CommandReply) => void = () => undefined;
    const registry = registryWith(
      "slow",
      () =>
        new Promise<CommandReply>((resolve) => {
          release = resolve;
        }),
      { ephemeral: true },
    );
    const { i, sent } = command({ commandName: "slow" });
    const done = handleCommandInteraction(env(registry), i, "channel");
    await vi.advanceTimersByTimeAsync(DEFER_AFTER_MS + 1);
    expect(sent.map((s) => s.call)).toEqual(["deferReply"]);
    expect(sent[0]?.options?.flags).toBe(MessageFlags.Ephemeral);
    release(CommandReply.text("done"));
    await done;
    expect(sent.map((s) => s.call)).toEqual(["deferReply", "editReply"]);
    expect(textOf(sent[1]?.options)).toBe("done");
    // Edits never carry the ephemeral flag (it cannot change after the defer).
    expect(isEphemeral(sent[1]?.options)).toBe(false);
  });

  test("a_slow_public_command_that_fails_answers_ephemerally_and_drops_the_placeholder", async () => {
    vi.useFakeTimers();
    let release: (r: CommandReply) => void = () => undefined;
    const registry = registryWith(
      "slow",
      () =>
        new Promise<CommandReply>((resolve) => {
          release = resolve;
        }),
    );
    const { i, sent } = command({ commandName: "slow" });
    const done = handleCommandInteraction(env(registry), i, "channel");
    await vi.advanceTimersByTimeAsync(DEFER_AFTER_MS + 1);
    release(notice("error", "無法加入語音頻道。", "timeout"));
    await done;
    expect(sent.map((s) => s.call)).toEqual(["deferReply", "followUp", "deleteReply"]);
    expect(isEphemeral(sent[1]?.options)).toBe(true);
    expect(textOf(sent[1]?.options)).toBe("無法加入語音頻道。\n-# timeout");
  });

  test("long_plain_text_is_split_into_followups", async () => {
    const registry = registryWith("long", () => CommandReply.text("x".repeat(9000)));
    const { i, sent } = command({ commandName: "long" });
    await handleCommandInteraction(env(registry), i, "channel");
    expect(sent.map((s) => s.call)).toEqual(["reply", "followUp", "followUp"]);
  });

  test("handler_failures_become_an_ephemeral_error_notice_with_the_raw_error_muted", async () => {
    const registry = registryWith("boom", () => {
      throw new Error("kaput");
    });
    const { i, sent } = command({ commandName: "boom" });
    await handleCommandInteraction(env(registry), i, "channel");
    expect(isEphemeral(sent[0]?.options)).toBe(true);
    expect(textOf(sent[0]?.options)).toBe(`${HANDLER_FAILED_TEXT}\n-# kaput`);
  });

  test("unknown_commands_get_the_registry_notice", async () => {
    const { i, sent } = command({ commandName: "nope" });
    await handleCommandInteraction(env(new CommandRegistry()), i, "channel");
    expect(textOf(sent[0]?.options)).toBe("找不到指令「/nope」。");
  });

  test("response_failures_are_swallowed", async () => {
    const registry = registryWith("ping", () => CommandReply.text("pong"));
    const { i } = command({
      reply: async () => {
        throw new Error("Unknown interaction");
      },
    });
    await expect(handleCommandInteraction(env(registry), i, "channel")).resolves.toBeUndefined();
  });

  test("follow_ups_and_files", async () => {
    const registry = registryWith("export", async (inv) => {
      await inv.followUp(CommandReply.text("backup first"));
      return cardReply([{ type: "text", text: "done" }], {
        files: [{ name: "memories.json", data: "[]" }],
      });
    });
    const { i, sent } = command({ commandName: "export" });
    await handleCommandInteraction(env(registry), i, "channel");
    expect(sent.map((s) => s.call)).toEqual(["deferReply", "followUp", "editReply"]);
    const files = sent[2]?.options?.files as { name: string; attachment: Buffer }[];
    expect(files[0]?.name).toBe("memories.json");
    expect(files[0]?.attachment.toString()).toBe("[]");
    // The file is shown by a file component.
    expect(JSON.stringify(sent[2]?.options?.components)).toContain("attachment://memories.json");
  });

  test("arguments_and_user_details_reach_the_handler", async () => {
    let seen: Invocation | undefined;
    const registry = registryWith(
      "echo",
      (inv) => {
        seen = inv;
        return CommandReply.text(`${inv.str("text")} ${inv.int("n")} ${inv.account("who")?.id}`);
      },
      {
        args: [
          argSpec("text", "t", ArgKind.string),
          argSpec("n", "n", ArgKind.integer),
          argSpec("who", "w", ArgKind.user),
        ],
      },
    );
    const { i, sent } = command({
      commandName: "echo",
      options: {
        data: [
          { name: "text", type: ApplicationCommandOptionType.String, value: "hi" },
          { name: "n", type: ApplicationCommandOptionType.Integer, value: 3 },
          { name: "who", type: ApplicationCommandOptionType.User, value: "5" },
        ],
      },
    });
    await handleCommandInteraction(env(registry), i, "channel");
    expect(textOf(sent[0]?.options)).toBe("hi 3 5");
    expect(seen?.invoker_is_guild_admin).toBe(true);
    expect(seen?.platform_roles).toEqual(["70", "71"]);
  });

  test("panels_get_a_session_and_are_disabled_when_it_expires", async () => {
    vi.useFakeTimers();
    const sessions = new PanelSessions();
    const registry = registryWith("help", () =>
      cardReply([{ type: "buttons", buttons: [{ id: componentId("help:x"), label: "x" }] }], {
        session: { ttlMs: 5_000 },
      }),
    );
    const { i, sent } = command({ commandName: "help" });
    await handleCommandInteraction(env(registry, sessions), i, "channel");
    expect(sessions.get("m1")?.initiator).toEqual({ platform: "discord", id: "42" });
    await vi.advanceTimersByTimeAsync(5_001);
    const edit = sent.find((s) => s.call === "webhookEdit");
    expect(edit?.options?.message).toBe("m1");
    expect(JSON.stringify(edit?.options?.components)).toContain('"disabled":true');
    expect(sessions.get("m1")).toBeNull();
  });
});

describe("handleComponentInteraction", () => {
  function queueRegistry(calls: string[]) {
    return registryWith("queue list", () => CommandReply.text("list"), {
      components: [
        {
          route: "queue:next",
          permission: "queue.manage",
          handle: () => {
            calls.push("next");
            return ComponentResult.update(CommandReply.text("updated list"));
          },
        },
        {
          route: "queue:ask",
          handle: () =>
            ComponentResult.modal({
              id: componentId("queue:answer"),
              title: "Add",
              fields: [{ id: "text", label: "Text" }],
            }),
        },
        {
          route: "queue:answer",
          handle: (inv) => ComponentResult.reply(CommandReply.text(`got ${inv.field("text")}`)),
        },
        {
          route: "queue:boom",
          handle: () => {
            throw new Error("kaput");
          },
        },
      ] as ComponentRoute[],
    });
  }

  test("updates_edit_the_message_the_control_is_on", async () => {
    const calls: string[] = [];
    const { i, sent } = component("mi:queue:next");
    await handleComponentInteraction(env(queueRegistry(calls)), i, "channel");
    expect(calls).toEqual(["next"]);
    expect(sent.map((s) => s.call)).toEqual(["update"]);
    expect(textOf(sent[0]?.options)).toBe("updated list");
  });

  test("refusals_never_overwrite_the_message", async () => {
    const calls: string[] = [];
    const { i, sent } = component("mi:queue:next", { user: { id: "7", username: "bob" } });
    i.member = null;
    await handleComponentInteraction(env(queueRegistry(calls)), i, "channel");
    expect(calls).toEqual([]);
    expect(sent.map((s) => s.call)).toEqual(["reply"]);
    expect(isEphemeral(sent[0]?.options)).toBe(true);
    expect(textOf(sent[0]?.options)).toContain("queue.manage");
  });

  test("slow_handlers_defer_the_update_and_errors_follow_up_ephemerally", async () => {
    const calls: string[] = [];
    const { i, sent } = component("mi:queue:boom");
    await handleComponentInteraction(env(queueRegistry(calls)), i, "channel");
    expect(sent.map((s) => s.call)).toEqual(["reply"]);
    expect(isEphemeral(sent[0]?.options)).toBe(true);
    expect(textOf(sent[0]?.options)).toContain("kaput");

    vi.useFakeTimers();
    let release: () => void = () => undefined;
    const slow = registryWith("x", () => CommandReply.text("x"), {
      components: [
        {
          route: "x:slow",
          handle: () =>
            new Promise<ComponentResult>((resolve) => {
              release = () => resolve(ComponentResult.update(CommandReply.text("later")));
            }),
        },
      ] as ComponentRoute[],
    });
    const second = component("mi:x:slow");
    const done = handleComponentInteraction(env(slow), second.i, "channel");
    await vi.advanceTimersByTimeAsync(DEFER_AFTER_MS + 1);
    release();
    await done;
    expect(second.sent.map((s) => s.call)).toEqual(["deferUpdate", "editReply"]);
  });

  test("modals_open_and_submissions_are_routed_with_their_fields", async () => {
    const calls: string[] = [];
    const registry = queueRegistry(calls);
    const ask = component("mi:queue:ask");
    await handleComponentInteraction(env(registry), ask.i, "channel");
    expect(ask.sent[0]?.call).toBe("showModal");
    expect(ask.sent[0]?.options?.custom_id).toBe("mi:queue:answer");

    const submit = component("mi:queue:answer", {
      fields: { fields: new Map([["text", { customId: "text", value: " hi " }]]) },
      showModal: undefined,
    });
    await handleComponentInteraction(env(registry), submit.i, "channel");
    expect(submit.sent.map((s) => s.call)).toEqual(["reply"]);
    expect(textOf(submit.sent[0]?.options)).toBe("got hi");
  });

  test("ids_from_others_are_ignored", async () => {
    const { i, sent } = component("collector:next");
    await handleComponentInteraction(env(queueRegistry([])), i, "channel");
    expect(sent).toEqual([]);
  });

  test("an_update_keeps_the_panel_session_or_ends_it_when_no_controls_are_left", async () => {
    vi.useFakeTimers();
    const sessions = new PanelSessions();
    sessions.open("panel", { platform: "discord", id: "42" }, { ttlMs: 5_000 }, () => undefined);
    const registry = registryWith("help", () => CommandReply.text("x"), {
      components: [
        {
          route: "help:page",
          handle: () =>
            ComponentResult.update(
              cardReply([
                { type: "buttons", buttons: [{ id: componentId("help:page"), label: "p" }] },
              ]),
            ),
        },
        {
          route: "help:done",
          handle: () => ComponentResult.update(notice("success", "已完成。")),
        },
      ] as ComponentRoute[],
    });
    const page = component("mi:help:page");
    await handleComponentInteraction(env(registry, sessions), page.i, "channel");
    // Still the initiator's panel, now disabling the new controls on expiry.
    expect(sessions.get("panel")?.initiator).toEqual({ platform: "discord", id: "42" });
    const done = component("mi:help:done");
    await handleComponentInteraction(env(registry, sessions), done.i, "channel");
    expect(sessions.get("panel")).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    // The finished card is never overwritten by an expiry.
    expect([...page.sent, ...done.sent].some((s) => s.call === "webhookEdit")).toBe(false);
  });

  test("only_the_initiator_may_use_a_panel", async () => {
    const sessions = new PanelSessions();
    sessions.open("panel", { platform: "discord", id: "42" }, {}, () => undefined);
    const registry = registryWith("help", () => CommandReply.text("x"), {
      components: [
        { route: "help:x", handle: () => ComponentResult.update(CommandReply.text("ok")) },
      ] as ComponentRoute[],
    });
    const other = component("mi:help:x", { user: { id: "7", username: "bob" } });
    await handleComponentInteraction(env(registry, sessions), other.i, "channel");
    expect(textOf(other.sent[0]?.options)).toBe("只有執行指令的人可以操作這個面板。");
    const mine = component("mi:help:x");
    await handleComponentInteraction(env(registry, sessions), mine.i, "channel");
    expect(mine.sent[0]?.call).toBe("update");
    sessions.closeAll();
  });
});

describe("handleAutocomplete", () => {
  test("answers_with_the_registry_suggestions_or_nothing", async () => {
    const registry = new CommandRegistry(Permissions.fromStrings(["discord:42"]));
    registry.register(
      commandSpec("stream scene", "x", {
        args: [argSpec("name", "n", ArgKind.string)],
        permission: "stream.scene",
      }),
      () => CommandReply.text("x"),
      { autocomplete: { name: (_i, v) => [{ name: `${v}!`, value: v }] } },
    );
    const answered: unknown[] = [];
    const i: AutocompleteInteractionLike = {
      commandName: "stream",
      user: { id: "42", username: "a" },
      guildId: "300",
      channelId: "200",
      member: null,
      responded: false,
      options: {
        data: [
          {
            name: "scene",
            type: ApplicationCommandOptionType.Subcommand,
            options: [{ name: "name", type: ApplicationCommandOptionType.String, value: "Ma" }],
          },
        ],
        getFocused: () => ({ name: "name", value: "Ma" }),
      },
      respond: async (choices) => {
        answered.push(choices);
      },
    };
    await handleAutocomplete(env(registry), i, "channel");
    expect(answered).toEqual([[{ name: "Ma!", value: "Ma" }]]);
    // Someone without the node gets nothing.
    await handleAutocomplete(env(registry), { ...i, user: { id: "7", username: "b" } }, "channel");
    expect(answered[1]).toEqual([]);
  });
});

describe("panels through the interaction layer", () => {
  function panelEnv() {
    const registry = new CommandRegistry(Permissions.fromStrings(["discord:1"]));
    const calls: string[] = [];
    // `voice leave` needs an owner node; `voice join` is for everyone.
    registry.register(commandSpec("voice join", "j", { permission: "voice.join" }), (inv) => {
      calls.push(`join by ${inv.invoker.id}`);
      return notice("success", "已加入");
    });
    registry.register(
      commandSpec("voice leave", "l", { permission: "owner.voice.leave" }),
      (inv) => {
        calls.push(`leave by ${inv.invoker.id}`);
        return notice("success", "已離開");
      },
    );
    registry.register(
      commandSpec("voice consent", "c", {
        args: [argSpec("state", "s", ArgKind.choice(["on", "off"]), { required: false })],
        permission: "voice.consent",
        ephemeral: true,
      }),
      (inv) => {
        calls.push(`consent ${inv.str("state")}`);
        return notice("success", "已更新");
      },
    );
    registry.register(commandSpec("me privacy", "p", { permission: "me.privacy" }), () =>
      notice("info", "設定"),
    );
    registerPanels(registry);
    const sessions = new PanelSessions();
    return { registry, sessions, calls };
  }

  const flagsOf = (s: Sent | undefined) => (s?.options?.flags ?? 0) as number;

  const sub = (name: string) => [
    { name, type: ApplicationCommandOptionType.Subcommand, options: [] as never[] },
  ];

  test("a_panel_opens_ephemeral_with_controls_and_a_session", async () => {
    const { registry, sessions } = panelEnv();
    const { i, sent } = command({ commandName: "me", options: { data: sub("i") } });
    await handleCommandInteraction({ registry, sessions }, i, "channel");
    expect(sent.map((s) => s.call)).toEqual(["reply"]);
    expect(flagsOf(sent[0]) & MessageFlags.Ephemeral).toBeTruthy();
    expect(flagsOf(sent[0]) & MessageFlags.IsComponentsV2).toBeTruthy();
    expect(sessions.size).toBe(1);
    const json = JSON.stringify(sent[0]?.options);
    expect(json).toContain("mi:me:do:home:consent-on:-");
    // No embed, only Components V2.
    expect(sent[0]?.options).not.toHaveProperty("embeds");
    sessions.closeAll();
  });

  test("a_button_updates_the_panel_in_place_and_runs_the_command", async () => {
    const { registry, sessions, calls } = panelEnv();
    const opened = command({ commandName: "me", options: { data: sub("i") } });
    await handleCommandInteraction({ registry, sessions }, opened.i, "channel");
    // The panel message is the one the platform tracked.
    const panelId = "m1";
    const { i, sent } = component("mi:me:do:home:consent-on:-", {
      message: { id: panelId, flags: { has: (f: number) => f === MessageFlags.Ephemeral } },
    });
    await handleComponentInteraction({ registry, sessions }, i, "channel");
    expect(calls).toEqual(["consent on"]);
    expect(sent.map((s) => s.call)).toEqual(["update"]);
    expect(JSON.stringify(sent[0]?.options)).toContain("已更新");
    sessions.closeAll();
  });

  const OWNER = { id: "1", username: "owner" };
  const publicMessage = (id: string) => ({ id, flags: { has: () => false } });

  test("a_public_panel_opens_in_the_channel_and_anyone_may_press_it", async () => {
    const { registry, sessions } = panelEnv();
    const opened = command({ commandName: "miyo", user: OWNER });
    await handleCommandInteraction({ registry, sessions }, opened.i, "channel");
    expect(flagsOf(opened.sent[0]) & MessageFlags.Ephemeral).toBeFalsy();
    expect(sessions.get("m1")).toMatchObject({
      initiator: { platform: "discord", id: "1" },
      initiator_only: false,
    });
    // The bare `/miyo` is the panel; `/me` alone is not (it has subcommands).
    const bare = command({ commandName: "me" });
    await handleCommandInteraction({ registry, sessions }, bare.i, "channel");
    expect(flagsOf(bare.sent[0]) & MessageFlags.Ephemeral).toBeTruthy();
    expect(JSON.stringify(bare.sent[0]?.options)).not.toContain("我的面板");
    sessions.closeAll();
  });

  test("a_press_by_someone_else_runs_as_them_with_their_own_rights", async () => {
    const { registry, sessions, calls } = panelEnv();
    const opened = command({ commandName: "miyo", user: OWNER });
    await handleCommandInteraction({ registry, sessions }, opened.i, "channel");
    const shared = publicMessage("m1");
    // The owner turns to the voice page: the shared message is edited in place.
    const mine = component("mi:miyo:page:-:-", {
      user: OWNER,
      values: ["voice"],
      message: shared,
    });
    await handleComponentInteraction({ registry, sessions }, mine.i, "channel");
    expect(mine.sent.map((s) => s.call)).toEqual(["update"]);
    // Someone else turning the page gets a private copy; the shared message is untouched.
    const theirs = component(
      "mi:miyo:page:-:-",
      { user: { id: "42", username: "alice_w" }, values: ["voice"], message: shared },
      "copy",
    );
    await handleComponentInteraction({ registry, sessions }, theirs.i, "channel");
    expect(theirs.sent.map((s) => s.call)).toEqual(["reply"]);
    expect(flagsOf(theirs.sent[0]) & MessageFlags.Ephemeral).toBeTruthy();
    expect(sessions.get("copy1")).toMatchObject({
      initiator: { platform: "discord", id: "42" },
      initiator_only: true,
    });
    expect(sessions.get("m1")).toMatchObject({ initiator: { id: "1" }, initiator_only: false });
    // The owner's admin control: the owner runs it, a member is refused privately.
    const leave = "mi:miyo:pdo:voice:leave:-";
    const refused = component(leave, { user: { id: "42", username: "alice_w" }, message: shared });
    await handleComponentInteraction({ registry, sessions }, refused.i, "channel");
    expect(calls).toEqual([]);
    expect(refused.sent.map((s) => s.call)).toEqual(["reply"]);
    expect(flagsOf(refused.sent[0]) & MessageFlags.Ephemeral).toBeTruthy();
    const allowed = component(leave, { user: OWNER, message: shared });
    await handleComponentInteraction({ registry, sessions }, allowed.i, "channel");
    expect(calls).toEqual(["leave by 1"]);
    expect(flagsOf(allowed.sent[0]) & MessageFlags.Ephemeral).toBeFalsy();
    // A member's own press of a control they may use runs as the member.
    const join = component("mi:miyo:pdo:voice:join:-", {
      user: { id: "42", username: "alice_w" },
      message: shared,
    });
    await handleComponentInteraction({ registry, sessions }, join.i, "channel");
    expect(calls).toEqual(["leave by 1", "join by 42"]);
    expect(flagsOf(join.sent[0]) & MessageFlags.Ephemeral).toBeFalsy();
    sessions.closeAll();
  });

  test("a_stale_or_foreign_panel_runs_nothing", async () => {
    const { registry, sessions, calls } = panelEnv();
    const { i, sent } = component("mi:me:do:home:consent-on:-");
    await handleComponentInteraction({ registry, sessions }, i, "channel");
    expect(calls).toEqual([]);
    expect(sent.map((s) => s.call)).toEqual(["reply"]);
    expect(flagsOf(sent[0]) & MessageFlags.Ephemeral).toBeTruthy();
  });
});
