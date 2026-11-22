// A module's own values per Space and per room through Core's settings layer (docs/design/
// v5-places.md, v5-settings.md §13): read with where each comes from, written to `place_settings`
// without a restart, refused where a field cannot differ, and listed in the place's history.

import { DROP_CONFIG } from "@miyoria/play/cards";
import { MarketConfigSchema } from "@miyoria/play/market";
import {
  Config,
  type ConfigSchema,
  defineManifest,
  type Module,
  type ModuleContext,
  SettingsError,
  Supervisor,
  setting,
} from "@miyoria/runtime/kernel";
import { SqliteStore } from "@miyoria/store";
import type { JsonValue } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { ModuleSettings } from "../src/module-settings.js";

const S = MarketConfigSchema.shape;

/** A module's schema with one field of each kind of place: built from existing fields' types. */
const PlacedSchema = MarketConfigSchema.pick({ utc_offset_minutes: true }).extend({
  channel: S.auction_channel.meta(
    setting({ kind: "channel", ref: "id", scope: "space", label: "頻道" }),
  ),
  hours: S.auction_hours.meta(setting({ kind: "number", scope: "space", label: "幾小時" })),
  count: S.song_priority_per_day.meta(setting({ kind: "number", scope: "room", label: "幾張" })),
  forbidden: DROP_CONFIG.drop_channels.meta(
    setting({ kind: "multi", scope: "room", merge: "union", label: "不能用" }),
  ),
  step: S.auction_step.meta(setting({ kind: "coins", label: "每次加" })),
});

class Recorder implements Module {
  readonly seen: JsonValue[] = [];
  readonly manifest = defineManifest("placed", "地方", {
    configSchema: PlacedSchema as ConfigSchema,
  });
  async start(ctx: ModuleContext): Promise<void> {
    this.seen.push(ctx.config(PlacedSchema) as JsonValue);
  }
}

let store: SqliteStore | null = null;
let sup: Supervisor | null = null;
afterEach(async () => {
  await sup?.stopAll();
  await store?.close();
  store = null;
  sup = null;
});

async function setup(toml: string) {
  const s = await SqliteStore.open(":memory:");
  store = s;
  const a = s.places.seen("discord", "1001", "一號");
  const b = s.places.seen("discord", "2002", "二號");
  const room = s.persons.ensureRoom("discord", "1001", "11111", "text");
  s.persons.ensureRoom("discord", "2002", "22222", "text");
  const config = Config.fromToml(toml);
  sup = new Supervisor();
  const settings = new ModuleSettings({
    config,
    revisions: s.moduleState.revisions,
    supervisor: sup,
    guard: () => null,
    places: {
      places: s.places,
      settings: s.config.places,
      events: s.events,
      ensureRoom: (space, channel) =>
        s.persons.ensureRoom(space.platform, space.external_id, channel, "text").id,
    },
  });
  const module = new Recorder();
  await sup.register(
    module,
    settings.boot("placed", config.module("placed").config, PlacedSchema),
    true,
  );
  await sup.startAll();
  return { settings, module, a, b, room, s };
}

async function refusal(call: Promise<unknown>): Promise<SettingsError> {
  try {
    await call;
  } catch (error) {
    if (error instanceof SettingsError) return error;
    throw error;
  }
  throw new Error("the call was not refused");
}

const TOML = `[modules.placed]\nchannel = "11111"\nhours = 12\nforbidden = ["x"]\n`;

