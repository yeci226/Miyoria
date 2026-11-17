// `GET /api/self` and `GET /api/world` against fake `SelfState` / `WorldState` services.

import { heartTables, type PeopleDirectory, PeopleDirectoryKey } from "@miyoria/heart/person";
import { Supervisor, SupervisorKey } from "@miyoria/runtime/kernel";
import { SqliteStore, StoreKey } from "@miyoria/store";
import {
  type ContextKey,
  type PlatformSink,
  PlatformSinks,
  PlatformSinksKey,
  type SelfSnapshot,
  type SelfState,
  SelfStateKey,
  type WorldSnapshot,
  type WorldState,
  WorldStateKey,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { ActiveProfileKey, ApiModule } from "../src/index.js";
import { adminCalls } from "./support/admin.js";
import { raw, statusOf } from "./support/http.js";

const TOKEN = "test-token";
const text: ContextKey = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" };

const SNAPSHOT: SelfSnapshot = {
  at: "2026-11-02T12:00:00.000Z",
  mood: { valence: 0.2, arousal: 0.5, energy: 0.7 },
  boredom: 0.4,
  drives: {
    social: 0.7,
    play: 0.5,
    attention: 0.3,
    rest: 0.2,
    curiosity: 0.6,
    esteem: 0.3,
    hunger: 0.3,
    longing: 0,
  },
  policy: {
    talkativeness: {
      "discord:g1": {
        level: 0.8,
        until: null,
        why: "大家很熱鬧",
        set_at: "2026-11-02T11:00:00.000Z",
      },
    },
    initiative: 0.5,
    initiative_why: "",
  },
  agenda: [
    {
      id: "a1",
      text: "等 Owen 上線問他報告結果",
      why: "",
      person: "person-1",
      context: null,
      created_at: "2026-11-02T11:00:00.000Z",
      due: null,
      expires_at: null,
      status: "open",
      closed_at: null,
    },
  ],
};

const WORLD: WorldSnapshot = {
  at: "2026-11-02T12:00:00.000Z",
  time: {
    local: "2026-11-02 20:00",
    weekday: 1,
    weekend: false,
    part_of_day: "晚上",
    utc_offset_minutes: 480,
  },
  her: { voice: null, voice_name: null, golive: null, streaming: false, scene: null, game: null },
  people: [
    {
      account: { platform: "discord", id: "1" },
      person: "person-1",
      display_name: "Owen",
      status: "online",
      activities: [],
      voice: null,
      online_since: "2026-11-02T11:00:00.000Z",
      updated_at: "2026-11-02T11:00:00.000Z",
    },
  ],
  voice_channels: [],
  channels: [
    {
      context: text,
      recent_messages: 5,
      per_minute: 0.5,
      last_at: "2026-11-02T11:59:00.000Z",
      recent_authors: ["Owen"],
      topic: ["鯨魚"],
      lively: false,
      her_last_at: null,
    },
  ],
};

const fakeSelf = { snapshot: () => SNAPSHOT } as unknown as SelfState;
const fakeWorld = { snapshot: () => WORLD } as unknown as WorldState;
const fakeSocial = {
  displayName: (p: string) => (p === "person-1" ? "Owen" : null),
} as unknown as PeopleDirectory;

const sups: Supervisor[] = [];
afterEach(async () => {
  for (const s of sups.splice(0)) await s.stopAll();
});

async function harness() {
  const sup = new Supervisor();
  sups.push(sup);
  sup.services.provide("kernel", SupervisorKey, sup);
  sup.services.provide("kernel", ActiveProfileKey, "p");
  const api = new ApiModule({ env: () => undefined });
  await sup.register(api, { bind: "127.0.0.1:0", token: TOKEN, panel_dir: "" }, true);
  await sup.startAll();
  const base = api.url();
  if (!base) throw new Error("api is not running");
  return { sup, base, adm: adminCalls(base, TOKEN) };
}

describe("inner routes", () => {
  it("are 503 while the modules are stopped and need the token", async () => {
    const h = await harness();
    expect(await statusOf(h.adm.self())).toBe(503);
    const world = await raw(h.base, "GET", "/api/world", { token: TOKEN });
    expect(world.status).toBe(503);
    expect((world.body as { error: string }).error).toContain("world module");
    h.sup.services.provide("self", SelfStateKey, fakeSelf);
    expect((await raw(h.base, "GET", "/api/self")).status).toBe(401);
    // Read-only.
    expect((await raw(h.base, "POST", "/api/self", { token: TOKEN })).status).toBe(405);
  });

  it("serve her inner state with her impressions of people from the heart's rows", async () => {
    const h = await harness();
    const store = await SqliteStore.open(":memory:", { plugins: [heartTables] });
    sups.push({ stopAll: () => store.close() } as unknown as Supervisor);
    const rows = store.plugin(heartTables).people;
    rows.edit(
      "person-1",
      { impression: "有點在意他" },
      { now: Date.parse("2026-11-02T11:30:00Z") },
    );
    rows.edit("person-9", { impression: "不太熟" }, { now: Date.parse("2026-11-01T11:30:00Z") });
    rows.edit("person-7", { call_name: "沒印象的人" });
    h.sup.services.provide("app", StoreKey, store);
    h.sup.services.provide("self", SelfStateKey, fakeSelf);
    h.sup.services.provide("heart", PeopleDirectoryKey, fakeSocial);
    const self = await h.adm.self();
    expect(self).toEqual({
      ...SNAPSHOT,
      feelings: [
        {
          person: "person-1",
          text: "有點在意他",
          updated_at: "2026-11-02T11:30:00.000Z",
          display_name: "Owen",
        },
        {
          person: "person-9",
          text: "不太熟",
          updated_at: "2026-11-01T11:30:00.000Z",
          display_name: null,
        },
      ],
    });
  });

  it("serve the world with channel names", async () => {
    const h = await harness();
    h.sup.services.provide("world", WorldStateKey, fakeWorld);
    const sinks = new PlatformSinks();
    const sink: PlatformSink = {
      platform: "discord",
      send: async () => ({ context: text, id: "1" }),
      react: async () => {},
      typing: async () => {},
      describe: async () => "Miyoria / 雜談",
    };
    sinks.register(sink);
    h.sup.services.provide("kernel", PlatformSinksKey, sinks);
    const world = await h.adm.world();
    expect(world.people).toEqual(WORLD.people);
    expect(world.channels).toEqual([{ ...WORLD.channels[0], label: "Miyoria / 雜談" }]);
    expect(world.time.part_of_day).toBe("晚上");
  });
});
