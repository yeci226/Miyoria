import { ServiceRegistry } from "@miyoria/kernel";
import { type AuditEntry, AuditLogKey } from "@miyoria/store";
import { AuthorizerKey, BaseAuthorizer, type Subject } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  ArgKind,
  type ArgSpec,
  argSpec,
  type CardBlock,
  CHANNEL_TIERS,
  CommandRegistry,
  type CommandReply,
  type ComponentInvocationData,
  type ComponentOutcome,
  commandSpec,
  type Invocation,
  type Modal,
  notice,
  Permissions,
  panelCommandPaths,
  panelDefs,
  type ResolvedUser,
  registerPanels,
  tierOf,
  type UserResolver,
  UserResolverKey,
} from "../src/index.js";
import { guildContext, inv } from "./helpers.js";

const OWNER = "1";
const MEMBER = "5";

/** Every command the repository registers (71 leaves, docs/design/v3-architecture.md §14.2). */
const INVENTORY = [
  "help",
  "admin autonomy pause",
  "admin autonomy resume",
  "admin autonomy status",
  "admin directive add",
  "admin directive list",
  "admin directive remove",
  "admin memory wipe",
  "admin module disable",
  "admin module enable",
  "admin module list",
  "admin module restart",
  "admin perm allow",
  "admin perm clear",
  "admin perm deny",
  "admin persona show",
  "admin person adjust",
  "admin person block",
  "admin person reset",
  "admin person show",
  "admin person tag",
  "admin person unblock",
  "admin person untag",
  "admin role assign",
  "admin role list",
  "admin role map",
  "admin role revoke",
  "admin role unmap",
  "admin role whois",
  "channel activeness",
  "channel mode",
  "game goal",
  "game start",
  "game status",
  "game stop",
  "me call",
  "me link",
  "me memory export",
  "me memory forget",
  "me memory show",
  "me privacy",
  "me profile",
  "queue add",
  "queue list",
  "queue manage clear",
  "queue manage done",
  "queue manage next",
  "queue manage pause",
  "queue manage priority",
  "queue manage remove",
  "queue manage resume",
  "queue manage skip",
  "queue song list",
  "queue song request",
  "queue song skip",
  "queue song stop",
  "queue song voteskip",
  "queue upvote",
  "queue vote end",
  "queue vote start",
  "stream scene",
  "stream start",
  "stream status",
  "stream stop",
  "voice consent",
  "voice golive start",
  "voice golive status",
  "voice golive stop",
  "voice join",
  "voice leave",
  "voice mode",
];

interface Call {
  path: string;
  args: Record<string, unknown>;
  resolved: string[];
}

interface Fake {
  path: string;
  permission?: string;
  ephemeral?: boolean;
  args?: ArgSpec[];
  reply?: (inv: Invocation) => CommandReply;
}

const FAKES: Fake[] = [
  { path: "voice join", permission: "voice.join", ephemeral: false },
  {
    path: "voice consent",
    permission: "voice.consent",
    ephemeral: true,
    args: [argSpec("state", "s", ArgKind.choice(["on", "off"]), { required: false })],
  },
  {
    path: "me privacy",
    permission: "me.privacy",
    ephemeral: true,
    args: ["dm", "approach", "presence"].map((n) =>
      argSpec(n, n, ArgKind.choice(["on", "off"]), { required: false }),
    ),
  },
  { path: "me profile", permission: "me.profile", ephemeral: true },
  {
    path: "me call",
    permission: "me.call",
    ephemeral: true,
    args: [argSpec("name", "n", ArgKind.string)],
  },
  {
    path: "queue song request",
    permission: "queue.song.request",
    ephemeral: false,
    args: [
      argSpec("song", "s", ArgKind.string),
      argSpec("key", "k", ArgKind.integer, { required: false }),
    ],
  },
  { path: "queue song list", permission: "queue.song.list", ephemeral: false },
  { path: "queue song stop", permission: "queue.song.stop", ephemeral: false },
  {
    path: "channel mode",
    permission: "channel.mode.view",
    ephemeral: true,
    args: [
      argSpec("mode", "m", ArgKind.choice(["off", "mention-only", "quiet", "normal", "reset"]), {
        required: false,
      }),
    ],
  },
  { path: "admin autonomy pause", permission: "admin.autonomy.toggle", ephemeral: true },
  { path: "admin role list", permission: "admin.role.list", ephemeral: true },
  {
    path: "admin person block",
    permission: "admin.person.block",
    ephemeral: true,
    args: [argSpec("user", "u", ArgKind.user)],
  },
  {
    path: "admin person tag",
    permission: "admin.person.tag",
    ephemeral: true,
    args: [argSpec("user", "u", ArgKind.user), argSpec("tag", "t", ArgKind.string)],
  },
];

class Grants extends BaseAuthorizer {
  constructor(private readonly nodes: ReadonlyMap<string, readonly string[]>) {
    super();
  }

