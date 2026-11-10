import { describe, expect, test } from "vitest";
import { DiscordConfigSchema } from "../src/config.js";
import { ambientChannel, messageAllowed } from "../src/gate.js";

const SELF = new Set(["100"]);

function config(extra: Record<string, unknown> = {}) {
  return DiscordConfigSchema.parse({ token: "t", ...extra });
}

function message(extra: { author?: string; mention?: boolean; reply?: boolean } = {}) {
  return {
    author: {
      account: { platform: "discord", id: extra.author ?? "42" },
      display_name: "a",
      is_bot: false,
    },
    mentions_self: extra.mention ?? false,
    reply_to_self: extra.reply ?? false,
  };
}

describe("ambient text gate", () => {
  test("defaults_to_the_allowlist_with_nothing_on_it", () => {
    const cfg = config();
    expect(cfg.ambient_text).toBe("allowlist");
    expect(cfg.ambient_channels).toEqual([]);
  });

  test("ambient_chat_in_an_unlisted_guild_channel_is_dropped", () => {
    const cfg = config();
    expect(messageAllowed(cfg, message(), "300", { channel: "200" }, SELF)).toBe(false);
  });

  test("being_addressed_always_gets_through", () => {
    const cfg = config();
    expect(messageAllowed(cfg, message({ mention: true }), "300", { channel: "200" }, SELF)).toBe(
      true,
    );
    expect(messageAllowed(cfg, message({ reply: true }), "300", { channel: "200" }, SELF)).toBe(
      true,
    );
  });

  test("dms_and_her_own_accounts_always_get_through", () => {
    const cfg = config();
    expect(messageAllowed(cfg, message(), null, { channel: "9" }, SELF)).toBe(true);
    expect(messageAllowed(cfg, message({ author: "100" }), "300", { channel: "200" }, SELF)).toBe(
      true,
    );
  });

  test("listed_channels_and_the_threads_in_them_get_through", () => {
    const cfg = config({ ambient_channels: ["200"] });
    expect(messageAllowed(cfg, message(), "300", { channel: "200" }, SELF)).toBe(true);
    expect(messageAllowed(cfg, message(), "300", { channel: "t1", parent: "200" }, SELF)).toBe(
      true,
    );
    expect(messageAllowed(cfg, message(), "300", { channel: "201" }, SELF)).toBe(false);
    expect(ambientChannel(cfg, { channel: "201", parent: null })).toBe(false);
  });

  test("tiers_mode_leaves_everything_to_the_agent", () => {
    const cfg = config({ ambient_text: "tiers" });
    expect(messageAllowed(cfg, message(), "300", { channel: "200" }, SELF)).toBe(true);
    expect(ambientChannel(cfg, { channel: "200" })).toBe(true);
  });
});
