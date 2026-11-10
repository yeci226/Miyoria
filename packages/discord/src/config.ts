// `[modules."platform.discord.bot"]` config section.
//
//   [modules."platform.discord.bot"]
//   token = "${DISCORD_BOT_TOKEN}"
//   command_guilds = ["123456789012345678"]
//   self_account_ids = ["234567890123456789"]

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

export const DiscordConfigSchema = z.object({
  /** Bot token. Keep it in the environment, not in the file. */
  token: z.string(),
  /**
   * Guilds that get the slash commands (updates apply instantly). Empty registers them
   * globally, which can take a while to propagate.
   */
  command_guilds: z.array(Snowflake).default([]),
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
  ambient_text: z.enum(["allowlist", "tiers"]).default("allowlist"),
  /** Channels (or the channels threads belong to) where she may follow ambient chat. */
  ambient_channels: z.array(Snowflake).default([]),
});

export type DiscordConfig = z.output<typeof DiscordConfigSchema>;

/** Rejects configs that parse but cannot work. Never includes the token in the message. */
export function validateDiscordConfig(config: DiscordConfig): void {
  if (config.token.trim() === "") throw new Error("`token` is empty");
  if (config.command_guilds.some((g) => BigInt(g) === 0n)) {
    throw new Error("`command_guilds` contains 0");
  }
}
