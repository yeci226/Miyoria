// The gateway bridge against a fake discord.js client (an EventEmitter): no live Discord.

import { EventEmitter } from "node:events";
import { CommandRegistry, CommandReply, commandSpec } from "@miyoria/commands";
import {
  defineManifest,
  EventBus,
  type Module,
  type ModuleContext,
  type Subscription,
  Supervisor,
} from "@miyoria/kernel";
import { PlatformHistories, PlatformSinks } from "@miyoria/types";
import { ChannelType, type Client, Events, MessageType } from "discord.js";
import { afterEach, describe, expect, test } from "vitest";
import { DiscordConfigSchema } from "../src/config.js";
import { GatewayBridge, Shared } from "../src/handler.js";

class Probe implements Module {
  readonly manifest = defineManifest("probe", "Probe");
  ctx: ModuleContext | undefined;

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
  }
}

interface PutCall {
  route: string;
  body: unknown;
}

function fakeClient() {
  const puts: PutCall[] = [];
  const client = Object.assign(new EventEmitter(), {
    user: { id: "100", username: "miyoria" },
    application: { id: "100" },
    guilds: {
      cache: new Map([
        ["77", {}],
        ["88", {}],
      ]),
    },
    channels: {
      cache: new Map<string, { type: ChannelType }>(),
      fetched: [] as string[],
      fetch: async (id: string): Promise<{ type: ChannelType } | null> => {
        client.channels.fetched.push(id);
        return id === "thread-1" ? { type: ChannelType.PublicThread } : null;
      },
    },
    rest: {
      post: async () => ({ id: "1" }),
      put: async (route: string, options?: { body?: unknown }) => {
        puts.push({ route, body: options?.body });
        return [];
      },
    },
  });
  return { client, puts };
}

interface Rig {
  sup: Supervisor;
  bus: EventBus;
  sinks: PlatformSinks;
  histories: PlatformHistories;
  registry: CommandRegistry;
  shared: Shared;
  fake: ReturnType<typeof fakeClient>;
  events: Subscription;
}

let rig: Rig | undefined;

afterEach(async () => {
  await rig?.sup.stopAll();
  rig = undefined;
});

async function boot(selfIds: string[] = [], config: Record<string, unknown> = {}): Promise<Rig> {
  const bus = new EventBus();
  const sup = new Supervisor({ bus });
  const probe = new Probe();
  await sup.register(probe, null, true);
  await sup.startAll();
  const registry = new CommandRegistry();
  const sinks = new PlatformSinks();
  // The gate has its own tests below; the rest of this file is about mapping.
  const parsed = DiscordConfigSchema.parse({
    token: "t",
    command_guilds: ["77"],
    ambient_text: "tiers",
    ...config,
  });
  const histories = new PlatformHistories();
  const shared = new Shared(parsed, selfIds, registry, sinks, histories);
  const fake = fakeClient();
  new GatewayBridge(probe.ctx as ModuleContext, shared).attach(fake.client as unknown as Client);
  const events = bus.subscribe("platform.*");
  rig = { sup, bus, sinks, histories, registry, shared, fake, events };
  return rig;
}

/** The `size` / `values()` slice of a discord.js attachment collection. */
function attachmentList(items: { url: string; name: string; contentType?: string }[]) {
  return { size: items.length, values: () => items.values() };
}

function guildMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "1000",
    type: MessageType.Default,
    channelId: "200",
    guildId: "300",
    channel: { type: ChannelType.GuildText, messages: { cache: new Map() } },
    author: { id: "42", username: "alice_w", globalName: "Alice", bot: false },
    member: { nickname: null },
    content: "hello",
    createdTimestamp: Date.parse("2026-11-01T12:00:00.000Z"),
    mentions: { users: new Map() },
    attachments: attachmentList([]),
    reference: null,
    ...overrides,
  };
}

async function next(r: Rig) {
  const env = await r.events.recv();
  if (!env) throw new Error("subscription closed");
  return env.event;
}

