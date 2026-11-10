// Module `platform.discord.bot`: the official bot account. Text messages, reactions, typing and
// slash commands; never voice.
//
// Developer Portal setup:
//
// 1. Create an application at https://discord.com/developers/applications and add a bot under
//    **Bot**. Copy its token into the environment (e.g. `DISCORD_BOT_TOKEN`) and reference it
//    as `token = "${DISCORD_BOT_TOKEN}"`.
// 2. Under **Bot -> Privileged Gateway Intents**, enable **Message Content Intent**, and (unless
//    `presence_intents = false`) **Presence Intent** and **Server Members Intent**. Without them
//    the gateway refuses to connect (disallowed intents, close code 4014) and the module keeps
//    failing.
// 3. Invite the bot with the `bot` and `applications.commands` scopes and the permissions View
//    Channels, Send Messages, Send Messages in Threads, Read Message History and Add Reactions.
// 4. For instant command updates during development, list your server ids in `command_guilds`;
//    otherwise commands are registered globally. The first sync of every run clears the scope
//    not in use, so switching modes leaves no duplicates; `miyoria discord commands reset`
//    clears everything by hand.

import { CommandRegistryKey, CommandsModule } from "@miyoria/commands";
import {
  defineManifest,
  errorMessage,
  HEALTHY,
  type Health,
  type Module,
  type ModuleContext,
  type ModuleManifest,
  withTimeout,
} from "@miyoria/kernel";
import { LlmRouterKey, userMessage, withLlmTag } from "@miyoria/llm";
import { SettingsStoreKey } from "@miyoria/store";
import {
  PlatformHistoriesKey,
  PlatformSinksKey,
  ProfileIdKey,
  PromptContributorsKey,
} from "@miyoria/types";
import { Client, Events, GatewayIntentBits, Options, Partials } from "discord.js";
import { DiscordConfigSchema, validateDiscordConfig } from "./config.js";
import { emojiContributor } from "./emoji.js";
import {
  DESCRIBE_PROMPT,
  DESCRIPTION_PREFIX,
  type Describe,
  type DescriptionStore,
  EmojiDescriber,
} from "./emoji-describe.js";
import { GatewayBridge, Shared } from "./handler.js";
import { PLATFORM, parseUserIds } from "./mapping.js";

/** How long to wait for the gateway to close after a shutdown request. */
export const SHUTDOWN_GRACE_MS = 3_000;

/** Gateway close codes after which reconnecting is pointless. */
const FATAL_CLOSE_CODES: ReadonlySet<number> = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

/** Close code of a gateway refusing intents the application has not enabled. */
const DISALLOWED_INTENTS = 4014;

/**
 * Gateway intents the bot needs. `MessageContent` is privileged and must be enabled in the
 * Developer Portal, as must `GuildPresences` and `GuildMembers` when `presence` is on.
 * Voice states are not privileged.
 */
export function intents(options: { presence?: boolean } = {}): number {
  const base =
    GatewayIntentBits.Guilds |
    GatewayIntentBits.GuildMessages |
    GatewayIntentBits.DirectMessages |
    GatewayIntentBits.MessageContent |
    GatewayIntentBits.GuildMessageTyping |
    GatewayIntentBits.DirectMessageTyping |
    GatewayIntentBits.GuildVoiceStates |
    // Custom emoji added, renamed or removed (the server emoji table; not privileged).
    GatewayIntentBits.GuildExpressions |
    // Reactions to her messages are feedback she learns from (not privileged).
    GatewayIntentBits.GuildMessageReactions |
    GatewayIntentBits.DirectMessageReactions;
  return options.presence
    ? base | GatewayIntentBits.GuildPresences | GatewayIntentBits.GuildMembers
    : base;
}

/**
 * Creates the client. Channel and user partials are needed for DMs and typing events, the member
 * partial for members leaving uncached.
 */
export function createClient(options: { presence?: boolean } = {}): Client {
  return new Client({
    intents: intents(options),
    // Message and reaction partials: reactions on messages that are not cached any more.
    partials: [
      Partials.Channel,
      Partials.User,
      Partials.GuildMember,
      Partials.Message,
      Partials.Reaction,
    ],
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      MessageManager: 100,
    }),
  });
}

export class DiscordBotModule implements Module {
  static readonly ID = "platform.discord.bot";

  readonly manifest: ModuleManifest = defineManifest(DiscordBotModule.ID, "Discord bot", {
    description: "Discord bot account: text messages and slash commands",
    requires: [CommandsModule.ID],
    // Starts after `world`, whose `PresencePrivacy` decides whose presence may be published.
    optional: ["world"],
    configSchema: DiscordConfigSchema,
  });

