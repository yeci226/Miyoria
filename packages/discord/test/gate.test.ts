import type { ContextKey, PlaceConfig, Places, PlaceWhere, SpaceRef } from "@miyoria/types";
import { describe, expect, test } from "vitest";
import { type DiscordConfig, DiscordConfigSchema } from "../src/config.js";
import {
  type AmbientPlaces,
  ambientChannel,
  ambientFor,
  messageAllowed,
  newGuild,
  perGuild,
} from "../src/gate.js";

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

/**
 * Two servers: gA (primary) and gB (joined later, not established), and gE, a second server she
 * was already in before the upgrade (established, not primary). `perGuild` is each server's section after its
 * place settings; `rooms` a room's own values on top; `own` the Space keys set for it.
 */
function twoServers(
  cluster: Record<string, unknown>,
  perServer: Record<string, Record<string, unknown>> = {},
  rooms: Record<string, Record<string, unknown>> = {},
  own: string[] = [],
): { cluster: DiscordConfig; places: AmbientPlaces } {
  const base = config(cluster);
  const spaces: SpaceRef[] = [
    {
      id: "A",
      platform: "discord",
      external_id: "gA",
      name: "A",
      primary: true,
      established: true,
    },
    {
      id: "B",
      platform: "discord",
      external_id: "gB",
      name: "B",
      primary: false,
      established: false,
    },
    {
      id: "E",
      platform: "discord",
      external_id: "gE",
      name: "E",
      primary: false,
      established: true,
    },
  ];
  const places = {
    ofGuild: (_p: string, g: string) => spaces.find((s) => s.external_id === g) ?? null,
    spaces: () => spaces,
  } as unknown as Places;
  const placeConfig: PlaceConfig<DiscordConfig> = {
    base: () => base,
    for: (where: PlaceWhere) => {
      const ctx = where as ContextKey;
      const server = perServer[ctx.scope ?? ""];
      const room = rooms[ctx.channel];
      if (!server && !room) return base;
      return config({ ...cluster, ...server, ...room });
    },
    onChange: () => () => {},
  };
  return {
    cluster: base,
    places: { config: placeConfig, places, own: (space, key) => own.includes(`${space}.${key}`) },
  };
}

describe("the gate per server", () => {
  test("the_original_server_keeps_the_files_rules", () => {
    const { cluster, places } = twoServers({ ambient_text: "tiers" });
    const rules = ambientFor(cluster, places, "gA", { channel: "a1" });
    expect(rules.ambient_text).toBe("tiers");
    expect(messageAllowed(rules, message(), "gA", { channel: "a1" }, SELF)).toBe(true);
  });

  test("a_second_server_she_was_already_in_keeps_the_files_rules_too", () => {
    const { cluster, places } = twoServers({ ambient_text: "tiers", ambient_follow: true });
    const rules = ambientFor(cluster, places, "gE", { channel: "e1" });
    expect(rules).toEqual(ambientFor(cluster, places, "gA", { channel: "a1" }));
    expect(rules).toMatchObject({ ambient_text: "tiers", ambient_follow: true });
    expect(messageAllowed(rules, message(), "gE", { channel: "e1" }, SELF)).toBe(true);
    expect(newGuild(places.places, "gE")).toBe(false);
    expect(newGuild(places.places, "gA")).toBe(false);
    expect(newGuild(places.places, "gB")).toBe(true);
    const emoji = twoServers({ emoji: { descriptions: { fanfan: "討飯用" } } });
    const per = perGuild({ config: emoji.cluster, places: emoji.places }, (c) => c.emoji);
    expect(per.descriptions("gE")).toEqual({ fanfan: "討飯用" });
  });

  test("a_server_joined_later_hears_only_who_calls_her_until_set", () => {
    const { cluster, places } = twoServers({ ambient_text: "tiers", ambient_follow: true });
    const rules = ambientFor(cluster, places, "gB", { channel: "b1" });
    expect(rules).toEqual({
      ambient_text: "allowlist",
      ambient_channels: [],
      ambient_follow: null,
    });
    expect(messageAllowed(rules, message(), "gB", { channel: "b1" }, SELF)).toBe(false);
    expect(messageAllowed(rules, message({ mention: true }), "gB", { channel: "b1" }, SELF)).toBe(
      true,
    );
    expect(messageAllowed(rules, message({ reply: true }), "gB", { channel: "b1" }, SELF)).toBe(
      true,
    );
    // A server she has no record of yet is the same.
    expect(ambientFor(cluster, places, "gC", { channel: "c1" }).ambient_text).toBe("allowlist");
  });

  test("a_server_joined_later_follows_what_was_set_for_it", () => {
    const { cluster, places } = twoServers(
      { ambient_text: "tiers" },
      { gB: { ambient_text: "tiers", ambient_channels: ["202"] } },
      { 203: { ambient_follow: true } },
      ["B.ambient_text"],
    );
    expect(ambientFor(cluster, places, "gB", { channel: "201" }).ambient_text).toBe("tiers");
    const allow = twoServers(
      { ambient_text: "tiers" },
      { gB: { ambient_channels: ["202"] } },
      { 203: { ambient_follow: true } },
    );
    const b2 = ambientFor(allow.cluster, allow.places, "gB", { channel: "202" });
    expect(b2.ambient_text).toBe("allowlist");
    expect(messageAllowed(b2, message(), "gB", { channel: "202" }, SELF)).toBe(true);
    const b3 = ambientFor(allow.cluster, allow.places, "gB", { channel: "203" });
    expect(messageAllowed(b3, message(), "gB", { channel: "203" }, SELF)).toBe(true);
    const b1 = ambientFor(allow.cluster, allow.places, "gB", { channel: "201" });
    expect(messageAllowed(b1, message(), "gB", { channel: "201" }, SELF)).toBe(false);
  });

  test("a_room_can_be_unfollowed_although_listed", () => {
    const cfg = config({ ambient_channels: ["200"], ambient_follow: false });
    expect(ambientChannel(cfg, { channel: "200" })).toBe(false);
    expect(ambientChannel(config({ ambient_follow: true }), { channel: "201" })).toBe(true);
  });

  test("emoji_meanings_of_the_file_are_the_original_servers", () => {
    const { cluster, places } = twoServers(
      { emoji: { descriptions: { fanfan: "討飯用" } } },
      { gC: {} },
    );
    const per = perGuild({ config: cluster, places }, (c) => c.emoji);
    expect(per.descriptions("gA")).toEqual({ fanfan: "討飯用" });
    expect(per.descriptions("gB")).toEqual({});
    expect(per.enabled("gB")).toBe(true);
    const own = twoServers(
      { emoji: { descriptions: { fanfan: "討飯用" } } },
      { gB: { emoji: { descriptions: { fanfan: "B 的意思" }, enabled: false } } },
    );
    const perB = perGuild({ config: own.cluster, places: own.places }, (c) => c.emoji);
    expect(perB.descriptions("gB")).toEqual({ fanfan: "B 的意思" });
    expect(perB.enabled("gB")).toBe(false);
    expect(perB.descriptions("gA")).toEqual({ fanfan: "討飯用" });
  });
});