describe("GatewayBridge", () => {
  test("ready_announces_every_self_account_and_registers_the_sink_and_syncs_commands", async () => {
    const r = await boot(["300", "50"]);
    r.registry.register(commandSpec("ping", "Ping"), () => CommandReply.public("pong"));
    r.fake.client.emit(Events.ClientReady, r.fake.client);

    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const event = await next(r);
      expect(event.type).toBe("platform_ready");
      if (event.type === "platform_ready") {
        expect(event.data.platform).toBe("discord");
        ids.push(event.data.self_account.id);
      }
    }
    // The bot account first, then her other accounts in id order.
    expect(ids).toEqual(["100", "50", "300"]);
    expect(r.sinks.get("discord")?.platform).toBe("discord");
    expect(r.histories.get("discord")?.platform).toBe("discord");
    expect(r.shared.ready).toBe(true);

    // The command guild gets the set; the global scope and the other guild are cleared once.
    await waitUntil(() => r.fake.puts.length === 3);
    expect(r.fake.puts.map((p) => p.route)).toEqual([
      "/applications/100/guilds/77/commands",
      "/applications/100/commands",
      "/applications/100/guilds/88/commands",
    ]);
    expect(r.fake.puts[0]?.body).toMatchObject([
      { name: "ping", description: "Ping", options: [] },
    ]);
    expect(r.fake.puts[1]?.body).toEqual([]);
    expect(r.fake.puts[2]?.body).toEqual([]);

    // A second ready (reconnect) does not start a second sync task.
    r.fake.client.emit(Events.ClientReady, r.fake.client);
    await waitUntil(() => r.shared.ready);
    expect(r.fake.puts).toHaveLength(3);
  });

  test("messages_become_platform_events", async () => {
    const r = await boot(["100"]);
    r.fake.client.emit(
      Events.MessageCreate,
      guildMessage({ mentions: { users: new Map([["100", {}]]) } }),
    );
    const event = await next(r);
    expect(event.type).toBe("platform_message_created");
    if (event.type !== "platform_message_created") return;
    expect(event.data).toMatchObject({
      id: {
        id: "1000",
        context: { platform: "discord", scope: "300", channel: "200", kind: "channel" },
      },
      author: { display_name: "Alice", is_bot: false },
      text: "hello",
      mentions_self: true,
      reply_to_self: false,
      ts: "2026-11-01T12:00:00.000Z",
    });
  });

  test("replies_to_her_accounts_are_detected_via_the_referenced_message", async () => {
    const r = await boot(["100"]);
    r.fake.client.emit(
      Events.MessageCreate,
      guildMessage({
        type: MessageType.Reply,
        reference: { messageId: "999" },
        fetchReference: async () => ({ author: { id: "100" } }),
      }),
    );
    const event = await next(r);
    expect(event.type === "platform_message_created" && event.data.reply_to_self).toBe(true);
    // The cache is preferred over REST, and a failed fetch means "not a reply to her".
    const cached = guildMessage({
      type: MessageType.Reply,
      reference: { messageId: "999" },
      channel: {
        type: ChannelType.GuildText,
        messages: { cache: new Map([["999", { author: { id: "100" } }]]) },
      },
      fetchReference: async () => {
        throw new Error("must not be called");
      },
    });
    r.fake.client.emit(Events.MessageCreate, cached);
    const second = await next(r);
    expect(second.type === "platform_message_created" && second.data.reply_to_self).toBe(true);
    r.fake.client.emit(
      Events.MessageCreate,
      guildMessage({
        type: MessageType.Reply,
        reference: { messageId: "5" },
        fetchReference: async () => {
          throw new Error("Unknown Message");
        },
      }),
    );
    const third = await next(r);
    expect(third.type === "platform_message_created" && third.data.reply_to_self).toBe(false);
  });

  test("replies_carry_the_parent_reference_and_its_text", async () => {
    const r = await boot(["100"]);
    const parent = guildMessage({
      id: "999",
      author: { id: "55", username: "bob" },
      content: "要不要吃拉麵",
    });
    r.fake.client.emit(
      Events.MessageCreate,
      guildMessage({
        type: MessageType.Reply,
        reference: { messageId: "999", channelId: "200" },
        channel: {
          type: ChannelType.GuildText,
          messages: { cache: new Map([["999", parent]]) },
        },
      }),
    );
    const event = await next(r);
    if (event.type !== "platform_message_created") throw new Error("expected a message");
    expect(event.data.reply_to?.id).toBe("999");
    expect(event.data.referenced).toEqual({
      author: { platform: "discord", id: "55" },
      author_name: "bob",
      text: "要不要吃拉麵",
    });
    expect(event.data.reply_to_self).toBe(false);
  });

  test("sticker_embed_and_forward_only_messages_are_kept", async () => {
    const r = await boot();
    const none = attachmentList([]);
    r.fake.client.emit(
      Events.MessageCreate,
      guildMessage({
        id: "s",
        content: "",
        attachments: none,
        stickers: new Map([["1", { id: "1", name: "嗨" }]]),
      }),
    );
    r.fake.client.emit(
      Events.MessageCreate,
      guildMessage({ id: "e", content: "", embeds: [{ title: "連結", url: "https://x" }] }),
    );
    r.fake.client.emit(
      Events.MessageCreate,
      guildMessage({
        id: "f",
        content: "",
        reference: { messageId: "1", type: 1 },
        messageSnapshots: new Map([["1", { content: "轉傳" }]]),
      }),
    );
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const event = await next(r);
      if (event.type === "platform_message_created") ids.push(event.data.id.id);
    }
    expect(ids).toEqual(["s", "e", "f"]);
  });

  test("system_and_empty_messages_are_ignored", async () => {
    const r = await boot();
    r.fake.client.emit(Events.MessageCreate, guildMessage({ type: MessageType.UserJoin }));
    r.fake.client.emit(Events.MessageCreate, guildMessage({ content: "" }));
    r.fake.client.emit(Events.MessageCreate, guildMessage({ id: "1001", content: "real" }));
    const event = await next(r);
    expect(event.type === "platform_message_created" && event.data.id.id).toBe("1001");
  });

  test("attachment_only_messages_are_kept", async () => {
    const r = await boot();
    const attachments = attachmentList([
      { url: "https://x/y.png", name: "y.png", contentType: "image/png" },
    ]);
    r.fake.client.emit(Events.MessageCreate, guildMessage({ content: "", attachments }));
    const event = await next(r);
    expect(event.type === "platform_message_created" && event.data.attachments).toHaveLength(1);
  });

  test("dm_messages_are_dm_contexts", async () => {
    const r = await boot();
    r.fake.client.emit(
      Events.MessageCreate,
      guildMessage({
        guildId: null,
        channel: { type: ChannelType.DM, messages: { cache: new Map() } },
      }),
    );
    const event = await next(r);
    expect(event.type === "platform_message_created" && event.data.id.context).toEqual({
      platform: "discord",
      scope: null,
      channel: "200",
      kind: "dm",
    });
  });

  test("thread_kinds_come_from_thread_create_or_a_rest_lookup", async () => {
    const r = await boot();
    r.fake.client.emit(Events.ThreadCreate, { id: "t9", type: ChannelType.PrivateThread }, true);
    r.fake.client.emit(Events.MessageCreate, guildMessage({ channelId: "t9", channel: undefined }));
    let event = await next(r);
    expect(event.type === "platform_message_created" && event.data.id.context.kind).toBe("thread");

    // Unknown channel: one REST lookup, then remembered.
    for (let i = 0; i < 2; i++) {
      r.fake.client.emit(
        Events.MessageCreate,
        guildMessage({ id: `m${i}`, channelId: "thread-1", channel: undefined }),
      );
      event = await next(r);
      expect(event.type === "platform_message_created" && event.data.id.context.kind).toBe(
        "thread",
      );
    }
    expect(r.fake.client.channels.fetched).toEqual(["thread-1"]);
  });

  test("typing_becomes_a_platform_event", async () => {
    const r = await boot();
    r.fake.client.emit(Events.TypingStart, {
      guild: { id: "300" },
      channel: { id: "200", type: ChannelType.GuildText },
      user: { id: "42" },
    });
    const event = await next(r);
    expect(event).toEqual({
      type: "platform_typing",
      data: {
        context: { platform: "discord", scope: "300", channel: "200", kind: "channel" },
        account: { platform: "discord", id: "42" },
      },
    });
  });

  test("the_default_gate_drops_ambient_chat_but_not_mentions_or_dms", async () => {
    const r = await boot(["100"], { ambient_text: "allowlist", ambient_channels: ["201"] });
    r.fake.client.emit(Events.MessageCreate, guildMessage({ id: "ambient" }));
    r.fake.client.emit(Events.MessageCreate, guildMessage({ id: "listed", channelId: "201" }));
    r.fake.client.emit(
      Events.MessageCreate,
      guildMessage({ id: "mention", mentions: { users: new Map([["100", {}]]) } }),
    );
    r.fake.client.emit(
      Events.MessageCreate,
      guildMessage({
        id: "dm",
        guildId: null,
        channel: { type: ChannelType.DM, messages: { cache: new Map() } },
      }),
    );
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      const event = await next(r);
      if (event.type === "platform_message_created") seen.push(event.data.id.id);
    }
    // `ambient` never arrives; the other three do, in order.
    expect(seen).toEqual(["listed", "mention", "dm"]);
  });

  test("typing_in_a_channel_she_may_not_follow_is_not_published", async () => {
    const r = await boot([], { ambient_text: "allowlist", ambient_channels: ["201"] });
    r.fake.client.emit(Events.TypingStart, {
      guild: { id: "300" },
      channel: { id: "200", type: ChannelType.GuildText },
      user: { id: "42" },
    });
    r.fake.client.emit(Events.TypingStart, {
      guild: { id: "300" },
      channel: { id: "201", type: ChannelType.GuildText },
      user: { id: "42" },
    });
    const event = await next(r);
    expect(event.type === "platform_typing" && event.data.context.channel).toBe("201");
  });

  test("chat_input_interactions_run_commands", async () => {
    const r = await boot();
    r.registry.register(commandSpec("ping", "Ping"), (inv) =>
      CommandReply.public(`pong ${inv.invoker.id}`),
    );
    const replies: unknown[] = [];
    r.fake.client.emit(Events.InteractionCreate, {
      isChatInputCommand: () => true,
      commandName: "ping",
      user: { id: "42", username: "alice_w", globalName: null },
      guildId: "300",
      channelId: "200",
      channel: { type: ChannelType.GuildText },
      member: null,
      options: { data: [] },
      reply: async (o: unknown) => {
        replies.push(o);
      },
    });
    await waitUntil(() => replies.length === 1);
    expect(JSON.stringify(replies[0])).toContain('"content":"pong 42"');
    // Buttons are routed to the registry too; ids from others are left alone.
    const updates: unknown[] = [];
    const no = () => false;
    r.fake.client.emit(Events.InteractionCreate, {
      isChatInputCommand: no,
      isAutocomplete: no,
      isButton: () => true,
      isStringSelectMenu: no,
      isModalSubmit: no,
      customId: "someone-else:1",
      user: { id: "42", username: "alice_w", globalName: null },
      guildId: "300",
      channelId: "200",
      channel: { type: ChannelType.GuildText },
      member: null,
      message: { id: "m" },
      update: async (o: unknown) => {
        updates.push(o);
      },
      deferUpdate: async () => undefined,
      reply: async (o: unknown) => {
        updates.push(o);
      },
    });
    // Other interaction kinds are ignored.
    r.fake.client.emit(Events.InteractionCreate, {
      isChatInputCommand: no,
      isAutocomplete: no,
      isButton: no,
      isStringSelectMenu: no,
      isModalSubmit: no,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(updates).toEqual([]);
  });

  test("listener_failures_do_not_escape", async () => {
    const r = await boot();
    // `author` missing: incomingMessage throws inside the listener.
    r.fake.client.emit(Events.MessageCreate, guildMessage({ author: undefined }));
    r.fake.client.emit(Events.MessageCreate, guildMessage({ id: "ok" }));
    const event = await next(r);
    expect(event.type === "platform_message_created" && event.data.id.id).toBe("ok");
  });
});

/** Polls until `condition` holds (real timers, short). */
async function waitUntil(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not reached");
}
