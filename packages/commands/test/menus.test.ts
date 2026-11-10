import { ServiceRegistry } from "@miyoria/kernel";
import {
  type MessageActionOutcome,
  type MessageActionRequest,
  type MessageActions,
  MessageActionsKey,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  CommandError,
  CommandRegistry,
  cardText,
  commandSpec,
  Invocation,
  MAX_MENUS_PER_TARGET,
  MENU_FORGET,
  MENU_PERSON,
  MENU_REPLY,
  MENU_TEXT,
  notice,
  Permissions,
  REPLY_COOLDOWN_MS,
  registerHelp,
  registerMenus,
  splitPath,
} from "../src/index.js";
import { guildContext } from "./helpers.js";

const OWNER = "1";
const MEMBER = "5";
const OTHER = "6";

class FakeActions implements MessageActions {
  replies: MessageActionRequest[] = [];
  forgets: MessageActionRequest[] = [];
  outcome: MessageActionOutcome = { ok: true };
  fail = false;

  async replyTo(request: MessageActionRequest): Promise<MessageActionOutcome> {
    this.replies.push(request);
    if (this.fail) throw new Error("boom");
    return this.outcome;
  }

  async dontRemember(request: MessageActionRequest): Promise<MessageActionOutcome> {
    this.forgets.push(request);
    return this.outcome;
  }
}

function setup(withActions = true, now: () => number = () => 0) {
  const services = new ServiceRegistry();
  const actions = new FakeActions();
  if (withActions) services.provide("test", MessageActionsKey, actions);
  const registry = new CommandRegistry(Permissions.fromStrings([`discord:${OWNER}`])).withServices(
    services,
  );
  registerMenus(registry, { services, now });
  return { registry, actions, services };
}

/** What the Discord adapter builds for a message menu. */
function onMessage(id: string, who: string, args: Record<string, string>): Invocation {
  return new Invocation({
    path: ["menu", id],
    args,
    invoker: { platform: "discord", id: who },
    invoker_display_name: "someone",
    context: guildContext,
    invoker_is_guild_admin: false,
  });
}

const text = (reply: { card?: unknown; text: string }) => reply.text;