  allowsSubject(subject: Subject, node: string): boolean {
    return node === "" || (this.nodes.get(subject.account.id) ?? []).includes(node);
  }
}

function setup(options: { grants?: Map<string, string[]>; resolver?: UserResolver } = {}) {
  const services = new ServiceRegistry();
  if (options.grants) services.provide("test", AuthorizerKey, new Grants(options.grants));
  if (options.resolver) services.provide("test", UserResolverKey, options.resolver);
  const registry = new CommandRegistry(Permissions.fromStrings([`discord:${OWNER}`]), {
    services,
  });
  const calls: Call[] = [];
  const fakes = [...FAKES];
  const add = (fake: Fake) => {
    registry.register(
      commandSpec(fake.path, `desc ${fake.path}`, {
        args: fake.args ?? [],
        permission: fake.permission ?? "",
        ephemeral: fake.ephemeral ?? true,
      }),
      (call) => {
        calls.push({
          path: call.path.join(" "),
          args: { ...call.args },
          resolved: Object.keys(call.resolved_users),
        });
        return fake.reply?.(call) ?? notice("success", `ok ${fake.path}`);
      },
    );
  };
  for (const fake of fakes) add(fake);
  registerPanels(registry, { services, policyUrl: "https://example.com/privacy" });
  return { registry, services, calls, add };
}

const session = (id: string) => ({
  initiator: { platform: "discord", id },
  initiator_only: true,
  data: null,
});

function click(
  customId: string,
  invoker: string,
  extra: Partial<ComponentInvocationData> = {},
): ComponentInvocationData {
  return {
    custom_id: customId,
    invoker: { platform: "discord", id: invoker },
    invoker_display_name: invoker,
    context: guildContext,
    invoker_is_guild_admin: false,
    message_id: "m1",
    session: session(invoker),
    ...extra,
  };
}

function blocks(reply: CommandReply): CardBlock[] {
  return reply.card?.blocks ?? [];
}

function buttons(reply: CommandReply) {
  return blocks(reply).flatMap((b) => {
    if (b.type === "buttons") return b.buttons;
    return b.type === "section" ? [b.button] : [];
  });
}

function selectOf(reply: CommandReply) {
  for (const b of blocks(reply)) if (b.type === "select") return b.select;
  return null;
}

function button(reply: CommandReply, label: string) {
  const found = buttons(reply).find((b) => b.label === label);
  if (!found) throw new Error(`no button ${label}: ${buttons(reply).map((b) => b.label)}`);
  return found;
}

async function open(
  registry: CommandRegistry,
  command: string,
  invoker: string,
  args: Record<string, string> = {},
  admin = false,
): Promise<CommandReply> {
  const data = inv(registry.panelPath(command).join(" "), invoker, args, guildContext);
  data.invoker_is_guild_admin = admin;
  return registry.dispatch(data);
}

function resultOf<T extends ComponentOutcome["result"]["type"]>(
  outcome: ComponentOutcome | null,
  type: T,
): Extract<ComponentOutcome["result"], { type: T }> {
  if (outcome === null) throw new Error("not a Miyoria component id");
  expect(outcome.result.type).toBe(type);
  return outcome.result as Extract<ComponentOutcome["result"], { type: T }>;
}

function updated(outcome: ComponentOutcome | null): CommandReply {
  return resultOf(outcome, "update").reply;
}

function replied(outcome: ComponentOutcome | null): CommandReply {
  return resultOf(outcome, "reply").reply;
}

function modalOf(outcome: ComponentOutcome | null): Modal {
  return resultOf(outcome, "modal").modal;
}

