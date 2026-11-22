// The levels per place (docs/design/v5-places.md): a room's own value, its channel's (a thread),
// its Space's, then `[modules.agent]` and the profile; a server joined later starts quiet; the old
// `channel_mode:` / `activeness:` keys move into `place_settings` once.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Db, identitySchema, migrate, SqliteStore } from "@miyoria/store";
import {
  type ContextKey,
  isJsonObject,
  type JsonObject,
  type PlaceConfig,
  type PlaceWhere,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { newOverrides } from "../src/handle.js";
import {
  type AgentConfig,
  AgentConfigSchema,
  AgentHandle,
  LEVEL_KEYS,
  PLACES_MIGRATION_KEY,
  UnknownPlaceError,
} from "../src/index.js";
import { PersonaHandle } from "../src/persona.js";
import { profile } from "./harness.js";

const ctx = (
  scope: string | null,
  channel: string,
  kind: ContextKey["kind"] = "channel",
): ContextKey => ({ platform: "discord", scope, channel, kind });

const stores: SqliteStore[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
  for (const c of cleanups.splice(0)) c();
});

/**
 * The agent's section per place, the way Core's `PlaceConfig` resolves it for these fields
 * (core/test/place-config.test.ts tests that one): room, then the thread's channel, then the Space.
 */
function placeConfigOf(store: SqliteStore, section: JsonObject): PlaceConfig<AgentConfig> {
  const base = AgentConfigSchema.parse(section);
  const keys = Object.values(LEVEL_KEYS);
  return {
    base: () => base,
    for: (where: PlaceWhere) => {
      if (!where || !("channel" in where)) return base;
      const at = store.places.at(where);
      const space =
        at?.space_id ??
        (where.scope === null
          ? null
          : (store.places.ofGuild(where.platform, where.scope)?.id ?? null));
      if (space === null) return base;
      const layers: ["room" | "space", string | null][] = [
        ["room", at?.room_id ?? null],
        ["room", at?.parent_room_id ?? null],
        ["space", space],
      ];
      const out = JSON.parse(JSON.stringify(section)) as JsonObject;
      for (const key of keys) {
        for (const [scope, id] of layers) {
          if (id === null) continue;
          const row = store.config.places.get(scope, id, "agent", key);
          if (row === null) continue;
          const [head, tail] = key.split(".") as [string, string | undefined];
          if (tail === undefined) out[head] = row.value;
          else {
            const inner = isJsonObject(out[head] ?? null) ? (out[head] as JsonObject) : {};
            out[head] = { ...inner, [tail]: row.value };
          }
          break;
        }
      }
      return AgentConfigSchema.parse(out);
    },
    onChange: () => () => {},
  };
}

/** Two servers: A (primary) with a1, a2, a thread at under a1 and a voice room av; B with b1. */
async function setup(section: JsonObject = {}, mode = "quiet") {
  let now = Date.UTC(2026, 10, 22);
  const store = await SqliteStore.open(":memory:", { clock: { now: () => now++ } });
  stores.push(store);
  const author = (id: string) => ({ account: { platform: "discord", id }, display_name: id });
  const a1 = store.persons.resolve(ctx("gA", "a1"), author("1"));
  store.persons.resolve(ctx("gA", "a2"), author("1"));
  const at = store.persons.resolve(ctx("gA", "at", "thread"), author("1"), { parent: "a1" });
  const av = store.persons.resolve(ctx("gA", "av", "voice"), author("1"));
  const b1 = store.persons.resolve(ctx("gB", "b1"), author("2"));
  const A = a1.space_id as string;
  const B = b1.space_id as string;
  const persona = new PersonaHandle(profile(mode));
  const config = AgentConfigSchema.parse(section);
  const make = () =>
    new AgentHandle(
      config,
      persona,
      newOverrides(),
      new Map(),
      { state: "ok" },
      store.settings,
      { now: () => now },
      {
        places: store.places,
        settings: store.config.places,
        config: placeConfigOf(store, section),
      },
    );
  const set = (scope: "space" | "room", id: string, key: string, value: string | null) =>
    store.config.places.set(scope, id, "agent", key, value, "test");
  return { store, make, set, A, B, a1, at, av, b1 };
}