describe("a module's settings per place", () => {
  it("sets a server's own value without a restart, leaves the other server alone, and clears it", async () => {
    const { settings, module, a, b } = await setup(TOML);
    const restarts = module.seen.length;
    const saved = await settings.save(
      "placed",
      { expected: 0, set: { hours: 48 }, reset: [], place: { space: b } },
      "panel:discord:1",
    );
    expect(saved.applied).toBe("immediate");
    expect(module.seen).toHaveLength(restarts);
    // No revision: the cluster layer is untouched.
    expect(saved.revision).toBe(0);

    const there = settings.describe("placed", { space: b });
    expect(there.place).toEqual({ space: { id: b, name: "二號" }, room: null });
    expect(there.values.hours).toMatchObject({
      value: 48,
      source: "space",
      place: { own: 48, own_set: true, inherited: 12, inherited_from: "file" },
    });
    // A field that cannot differ per place carries no place part.
    expect(there.values.step?.place).toBeUndefined();
    const home = settings.describe("placed", { space: a });
    expect(home.values.hours).toMatchObject({ value: 12, source: "file" });
    expect(home.values.hours?.place).toMatchObject({ own_set: false, inherited: 12 });
    expect(settings.describe("placed").values.hours).toMatchObject({ value: 12, source: "file" });

    await settings.save(
      "placed",
      { expected: 0, set: {}, reset: ["hours"], place: { space: b } },
      "p",
    );
    expect(settings.describe("placed", { space: b }).values.hours).toMatchObject({
      value: 12,
      source: "file",
      place: { own: null, own_set: false },
    });

    const history = await settings.placeHistory("placed", { space: b });
    expect(history.items.map((i) => i.changes)).toEqual([
      [{ path: "hours", label: "幾小時", before: 48, after: null }],
      [{ path: "hours", label: "幾小時", before: null, after: 48 }],
    ]);
    expect(history.items[1]).toMatchObject({ by: "panel:discord:1", place: { scope: "space" } });
    expect((await settings.placeHistory("placed", { space: a })).items).toEqual([]);
  });

  it("drops a cluster channel in another server, and refuses setting one there", async () => {
    const { settings, a, b } = await setup(TOML);
    expect(settings.describe("placed", { space: a }).values.channel?.value).toBe("11111");
    const other = settings.describe("placed", { space: b }).values.channel;
    expect(other).toMatchObject({ value: "", place: { own_set: false, inherited: "" } });
    const refused = await refusal(
      settings.save(
        "placed",
        { expected: 0, set: { channel: "11111" }, reset: [], place: { space: b } },
        "p",
      ),
    );
    expect(refused.kind).toBe("invalid");
    expect(refused.problems).toEqual([{ path: "channel", message: "頻道:這個頻道不在二號" }]);
    await settings.save(
      "placed",
      { expected: 0, set: { channel: "22222" }, reset: [], place: { space: b } },
      "p",
    );
    expect(settings.describe("placed", { space: b }).values.channel?.value).toBe("22222");
  });

  it("sets a room's own value, merges a union list, and creates a room she has not seen", async () => {
    const { settings, a, s } = await setup(TOML);
    await settings.save(
      "placed",
      {
        expected: 0,
        set: { count: 7, forbidden: ["y"] },
        reset: [],
        place: { space: a, room: "11111" },
      },
      "p",
    );
    const room = settings.describe("placed", { space: a, room: "11111" });
    expect(room.place?.room).toEqual({ id: "11111", name: null });
    expect(room.values.count).toMatchObject({
      value: 7,
      source: "room",
      place: { own: 7, inherited: 2 },
    });
    expect(room.values.forbidden).toMatchObject({
      value: ["x", "y"],
      source: "room",
      place: { own: ["y"], inherited: ["x"], inherited_from: "file" },
    });
    // A Space field is not a room's to change.
    const refused = await refusal(
      settings.save(
        "placed",
        { expected: 0, set: { hours: 3 }, reset: [], place: { space: a, room: "11111" } },
        "p",
      ),
    );
    expect(refused.kind).toBe("not_editable");
    expect(room.values.hours?.place).toBeUndefined();
    // A union list's value must be a list.
    const notList = await refusal(
      settings.save(
        "placed",
        { expected: 0, set: { forbidden: "z" }, reset: [], place: { space: a } },
        "p",
      ),
    );
    expect(notList.problems[0]?.message).toBe("不能用:要是一個清單");
    // A Space's room value is what a room without its own inherits.
    await settings.save(
      "placed",
      { expected: 0, set: { count: 4 }, reset: [], place: { space: a } },
      "p",
    );
    expect(settings.describe("placed", { space: a, room: "33333" }).values.count).toMatchObject({
      value: 4,
      source: "space",
      place: { own_set: false, inherited: 4, inherited_from: "space" },
    });
    await settings.save(
      "placed",
      { expected: 0, set: { count: 1 }, reset: [], place: { space: a, room: "33333" } },
      "p",
    );
    expect(s.places.channelSpace("discord", "33333")).toBe(a);
    expect(settings.describe("placed", { space: a, room: "33333" }).values.count?.value).toBe(1);
  });

  it("refuses a Space she is not in and a channel of another Space", async () => {
    const { settings, a } = await setup(TOML);
    expect(() => settings.describe("placed", { space: "nope" })).toThrow(/找不到這個伺服器/);
    expect(() => settings.describe("placed", { space: a, room: "22222" })).toThrow(
      /不在這個伺服器/,
    );
    const bare = new ModuleSettings({
      config: Config.fromToml(TOML),
      revisions: (store as SqliteStore).moduleState.revisions,
      supervisor: sup as Supervisor,
      guard: () => null,
    });
    expect(() => bare.describe("placed", { space: a })).toThrow(SettingsError);
  });
});