describe("registration", () => {
  it("a_slash_platform_gets_the_panels_first_and_then_the_whole_tree", () => {
    const { registry } = setup();
    const paths = registry.slashSpecs().map((s) => s.path.join(" "));
    // Commands with subcommands get `i`; the others stay bare.
    expect(paths.slice(0, 4)).toEqual(["admin i", "me i", "miyo", "song"]);
    expect(paths).toContain("me profile");
    expect(paths).toContain("voice join");
    expect(paths.length).toBe(4 + registry.specs().length);
    // The panels are not in the command list of text platforms.
    expect(registry.specs().some((s) => s.path.join(" ") === "me i")).toBe(false);
    expect(registry.specs().some((s) => s.path.length === 1 && s.path[0] === "me")).toBe(false);
  });

  it("i_opens_the_panel_and_a_bare_command_with_subcommands_does_not", async () => {
    const { registry } = setup();
    expect(registry.panelPath("me")).toEqual(["me", "i"]);
    expect(registry.panelPath("miyo")).toEqual(["miyo"]);
    const me = await registry.dispatch(inv("me i", MEMBER, {}, guildContext));
    expect(me.card?.title).toBe("我的面板");
    const bare = await registry.dispatch(inv("me", MEMBER, {}, guildContext));
    expect(bare.tone).toBe("warn");
    const miyoBare = await registry.dispatch(inv("miyo", MEMBER, {}, guildContext));
    expect(miyoBare.card?.title).toBe("Miyoria 控制面板");
    const miyoI = await registry.dispatch(inv("miyo i", MEMBER, {}, guildContext));
    expect(miyoI.tone).toBe("warn");
    // `i` takes the arguments of the panel (`/admin i user:`).
    const admin = registry.get(["admin", "i"]);
    expect(admin?.args.map((a) => a.name)).toEqual(["user"]);
  });

  it("an_extension_cannot_take_the_name_i_of_a_panel", () => {
    const { registry } = setup();
    expect(() => registry.register(commandSpec("me i", "x"), () => notice("info", "x"))).toThrow(
      "panel",
    );
  });

  it("a_plain_registry_still_shows_every_command", () => {
    const registry = new CommandRegistry();
    registry.register(commandSpec("ping", "p"), () => notice("info", "x"));
    expect(registry.slashSpecs().map((s) => s.path.join(" "))).toEqual(["ping"]);
  });

  it("registering_twice_replaces_instead_of_duplicating", () => {
    const { registry, services } = setup();
    const before = registry.routes();
    registerPanels(registry, { services });
    expect(registry.routes()).toEqual(before);
    expect(registry.slashSpecs()).toHaveLength(4 + registry.specs().length);
  });

  it("panels_are_open_to_everyone_and_not_gated_by_manage_server", () => {
    const { registry } = setup();
    const panels = registry.slashSpecs().slice(0, 4);
    for (const spec of panels) expect(spec.permission).toBe("");
    // `/miyo` and `/song` are public, `/me i` and `/admin i` private.
    expect(panels.map((s) => [s.path.join(" "), s.ephemeral])).toEqual([
      ["admin i", true],
      ["me i", true],
      ["miyo", false],
      ["song", false],
    ]);
    expect(registry.groupInfo("admin")?.member_permission).toBeNull();
    expect(registry.groupInfo("me")?.guild_only).toBe(false);
    expect(registry.groupInfo("miyo")?.guild_only).toBe(true);
  });

  it("the_rules_are_on_both_miyo_and_admin", () => {
    for (const command of ["miyo", "admin"]) {
      const def = panelDefs().find((d) => d.command === command);
      const page = def?.pages.find((p) => p.id === "rules");
      expect(page?.status?.map((s) => s.path)).toEqual(["admin directive list"]);
      // The public `/miyo` lists the rules by a button (the answer is private), `/admin` by
      // its status line.
      expect(page?.actions.map((a) => a.path)).toEqual([
        ...(command === "miyo" ? ["admin directive list"] : []),
        "admin directive add",
        "admin directive remove",
      ]);
    }
  });

  it("every_existing_command_has_a_control", () => {
    const mapped = new Set(panelCommandPaths());
    mapped.add("help"); // folded into /me, still a text command
    expect(INVENTORY.filter((path) => !mapped.has(path))).toEqual([]);
    expect(INVENTORY).toHaveLength(71);
  });

  it("the_tiers_map_onto_the_agent_levels", () => {
    expect(CHANNEL_TIERS.map((t) => [t.id, t.mode])).toEqual([
      ["off", "off"],
      ["mention", "mention-only"],
      ["chatty", "normal"],
    ]);
    expect(tierOf("off")).toBe("off");
    expect(tierOf("mention-only")).toBe("mention");
    for (const mode of ["quiet", "normal", "lively", "always"]) expect(tierOf(mode)).toBe("chatty");
  });
});

