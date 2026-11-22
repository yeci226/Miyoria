// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the tests use literal ${VAR} references
// Per-place settings (v5-data §6) and the one-off import of `miyoria.toml` (§7 step 5), against
// the repository's example config and small example files only.

import { readFileSync } from "node:fs";
import { parseTomlJson } from "@miyoria/runtime/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigImportError, SqliteStore } from "../src/index.js";

const EXAMPLE = readFileSync(new URL("../../../miyoria.example.toml", import.meta.url), "utf8");

const stores: SqliteStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

async function open(): Promise<SqliteStore> {
  const store = await SqliteStore.open(":memory:", {
    clock: { now: () => Date.UTC(2026, 10, 15) },
  });
  stores.push(store);
  return store;
}

function changes(store: SqliteStore, type: string) {
  return store.events.query({ types: [type], order: "asc" }).map((e) => e.envelope.data);
}

describe("place settings", () => {
  it("override one plugin's setting per space and per room, room first", async () => {
    const store = await open();
    const places = store.config.places;
    const spaceId = store.persons.ensureSpace("discord", "g1");
    const room = store.persons.ensureRoom("discord", "g1", "c1", "text");
    const other = store.persons.ensureRoom("discord", "g1", "c2", "text");
    expect(room.space_id).toBe(spaceId);

    places.set("space", spaceId, "agent", "mode", "quiet", "panel:p1");
    places.set("room", room.id, "agent", "mode", "lively", "panel:p1");
    places.set("space", spaceId, "daily", "post", { channel: "c1", on: true }, "panel:p1");
    expect(places.get("room", room.id, "agent", "mode")).toEqual({
      scope: "room",
      scope_id: room.id,
      plugin: "agent",
      key: "mode",
      value: "lively",
      updated_at: "2026-11-15T00:00:00.000Z",
      updated_by: "panel:p1",
    });
    expect(places.resolve("agent", "mode", { room_id: room.id, space_id: spaceId })).toEqual({
      value: "lively",
      scope: "room",
      scope_id: room.id,
    });
    expect(places.resolve("agent", "mode", { room_id: other.id, space_id: spaceId })).toEqual({
      value: "quiet",
      scope: "space",
      scope_id: spaceId,
    });
    expect(places.resolve("agent", "mode", { room_id: null, space_id: null })).toBeNull();
    expect(places.resolve("agent", "language", { room_id: room.id, space_id: spaceId })).toBeNull();
    expect(places.list().map((r) => [r.scope, r.plugin, r.key])).toEqual([
      ["space", "agent", "mode"],
      ["space", "daily", "post"],
      ["room", "agent", "mode"],
    ]);
    expect(places.list({ plugin: "daily" }).map((r) => r.value)).toEqual([
      { channel: "c1", on: true },
    ]);
    expect(places.list({ scope: "room", scope_id: room.id })).toHaveLength(1);

    // The same value again, or removing what is not there, writes nothing.
    places.set("room", room.id, "agent", "mode", "lively", "panel:p2");
    places.set("room", other.id, "agent", "mode", null, "panel:p2");
    places.set("room", room.id, "agent", "mode", null, "panel:p2");
    expect(places.get("room", room.id, "agent", "mode")).toBeNull();
    // Each change is one event for the owner, kept, with its place.
    expect(changes(store, "settings.changed")).toEqual([
      {
        scope: "space",
        scope_id: spaceId,
        plugin: "agent",
        key: "mode",
        value: "quiet",
        by: "panel:p1",
      },
      {
        scope: "room",
        scope_id: room.id,
        plugin: "agent",
        key: "mode",
        value: "lively",
        by: "panel:p1",
      },
      {
        scope: "space",
        scope_id: spaceId,
        plugin: "daily",
        key: "post",
        value: { channel: "c1", on: true },
        by: "panel:p1",
      },
      {
        scope: "room",
        scope_id: room.id,
        plugin: "agent",
        key: "mode",
        value: null,
        by: "panel:p2",
      },
    ]);
    const [first] = store.events.query({ types: ["settings.changed"], order: "asc", limit: 1 });
    expect(first?.envelope).toMatchObject({ scope: "owner", tier: "keep", space_id: spaceId });
  });

  it("refuses an unknown place, and a setting without a plugin or key", async () => {
    const store = await open();
    const places = store.config.places;
    expect(() => places.set("space", "nope", "agent", "mode", "quiet", "x")).toThrow(
      /unknown space `nope`/,
    );
    expect(() => places.set("room", "nope", "agent", "mode", "quiet", "x")).toThrow(
      /unknown room `nope`/,
    );
    const space = store.persons.ensureSpace("discord", "g1");
    expect(() => places.set("space", space, "", "mode", 1, "x")).toThrow(/plugin and a key/);
    expect(places.list()).toEqual([]);
  });
});

