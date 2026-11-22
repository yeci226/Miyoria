// `[modules."platform.discord.bot"]` config section.
//
//   [modules."platform.discord.bot"]
//   token = "${DISCORD_BOT_TOKEN}"
//   command_guilds = ["123456789012345678"]   # or ["*"]: every server she is in
//   self_account_ids = ["234567890123456789"]
//
// Per server (docs/design/v5-places.md): `ambient_text`, `ambient_channels`, and the emoji's and
// stickers' `enabled` and `descriptions`; per room: `ambient_follow`. A server she joined after the
// original one starts quiet: until something is set for it there, only messages that mention or
// reply to her reach her, and the owner's emoji and sticker meanings of the file are not its own.

import { setting, settingGroups } from "@miyoria/runtime/kernel";
import { z } from "zod";

/**
 * A Discord snowflake as text. TOML integers above 2^53 lose precision when the config is
 * loaded, so ids that do not fit a JS number must be written as strings.
 */
const Snowflake = z.union([z.string(), z.number()]).transform((value, ctx) => {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      ctx.addIssue({
        code: "custom",
        message: `\`${value}\` is not a safe integer; write Discord ids as quoted strings`,
      });
      return z.NEVER;
    }
    return String(value);
  }
  const trimmed = value.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    ctx.addIssue({ code: "custom", message: `\`${value}\` is not a Discord id` });
    return z.NEVER;
  }
  return BigInt(trimmed).toString();
});

/**
 * `[modules."platform.discord.bot".emoji]`: the server's custom emoji (docs/design/server-emoji.md).
 *
 *   [modules."platform.discord.bot".emoji]
 *   descriptions = { fanfan = "一碗白飯,討飯用" }
 */
export const EmojiConfigSchema = z.object({
  /** Show her the server's custom emoji and turn her `:name:` into them. */
  enabled: z
    .boolean()
    .default(true)
    .meta(setting({ kind: "switch", scope: "space", label: "伺服器表情", group: "places" })),
  /**
   * The owner's meaning per emoji name; wins over the written one. Per server: a server joined
   * after the original one has only its own (the file's are the original server's).
   */
  descriptions: z
    .record(z.string(), z.string())
    .default({})
    .meta(setting({ kind: "rows", scope: "space", label: "表情的意思", group: "places" })),
  /** Have the image model write a line for emoji without one (once each, kept). */
  auto_describe: z.boolean().default(true),
  /** Emoji listed in her prompt, at most (ones with a meaning first). */
  max_listed: z.number().int().nonnegative().default(40),
  /** Server emoji in one message, at most. */
  per_message: z.number().int().nonnegative().default(1),
  /** Of her last `window_messages` messages in a channel, at most `max_in_window` carry one. */
  window_messages: z.number().int().positive().default(3),
  max_in_window: z.number().int().nonnegative().default(1),
});

export type EmojiConfig = z.output<typeof EmojiConfigSchema>;

/**
 * `[modules."platform.discord.bot".stickers]`: the server's stickers (docs/design/server-emoji.md).
 * She writes `[貼圖: 名字]` in a line and the sticker goes with that message; never in voice.
 *
 *   [modules."platform.discord.bot".stickers]
 *   descriptions = { "貓咪鞠躬" = "道謝用" }
 */
export const StickerConfigSchema = z.object({
  /** Show her the server's stickers and send the ones she writes. */
  enabled: z
    .boolean()
    .default(true)
    .meta(setting({ kind: "switch", scope: "space", label: "伺服器貼圖", group: "places" })),
  /**
   * The owner's meaning per sticker name; wins over the written one and the server's own. Per
   * server, like the emoji's.
   */
  descriptions: z
    .record(z.string(), z.string())
    .default({})
    .meta(setting({ kind: "rows", scope: "space", label: "貼圖的意思", group: "places" })),
  /** Have the image model write a line for stickers without one (once each, kept). */
  auto_describe: z.boolean().default(true),
  /** Stickers listed in her prompt, at most (ones with a meaning first). */
  max_listed: z.number().int().nonnegative().default(20),
  /** Of her last `window_messages` messages in a channel, at most `max_in_window` carry one. */
  window_messages: z.number().int().positive().default(5),
  max_in_window: z.number().int().nonnegative().default(1),
  /** Stickers per channel per rolling hour, at most. */
  per_hour: z.number().int().nonnegative().default(3),
});

export type StickerConfig = z.output<typeof StickerConfigSchema>;