describe("what a member sees", () => {
  it("a_new_member_gets_song_and_privacy_without_reading_docs", async () => {
    const { registry } = setup();
    const reply = await open(registry, "me", MEMBER);
    expect(reply.card?.title).toBe("我的面板");
    expect(button(reply, "點歌")).toBeDefined();
    expect(button(reply, "允許語音收音")).toBeDefined();
    // The page selector reaches privacy, own data and memory.
    const labels = selectOf(reply)?.options.map((o) => o.label);
    expect(labels).toEqual(["開始", "隱私", "我的資料"]);
    // The policy link is a link button.
    expect(buttons(reply).find((b) => b.url === "https://example.com/privacy")).toBeDefined();
  });

  it("without_a_policy_the_panel_says_so", async () => {
    const { registry } = setup();
    registerPanels(registry, { services: null });
    const reply = await open(registry, "me", MEMBER);
    expect(reply.text).toContain("還沒有提供隱私政策");
  });

  it("the_privacy_page_changes_a_setting_in_place", async () => {
    const { registry, calls } = setup();
    const home = await open(registry, "me", MEMBER);
    const nav = selectOf(home);
    const page = await registry.dispatchComponent(
      click(nav?.id ?? "", MEMBER, { values: ["privacy"] }),
    );
    const privacy = updated(page);
    expect(privacy.text).toContain("目前的設定");
    const off = button(privacy, "禁止私訊");
    const done = await registry.dispatchComponent(click(off.id, MEMBER));
    expect(calls.find((c) => c.args.dm === "off")).toMatchObject({ path: "me privacy" });
    // A plain success notice becomes a line in the panel itself, visible to the member only.
    const after = updated(done);
    expect(after.text).toContain("ok me privacy");
    expect(after.card?.title).toBe("我的面板");
    expect(button(after, "禁止私訊")).toBeDefined();
    expect(done?.ephemeral).toBe(true);
  });

  it("a_member_never_sees_admin_controls", async () => {
    const { registry } = setup();
    const reply = await open(registry, "admin", MEMBER);
    expect(reply.tone).toBe("warn");
    expect(reply.text).toContain("沒有可以使用的項目");
    const miyo = await open(registry, "miyo", MEMBER);
    const labels = selectOf(miyo)?.options.map((o) => o.label) ?? [];
    expect(labels).not.toContain("緊急停止");
  });

  it("a_node_decides_not_the_command", async () => {
    // A moderator without Manage Server but with `admin.person.block` finds `/admin`.
    const grants = new Map([["7", ["admin.person.block", "admin.person.tag"]]]);
    const { registry } = setup({ grants });
    const reply = await open(registry, "admin", "7");
    expect(reply.tone).toBeUndefined();
    expect(selectOf(reply)).toBeNull(); // one page only: no selector
    expect(reply.text).toContain("她認識的人");
    expect(button(reply, "加標籤")).toBeDefined();
    expect(buttons(reply).some((b) => b.label === "封鎖")).toBe(false); // needs a person first
  });

  it("the_owner_gets_every_page", async () => {
    const { registry } = setup();
    const reply = await open(registry, "admin", OWNER);
    expect(selectOf(reply)?.options.map((o) => o.label)).toEqual(["角色與權限", "她認識的人"]);
    const miyo = await open(registry, "miyo", OWNER);
    const pages = selectOf(miyo)?.options.map((o) => o.label);
    expect(pages).toEqual(["總覽", "語音", "聊天等級", "歌單", "緊急停止"]);
  });
});

describe("ephemeral rules", () => {
  it("public_panels_answer_public_commands_in_the_channel", async () => {
    const { registry } = setup();
    const home = await open(registry, "song", MEMBER);
    const song = home.card ? button(home, "點歌") : null;
    // `queue song request` is public, so its button uses the public route.
    const opened = await registry.dispatchComponent(click(song?.id ?? "", MEMBER));
    expect(opened?.result.type).toBe("modal");
    const modalId = modalOf(opened).id;
    expect(modalId).toContain(":pask:");
    const submitted = await registry.dispatchComponent(
      click(modalId, MEMBER, { fields: { song: "櫻ノ詩", key: "" } }),
    );
    // The success notice is a plain one, but public commands answer in the channel.
    expect(replied(submitted).text).toContain("ok queue song request");
    expect(submitted?.ephemeral).toBe(false);
  });

  it("an_ephemeral_command_stays_private", async () => {
    const { registry } = setup();
    const home = await open(registry, "me", MEMBER);
    const outcome = await registry.dispatchComponent(
      click(button(home, "允許語音收音").id, MEMBER),
    );
    expect(outcome?.ephemeral).toBe(true);
  });

  it("failures_are_ephemeral_and_not_written_into_the_panel", async () => {
    const { registry, add } = setup();
    add({
      path: "voice leave",
      permission: "voice.leave",
      ephemeral: false,
      reply: () => notice("warn", "她目前不在語音頻道中。"),
    });
    const miyo = await open(registry, "miyo", MEMBER);
    const nav = selectOf(miyo);
    const voice = updated(
      await registry.dispatchComponent(click(nav?.id ?? "", MEMBER, { values: ["voice"] })),
    );
    const outcome = await registry.dispatchComponent(
      click(button(voice, "離開語音頻道").id, MEMBER),
    );
    expect(replied(outcome).tone).toBe("warn");
    expect(outcome?.ephemeral).toBe(true);
  });

  it("a_rich_answer_is_its_own_message", async () => {
    const { registry, add } = setup();
    add({
      path: "me memory show",
      permission: "memory.self.show",
      reply: () =>
        notice("info", "x").card
          ? {
              text: "list",
              card: { accent: "neutral", title: "記憶", blocks: [{ type: "text", text: "list" }] },
              session: {},
            }
          : notice("info", "x"),
    });
    const me = await open(registry, "me", MEMBER);
    const mem = updated(
      await registry.dispatchComponent(
        click(selectOf(me)?.id ?? "", MEMBER, { values: ["memory"] }),
      ),
    );
    // A paged card with its own session is not folded into the panel.
    const outcome = await registry.dispatchComponent(click(button(mem, "查看").id, MEMBER));
    expect(replied(outcome).card?.title).toBe("記憶");
  });
});

