import { configJsonSchema, placeFields, settingFields } from "@miyoria/runtime/kernel";
import { describe, expect, test } from "vitest";
import { allGuilds, DiscordConfigSchema, validateDiscordConfig } from "../src/config.js";

describe("DiscordConfig", () => {
  test("token_is_required", () => {
    expect(DiscordConfigSchema.safeParse({}).success).toBe(false);
    const cfg = DiscordConfigSchema.parse({ token: "abc" });
    expect(() => validateDiscordConfig(cfg)).not.toThrow();
    expect(cfg.command_guilds).toEqual([]);
    expect(cfg.self_account_ids).toEqual([]);
    const blank = DiscordConfigSchema.parse({ token: " ", command_guilds: [1] });
    expect(() => validateDiscordConfig(blank)).toThrow("`token` is empty");
  });

  test("ambient_text_defaults_to_the_allowlist", () => {
    const cfg = DiscordConfigSchema.parse({
      token: "t",
      ambient_channels: [42, "123456789012345678"],
    });
    expect(cfg.ambient_text).toBe("allowlist");
    expect(cfg.ambient_channels).toEqual(["42", "123456789012345678"]);
    expect(DiscordConfigSchema.parse({ token: "t" }).ambient_channels).toEqual([]);
    expect(DiscordConfigSchema.safeParse({ token: "t", ambient_text: "everywhere" }).success).toBe(
      false,
    );
  });

  test("command_guilds_accept_numbers_and_strings", () => {
    const cfg = DiscordConfigSchema.parse({
      token: "t",
      command_guilds: [42, "123456789012345678"],
    });
    expect(cfg.command_guilds).toEqual(["42", "123456789012345678"]);
    expect(() =>
      validateDiscordConfig(DiscordConfigSchema.parse({ token: "t", command_guilds: [0] })),
    ).toThrow("`command_guilds` contains 0");
  });

  test("unsafe_integers_are_rejected_instead_of_silently_rounded", () => {
    const parsed = DiscordConfigSchema.safeParse({
      token: "t",
      command_guilds: [Number("123456789012345678")],
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("quoted strings");
    expect(DiscordConfigSchema.safeParse({ token: "t", command_guilds: ["abc"] }).success).toBe(
      false,
    );
  });

  test("validation_errors_never_contain_the_token", () => {
    const cfg = DiscordConfigSchema.parse({ token: "SECRET-TOKEN", command_guilds: [0] });
    expect(() => validateDiscordConfig(cfg)).toThrow(/command_guilds/);
    try {
      validateDiscordConfig(cfg);
    } catch (error) {
      expect(String(error)).not.toContain("SECRET-TOKEN");
    }
  });

  test("a_star_means_every_server", () => {
    const cfg = DiscordConfigSchema.parse({ token: "t", command_guilds: ["*"] });
    expect(cfg.command_guilds).toEqual(["*"]);
    expect(allGuilds(cfg)).toBe(true);
    expect(() => validateDiscordConfig(cfg)).not.toThrow();
    expect(allGuilds(DiscordConfigSchema.parse({ token: "t", command_guilds: [1] }))).toBe(false);
  });

  test("the_fields_that_differ_per_server_and_room", () => {
    expect(settingFields(configJsonSchema(DiscordConfigSchema)).skipped).toEqual([]);
    expect(placeFields(DiscordConfigSchema).map((f) => [f.keys.join("."), f.scope])).toEqual([
      ["ambient_text", "space"],
      ["ambient_channels", "space"],
      ["ambient_follow", "room"],
      ["emoji.enabled", "space"],
      ["emoji.descriptions", "space"],
      ["stickers.enabled", "space"],
      ["stickers.descriptions", "space"],
    ]);
  });
});