/**
 * An install upgraded with two servers she was already in: gA (primary) and gE, both written in
 * before identity v4 ran, so both are established; then gN, a server first seen after it.
 */
async function upgraded(section: JsonObject = {}) {
  let now = Date.UTC(2026, 10, 22);
  const clock = { now: () => now++ };
  const dir = mkdtempSync(join(tmpdir(), "miyoria-established-"));
  const path = join(dir, "core.db");
  const before = new Db(new DatabaseSync(path), clock);
  migrate(before, [{ ...identitySchema, migrations: identitySchema.migrations.slice(0, 3) }]);
  // As the build of before wrote them (its own SQL: this build's tables have the v4 column).
  before.run(
    `INSERT INTO spaces (id, platform, external_id, name, joined_at, is_primary)
     VALUES ('s-a', 'discord', 'gA', 'A', 1, 1), ('s-e', 'discord', 'gE', 'E', 2, 0)`,
  );
  before.close();
  const author = (id: string) => ({ account: { platform: "discord", id }, display_name: id });
  const store = await SqliteStore.open(path, { clock });
  stores.push(store);
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  store.persons.resolve(ctx("gA", "a1"), author("1"));
  store.persons.resolve(ctx("gE", "e1"), author("2"));
  store.persons.resolve(ctx("gN", "n1"), author("3"));
  const persona = new PersonaHandle(profile("quiet"));
  const handle = new AgentHandle(
    AgentConfigSchema.parse(section),
    persona,
    newOverrides(),
    new Map(),
    { state: "ok" },
    store.settings,
    { now: () => now },
    { places: store.places, settings: store.config.places, config: placeConfigOf(store, section) },
  );
  return { store, handle };
}