describe("audit", () => {
  it("drawing_a_page_leaves_no_entry_but_pressing_a_control_does", async () => {
    const { registry, services, add } = setup();
    add({ path: "admin autonomy status", permission: "admin.autonomy.view" });
    const entries: AuditEntry[] = [];
    services.provide("test", AuditLogKey, {
      append: async (entry) => {
        entries.push(entry);
      },
      recent: async () => entries,
    });
    const owner = await open(registry, "miyo", OWNER);
    const nav = selectOf(owner);
    const safety = updated(
      await registry.dispatchComponent(click(nav?.id ?? "", OWNER, { values: ["safety"] })),
    );
    // The status line is on the page, and reading it is not an action.
    expect(JSON.stringify(safety)).toContain("自主行動");
    await registry.dispatchComponent(click(nav?.id ?? "", OWNER, { values: ["safety"] }));
    expect(entries.filter((e) => e.action === "admin autonomy status")).toEqual([]);
    // Typing the command is a person asking, and stays audited, like every real action.
    await open(registry, "admin autonomy status", OWNER);
    expect(entries.map((e) => e.action)).toEqual(["admin autonomy status"]);
    await registry.dispatchComponent(click(button(safety, "緊急停止").id, OWNER));
    expect(entries.map((e) => e.action)).toEqual(["admin autonomy status", "admin autonomy pause"]);
  });
});

describe("permissions of controls", () => {
  it("a_forged_id_cannot_reach_a_command_the_member_may_not_run", async () => {
    const { registry, calls } = setup();
    const owner = await open(registry, "miyo", OWNER);
    const nav = selectOf(owner);
    const safety = updated(
      await registry.dispatchComponent(click(nav?.id ?? "", OWNER, { values: ["safety"] })),
    );
    const pause = button(safety, "緊急停止");
    const forged = await registry.dispatchComponent(click(pause.id, MEMBER));
    expect(replied(forged).tone).toBe("error");
    expect(calls.some((c) => c.path === "admin autonomy pause")).toBe(false);
    // The owner can.
    await registry.dispatchComponent(click(pause.id, OWNER));
    expect(calls.some((c) => c.path === "admin autonomy pause")).toBe(true);
  });

  it("an_unknown_action_id_is_refused", async () => {
    const { registry } = setup();
    const outcome = await registry.dispatchComponent(click("mi:me:do:home:nope:-", MEMBER));
    expect(replied(outcome).tone).toBe("warn");
  });

  it("only_the_opener_may_press_and_an_expired_panel_is_refused", async () => {
    const { registry, calls } = setup();
    const home = await open(registry, "me", MEMBER);
    const id = button(home, "允許語音收音").id;
    const other = await registry.dispatchComponent(click(id, "6", { session: session(MEMBER) }));
    expect(replied(other).text).toContain("只有執行指令的人");
    const expired = await registry.dispatchComponent(click(id, MEMBER, { session: null }));
    expect(replied(expired).text).toContain("過期");
    expect(calls).toEqual([]);
  });
});

describe("controls", () => {
  it("a_modal_asks_for_the_arguments_and_leaves_optional_ones_out", async () => {
    const { registry, calls } = setup();
    const home = await open(registry, "me", MEMBER);
    const opened = await registry.dispatchComponent(click(button(home, "點歌").id, MEMBER));
    const modal = modalOf(opened);
    expect(modal.fields.map((f) => [f.id, f.required])).toEqual([
      ["song", true],
      ["key", false],
    ]);
    const modalId = modalOf(opened).id;
    await registry.dispatchComponent(
      click(modalId, MEMBER, { fields: { song: "櫻ノ詩", key: "2" } }),
    );
    expect(calls.at(-1)).toMatchObject({
      path: "queue song request",
      args: { song: "櫻ノ詩", key: 2 },
    });
  });

  it("a_choice_select_offers_the_choices_of_the_argument", async () => {
    const grants = new Map([["7", ["channel.mode.view"]]]);
    const { registry, calls } = setup({ grants });
    const miyo = await open(registry, "miyo", "7");
    const chat = updated(
      await registry.dispatchComponent(click(selectOf(miyo)?.id ?? "", "7", { values: ["chat"] })),
    );
    const select = blocks(chat).flatMap((b) => (b.type === "select" ? [b.select] : []))[0];
    expect(select?.options.map((o) => o.label)).toEqual([
      "關閉",
      "只回提及",
      "安靜",
      "一般",
      "恢復預設",
    ]);
    const outcome = await registry.dispatchComponent(
      click(select?.id ?? "", "7", { values: ["mention-only"] }),
    );
    expect(calls.find((c) => c.args.mode === "mention-only")?.path).toBe("channel mode");
    expect(updated(outcome).card?.title).toBe("Miyoria 控制面板");
    // The three tiers are buttons.
    expect(buttons(chat).map((b) => b.label)).toEqual(
      expect.arrayContaining(["關閉", "只回提及", "可以聊天"]),
    );
    const tier = await registry.dispatchComponent(click(button(chat, "可以聊天").id, "7"));
    expect(tier).not.toBeNull();
    expect(calls.some((c) => c.args.mode === "normal")).toBe(true);
  });

  it("a_dangerous_control_asks_first", async () => {
    const grants = new Map([["7", ["queue.song.stop", "queue.song.list"]]]);
    const { registry, calls } = setup({ grants });
    const song = await open(registry, "song", "7");
    const stop = await registry.dispatchComponent(click(button(song, "停止並清空").id, "7"));
    const card = updated(stop);
    expect(card.card?.accent).toBe("danger");
    expect(calls.some((c) => c.path === "queue song stop")).toBe(false);
    const yes = card.card?.blocks.flatMap((b) => (b.type === "buttons" ? b.buttons : []));
    const go = await registry.dispatchComponent(
      click(yes?.find((b) => b.style === "danger")?.id ?? "", "7"),
    );
    expect(calls.some((c) => c.path === "queue song stop")).toBe(true);
    expect(go?.ephemeral).toBe(false);
    // Cancel goes back to the panel.
    const cancel = await registry.dispatchComponent(
      click(yes?.find((b) => b.style === "secondary")?.id ?? "", "7"),
    );
    expect(updated(cancel).card?.title).toBe("點歌");
  });
});