describe("context menus", () => {
  it("registers_two_message_menus_and_one_user_menu", () => {
    const { registry } = setup();
    expect(registry.menus().map((m) => [m.target, m.name, m.id])).toEqual([
      ["message", "不要記住這個", MENU_FORGET],
      ["message", "要她回這則", MENU_REPLY],
      ["user", "她對這個人的印象", MENU_PERSON],
    ]);
    expect(registry.menuByName("message", "要她回這則")?.id).toBe(MENU_REPLY);
    expect(registry.menuByName("user", "要她回這則")).toBeUndefined();
  });

  it("menus_stay_out_of_the_slash_tree_and_the_command_list", () => {
    const { registry } = setup();
    expect(registry.specs().some((s) => s.path[0] === "menu")).toBe(false);
    expect(registry.slashSpecs().some((s) => s.path[0] === "menu")).toBe(false);
  });

  it("no_command_may_take_the_reserved_root", () => {
    const { registry } = setup();
    expect(() => registry.register(commandSpec("menu x", "x"), () => notice("info", "x"))).toThrow(
      CommandError,
    );
  });

  it("at_most_five_menus_per_target_and_names_are_unique_and_short", () => {
    const { registry } = setup();
    const add = (id: string, name: string) =>
      registry.registerMenu({ id, name, target: "message", permission: "", ephemeral: true }, () =>
        notice("info", "x"),
      );
    for (let i = 0; i < MAX_MENUS_PER_TARGET - 2; i++) add(`m${i}`, `menu ${i}`);
    expect(() => add("extra", "one too many")).toThrow(/at most/);
    expect(() => add("m0", "要她回這則")).toThrow(/taken/);
    expect(() => add("m0", "x".repeat(33))).toThrow(/1 to 32/);
    // Replacing an entry is not adding one.
    expect(() => add("m0", "renamed")).not.toThrow();
    expect(registry.unregisterMenu("m0")).toBe(true);
    expect(registry.unregisterMenu("m0")).toBe(false);
  });

  it("reply_here_asks_the_provider_with_the_message_its_author_and_the_asker", async () => {
    const { registry, actions } = setup();
    const reply = await registry.dispatch(
      onMessage(MENU_REPLY, MEMBER, { target: "900", author: OTHER }).withArg("target", "900"),
    );
    expect(reply.tone).toBe("success");
    expect(text(reply)).toBe(MENU_TEXT.replyAsked);
    expect(actions.replies).toEqual([
      {
        message: { context: guildContext, id: "900" },
        author: { platform: "discord", id: OTHER },
        requested_by: { platform: "discord", id: MEMBER },
      },
    ]);
    expect(registry.get(["menu", MENU_REPLY])?.ephemeral).toBe(true);
  });

  it("reply_here_without_a_provider_says_it_is_unavailable", async () => {
    const { registry } = setup(false);
    const reply = await registry.dispatch(onMessage(MENU_REPLY, MEMBER, { target: "900" }));
    expect(text(reply)).toBe(MENU_TEXT.unavailable);
  });

  it("reply_here_waits_between_requests_of_one_person", async () => {
    let at = 1_000;
    const { registry, actions } = setup(true, () => at);
    const ask = (who: string) => registry.dispatch(onMessage(MENU_REPLY, who, { target: "900" }));
    expect((await ask(MEMBER)).tone).toBe("success");
    expect((await ask(MEMBER)).tone).toBe("warn");
    expect((await ask(OTHER)).tone).toBe("success");
    at += REPLY_COOLDOWN_MS;
    expect((await ask(MEMBER)).tone).toBe("success");
    expect(actions.replies).toHaveLength(3);
  });

  it("a_refusal_or_a_failing_provider_gives_a_neutral_notice", async () => {
    const { registry, actions } = setup();
    actions.outcome = { ok: false, reason: "她現在不在這個頻道。" };
    const refused = await registry.dispatch(onMessage(MENU_REPLY, MEMBER, { target: "900" }));
    expect(refused.tone).toBe("warn");
    expect(text(refused)).toBe("她現在不在這個頻道。");
    actions.fail = true;
    const failed = await registry.dispatch(onMessage(MENU_REPLY, OTHER, { target: "900" }));
    expect(failed.tone).toBe("error");
    expect(text(failed)).toBe(MENU_TEXT.failed);
  });

  it("a_missing_message_id_is_refused_by_the_argument_check", async () => {
    const { registry } = setup();
    const reply = await registry.dispatch(onMessage(MENU_REPLY, MEMBER, {}));
    expect(reply.tone).toBe("warn");
  });

  it("dont_remember_is_for_the_author_or_for_people_with_the_node", async () => {
    const { registry, actions } = setup();
    const ask = (who: string, author: Record<string, string>) =>
      registry.dispatch(onMessage(MENU_FORGET, who, { target: "900", ...author }));
    // Their own message.
    expect((await ask(MEMBER, { author: MEMBER })).tone).toBe("success");
    // Someone else's, or one whose author is unknown: refused for a member.
    const notYours = await ask(MEMBER, { author: OTHER });
    expect(notYours.tone).toBe("warn");
    expect(text(notYours)).toBe(MENU_TEXT.forgetNotYours);
    expect((await ask(MEMBER, {})).tone).toBe("warn");
    // The owner may.
    expect((await ask(OWNER, { author: OTHER })).tone).toBe("success");
    expect(actions.forgets.map((r) => r.requested_by.id)).toEqual([MEMBER, OWNER]);
    expect(actions.forgets[0]?.message).toEqual({ context: guildContext, id: "900" });
  });

  it("her_view_runs_admin_person_show_under_its_own_permission", async () => {
    const { registry } = setup();
    const seen: (string | null)[] = [];
    registry.register(
      commandSpec("admin person show", "x", {
        args: [{ name: "user", description: "who", kind: { type: "user" }, required: true }],
        permission: "admin.person.show",
        ephemeral: true,
      }),
      (i) => {
        seen.push(i.str("user"));
        return notice("info", "印象");
      },
    );
    const click = (who: string) =>
      registry.dispatch(
        new Invocation({
          path: ["menu", MENU_PERSON],
          args: { target: `<@${OTHER}>` },
          invoker: { platform: "discord", id: who },
          invoker_display_name: "someone",
          context: guildContext,
          invoker_is_guild_admin: false,
          resolved_users: {
            [OTHER]: { display_name: "x", platform_roles: [], is_guild_admin: false },
          },
        }),
      );
    expect(text(await click(OWNER))).toContain("印象");
    expect(seen).toEqual([OTHER]);
    const refused = await click(MEMBER);
    expect(refused.tone).toBe("error");
    expect(seen).toHaveLength(1);
  });
});

