import { incomingText } from "@miyoria/types";
import { ApplicationCommandOptionType, ChannelType } from "discord.js";
import { describe, expect, test } from "vitest";
import {
  commandPath,
  componentsText,
  displayName,
  hasContent,
  incomingMessage,
  isGuildAdmin,
  kindOf,
  type MemberLike,
  type MessageLike,
  type OptionLike,
  otherMentions,
  parseUserIds,
  quotedMessage,
  resolvedUsers,
  resolveMentions,
  snowflake,
  type UserLike,
} from "../src/mapping.js";

const user = (id: string, username: string, globalName: string | null, bot = false): UserLike => ({
  id,
  username,
  globalName,
  bot,
});

function message(extra: Partial<MessageLike> = {}): MessageLike {
  return {
    id: "1000",
    channelId: "200",
    guildId: "300",
    author: user("42", "alice_w", "Alice"),
    member: { nickname: "Ali" },
    content: "hi <@7>",
    createdTimestamp: Date.parse("2026-11-01T12:00:00.000Z"),
    mentions: { users: new Map() },
    attachments: new Map(),
    ...extra,
  };
}

const selves = () => parseUserIds(["7", "discord:8"]);

describe("mapping", () => {
  test("maps_guild_message", () => {
    const msg = message({
      mentions: { users: new Map([["7", user("7", "miyoria", null, true)]]) },
      attachments: new Map([
        ["5", { url: "https://cdn/cat.png", name: "cat.png", contentType: "image/png" }],
      ]),
    });
    const m = incomingMessage(msg, "thread", selves());
    expect(m.id.id).toBe("1000");
    expect(m.id.context).toEqual({
      platform: "discord",
      scope: "300",
      channel: "200",
      kind: "thread",
    });
    expect(m.author.display_name).toBe("Ali");
    expect(m.author.account).toEqual({ platform: "discord", id: "42" });
    expect(m.author.is_bot).toBe(false);
    expect(m.mentions_self).toBe(true);
    expect(m.reply_to_self).toBe(false);
    expect(m.attachments).toEqual([
      {
        url: "https://cdn/cat.png",
        filename: "cat.png",
        content_type: "image/png",
        id: null,
        size: null,
        description: null,
      },
    ]);
    // Mentions are resolved to names on intake.
    expect(m.text).toBe("hi @miyoria");
    expect(m.reply_to).toBeNull();
    expect(m.referenced).toBeNull();
    expect(m.stickers).toEqual([]);
    expect(m.embeds).toEqual([]);
    expect(m.forwarded).toEqual([]);
    expect(m.ts).toBe("2026-11-01T12:00:00.000Z");
  });

  test("maps_dm_reply_to_self_account", () => {
    const msg = message({ guildId: null, member: null });
    const m = incomingMessage(msg, "channel", selves(), "8");
    expect(m.id.context.kind).toBe("dm");
    expect(m.id.context.scope).toBeNull();
    expect(m.author.display_name).toBe("Alice");
    expect(m.reply_to_self).toBe(true);
    expect(m.mentions_self).toBe(false);
    // A reply to somebody else is not a reply to her.
    expect(incomingMessage(msg, "dm", selves(), "99").reply_to_self).toBe(false);
    expect(incomingMessage(msg, "dm", selves(), null).reply_to_self).toBe(false);
  });

  test("attachment_without_content_type_is_null", () => {
    const msg = message({ attachments: new Map([["5", { url: "u", name: "f" }]]) });
    expect(incomingMessage(msg, "channel", selves()).attachments[0]?.content_type).toBeNull();
  });

  test("display_name_fallbacks", () => {
    expect(displayName(user("1", "bob", null))).toBe("bob");
    expect(displayName(user("1", "bob", null), "Bobby")).toBe("Bobby");
    expect(displayName(user("1", "bob", "Bob!"))).toBe("Bob!");
    // A blank nickname does not fall through to the global name (like the legacy filter).
    expect(displayName(user("1", "bob", "Bob!"), " ")).toBe("bob");
  });

  test("flattens_subcommand_groups", () => {
    const options: OptionLike[] = [
      {
        name: "module",
        type: ApplicationCommandOptionType.SubcommandGroup,
        options: [
          {
            name: "enable",
            type: ApplicationCommandOptionType.Subcommand,
            options: [
              { name: "id", type: ApplicationCommandOptionType.String, value: "llm" },
              { name: "force", type: ApplicationCommandOptionType.Boolean, value: true },
              { name: "times", type: ApplicationCommandOptionType.Integer, value: 3 },
              { name: "ratio", type: ApplicationCommandOptionType.Number, value: 2.5 },
              { name: "who", type: ApplicationCommandOptionType.User, value: "55" },
              { name: "what", type: ApplicationCommandOptionType.Role, value: "66" },
            ],
          },
        ],
      },
    ];
    const { path, args } = commandPath("admin", options);
    expect(path).toEqual(["admin", "module", "enable"]);
    expect(Object.fromEntries(args)).toEqual({
      id: "llm",
      force: true,
      times: 3,
      ratio: "2.5",
      who: "55",
      what: "66",
    });

    const plain = commandPath("ping", []);
    expect(plain.path).toEqual(["ping"]);
    expect(plain.args.size).toBe(0);
  });

  test("guild_admin_detection", () => {
    const member = (permissions: string): MemberLike => ({ roles: [], permissions });
    expect(isGuildAdmin(member("8"))).toBe(true); // ADMINISTRATOR
    expect(isGuildAdmin(member("32"))).toBe(true); // MANAGE_GUILD
    expect(isGuildAdmin(member("2048"))).toBe(false); // SEND_MESSAGES
    expect(isGuildAdmin(null)).toBe(false);
    // discord.js GuildMember exposes a PermissionsBitField.
    expect(isGuildAdmin({ roles: [], permissions: { bitfield: 8n } })).toBe(true);
    expect(isGuildAdmin({ roles: [] })).toBe(false);
  });

  test("maps_resolved_users", () => {
    const resolved = {
      users: new Map([
        ["5", user("5", "eve", "Eve")],
        ["6", user("6", "dm_only", null)],
      ]),
      members: new Map<string, MemberLike>([
        ["5", { nick: "Evie", roles: ["70", "71"], permissions: "8" }],
      ]),
    };
    const users = resolvedUsers(resolved);
    expect(users.get("5")).toEqual({
      display_name: "Evie",
      platform_roles: ["70", "71"],
      is_guild_admin: true,
    });
    expect(users.get("6")).toEqual({
      display_name: "dm_only",
      platform_roles: [],
      is_guild_admin: false,
    });
    expect(resolvedUsers(null).size).toBe(0);
    // A discord.js GuildMember has a role manager with a cache.
    const gm = new Map<string, MemberLike>([
      ["5", { nickname: "Evie", roles: { cache: new Map([["3", {}]]) } }],
    ]);
    expect(resolvedUsers({ users: resolved.users, members: gm }).get("5")?.platform_roles).toEqual([
      "3",
    ]);
  });

  test("parses_user_ids", () => {
    expect(selves().size).toBe(2);
    expect(selves().has("8")).toBe(true);
    expect(() => parseUserIds(["abc"])).toThrow("invalid Discord user id `abc`");
    expect(() => parseUserIds(["0"])).toThrow("invalid Discord user id `0`");
    expect(parseUserIds([" discord:007 "])).toEqual(new Set(["7"]));
  });

  test("channel_kinds", () => {
    expect(kindOf(ChannelType.PublicThread)).toBe("thread");
    expect(kindOf(ChannelType.PrivateThread)).toBe("thread");
    expect(kindOf(ChannelType.AnnouncementThread)).toBe("thread");
    expect(kindOf(ChannelType.DM)).toBe("dm");
    expect(kindOf(ChannelType.GroupDM)).toBe("dm");
    expect(kindOf(ChannelType.GuildText)).toBe("channel");
    // Text chat inside a voice channel is a normal channel; voice belongs to the voice node.
    expect(kindOf(ChannelType.GuildVoice)).toBe("channel");
  });

  test("snowflake_parsing", () => {
    expect(snowflake("123456789012345678", "channel")).toBe("123456789012345678");
    expect(() => snowflake("0", "channel")).toThrow("invalid Discord channel id `0`");
    expect(() => snowflake("x1", "message")).toThrow("invalid Discord message id `x1`");
  });

  test("resolves_mentions_channels_roles_and_custom_emoji", () => {
    const msg = message({
      content: "<@42> <@!43> 看 <#9> 問 <@&5> <:pepe:123> <a:dance:456> <@1> <#2> <t:1700000000:R>",
      mentions: {
        users: new Map([
          ["42", user("42", "alice_w", "Alice")],
          ["43", user("43", "bob", null)],
        ]),
        members: new Map([["43", { nickname: "阿伯" }]]),
        channels: new Map([["9", { name: "雜談" }]]),
        roles: new Map([["5", { name: "管理員" }]]),
      },
    });
    expect(incomingMessage(msg, "channel", selves()).text).toBe(
      "@Alice @阿伯 看 #雜談 問 @管理員 :pepe: :dance: @某人 #某個頻道 <t:1700000000:R>",
    );
    // Unknown ids never leak as raw markup.
    const none = { users: new Map(), channels: new Map(), roles: new Map() };
    expect(resolveMentions("<@&9>", none)).toBe("@某個身分組");
  });

  test("maps_reply_references_stickers_embeds_attachment_details_and_forwards", () => {
    const quoted = { author: { platform: "discord", id: "8" }, author_name: "DS", text: "早安" };
    const forwardedMentions = { users: new Map([["42", user("42", "a", "Alice")]]) };
    const msg = message({
      content: "",
      reference: { messageId: "900", channelId: "200", guildId: "300", type: 0 },
      attachments: new Map([
        [
          "5",
          {
            id: "5",
            url: "https://cdn.discordapp.com/a/5/cat.png?ex=1",
            name: "cat.png",
            contentType: "image/png",
            size: 1234,
            description: "一隻橘貓",
          },
        ],
      ]),
      stickers: new Map([["s1", { id: "s1", name: "鯨魚揮手" }]]),
      embeds: [{ title: "新聞", description: "內容", url: "https://example.com/x" }, {}],
      messageSnapshots: new Map([["f1", { content: "轉傳的 <@42>", mentions: forwardedMentions }]]),
    });
    const m = incomingMessage(msg, "channel", selves(), "8", quoted);
    expect(m.reply_to).toEqual({ context: m.id.context, id: "900" });
    expect(m.reply_to_self).toBe(true);
    expect(m.referenced).toEqual(quoted);
    expect(m.attachments[0]).toMatchObject({ id: "5", size: 1234, description: "一隻橘貓" });
    expect(m.stickers).toEqual([{ id: "s1", name: "鯨魚揮手" }]);
    // Empty embeds are dropped.
    expect(m.embeds).toEqual([
      { title: "新聞", description: "內容", url: "https://example.com/x" },
    ]);
    expect(m.forwarded).toEqual([
      { text: "轉傳的 @Alice", attachments: [], stickers: [], embeds: [] },
    ]);
    expect(incomingText(m)).toBe(
      "[貼圖: 鯨魚揮手] [嵌入: 新聞 - 內容 https://example.com/x] [圖片: cat.png(一隻橘貓)] [轉傳: 轉傳的 @Alice]",
    );
    expect(hasContent(msg)).toBe(true);
  });

  test("forwards_are_not_replies_and_empty_messages_have_no_content", () => {
    const forward = message({ reference: { messageId: "900", type: 1 } });
    expect(incomingMessage(forward, "channel", selves()).reply_to).toBeNull();
    // A reply in another channel keeps the parent's channel.
    const cross = message({ reference: { messageId: "900", channelId: "201" } });
    expect(incomingMessage(cross, "thread", selves()).reply_to?.context).toEqual({
      platform: "discord",
      scope: "300",
      channel: "201",
      kind: "thread",
    });
    expect(hasContent(message({ content: "  " }))).toBe(false);
    const sticker = new Map([["s", { id: "s", name: "x" }]]);
    expect(hasContent(message({ content: "", stickers: sticker }))).toBe(true);
    expect(hasContent(message({ content: "", embeds: [{ title: "t" }] }))).toBe(true);
  });

  test("quoted_parent_is_clipped_and_resolved", () => {
    const parent = message({
      content: `<@42> ${"長".repeat(400)}`,
      mentions: { users: new Map([["42", user("42", "a", "Alice")]]) },
    });
    const q = quotedMessage(parent);
    expect(q.author).toEqual({ platform: "discord", id: "42" });
    expect(q.author_name).toBe("Ali");
    expect(q.text.startsWith("@Alice 長")).toBe(true);
    expect([...q.text].length).toBe(301);
  });
});