describe("people", () => {
  const resolver = (known: Record<string, ResolvedUser>): UserResolver => ({
    platform: "discord",
    resolveUsers: async (_context, ids) =>
      Object.fromEntries(
        ids.filter((id) => id in known).map((id) => [id, known[id] as ResolvedUser]),
      ),
  });
  const mod = { display_name: "m", platform_roles: ["9"], is_guild_admin: false };

  it("a_focused_person_gets_their_roles_resolved_before_a_command_runs", async () => {
    const { registry, calls } = setup({ resolver: resolver({ "42": mod }) });
    const reply = await open(registry, "admin", OWNER, { user: "<@42>" });
    expect(reply.text).toContain("<@42>");
    const block = await registry.dispatchComponent(click(button(reply, "封鎖").id, OWNER));
    expect(block).not.toBeNull();
    expect(calls.at(-1)).toMatchObject({
      path: "admin person block",
      args: { user: "42" },
      resolved: ["42"],
    });
  });

  it("it_refuses_when_the_platform_cannot_say_who_they_are", async () => {
    const { registry, calls } = setup();
    const reply = await open(registry, "admin", OWNER, { user: "42" });
    const outcome = await registry.dispatchComponent(click(button(reply, "封鎖").id, OWNER));
    expect(replied(outcome).tone).toBe("warn");
    expect(replied(outcome).text).toContain("無法確認對方的身分組");
    expect(calls.some((c) => c.path === "admin person block")).toBe(false);
  });

  it("a_modal_prefills_the_focus_and_acting_on_yourself_needs_no_lookup", async () => {
    const { registry, calls } = setup();
    const reply = await open(registry, "admin", OWNER, { user: "42" });
    const opened = await registry.dispatchComponent(click(button(reply, "加標籤").id, OWNER));
    const modal = modalOf(opened);
    expect(modal.fields.find((f) => f.id === "user")?.value).toBe("42");
    // The owner tags themselves: no lookup, the command runs.
    await registry.dispatchComponent(
      click(modal.id, OWNER, { fields: { user: OWNER, tag: "friend" } }),
    );
    expect(calls.at(-1)).toMatchObject({
      path: "admin person tag",
      args: { user: OWNER, tag: "friend" },
    });
  });

  it("the_focus_can_be_chosen_from_the_panel", async () => {
    const { registry } = setup({ resolver: resolver({ "42": mod }) });
    const reply = await open(registry, "admin", OWNER);
    const nav = selectOf(reply);
    const people = updated(
      await registry.dispatchComponent(click(nav?.id ?? "", OWNER, { values: ["people"] })),
    );
    const pick = await registry.dispatchComponent(click(button(people, "指定對象").id, OWNER));
    const modal = modalOf(pick);
    const focused = updated(
      await registry.dispatchComponent(click(modal.id, OWNER, { fields: { user: "<@42>" } })),
    );
    expect(focused.text).toContain("<@42>");
    expect(button(focused, "封鎖")).toBeDefined();
  });
});