describe("regrouped slash paths", () => {
  function withEconomy() {
    const registry = new CommandRegistry(Permissions.fromStrings([`discord:${OWNER}`]));
    const calls: string[][] = [];
    for (const path of ["me wallet", "me quests", "me shop"]) {
      registry.register(commandSpec(path, `${path} desc`), (i) => {
        calls.push(i.path);
        return notice("info", i.path.join(" "));
      });
    }
    return { registry, calls };
  }

  it("discord_shows_the_economy_commands_under_me_play", () => {
    const { registry } = withEconomy();
    expect(registry.slashSpecs().map((s) => s.path.join(" "))).toEqual([
      "me play quests",
      "me play shop",
      "me wallet",
    ]);
    // The real paths are untouched.
    expect(registry.specs().map((s) => s.path.join(" "))).toEqual([
      "me quests",
      "me shop",
      "me wallet",
    ]);
    expect(registry.slashPath(splitPath("me quests"))).toEqual(["me", "play", "quests"]);
    expect(registry.slashPath(splitPath("me wallet"))).toEqual(["me", "wallet"]);
  });

  it("both_paths_run_the_same_command_as_the_real_one", async () => {
    const { registry, calls } = withEconomy();
    const run = (path: string) =>
      registry.dispatch(
        new Invocation({
          path: splitPath(path),
          args: {},
          invoker: { platform: "discord", id: OWNER },
          invoker_display_name: "o",
          context: guildContext,
          invoker_is_guild_admin: false,
        }),
      );
    await run("me play quests");
    await run("me quests");
    expect(calls).toEqual([
      ["me", "quests"],
      ["me", "quests"],
    ]);
    expect(registry.get(["me", "play", "shop"])?.path).toEqual(["me", "shop"]);
  });

  it("visibility_overrides_keep_using_the_real_path", () => {
    const { registry } = withEconomy();
    registry.setVisibility({ "me quests": "private" });
    expect(registry.get(["me", "play", "quests"])?.ephemeral).toBe(true);
    expect(registry.slashSpecs().find((s) => s.path[2] === "quests")?.ephemeral).toBe(true);
  });

  it("help_lists_the_path_people_type", async () => {
    const { registry } = withEconomy();
    registerHelp(registry);
    const reply = await registry.dispatch(
      new Invocation({
        path: ["help"],
        args: {},
        invoker: { platform: "discord", id: OWNER },
        invoker_display_name: "o",
        context: guildContext,
        invoker_is_guild_admin: false,
      }),
    );
    expect(reply.card).toBeDefined();
    const route = registry.routes().find((r) => r === "help:category") as string;
    const outcome = await registry.dispatchComponent({
      custom_id: "mi:help:category",
      values: ["me"],
      fields: {},
      message_id: "1",
      session: { initiator: { platform: "discord", id: OWNER }, initiator_only: false, data: null },
      invoker: { platform: "discord", id: OWNER },
      invoker_display_name: "o",
      context: guildContext,
      invoker_is_guild_admin: false,
    });
    expect(route).toBe("help:category");
    const page = outcome?.result.type === "update" ? outcome.result.reply : null;
    const body = page === null ? "" : cardText(page.card as never);
    expect(body).toContain("`/me play quests`");
    expect(body).toContain("`/me wallet`");
    expect(body).not.toContain("`/me quests`");
  });
});