describe("levels per place", () => {
  it("resolves the room, the thread's channel, the Space, the file, then the profile", async () => {
    const { make, set, A, a1 } = await setup({ channels: { "discord:gA:a2": "lively" } });
    const h = make();
    expect(h.channelMode(ctx("gA", "a1"))).toBe("quiet"); // the profile
    expect(h.channelMode(ctx("gA", "a2"))).toBe("lively"); // the file's `channels`
    set("space", A, "mode", "normal");
    expect(h.channelMode(ctx("gA", "a1"))).toBe("normal");
    expect(h.channelMode(ctx("gA", "at", "thread"))).toBe("normal");
    // A Space's value wins over the file's per-channel entry, a room's over both.
    expect(h.channelMode(ctx("gA", "a2"))).toBe("normal");
    set("room", a1.room_id, "mode", "off");
    expect(h.channelMode(ctx("gA", "a1"))).toBe("off");
    expect(h.channelMode(ctx("gA", "at", "thread"))).toBe("off");
    expect(h.channelModeOverride(ctx("gA", "a1"))).toBe("off");
    expect(h.channelModeOverride(ctx("gA", "at", "thread"))).toBeNull();
    expect(h.configuredChannelMode(ctx("gA", "a1"))).toBe("normal");
    expect(h.configuredChannelMode(ctx("gA", "at", "thread"))).toBe("off");
    expect(h.spaceChannelMode(ctx("gA", "a1"))).toBe("normal");
    expect(h.configuredSpaceMode(ctx("gA", "a1"))).toBe("quiet");
  });

  it("keeps voice and text apart in one room", async () => {
    const { make, set, av } = await setup();
    const h = make();
    set("room", av.room_id, LEVEL_KEYS.voiceMode, "mention-only");
    expect(h.channelMode(ctx("gA", "av", "voice"))).toBe("mention-only");
    expect(h.channelMode(ctx("gA", "av"))).toBe("quiet");
    set("room", av.room_id, LEVEL_KEYS.voiceActiveness, "high");
    expect(h.activeness(ctx("gA", "av", "voice"))).toBe("high");
    expect(h.activeness(ctx("gA", "av"))).toBe("medium");
  });

  it("starts a server joined later quiet, until something is set for it", async () => {
    const { make, set, B, b1 } = await setup({ default_mode: "normal" });
    const h = make();
    expect(h.inNewSpace(ctx("gA", "a1"))).toBe(false);
    expect(h.inNewSpace(ctx("gB", "b1"))).toBe(true);
    expect(h.channelMode(ctx("gA", "a1"))).toBe("normal");
    expect(h.channelMode(ctx("gB", "b1"))).toBe("mention-only");
    expect(h.activeness(ctx("gB", "b1"))).toBe("low");
    // A server she has no record of yet is new too.
    expect(h.channelMode(ctx("gC", "c1"))).toBe("mention-only");
    set("space", B, "mode", "lively");
    expect(h.channelMode(ctx("gB", "b1"))).toBe("lively");
    set("room", b1.room_id, LEVEL_KEYS.activeness, "high");
    expect(h.activeness(ctx("gB", "b1"))).toBe("high");
    // Server A's levels never reach B.
    expect(h.channelMode(ctx("gA", "a1"))).toBe("normal");
  });

  it("keeps every server she was already in at the upgrade as it was; only a later one starts quiet", async () => {
    const { store, handle: h } = await upgraded({ default_mode: "normal" });
    const space = (g: string) => store.places.ofGuild("discord", g);
    expect(space("gA")).toMatchObject({ primary: true, established: true });
    expect(space("gE")).toMatchObject({ primary: false, established: true });
    expect(space("gN")).toMatchObject({ primary: false, established: false });
    expect(h.inNewSpace(ctx("gE", "e1"))).toBe(false);
    expect(h.inNewSpace(ctx("gN", "n1"))).toBe(true);
    // The second server has the file's level and activeness, exactly like the primary.
    expect(h.channelMode(ctx("gE", "e1"))).toBe(h.channelMode(ctx("gA", "a1")));
    expect(h.channelMode(ctx("gE", "e1"))).toBe("normal");
    expect(h.activeness(ctx("gE", "e1"))).toBe(h.activeness(ctx("gA", "a1")));
    expect(h.channelMode(ctx("gN", "n1"))).toBe("mention-only");
    expect(h.activeness(ctx("gN", "n1"))).toBe("low");
  });

  it("follows the file's per-context entry in a new server too", async () => {
    const { make } = await setup({ channels: { "discord:gB": "normal" } });
    expect(make().channelMode(ctx("gB", "b1"))).toBe("normal");
  });

  it("reads the language of a place", async () => {
    const { make, set, A, b1 } = await setup();
    const h = make();
    expect(h.language(ctx("gA", "a1"))).toBeNull();
    set("space", A, LEVEL_KEYS.language, "日本語");
    set("room", b1.room_id, LEVEL_KEYS.language, "English");
    expect(h.language(ctx("gA", "a1"))).toBe("日本語");
    expect(h.language(ctx("gB", "b1"))).toBe("English");
  });

  it("writes a room's and a Space's level, and resets them", async () => {
    const { store, make, A, a1 } = await setup();
    const h = make();
    await h.setChannelMode(ctx("gA", "a1"), "lively", { by: "discord:1" });
    expect(store.config.places.get("room", a1.room_id, "agent", "mode")).toMatchObject({
      value: "lively",
      updated_by: "discord:1",
    });
    await h.setActiveness(ctx("gA", "a2"), "high", { scope: "space" });
    expect(store.config.places.get("space", A, "agent", "activeness_level")?.value).toBe("high");
    expect(h.activeness(ctx("gA", "a1"))).toBe("high");
    expect(h.channelModeOverrides()).toEqual([["discord:gA:a1", "lively"]]);
    expect(h.channelModeOverrides(A)).toEqual([["discord:gA:a1", "lively"]]);
    await h.setChannelMode(ctx("gA", "a1"), null);
    expect(store.config.places.get("room", a1.room_id, "agent", "mode")).toBeNull();
    expect(h.channelMode(ctx("gA", "a1"))).toBe("quiet");
  });

  it("holds a level for a room nobody spoke in yet in memory, and says so", async () => {
    const { make } = await setup();
    const h = make();
    await expect(h.setChannelMode(ctx("gA", "new"), "lively")).rejects.toBeInstanceOf(
      UnknownPlaceError,
    );
    expect(h.channelMode(ctx("gA", "new"))).toBe("lively");
    await expect(
      h.setChannelMode(ctx(null, "dm"), "off", { scope: "space" }),
    ).rejects.toBeInstanceOf(UnknownPlaceError);
  });

  it("lets her own temporary activeness win over the place's", async () => {
    const { make, set, a1 } = await setup();
    const h = make();
    set("room", a1.room_id, LEVEL_KEYS.activeness, "low");
    h.setTemporaryActiveness(ctx("gA", "a1"), "high", Date.UTC(2027, 0, 1));
    expect(h.activeness(ctx("gA", "a1"))).toBe("high");
  });
});