describe("who a message is for", () => {
  const people = new Map([
    ["7", user("7", "miyoria", null, true)],
    ["50", user("50", "bob_w", "Bob")],
    ["51", user("51", "helper", null, true)],
  ]);

  test("reply_to_her_that_opens_with_someone_else_is_flagged", () => {
    // The 2026-11-10 incident: a reply to her whose text talks to another person.
    const msg = message({
      content: "<@50> she keeps repeating herself",
      mentions: { users: new Map([...people].filter(([id]) => id !== "51")) },
    });
    const m = incomingMessage(msg, "channel", selves(), "7");
    expect(m.reply_to_self).toBe(true);
    expect(m.mentions_self).toBe(true);
    expect(m.opens_with_other_mention).toBe(true);
    expect(m.mentions_others).toEqual([
      { account: { platform: "discord", id: "50" }, display_name: "Bob", is_bot: false },
    ]);
  });

  test("a_reply_ping_without_markup_is_not_a_mention_of_someone_else", () => {
    const msg = message({
      content: "hello there",
      mentions: { users: new Map([["50", people.get("50") as UserLike]]) },
    });
    const m = incomingMessage(msg, "channel", selves(), "50");
    expect(m.mentions_others).toEqual([]);
    expect(m.opens_with_other_mention).toBe(false);
  });

  test("opening_with_her_is_not_opening_with_someone_else", () => {
    const msg = message({ content: "<@7> and <@!50> please", mentions: { users: people } });
    const m = incomingMessage(msg, "channel", selves());
    expect(m.opens_with_other_mention).toBe(false);
    expect(m.mentions_others?.map((x) => x.account.id)).toEqual(["50"]);
  });

  test("her_second_account_counts_as_her", () => {
    const users = new Map([["8", user("8", "self2", null)]]);
    const m = incomingMessage(message({ content: "<@8> hi", mentions: { users } }), "dm", selves());
    expect(m.mentions_others).toEqual([]);
    expect(m.opens_with_other_mention).toBe(false);
  });

  test("bots_are_flagged_dedupe_and_keep_order_nicknames_win_roles_are_left_out", () => {
    const { mentions_others } = otherMentions(
      "x <@51> <@!50> <@51> <@&99>",
      {
        users: people,
        members: new Map([["50", { nickname: "Bobby" }]]),
        roles: new Map([["99", { name: "mods" }]]),
      },
      selves(),
    );
    expect(mentions_others).toEqual([
      { account: { platform: "discord", id: "51" }, display_name: "helper", is_bot: true },
      { account: { platform: "discord", id: "50" }, display_name: "Bobby", is_bot: false },
    ]);
  });

  test("a_leading_role_mention_is_not_a_person", () => {
    const r = otherMentions("<@&99> meeting", { users: new Map() }, selves());
    expect(r).toEqual({ mentions_others: [], opens_with_other_mention: false });
  });

  test("a_mention_in_the_middle_does_not_open_the_text", () => {
    const m = incomingMessage(
      message({ content: "  hey <@50>", mentions: { users: people } }),
      "channel",
      selves(),
    );
    expect(m.opens_with_other_mention).toBe(false);
    expect(m.mentions_others).toHaveLength(1);
    const lead = incomingMessage(
      message({ content: "  <@50> hey", mentions: { users: people } }),
      "channel",
      selves(),
    );
    expect(lead.opens_with_other_mention).toBe(true);
  });
});

