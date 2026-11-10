import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ArgKind,
  argSpec,
  CommandError,
  CommandRegistry,
  CommandReply,
  type ComponentInvocationData,
  ComponentResult,
  cardReply,
  commandSpec,
  componentId,
  componentSegments,
  confirm,
  defineRoute,
  intParam,
  notice,
  PanelSessions,
  Permissions,
  pageButtons,
  pageOf,
  replyEphemeral,
} from "../src/index.js";
import { guildContext, inv } from "./helpers.js";

function registry(): CommandRegistry {
  return new CommandRegistry(Permissions.fromStrings(["discord:1"]));
}

function click(customId: string, invoker: string, extra: Partial<ComponentInvocationData> = {}) {
  return {
    custom_id: customId,
    invoker: { platform: "discord", id: invoker },
    invoker_display_name: invoker,
    context: guildContext,
    invoker_is_guild_admin: false,
    ...extra,
  } satisfies ComponentInvocationData;
}

const ok = () => CommandReply.text("ok");

afterEach(() => {
  vi.useRealTimers();
});

describe("component ids", () => {
  it("builds_and_splits_ids", () => {
    expect(componentId("queue:skip", 12, "x")).toBe("mi:queue:skip:12:x");
    expect(componentSegments("mi:queue:skip:12")).toEqual(["queue", "skip", "12"]);
    expect(componentSegments("other:queue")).toBeNull();
    expect(componentSegments("mi")).toBeNull();
    expect(() => componentId("queue", "a:b")).toThrow(CommandError);
    expect(() => componentId("bad route")).toThrow(CommandError);
    expect(() => componentId("x", "y".repeat(100))).toThrow("longer than 100");
    expect(intParam("12")).toBe(12);
    expect(intParam("-1")).toBeNull();
    expect(intParam(undefined)).toBeNull();
  });
});