  #running: Shared | null = null;
  #unregister: (() => void)[] = [];

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(DiscordConfigSchema);
    validateDiscordConfig(config);
    const selfIds = parseUserIds(config.self_account_ids);
    const registry = ctx.services.require(CommandRegistryKey);
    const sinks = ctx.services.get(PlatformSinksKey) ?? null;
    if (sinks === null) {
      ctx.log.warn("PlatformSinks service missing; output actions cannot reach Discord");
    }
    const histories = ctx.services.get(PlatformHistoriesKey) ?? null;
    const shared = new Shared(config, selfIds, registry, sinks, histories);
    this.#running = shared;
    const client = createClient({ presence: config.presence_intents });
    new GatewayBridge(ctx, shared).attach(client);
    this.#startEmoji(ctx, shared);
    // The token stays in this closure; it is never logged or put in an error message.
    const token = config.token;
    ctx.spawn("gateway", (signal) => runGateway(client, token, shared, ctx, signal));
  }

  /** The server emoji block, and meanings written for new emoji in the background. */
  #startEmoji(ctx: ModuleContext, shared: Shared): void {
    const config = shared.config.emoji;
    const describer = new EmojiDescriber(descriptionStore(ctx), describeWithModel(ctx));
    const owner = (name: string): string | undefined =>
      config.descriptions[name]?.trim() || undefined;
    const contributors = ctx.services.get(PromptContributorsKey);
    const contributor = emojiContributor(
      shared.emoji,
      { owner, described: (id) => describer.get(id) },
      { max_listed: config.max_listed, enabled: () => config.enabled },
    );
    contributors?.register(contributor);
    this.#unregister.push(() => contributors?.unregister(contributor.key));
    void describer.load();
    if (!config.enabled || !config.auto_describe) return;
    const controller = new AbortController();
    this.#unregister.push(() => controller.abort());
    const off = shared.emoji.onChange(() => {
      void describer.describeMissing(
        shared.emoji.all().filter((e) => e.available),
        (e) => owner(e.name) !== undefined,
        controller.signal,
      );
    });
    this.#unregister.push(off);
  }

  async stop(): Promise<void> {
    for (const undo of this.#unregister.splice(0)) undo();
    const shared = this.#running;
    this.#running = null;
    if (shared) {
      shared.ready = false;
      shared.sessions.closeAll();
      shared.sinks?.unregister(PLATFORM);
      shared.histories?.unregister(PLATFORM);
    }
  }

  async health(): Promise<Health> {
    const shared = this.#running;
    if (shared === null) return { status: "unhealthy", reason: "not running" };
    return shared.ready ? HEALTHY : { status: "degraded", reason: "connecting to Discord" };
  }
}

/** Written emoji meanings in the settings store; `null` without one. */
function descriptionStore(ctx: ModuleContext): DescriptionStore | null {
  const store = ctx.services.get(SettingsStoreKey);
  const profile = ctx.services.get(ProfileIdKey);
  if (!store || profile === undefined) return null;
  return {
    async load() {
      const out = new Map<string, string>();
      for (const [key, value] of await store.list(profile, DESCRIPTION_PREFIX)) {
        if (typeof value === "string") out.set(key.slice(DESCRIPTION_PREFIX.length), value);
      }
      return out;
    },
    save: (id, line) => store.set(profile, `${DESCRIPTION_PREFIX}${id}`, line),
  };
}

/** The chat model looks at an emoji, when it takes images; `null` otherwise. */
function describeWithModel(ctx: ModuleContext): Describe | null {
  return async (dataUrl, name, signal) => {
    const router = ctx.services.get(LlmRouterKey);
    if (router?.takesImages("chat") !== true) return null;
    const response = await withLlmTag({ module: "discord", label: "emoji" }, () =>
      router.complete(
        "chat",
        {
          messages: [
            userMessage([
              { type: "text", text: DESCRIBE_PROMPT(name) },
              { type: "image_url", image_url: { url: dataUrl, detail: "low" } },
            ]),
          ],
          max_tokens: 80,
          thinking: false,
          reasoning_purpose: "emoji",
        },
        signal,
      ),
    );
    return response.text;
  };
}

/**
 * Logs in and keeps the gateway open until `signal` aborts (then closes it cleanly). Rejects when
 * the login fails or Discord closes the gateway for good (bad token, disallowed intents), so the
 * supervisor restarts the module with backoff.
 */
async function runGateway(
  client: Client,
  token: string,
  shared: Shared,
  ctx: ModuleContext,
  signal: AbortSignal,
): Promise<void> {
  const aborted = new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
  const fatal = new Promise<never>((_, reject) => {
    client.on(Events.ShardDisconnect, (event) => {
      shared.ready = false;
      if (event.code === DISALLOWED_INTENTS) {
        ctx.log.error(
          "Discord refused the gateway intents: enable Message Content, Presence and Server Members under Bot -> Privileged Gateway Intents, or set presence_intents = false",
        );
      }
      if (FATAL_CLOSE_CODES.has(event.code)) {
        reject(new Error(`Discord gateway closed with code ${event.code}`));
      }
    });
  });
  // Handled below via the race; this keeps a late rejection (after shutdown) from being unhandled.
  fatal.catch(() => undefined);
  client.on(Events.ShardReady, () => {
    shared.ready = true;
  });
  client.on(Events.ShardResume, () => {
    shared.ready = true;
  });
  client.on(Events.Error, (error) => {
    ctx.log.warn({ error: errorMessage(error) }, "Discord client error");
  });
  client.on(Events.ShardError, (error) => {
    ctx.log.warn({ error: errorMessage(error) }, "Discord shard error");
  });

  const login = client.login(token);
  login.catch(() => undefined); // an abort during login settles the race below instead
  try {
    await Promise.race([login, aborted, fatal]);
    if (!signal.aborted) await Promise.race([aborted, fatal]);
  } finally {
    ctx.log.info("shutting down Discord gateway");
    await withTimeout(
      client.destroy().catch((error: unknown) => {
        ctx.log.debug({ error: errorMessage(error) }, "error while closing the gateway");
      }),
      SHUTDOWN_GRACE_MS,
    );
  }
}