describe("componentsText", () => {
  test("reads_text_displays_in_order_and_ignores_the_rest", () => {
    expect(
      componentsText([
        { type: 17, components: [{ type: 10, content: " 第一行 " }, { type: 14 }] },
        { toJSON: () => ({ type: 10, content: "第二行" }) },
        null,
      ]),
    ).toBe("第一行\n第二行");
    expect(componentsText(undefined)).toBe("");
    expect([...componentsText([{ type: 10, content: "長".repeat(700) }])].length).toBe(601);
  });
});

describe("her cards", () => {
  /** A receipt as `DiscordSink.sendCard` posts it: components, no content, no pings. */
  const receipt = (extra: Partial<MessageLike> = {}) =>
    message({
      author: user("7", "miyoria", null, true),
      member: null,
      content: "",
      components: [
        { type: 17, components: [{ type: 10, content: "**🍚 收下了**\n<@99> 餵了白飯" }] },
      ],
      ...extra,
    });

  test("a card is marked as one, a plain line is not", () => {
    expect(incomingMessage(receipt(), "channel", selves()).card).toBe(true);
    expect(incomingMessage(message(), "channel", selves()).card).toBeUndefined();
    // Content beside components is something said.
    expect(incomingMessage(receipt({ content: "好" }), "channel", selves()).card).toBeUndefined();
  });

  test("a mention Discord lists nobody for is named from the platform's caches", () => {
    // 2026-11-11: receipts read 「@某人」 in her history, so nobody could tell whom it charged.
    expect(incomingMessage(receipt(), "channel", selves()).text).toContain("@某人 餵了白飯");
    const names = (id: string) => (id === "99" ? "阿鰻" : null);
    const m = incomingMessage(receipt(), "channel", selves(), null, null, names);
    expect(m.text).toBe("**🍚 收下了**\n@阿鰻 餵了白飯");
    // What the message's own mention data says wins.
    const listed = receipt({ mentions: { users: new Map([["99", user("99", "eel", "鰻魚")]]) } });
    expect(incomingMessage(listed, "channel", selves(), null, null, names).text).toContain(
      "@鰻魚 餵了白飯",
    );
  });
});