describe("component router", () => {
  it("routes_by_the_longest_registered_prefix_with_typed_params", async () => {
    const reg = registry();
    const seen: string[] = [];
    reg.register(commandSpec("queue list", "x", { permission: "queue.list" }), ok, {
      components: [
        { route: "queue", handle: () => ComponentResult.update(CommandReply.text("short")) },
        defineRoute<number>({
          route: "queue:skip",
          parse: (p) => intParam(p[0]),
          handle: (_inv, id) => {
            seen.push(`skip ${id + 1}`);
            return ComponentResult.update(CommandReply.text("skipped"));
          },
        }),
      ],
    });
    const out = await reg.dispatchComponent(click("mi:queue:skip:41", "5"));
    expect(out?.result).toEqual({ type: "update", reply: { text: "skipped" } });
    expect(seen).toEqual(["skip 42"]);
    const fallback = await reg.dispatchComponent(click("mi:queue:other", "5"));
    expect(fallback?.result).toEqual({ type: "update", reply: { text: "short" } });
    // A parameter that does not parse is refused.
    const bad = await reg.dispatchComponent(click("mi:queue:skip:abc", "5"));
    expect(bad?.ephemeral).toBe(true);
    expect(bad?.result.type === "reply" && bad.result.reply.tone).toBe("error");
    // Not one of ours: left alone.
    expect(await reg.dispatchComponent(click("collector:1", "5"))).toBeNull();
    // Unknown route (e.g. the command is gone): a warning.
    const stale = await reg.dispatchComponent(click("mi:nothing:here", "5"));
    expect(stale?.result.type === "reply" && stale.result.reply.text).toBe(
      "這個控制項已失效，請重新執行指令。",
    );
  });

  it("enforces_the_owning_commands_permission_and_the_routes_own_node", async () => {
    const reg = registry();
    let changed = 0;
    reg.register(commandSpec("channel mode", "x", { permission: "channel.mode.view" }), ok, {
      components: [
        {
          route: "channel:mode:set",
          permission: "admin.channel.mode",
          handle: () => {
            changed++;
            return ComponentResult.update(CommandReply.text("set"));
          },
        },
      ],
    });
    reg.register(commandSpec("admin x", "x", { permission: "admin.x" }), ok, {
      components: [{ route: "admin:x", handle: () => ComponentResult.update(ok()) }],
    });
    const user = await reg.dispatchComponent(click("mi:channel:mode:set", "5"));
    expect(user?.result.type === "reply" && user.result.reply.text).toContain("admin.channel.mode");
    expect(changed).toBe(0);
    const owner = await reg.dispatchComponent(click("mi:channel:mode:set", "1"));
    expect(owner?.result.type).toBe("update");
    expect(changed).toBe(1);
    const admin = await reg.dispatchComponent(click("mi:admin:x", "5"));
    expect(admin?.result.type === "reply" && admin.result.reply.text).toContain("admin.x");
    const asGuildAdmin = await reg.dispatchComponent(
      click("mi:admin:x", "5", { invoker_is_guild_admin: true }),
    );
    expect(asGuildAdmin?.result.type).toBe("update");
  });

  it("checks_the_session_initiator_expiry_and_require", async () => {
    const reg = registry();
    reg.register(commandSpec("me profile", "x"), ok, {
      components: [
        { route: "me:profile", requiresSession: true, handle: () => ComponentResult.update(ok()) },
        defineRoute<string>({
          route: "me:own",
          parse: (p) => p[0] ?? null,
          require: (owner, i) => owner === i.invoker.id,
          handle: () => ComponentResult.update(ok()),
        }),
      ],
    });
    const session = {
      initiator: { platform: "discord", id: "7" },
      initiator_only: true,
      data: null,
    };
    const expired = await reg.dispatchComponent(click("mi:me:profile", "7"));
    expect(expired?.result.type === "reply" && expired.result.reply.text).toBe(
      "這個面板已過期，請重新執行指令。",
    );
    const other = await reg.dispatchComponent(click("mi:me:profile", "8", { session }));
    expect(other?.result.type === "reply" && other.result.reply.text).toBe(
      "只有執行指令的人可以操作這個面板。",
    );
    const mine = await reg.dispatchComponent(click("mi:me:profile", "7", { session }));
    expect(mine?.result.type).toBe("update");
    const refused = await reg.dispatchComponent(click("mi:me:own:7", "8"));
    expect(refused?.result.type === "reply" && refused.result.reply.text).toBe(
      "你不能進行這個操作。",
    );
    expect((await reg.dispatchComponent(click("mi:me:own:8", "8")))?.result.type).toBe("update");
  });

  it("reply_visibility_follows_the_command_the_route_and_the_tone", async () => {
    const reg = registry();
    reg.register(commandSpec("queue list", "x"), ok, {
      components: [
        {
          route: "queue:announce",
          ephemeral: false,
          handle: () => ComponentResult.reply(CommandReply.text("輪到 #1")),
        },
        {
          route: "queue:oops",
          ephemeral: false,
          handle: () => ComponentResult.reply(notice("warn", "沒有人在排隊。")),
        },
        // No `ephemeral`: the command is public, so the answer is too.
        { route: "queue:mine", handle: () => ComponentResult.reply(CommandReply.text("x")) },
        {
          route: "queue:quiet",
          ephemeral: true,
          handle: () => ComponentResult.reply(CommandReply.text("x")),
        },
      ],
    });
    expect((await reg.dispatchComponent(click("mi:queue:announce", "5")))?.ephemeral).toBe(false);
    expect((await reg.dispatchComponent(click("mi:queue:oops", "5")))?.ephemeral).toBe(true);
    expect((await reg.dispatchComponent(click("mi:queue:mine", "5")))?.ephemeral).toBe(false);
    expect((await reg.dispatchComponent(click("mi:queue:quiet", "5")))?.ephemeral).toBe(true);
  });

  it("a_private_command_keeps_its_answers_private_whatever_the_route_says", async () => {
    const reg = registry();
    reg.register(commandSpec("me profile", "x", { ephemeral: true }), ok, {
      components: [
        {
          route: "me:show",
          ephemeral: false,
          handle: () => ComponentResult.reply(CommandReply.text("x")),
        },
        { route: "me:plain", handle: () => ComponentResult.reply(CommandReply.text("x")) },
      ],
    });
    expect((await reg.dispatchComponent(click("mi:me:show", "5")))?.ephemeral).toBe(true);
    expect((await reg.dispatchComponent(click("mi:me:plain", "5")))?.ephemeral).toBe(true);
    // The configuration can open it up, or close a public command.
    reg.setVisibility({ "me profile": "public" });
    expect((await reg.dispatchComponent(click("mi:me:plain", "5")))?.ephemeral).toBe(false);
    reg.setVisibility({ me: "private" });
    expect((await reg.dispatchComponent(click("mi:me:show", "5")))?.ephemeral).toBe(true);
  });

  it("duplicate_routes_fail_at_registration_and_routes_go_with_their_command", () => {
    const reg = registry();
    const route = { route: "dup:x", handle: () => ComponentResult.update(ok()) };
    reg.register(commandSpec("a", "x"), ok, { components: [route] });
    const other = { route: "dup:y", handle: () => ComponentResult.update(ok()) };
    expect(() => reg.register(commandSpec("b", "x"), ok, { components: [route] })).toThrow(
      "component route `dup:x` of `b` is already used by `a`",
    );
    expect(() => reg.register(commandSpec("c", "x"), ok, { components: [other, other] })).toThrow(
      "twice",
    );
    expect(reg.get(["b"])).toBeUndefined();
    // Re-registering the same command may keep its route.
    reg.register(commandSpec("a", "y"), ok, { components: [route] });
    expect(reg.routes()).toEqual(["dup:x"]);
    reg.unregister("a");
    expect(reg.routes()).toEqual([]);
    reg.register(commandSpec("b", "x"), ok, { components: [route] });
    expect(reg.routes()).toEqual(["dup:x"]);
  });

  it("autocomplete_needs_a_string_argument_and_the_permission", async () => {
    const reg = registry();
    expect(() =>
      reg.register(
        commandSpec("stream scene", "x", { args: [argSpec("n", "n", ArgKind.integer)] }),
        ok,
        { autocomplete: { n: () => [] } },
      ),
    ).toThrow("autocomplete needs a string argument");
    reg.register(
      commandSpec("stream scene", "x", {
        args: [argSpec("name", "n", ArgKind.string)],
        permission: "stream.scene",
      }),
      ok,
      {
        autocomplete: {
          name: (_i, value) =>
            ["Main", "BRB", "Ending"]
              .filter((s) => s.toLowerCase().startsWith(value.toLowerCase()))
              .map((s) => ({ name: s, value: s })),
        },
      },
    );
    expect(reg.get(["stream", "scene"])?.args[0]?.autocomplete).toBe(true);
    const owner = inv("stream scene", "1", {}, guildContext);
    expect(await reg.autocomplete(owner, "name", "b")).toEqual([{ name: "BRB", value: "BRB" }]);
    expect(await reg.autocomplete(inv("stream scene", "5", {}, guildContext), "name", "")).toEqual(
      [],
    );
    expect(await reg.autocomplete(owner, "other", "")).toEqual([]);
  });

  it("invocations_can_check_extra_nodes_and_follow_up", async () => {
    const reg = registry();
    const sent: string[] = [];
    reg.register(
      commandSpec("admin person tag", "x", { permission: "admin.person.tag" }),
      async (i) => {
        const owner = await i.allowed("owner.person.tag");
        if (i.canFollowUp()) await i.followUp(CommandReply.text("backup"));
        return CommandReply.text(owner ? "owner" : "admin");
      },
    );
    const asOwner = await reg.dispatch(inv("admin person tag", "1", {}, guildContext), {
      followUp: async (r) => {
        sent.push(r.text);
      },
    });
    expect(asOwner.text).toBe("owner");
    expect(sent).toEqual(["backup"]);
    const admin = inv("admin person tag", "5", {}, guildContext);
    admin.invoker_is_guild_admin = true;
    expect((await reg.dispatch(admin)).text).toBe("admin");
  });
});