describe("importing miyoria.toml", () => {
  it("imports the example config as revision 1, as written", async () => {
    const store = await open();
    const result = store.importConfig(EXAMPLE);
    expect(result).toMatchObject({ imported: true, places: [], kept: [] });
    expect(result.revision).toMatchObject({
      version: 1,
      created_by: "import",
      note: "miyoria.toml",
    });
    // The whole file, env references unexpanded.
    expect(result.revision.doc).toEqual(parseTomlJson(EXAMPLE));
    const bot = (result.revision.doc.modules as Record<string, Record<string, unknown>>)[
      "platform.discord.bot"
    ];
    expect(bot?.token).toBe("${DISCORD_BOT_TOKEN:-}");
    expect(store.config.revisions.current()).toEqual(result.revision);
    expect(changes(store, "config.revised")).toEqual([
      expect.objectContaining({ version: 1, created_by: "import", note: "miyoria.toml" }),
    ]);
    // What the file turns off is off.
    expect(await store.moduleState.get("moderation")).toBe(
      (parseTomlJson(EXAMPLE).modules as Record<string, { enabled?: boolean }>).moderation
        ?.enabled ?? null,
    );

    // Once only.
    const again = store.importConfig(EXAMPLE);
    expect(again).toEqual({ imported: false, revision: result.revision, places: [], kept: [] });
    expect(store.config.revisions.history()).toHaveLength(1);
  });

  it("moves the per-channel levels that name a place to place settings", async () => {
    const store = await open();
    const toml = `
[core]
profile = "deepseek-chan"

[modules.agent]
default_mode = "quiet"
channels = { "discord:111" = "mention-only", "discord:111:222" = "lively", "discord:111:voice:333" = "normal", "444" = "quiet", "discord:dm:555" = "off" }
activeness = { "discord:111:222" = "high" }

[modules."ext.miyoria.osu"]
enabled = false
`;
    const result = store.importConfig(toml);
    const space = store.persons.ensureSpace("discord", "111");
    const text = store.persons.ensureRoom("discord", "111", "222", "text");
    const voice = store.persons.ensureRoom("discord", "111", "333", "voice");
    expect(voice.kind).toBe("voice");
    expect(result.places).toEqual([
      {
        from: 'modules.agent.channels."discord:111"',
        scope: "space",
        scope_id: space,
        plugin: "agent",
        key: "mode",
        value: "mention-only",
      },
      {
        from: 'modules.agent.channels."discord:111:222"',
        scope: "room",
        scope_id: text.id,
        plugin: "agent",
        key: "mode",
        value: "lively",
      },
      {
        from: 'modules.agent.channels."discord:111:voice:333"',
        scope: "room",
        scope_id: voice.id,
        plugin: "agent",
        key: "voice.mode",
        value: "normal",
      },
      {
        from: 'modules.agent.activeness."discord:111:222"',
        scope: "room",
        scope_id: text.id,
        plugin: "agent",
        key: "activeness_level",
        value: "high",
      },
    ]);
    // A bare channel id names no space and a DM key no person: they stay in the config.
    expect(result.kept).toEqual([
      "modules.agent.channels.444",
      'modules.agent.channels."discord:dm:555"',
    ]);
    expect(result.revision.doc).toEqual({
      core: { profile: "deepseek-chan" },
      modules: {
        agent: { default_mode: "quiet", channels: { "444": "quiet", "discord:dm:555": "off" } },
        "ext.miyoria.osu": { enabled: false },
      },
    });
    expect(
      store.config.places
        .list()
        .map((r) => [r.scope, r.scope_id, r.plugin, r.key, r.value, r.updated_by]),
    ).toEqual([
      ["space", space, "agent", "mode", "mention-only", "import"],
      ...[
        [text.id, "activeness_level", "high"],
        [text.id, "mode", "lively"],
        [voice.id, "voice.mode", "normal"],
      ]
        .sort(([a, x], [b, y]) => (`${a} ${x}` < `${b} ${y}` ? -1 : 1))
        .map(([id, key, value]) => ["room", id, "agent", key, value, "import"]),
    ]);
    expect(await store.moduleState.get("ext.miyoria.osu")).toBe(false);
    expect(changes(store, "settings.changed")).toHaveLength(4);
  });

  it("keeps a module a runtime toggle turned off before the import", async () => {
    const store = await open();
    await store.moduleState.set("speech", false);
    await store.moduleState.set("api", true);
    const result = store.importConfig('[modules.api]\ntoken = "${MIYORIA_API_TOKEN:-}"\n');
    // Two toggles wrote revisions 1 and 2.
    expect(result.revision).toMatchObject({ version: 3, created_by: "import" });
    expect(result.revision.doc).toEqual({
      modules: { api: { token: "${MIYORIA_API_TOKEN:-}" }, speech: { enabled: false } },
    });
    expect(await store.moduleState.list()).toEqual(new Map([["speech", false]]));
  });

  it("refuses a file that holds a secret as text, without echoing it", async () => {
    const store = await open();
    const toml = `[llm.providers.x]\napi_key = "sk-live-123"\n[modules.api]\ntoken = "abc"\n[stage.obs]\npassword = ""\n`;
    let error: unknown = null;
    try {
      store.importConfig(toml);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigImportError);
    expect((error as Error).message).toContain("`llm.providers.x.api_key`, `modules.api.token`");
    expect((error as Error).message).not.toContain("sk-live-123");
    expect((error as Error).message).not.toContain("password");
    expect(store.config.revisions.current()).toBeNull();
    expect(() => store.importConfig("not = [toml")).toThrow(/invalid TOML/);
  });

  it("keeps what the panel set over the file's values, and imports again only with replace", async () => {
    const store = await open();
    // The panel's layer before the import: a changed key, and a module turned off.
    store.config.revisions.write(
      { modules: { market: { auction_hours: 48, enabled: false }, party: { song_rounds: 9 } } },
      "panel:discord:1",
    );
    const toml = `[modules.market]\nauction_hours = 12\nauction_step = 5\n[modules.api]\ntoken = "\${MIYORIA_API_TOKEN:-}"\n`;
    const result = store.importConfig(toml);
    expect(result.imported).toBe(true);
    expect(result.revision?.doc).toEqual({
      modules: {
        market: { auction_hours: 48, auction_step: 5, enabled: false },
        party: { song_rounds: 9 },
        api: { token: "${MIYORIA_API_TOKEN:-}" },
      },
    });
    expect(result.plan?.panel).toEqual([
      "modules.market.auction_hours",
      "modules.party.song_rounds",
    ]);

    // Once imported, another run writes nothing; `replace` writes the file as it is.
    expect(store.importConfig(toml).imported).toBe(false);
    const replaced = store.importConfig(toml, { replace: true });
    expect(replaced.imported).toBe(true);
    expect(replaced.revision?.doc).toEqual({
      modules: {
        market: { auction_hours: 12, auction_step: 5, enabled: false },
        api: { token: "${MIYORIA_API_TOKEN:-}" },
      },
    });
    expect(store.config.revisions.history()).toHaveLength(3);
  });

  it("works it out without writing in a dry run", async () => {
    const store = await open();
    const toml = `[modules.agent]\nchannels = { "discord:111:222" = "lively" }\n[modules.market]\nauction_hours = 12\n`;
    const dry = store.importConfig(toml, { dryRun: true });
    expect(dry.imported).toBe(false);
    expect(dry.plan).toMatchObject({
      dry_run: true,
      base: null,
      changed: ["modules"],
      places: [
        {
          from: 'modules.agent.channels."discord:111:222"',
          scope: "room",
          place: "discord:111:222",
          scope_id: null,
          plugin: "agent",
          key: "mode",
          value: "lively",
          current: null,
          action: "write",
        },
      ],
    });
    expect(store.config.revisions.current()).toBeNull();
    expect(store.config.places.list()).toEqual([]);
    expect(store.places.spaces()).toEqual([]);
  });

  it("copies a server's channel into that server's place setting, and keeps a place's own value", async () => {
    const store = await open();
    const a = store.places.seen("discord", "111", "一號");
    const b = store.places.seen("discord", "222", "二號");
    store.persons.ensureRoom("discord", "111", "5001", "text");
    store.persons.ensureRoom("discord", "222", "6001", "text");
    // Server B already set its own lottery channel.
    store.config.places.set("space", b, "market", "lottery_channel", "6009", "panel:discord:1");
    const toml = [
      "[modules.market]",
      'auction_channel = "5001"',
      'lottery_channel = "6001"',
      "[modules.cards]",
      'drop_channels = ["5001", "6001", "7777"]',
      "[modules.karaoke]",
      'comment_channel = "discord:222:6002"',
    ].join("\n");
    const spaceChannels = [
      { module: "market", keys: ["auction_channel"], ref: "id" as const },
      { module: "market", keys: ["lottery_channel"], ref: "id" as const },
      { module: "cards", keys: ["drop_channels"], ref: "id" as const },
      { module: "karaoke", keys: ["comment_channel"], ref: "context" as const },
    ];
    const result = store.importConfig(toml, { spaceChannels });
    const rows = (space: string) =>
      store.config.places
        .list({ scope: "space", scope_id: space })
        .map((r) => [r.plugin, r.key, r.value, r.updated_by]);
    expect(rows(a)).toEqual([
      ["cards", "drop_channels", ["5001"], "import"],
      ["market", "auction_channel", "5001", "import"],
    ]);
    expect(rows(b)).toEqual([
      ["cards", "drop_channels", ["6001"], "import"],
      ["karaoke", "comment_channel", "discord:222:6002", "import"],
      ["market", "lottery_channel", "6009", "panel:discord:1"],
    ]);
    // A channel no one knows stays at cluster level only; so does the cluster value itself.
    expect(result.plan?.unplaced).toEqual(['modules.cards.drop_channels = "7777"']);
    expect(result.revision?.doc).toMatchObject({
      modules: {
        market: { auction_channel: "5001" },
        cards: { drop_channels: ["5001", "6001", "7777"] },
      },
    });
    expect(result.plan?.places.filter((p) => p.action === "keep")).toEqual([
      expect.objectContaining({
        plugin: "market",
        key: "lottery_channel",
        place: "discord:222",
        value: "6001",
        current: "6009",
      }),
    ]);
  });

  it("names the secrets it refuses", async () => {
    const store = await open();
    try {
      store.importConfig('[modules.api]\ntoken = "abc"\n');
      throw new Error("not refused");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigImportError);
      expect((error as ConfigImportError).secrets).toEqual(["modules.api.token"]);
    }
  });

  it("writes all of it or nothing", async () => {
    const store = await open();
    // A failure late in the import (writing the revision) undoes the places written before it.
    const toml = `[modules.agent]\nchannels = { "discord:1:2" = "lively" }\n`;
    const write = store.config.revisions.write.bind(store.config.revisions);
    store.config.revisions.write = () => {
      throw new Error("disk full");
    };
    try {
      expect(() => store.importConfig(toml)).toThrow(/disk full/);
    } finally {
      store.config.revisions.write = write;
    }
    expect(store.config.places.list()).toEqual([]);
    expect(changes(store, "settings.changed")).toEqual([]);
    expect(store.importConfig(toml).imported).toBe(true);
  });
});