describe("the rest of the commands", () => {
  it("a_command_without_a_control_is_listed_and_runnable", async () => {
    const { registry, add, calls } = setup();
    add({
      path: "ext hello",
      permission: "",
      args: [argSpec("who", "誰", ArgKind.string)],
    });
    add({ path: "ext ping", permission: "" });
    const admin = await open(registry, "admin", OWNER);
    const options = selectOf(admin)?.options.map((o) => o.label);
    expect(options).toContain("其他指令");
    const more = updated(
      await registry.dispatchComponent(
        click(selectOf(admin)?.id ?? "", OWNER, { values: ["more"] }),
      ),
    );
    const list = blocks(more).flatMap((b) => (b.type === "select" ? [b.select] : []))[0];
    const values = list?.options.map((o) => o.value) ?? [];
    expect(values).toContain("ext hello");
    expect(values).toContain("ext ping");
    // Commands that have a control are not repeated.
    expect(values).not.toContain("me profile");

    const plain = await registry.dispatchComponent(
      click(list?.id ?? "", OWNER, { values: ["ext ping"] }),
    );
    expect(calls.at(-1)?.path).toBe("ext ping");
    expect(plain?.result.type).toBe("update");

    const asked = await registry.dispatchComponent(
      click(list?.id ?? "", OWNER, { values: ["ext hello"] }),
    );
    const modal = modalOf(asked);
    await registry.dispatchComponent(click(modal.id, OWNER, { fields: { who: "世界" } }));
    expect(calls.at(-1)).toMatchObject({ path: "ext hello", args: { who: "世界" } });
  });

  it("the_runner_respects_permissions", async () => {
    const { registry, add } = setup();
    add({ path: "ext secret", permission: "admin.secret" });
    const admin = await open(registry, "admin", MEMBER);
    expect(admin.tone).toBe("warn");
    const owner = await open(registry, "admin", OWNER);
    expect(owner.tone).toBeUndefined();
  });
});

// ---- shared (public) panels -----------------------------------------------------------------

const shared = (opener: string) => ({
  initiator: { platform: "discord", id: opener },
  initiator_only: false,
  data: null,
});

/** `voice join` that records who ran it. */
function joinBy(ran: string[]): Fake {
  return {
    path: "voice join",
    permission: "voice.join",
    ephemeral: false,
    reply: (call) => {
      ran.push(call.invoker.id);
      return notice("success", `joined by ${call.invoker.id}`);
    },
  };
}

async function voicePage(registry: CommandRegistry, opener: string) {
  const home = await open(registry, "miyo", opener);
  const nav = selectOf(home);
  return updated(
    await registry.dispatchComponent(
      click(nav?.id ?? "", opener, { values: ["voice"], session: shared(opener) }),
    ),
  );
}