describe("reply helpers and visibility", () => {
  it("the_visibility_rule", () => {
    expect(replyEphemeral(false, CommandReply.text("x"))).toBe(false);
    expect(replyEphemeral(true, CommandReply.text("x"))).toBe(true);
    // A reply may narrow a public command, never widen an ephemeral one.
    expect(replyEphemeral(false, CommandReply.ephemeral("x"))).toBe(true);
    expect(replyEphemeral(true, CommandReply.public("x"))).toBe(true);
    expect(replyEphemeral(false, notice("error", "x"))).toBe(true);
    expect(replyEphemeral(false, notice("warn", "x"))).toBe(true);
    expect(replyEphemeral(false, notice("success", "x"))).toBe(false);
  });

  it("notices_and_confirm_cards", () => {
    const n = notice("error", "無法加入語音頻道。", "timeout");
    expect(n.text).toBe("無法加入語音頻道。\ntimeout");
    expect(n.card?.accent).toBe("error");
    expect(n.card?.blocks).toEqual([
      { type: "text", text: "無法加入語音頻道。" },
      { type: "muted", text: "timeout" },
    ]);
    const c = confirm({
      title: "清空佇列",
      text: "確定？",
      confirmId: componentId("queue:clear:yes"),
      cancelId: componentId("queue:clear:no"),
    });
    expect(c.card?.accent).toBe("danger");
    expect(c.ephemeral).toBe(true);
    const buttons = c.card?.blocks.find((b) => b.type === "buttons");
    expect(buttons?.type === "buttons" && buttons.buttons.map((b) => b.style)).toEqual([
      "danger",
      "secondary",
    ]);
    const card = cardReply([{ type: "text", text: "a" }], { title: "T" });
    expect(card.text).toBe("T\na");
  });

  it("pages", () => {
    const view = pageOf([1, 2, 3, 4, 5], 9, 2);
    expect(view).toEqual({ items: [5], page: 2, pages: 3 });
    const blocks = pageButtons(view, (p) => componentId("help:page", p));
    expect(blocks[0]?.type === "buttons" && blocks[0].buttons.map((b) => b.disabled)).toEqual([
      false,
      true,
    ]);
    expect(pageButtons(pageOf([1], 0, 5), () => "x")).toEqual([]);
  });
});

describe("panel sessions", () => {
  it("expire_after_the_ttl_and_disable_the_controls", async () => {
    vi.useFakeTimers();
    const expired: string[] = [];
    const sessions = new PanelSessions({ clock: { now: () => Date.now() } });
    sessions.open("m1", { platform: "discord", id: "1" }, { ttlMs: 5_000 }, () => {
      expired.push("m1");
    });
    expect(sessions.get("m1")?.initiator_only).toBe(true);
    vi.advanceTimersByTime(4_999);
    expect(sessions.get("m1")).not.toBeNull();
    vi.advanceTimersByTime(2);
    expect(expired).toEqual(["m1"]);
    expect(sessions.get("m1")).toBeNull();
    // Re-opening replaces; closing forgets without disabling.
    sessions.open("m2", { platform: "discord", id: "1" }, { initiatorOnly: false }, () => {
      expired.push("m2");
    });
    sessions.update("m2", { page: 2 });
    expect(sessions.get("m2")).toMatchObject({ initiator_only: false, data: { page: 2 } });
    sessions.closeAll();
    vi.advanceTimersByTime(60 * 60_000);
    expect(expired).toEqual(["m1"]);
    expect(sessions.size).toBe(0);
  });
});