/** `command_guilds = ["*"]`: every server she is in. */
export const ALL_GUILDS = "*";

/**
 * A guild id, or `"*"`. One schema, not a union with `Snowflake`: a union would answer a bad id
 * with "Invalid input" instead of the sentence that says what is wrong with it.
 */
const GuildOrAll = z.union([z.string(), z.number()]).transform((value, ctx): string => {
  if (value === ALL_GUILDS) return ALL_GUILDS;
  const parsed = Snowflake.safeParse(value);
  if (parsed.success) return parsed.data;
  for (const issue of parsed.error.issues) ctx.addIssue({ code: "custom", message: issue.message });
  return z.NEVER;
});

export const DiscordConfigSchema = z
  .object({
    /** Bot token. Keep it in the environment, not in the file. */
    token: z.string(),
    /**
     * Guilds that get the slash commands (updates apply instantly). Empty registers them
     * globally, which can take a while to propagate. `["*"]`: every server she is in, and each
     * server she joins as it joins.
     */
    command_guilds: z.array(GuildOrAll).default([]),
    /**
     * Her other accounts (e.g. the self account used by the voice node). Mentions of and replies
     * to them count as addressing her.
     */
    self_account_ids: z.array(z.string()).default([]),
    /**
     * Request the privileged Presence and Server Members intents, so she knows who is online,
     * what they play or listen to, and who is in which voice channel. Both must also be enabled
     * in the Developer Portal (Bot -> Privileged Gateway Intents), otherwise Discord refuses the
     * connection; set `false` to run without them.
     */
    presence_intents: z.boolean().default(true),
    /**
     * Which guild messages she gets to read (docs/design/v3-architecture.md §19 item 4):
     *
     * - `allowlist` (default): a guild message reaches her only when it mentions her, replies to
     *   her, or is in a channel listed in `ambient_channels`. DMs always do.
     * - `tiers`: every message reaches her and the per-channel level (`/miyo` -> chat level)
     *   decides how much she joins in. This was the behaviour before the gate existed.
     */
    ambient_text: z
      .enum(["allowlist", "tiers"])
      .default("allowlist")
      .meta(
        setting({
          kind: "select",
          scope: "space",
          label: "她讀得到哪些訊息",
          help: "allowlist:只有提及她、回覆她,或跟隨的頻道;tiers:全部,由聊天等級決定",
          labels: { allowlist: "只有叫她的和跟隨的頻道", tiers: "全部(看聊天等級)" },
          group: "places",
        }),
      ),
    /** Channels (or the channels threads belong to) where she may follow ambient chat. */
    ambient_channels: z
      .array(Snowflake)
      .default([])
      .meta(
        setting({
          kind: "channel",
          ref: "id",
          multiple: true,
          room: "text",
          scope: "space",
          label: "跟隨的頻道",
          group: "places",
        }),
      ),
    /**
     * One room's own say (`place_settings`, scope room): `true` she follows its ambient chat,
     * `false` she does not even when it is in `ambient_channels`; unset: as `ambient_channels` says.
     * A thread takes its channel's.
     */
    ambient_follow: z
      .boolean()
      .nullable()
      .default(null)
      .meta(
        setting({
          kind: "switch",
          scope: "room",
          label: "跟隨這個頻道的聊天",
          group: "places",
        }),
      ),
    emoji: EmojiConfigSchema.prefault({}),
    stickers: StickerConfigSchema.prefault({}),
    /**
     * The most bytes the files of one message of hers may be together (artifacts she shares as
     * attachments). Discord's own default limit for a bot is 10 MiB; a boosted guild takes more,
     * and a larger value here only helps there.
     */
    max_upload_bytes: z.number().int().positive().default(10_485_760),
  })
  .meta(settingGroups([{ id: "places", label: "每個伺服器" }]));

export type DiscordConfig = z.output<typeof DiscordConfigSchema>;

/** Rejects configs that parse but cannot work. Never includes the token in the message. */
export function validateDiscordConfig(config: DiscordConfig): void {
  if (config.token.trim() === "") throw new Error("`token` is empty");
  if (config.command_guilds.some((g) => g !== ALL_GUILDS && BigInt(g) === 0n)) {
    throw new Error("`command_guilds` contains 0");
  }
}

/** Whether `command_guilds` asks for every server she is in (`["*"]`). */
export function allGuilds(config: Pick<DiscordConfig, "command_guilds">): boolean {
  return config.command_guilds.includes(ALL_GUILDS);
}