describe("the move of the old keys", () => {
  it("moves them once, keeps the old keys, and does not move them again", async () => {
    const { store, make, set, a1, av } = await setup();
    const P = "test-chan";
    await store.settings.set(P, "channel_mode:discord:gA:a1", "lively");
    await store.settings.set(P, "channel_mode:discord:gA:voice:av", "off");
    await store.settings.set(P, "activeness:discord:gA:a1", "high");
    await store.settings.set(P, "channel_mode:discord:gA:bogus", "nonsense");
    const first = make();
    expect(await first.load()).toBe(3);
    const row = store.config.places.get("room", a1.room_id, "agent", "mode");
    expect(row).toMatchObject({ value: "lively", updated_by: "migration" });
    expect(store.config.places.get("room", av.room_id, "agent", "voice.mode")?.value).toBe("off");
    expect(store.config.places.get("room", a1.room_id, "agent", "activeness_level")?.value).toBe(
      "high",
    );
    expect(first.channelMode(ctx("gA", "a1"))).toBe("lively");
    expect(first.channelMode(ctx("gA", "av", "voice"))).toBe("off");
    // The old keys stay where they were.
    expect(await store.settings.get(P, "channel_mode:discord:gA:a1")).toBe("lively");
    expect(await store.settings.get(P, PLACES_MIGRATION_KEY)).toMatchObject({
      moved: 3,
      pending: [],
    });

    // Changed since: a second start moves nothing and reads the place, not the old key.
    set("room", a1.room_id, "mode", "off");
    const again = make();
    expect(await again.migrateLegacy()).toEqual({ moved: 0, pending: [] });
    expect(again.channelMode(ctx("gA", "a1"))).toBe("off");
  });

  it("keeps a key whose room is unknown in effect and moves it once the room is known", async () => {
    const { store, make } = await setup();
    const P = "test-chan";
    await store.settings.set(P, "channel_mode:discord:gA:later", "lively");
    const first = make();
    expect(await first.migrateLegacy()).toEqual({
      moved: 0,
      pending: ["channel_mode:discord:gA:later"],
    });
    expect(first.channelMode(ctx("gA", "later"))).toBe("lively");
    const room = store.persons.resolve(ctx("gA", "later"), {
      account: { platform: "discord", id: "1" },
      display_name: "1",
    });
    const second = make();
    expect(await second.migrateLegacy()).toEqual({ moved: 1, pending: [] });
    expect(store.config.places.get("room", room.room_id, "agent", "mode")?.value).toBe("lively");
    expect(await make().migrateLegacy()).toEqual({ moved: 0, pending: [] });
  });

  it("puts a runtime level above the file's imported copy", async () => {
    const { store, make, a1 } = await setup();
    store.config.places.set("room", a1.room_id, "agent", "mode", "normal", "import");
    await store.settings.set("test-chan", "channel_mode:discord:gA:a1", "lively");
    await make().migrateLegacy();
    expect(store.config.places.get("room", a1.room_id, "agent", "mode")?.value).toBe("lively");
  });
});
