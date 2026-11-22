// Core's `PlaceConfig` (docs/design/v5-places.md §3): room → parent → space → cluster → default,
// union lists, the channel-in-space rule, and a place setting applied without a restart.

import { MarketConfigSchema } from "@miyoria/play/market";
import { type ModuleContext, placeConfig, placeFields } from "@miyoria/runtime/kernel";
import { SqliteStore } from "@miyoria/store";
import {
  type ContextKey,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type PlaceConfigChange,
  PlaceConfigKey,
  type PlaceDirectory,
  type PlaceField,
  type PlaceRoom,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { PlaceConfigs } from "../src/place-config.js";

interface Cfg {
  name: string;
  channel: string;
  channels: string[];
  mode: string;
  forbidden: string[];
  count: number;
}

const DEFAULTS: Cfg = {
  name: "n",
  channel: "",
  channels: [],
  mode: "normal",
  forbidden: [],
  count: 1,
};

/** A schema by hand: the defaults, and `count` must be a number. */
function parse(section: JsonValue | null): Cfg {
  const raw = isJsonObject(section ?? null) ? (section as JsonObject) : {};
  const out = { ...DEFAULTS, ...raw } as Cfg;
  if (typeof out.count !== "number") throw new Error("count: not a number");
  return out;
}

const FIELDS: PlaceField[] = [
  { keys: ["channel"], scope: "space", merge: "replace", channel: { ref: "id", multiple: false } },
  {
    keys: ["channels"],
    scope: "room",
    merge: "replace",
    channel: { ref: "context", multiple: true },
  },
  { keys: ["mode"], scope: "room", merge: "replace", channel: null },
  { keys: ["forbidden"], scope: "room", merge: "union", channel: null },
  { keys: ["count"], scope: "space", merge: "replace", channel: null },
];

const ctx = (
  scope: string | null,
  channel: string,
  kind: ContextKey["kind"] = "channel",
): ContextKey => ({
  platform: "discord",
  scope,
  channel,
  kind,
});

const stores: SqliteStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

/** Two servers she is in: A (primary) with channels a1, a2 and a thread at under a1; B with b1. */
async function setup(directory?: PlaceDirectory) {
  let now = Date.UTC(2026, 10, 22);
  const store = await SqliteStore.open(":memory:", { clock: { now: () => now++ } });
  stores.push(store);
  const author = (id: string) => ({ account: { platform: "discord", id }, display_name: id });
  const a1 = store.persons.resolve(ctx("gA", "a1"), author("1"));
  const a2 = store.persons.resolve(ctx("gA", "a2"), author("1"));
  const at = store.persons.resolve(ctx("gA", "at", "thread"), author("1"), { parent: "a1" });
  const b1 = store.persons.resolve(ctx("gB", "b1"), author("2"));
  const A = a1.space_id as string;
  const B = b1.space_id as string;
  const configs = new PlaceConfigs({
    places: store.places,
    settings: store.config.places,
    ...(directory && { directory: () => directory }),
  });
  const set = (scope: "space" | "room", id: string, key: string, value: JsonValue | null) =>
    store.config.places.set(scope, id, "test", key, value, "test");
  return { store, configs, set, A, B, a1, a2, at, b1 };
}

const open = (configs: PlaceConfigs, section: JsonValue | null, signal?: AbortSignal) =>
  configs.open({ module: "test", section, fields: FIELDS, parse, ...(signal && { signal }) });

describe("PlaceConfig", () => {
  it("resolves room, then the thread's channel, then the space, then the cluster, then the default", async () => {
    const { configs, set, A, B, a1, a2 } = await setup();
    const cfg = open(configs, { mode: "cluster" });
    expect(cfg.base().mode).toBe("cluster");
    expect(cfg.for({ space_id: A }).mode).toBe("cluster");
    set("space", A, "mode", "space");
    set("room", a1.room_id, "mode", "room");
    expect(cfg.for({ space_id: A }).mode).toBe("space");
    expect(cfg.for(ctx("gA", "a1")).mode).toBe("room");
    expect(cfg.for({ room_id: a1.room_id }).mode).toBe("room");
    // A thread takes its channel's, then the Space's.
    expect(cfg.for(ctx("gA", "at", "thread")).mode).toBe("room");
    expect(cfg.for(ctx("gA", "a2")).mode).toBe("space");
    expect(cfg.for({ room_id: a2.room_id, space_id: B }).mode).toBe("space");
    // A room not seen yet still has its Space; another server, a DM and nothing are the cluster's.
    expect(cfg.for(ctx("gA", "new")).mode).toBe("space");
    expect(cfg.for({ space_id: B }).mode).toBe("cluster");
    expect(cfg.for(ctx(null, "dm1", "dm")).mode).toBe("cluster");
    expect(cfg.for(null).mode).toBe("cluster");
    expect(cfg.for({ space_id: "unknown" }).mode).toBe("cluster");
    // Nothing set anywhere: the schema's default.
    expect(open(configs, null).for({ space_id: B }).mode).toBe("normal");
  });

  it("a space field ignores a room's value; a field not marked ignores every place", async () => {
    const { configs, set, A, a1 } = await setup();
    const cfg = open(configs, { count: 2, name: "cluster" });
    set("room", a1.room_id, "count", 9);
    set("space", A, "name", "space");
    expect(cfg.for(ctx("gA", "a1"))).toMatchObject({ count: 2, name: "cluster" });
    set("space", A, "count", 3);
    expect(cfg.for(ctx("gA", "a1")).count).toBe(3);
  });

  it("a union list takes every layer, so a room cannot lift what the cluster forbids", async () => {
    const { configs, set, A, a1 } = await setup();
    const cfg = open(configs, { forbidden: ["post"] });
    set("space", A, "forbidden", ["sing", "post"]);
    set("room", a1.room_id, "forbidden", ["draw"]);
    expect(cfg.for(ctx("gA", "a1")).forbidden).toEqual(["post", "sing", "draw"]);
    set("room", a1.room_id, "forbidden", []);
    expect(cfg.for(ctx("gA", "a1")).forbidden).toEqual(["post", "sing"]);
    expect(cfg.base().forbidden).toEqual(["post"]);
  });

  it("a channel of another server is dropped: a single one falls back to the default, a list loses it", async () => {
    const { configs, set, A, B } = await setup();
    const cfg = open(configs, {
      channel: "a1",
      channels: ["discord:gA:a1", "discord:gB:b1", "discord:dm:x"],
    });
    expect(cfg.for({ space_id: A })).toMatchObject({ channel: "a1", channels: ["discord:gA:a1"] });
    expect(cfg.for({ space_id: B })).toMatchObject({ channel: "", channels: ["discord:gB:b1"] });
    // B's own channel, set for B.
    set("space", B, "channel", "b1");
    expect(cfg.for({ space_id: B }).channel).toBe("b1");
    // A channel of A set for B by mistake is dropped too.
    set("space", B, "channel", "a2");
    expect(cfg.for({ space_id: B }).channel).toBe("");
    // The cluster's value stays what the file says.
    expect(cfg.base().channel).toBe("a1");
  });

  it("an unknown channel counts for the primary server and for the server that set it", async () => {
    const { configs, set, A, B } = await setup();
    const cfg = open(configs, { channel: "c-unseen" });
    expect(cfg.for({ space_id: A }).channel).toBe("c-unseen");
    expect(cfg.for({ space_id: B }).channel).toBe("");
    set("space", B, "channel", "b-unseen");
    expect(cfg.for({ space_id: B }).channel).toBe("b-unseen");
  });

  it("asks the platform's live view about a channel identity has not seen", async () => {
    const room = (id: string, guild: string) =>
      ({ id, space: { id: guild, name: guild } }) as PlaceRoom;
    const directory: PlaceDirectory = {
      platform: "discord",
      ready: () => true,
      spaces: () => [],
      rooms: () => [room("live-a", "gA"), room("live-b", "gB")],
    };
    const { configs, A, B } = await setup(directory);
    const cfg = open(configs, { channel: "live-b" });
    expect(cfg.for({ space_id: A }).channel).toBe("");
    expect(cfg.for({ space_id: B }).channel).toBe("live-b");
  });

  it("applies a place setting at the next read and says where it changed, with no restart", async () => {
    const { store, configs, set, A, a1 } = await setup();
    const cfg = open(configs, {});
    const changes: PlaceConfigChange[] = [];
    cfg.onChange((c) => changes.push(c));
    expect(cfg.for(ctx("gA", "a1")).mode).toBe("normal");
    set("room", a1.room_id, "mode", "quiet");
    expect(cfg.for(ctx("gA", "a1")).mode).toBe("quiet");
    set("space", A, "mode", "loud");
    set("room", a1.room_id, "mode", null);
    expect(cfg.for(ctx("gA", "a1")).mode).toBe("loud");
    // Another module's setting is not this one's change.
    store.config.places.set("space", A, "other", "mode", "x", "test");
    // A server she joins is.
    const C = store.places.seen("discord", "gC", "C");
    expect(changes).toEqual([
      { space_id: A, room_id: a1.room_id },
      { space_id: A, room_id: null },
      { space_id: A, room_id: a1.room_id },
      { space_id: C, room_id: null },
    ]);
  });

  it("a place value that does not fit is skipped and the others still apply", async () => {
    const { configs, set, A } = await setup();
    const cfg = open(configs, { count: 2 });
    set("space", A, "count", "many");
    set("space", A, "mode", "space");
    expect(cfg.for({ space_id: A })).toMatchObject({ count: 2, mode: "space" });
  });

  it("stops listening when the module stops", async () => {
    const { configs, set, A } = await setup();
    const stop = new AbortController();
    const cfg = open(configs, {}, stop.signal);
    const changes: PlaceConfigChange[] = [];
    cfg.onChange((c) => changes.push(c));
    stop.abort();
    set("space", A, "mode", "space");
    expect(changes).toEqual([]);
  });
});

describe("placeConfig (kernel) over Core's service", () => {
  it("reads which fields differ per server from the schema, and falls back to the cluster without the service", async () => {
    const { configs, set, A, B, a1, b1 } = await setup();
    expect(
      placeFields(MarketConfigSchema).map((f) => [f.keys.join("."), f.scope, f.channel?.ref]),
    ).toEqual(
      expect.arrayContaining([
        ["auction_channel", "space", "id"],
        ["lottery_channel", "space", "id"],
      ]),
    );
    const services = new Map<unknown, unknown>([[PlaceConfigKey, configs]]);
    const module = (withService: boolean) =>
      ({
        id: "test",
        rawConfig: { auction_channel: "100000000000000001" },
        signal: new AbortController().signal,
        services: { get: (key: unknown) => (withService ? services.get(key) : undefined) },
      }) as unknown as ModuleContext;
    // Channel ids the market schema accepts, seen in A and in B.
    const store = stores[0] as SqliteStore;
    store.persons.ensureRoom("discord", "gA", "100000000000000001", "text");
    store.persons.ensureRoom("discord", "gB", "200000000000000002", "text");
    const cfg = placeConfig(module(true), MarketConfigSchema);
    expect(cfg.for({ space_id: A }).auction_channel).toBe("100000000000000001");
    expect(cfg.for({ space_id: B }).auction_channel).toBe("");
    set("space", B, "auction_channel", "200000000000000002");
    expect(cfg.for(ctx("gB", "b1")).auction_channel).toBe("200000000000000002");
    expect(cfg.for(ctx("gA", "a1")).auction_channel).toBe("100000000000000001");
    const fixed = placeConfig(module(false), MarketConfigSchema);
    expect(fixed.for({ space_id: B }).auction_channel).toBe("100000000000000001");
    expect([a1.room_id, b1.room_id]).toHaveLength(2);
  });
});