describe("public panels", () => {
  it("a_public_panel_is_open_to_presses_and_a_private_one_is_not", async () => {
    const { registry } = setup();
    expect((await open(registry, "miyo", MEMBER)).session).toEqual({ initiatorOnly: false });
    expect((await open(registry, "song", MEMBER)).session).toEqual({ initiatorOnly: false });
    expect((await open(registry, "me", MEMBER)).session).toEqual({ initiatorOnly: true });
    expect((await open(registry, "admin", OWNER)).session).toEqual({ initiatorOnly: true });
  });

  it("someone_else_presses_with_their_own_permissions_not_the_openers", async () => {
    const ran: string[] = [];
    const grants = new Map([
      ["5", ["voice.join"]],
      ["6", []],
      ["7", ["voice.join"]],
    ]);
    const { registry, add } = setup({ grants });
    add(joinBy(ran));
    const voice = await voicePage(registry, "5");
    const join = button(voice, "加入我的語音頻道");
    // 6 has no `voice.join`: a private refusal, and the command never runs.
    const refused = await registry.dispatchComponent(click(join.id, "6", { session: shared("5") }));
    expect(replied(refused).tone).toBe("error");
    expect(refused?.ephemeral).toBe(true);
    expect(ran).toEqual([]);
    // 7 has it: the command runs as 7 (not as the opener 5), and the answer is public.
    const ok = await registry.dispatchComponent(click(join.id, "7", { session: shared("5") }));
    expect(replied(ok).text).toContain("joined by 7");
    expect(ok?.ephemeral).toBe(false);
    expect(ran).toEqual(["7"]);
  });

  it("the_openers_rights_do_not_carry_over_to_a_member_without_them", async () => {
    const { registry, calls } = setup();
    // The owner opens `/miyo` and reaches the safety page; a plain member pressing its button
    // is refused, because the control is checked again for the presser.
    const home = await open(registry, "miyo", OWNER);
    const nav = selectOf(home);
    const safety = updated(
      await registry.dispatchComponent(
        click(nav?.id ?? "", OWNER, { values: ["safety"], session: shared(OWNER) }),
      ),
    );
    const pause = button(safety, "緊急停止");
    const forged = await registry.dispatchComponent(
      click(pause.id, MEMBER, { session: shared(OWNER) }),
    );
    expect(replied(forged).tone).toBe("error");
    expect(forged?.ephemeral).toBe(true);
    expect(calls.some((c) => c.path === "admin autonomy pause")).toBe(false);
  });

  it("someone_elses_navigation_is_a_private_copy_and_the_shared_message_stays", async () => {
    const { registry } = setup();
    const home = await open(registry, "miyo", "5");
    const nav = selectOf(home);
    const mine = await registry.dispatchComponent(
      click(nav?.id ?? "", "5", { values: ["voice"], session: shared("5") }),
    );
    expect(mine?.result.type).toBe("update");
    const theirs = await registry.dispatchComponent(
      click(nav?.id ?? "", "6", { values: ["voice"], session: shared("5") }),
    );
    // A new ephemeral message for 6, bound to 6 alone.
    const copy = replied(theirs);
    expect(theirs?.ephemeral).toBe(true);
    expect(copy.card?.title).toBe("Miyoria 控制面板");
    expect(copy.session).toEqual({ initiatorOnly: true });
  });

  it("a_private_answer_is_never_written_into_a_shared_panel", async () => {
    const { registry } = setup();
    const owner = await open(registry, "miyo", OWNER);
    const level = updated(
      await registry.dispatchComponent(
        click(selectOf(owner)?.id ?? "", OWNER, { values: ["chat"], session: shared(OWNER) }),
      ),
    );
    // `channel mode` is private by declaration in these fixtures.
    const pick = selectOf(level);
    expect(pick).not.toBeNull();
    const outcome = await registry.dispatchComponent(
      click(pick?.id ?? "", OWNER, { values: ["quiet"], session: shared(OWNER) }),
    );
    expect(outcome?.result.type).toBe("reply");
    expect(outcome?.ephemeral).toBe(true);
  });

  it("a_confirm_card_is_for_the_presser_alone", async () => {
    const { registry } = setup();
    const song = await open(registry, "song", OWNER);
    const stop = button(song, "停止並清空");
    const outcome = await registry.dispatchComponent(
      click(stop.id, OWNER, { session: shared(OWNER) }),
    );
    expect(outcome?.result.type).toBe("reply");
    expect(outcome?.ephemeral).toBe(true);
    expect(replied(outcome).session).toEqual({});
  });

  it("a_private_status_line_stays_out_of_a_shared_panel", async () => {
    const { registry, add } = setup();
    add({
      path: "admin directive list",
      permission: "admin.directive.view",
      ephemeral: true,
      reply: () => notice("info", "SECRET RULE"),
    });
    add({ path: "admin directive add", permission: "admin.directive.add", ephemeral: true });
    const miyo = await open(registry, "miyo", OWNER);
    const rules = updated(
      await registry.dispatchComponent(
        click(selectOf(miyo)?.id ?? "", OWNER, { values: ["rules"], session: shared(OWNER) }),
      ),
    );
    expect(JSON.stringify(rules)).not.toContain("SECRET RULE");
    // The list is a button whose answer is private.
    const list = await registry.dispatchComponent(
      click(button(rules, "查看規則").id, OWNER, { session: shared(OWNER) }),
    );
    expect(replied(list).text).toContain("SECRET RULE");
    expect(list?.ephemeral).toBe(true);
    // On the private `/admin i` it is a status line.
    const admin = await open(registry, "admin", OWNER);
    const adminRules = updated(
      await registry.dispatchComponent(
        click(selectOf(admin)?.id ?? "", OWNER, { values: ["rules"] }),
      ),
    );
    expect(JSON.stringify(adminRules)).toContain("SECRET RULE");
  });

  it("a_private_panel_writes_answers_into_itself_and_stays_private", async () => {
    const { registry } = setup();
    const me = await open(registry, "me", MEMBER);
    const privacy = updated(
      await registry.dispatchComponent(
        click(selectOf(me)?.id ?? "", MEMBER, { values: ["privacy"] }),
      ),
    );
    const outcome = await registry.dispatchComponent(click(button(privacy, "禁止私訊").id, MEMBER));
    expect(outcome?.ephemeral).toBe(true);
    expect(outcome?.result.type).toBe("update");
  });

  it("the_configuration_can_make_a_panel_private_or_a_command_public", async () => {
    const { registry } = setup();
    registry.setVisibility({ miyo: "private", "me i": "public" });
    expect((await open(registry, "miyo", MEMBER)).session).toEqual({ initiatorOnly: true });
    expect((await open(registry, "me", MEMBER)).session).toEqual({ initiatorOnly: false });
    expect(registry.get(["miyo"])?.ephemeral).toBe(true);
    expect(registry.get(["me", "i"])?.ephemeral).toBe(false);
    // The prefix covers the whole group; the longest key wins.
    registry.setVisibility({ me: "private", "me profile": "public" });
    expect(registry.get(["me", "call"])?.ephemeral).toBe(true);
    expect(registry.get(["me", "profile"])?.ephemeral).toBe(false);
    expect(registry.unknownVisibility()).toEqual([]);
    registry.setVisibility({ "me wallett": "private", nothing: "public", "me i": "public" });
    expect(registry.unknownVisibility().sort()).toEqual(["me wallett", "nothing"]);
  });
});
