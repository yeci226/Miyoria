// The settings, card and place routes. Core's real settings layer is tested in `@miyoria/core`
// (which depends on this package); here a small stand-in answers as it does.

import type {
  ModuleDetail,
  ModuleInfo,
  ModuleSettings,
  PlaceRooms,
  SaveSettingsResult,
  SettingsHistory,
} from "@miyoria/contracts/api";
import { PartyConfigSchema } from "@miyoria/play/party";
import {
  type ConfigSchema,
  configJsonSchema,
  defineManifest,
  type Module,
  type ModuleCard,
  type ModuleContext,
  ModuleSettingsKey,
  type ModuleSettingsService,
  type ModuleSettingsView,
  SettingsError,
  type SettingsPlace,
  type SettingsSaveRequest,
  Supervisor,
  SupervisorKey,
  settingFields,
} from "@miyoria/runtime/kernel";
import { AuditLogKey } from "@miyoria/store";
import {
  type AccountRef,
  AuthorizerKey,
  BaseAuthorizer,
  type JsonObject,
  type JsonValue,
  type PlaceDirectory,
  PlaceDirectoryKey,
  type Places,
  PlacesKey,
  type Principal,
  type SpaceRef,
  type Subject,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { ActiveProfileKey, ApiModule } from "../src/index.js";
import { mayEdit } from "../src/settings.js";
import type { ApiContext, ApiState } from "../src/state.js";
import { call, raw } from "./support/http.js";
import { TestStore } from "./support/stores.js";

const TOKEN = "test-token";

class Party implements Module {
  readonly manifest = defineManifest("party", "派對遊戲", {
    configSchema: PartyConfigSchema as ConfigSchema,
    icon: "party-popper",
    category: "play",
  });
  readonly seen: JsonValue[] = [];
  readonly acted: string[] = [];
  slow = false;
  async start(ctx: ModuleContext): Promise<void> {
    this.seen.push(ctx.config(PartyConfigSchema) as JsonValue);
  }
  async card(): Promise<ModuleCard> {
    if (this.slow) await new Promise((r) => setTimeout(r, 2_000));
    return {
      facts: [
        { label: "進行中", value: 1, unit: "場" },
        { label: "a", value: 1 },
        { label: "b", value: 2 },
        { label: "c", value: 3 },
        { label: "d", value: 4 },
      ],
      actions: [{ id: "end", label: "結束", confirm: "結束遊戲?" }],
    };
  }
  async act(action: string, _by: Principal): Promise<void> {
    this.acted.push(action);
  }
}

/** Core's settings layer, as far as the routes see it. */
class FakeSettings implements ModuleSettingsService {
  revision = 0;
  layer: JsonObject = {};
  readonly saves: { by: string; request: SettingsSaveRequest }[] = [];
  constructor(readonly sup: Supervisor) {}
  editable(id: string): boolean {
    return id === "party";
  }
  readonly places: (SettingsPlace | null | undefined)[] = [];
  describe(id: string, place?: SettingsPlace | null): ModuleSettingsView {
    if (id !== "party") throw new SettingsError("unknown", `unknown module \`${id}\``);
    this.places.push(place);
    const found = settingFields(configJsonSchema(PartyConfigSchema));
    return {
      place: place ? { space: { id: place.space, name: place.space }, room: null } : null,
      module: id,
      name: "派對遊戲",
      revision: this.revision,
      groups: found.groups,
      fields: found.fields,
      values: {
        song_rounds: {
          value: (this.layer.song_rounds as number | undefined) ?? 5,
          source: this.layer.song_rounds === undefined ? "file" : "panel",
          file: 5,
          file_set: true,
          set: true,
          env: null,
          invalid: null,
        },
      },
      updated: null,
      guard: null,
      pending: null,
    };
  }
  async save(id: string, request: SettingsSaveRequest, by: string) {
    if (request.place) {
      this.saves.push({ by, request });
      return {
        revision: this.revision,
        applied: "immediate" as const,
        state: "running" as const,
        reason: null,
      };
    }
    if (request.expected !== this.revision) throw new SettingsError("conflict", "stale");
    const rounds = request.set.song_rounds;
    if (typeof rounds === "number" && rounds > 30) {
      throw new SettingsError("invalid", "bad", [
        { path: "song_rounds", message: "猜歌幾首:數值過大" },
      ]);
    }
    this.saves.push({ by, request });
    this.layer = { ...this.layer, ...request.set };
    this.revision += 1;
    await this.sup.reconfigure(id, this.layer);
    return {
      revision: this.revision,
      applied: "restarted" as const,
      state: "running" as const,
      reason: null,
    };
  }
  history() {
    return {
      items: this.saves.map((s, i) => ({
        version: i + 1,
        at: "2026-11-18T00:00:00.000Z",
        by: s.by,
        note: null,
        changes: Object.entries(s.request.set).map(([path, after]) => ({
          path,
          label: path,
          before: null,
          after,
        })),
      })),
      next_before: null,
    };
  }
  async placeHistory(_id: string, place: SettingsPlace) {
    this.places.push(place);
    return { items: [], next_before: null };
  }
  async revert(id: string, _version: number, _expected: number, _by: string) {
    this.layer = {};
    this.revision += 1;
    await this.sup.reconfigure(id, null);
    return {
      revision: this.revision,
      applied: "restarted" as const,
      state: "running" as const,
      reason: null,
    };
  }
  pending(): string | null {
    return null;
  }
  overrides() {
    return [];
  }
}

const directory: PlaceDirectory = {
  platform: "discord",
  ready: () => true,
  spaces: () => [],
  rooms: (o) =>
    [
      {
        platform: "discord",
        id: "1",
        context: "discord:9:1",
        name: "活動",
        kind: "text" as const,
        space: { id: "9", name: "魚缸" },
        category: null,
        position: 0,
        usable: true,
        reason: null,
      },
    ].filter((r) => o?.kind === undefined || r.kind === o.kind),
};

const SPACE_A: SpaceRef = {
  id: "S1",
  platform: "discord",
  external_id: "9",
  name: "魚缸",
  primary: true,
  established: true,
};
const SPACE_B: SpaceRef = {
  ...SPACE_A,
  id: "S2",
  external_id: "8",
  name: "第二",
  primary: false,
  established: false,
};

/** The two Spaces she is in, as far as the routes ask. */
const places = {
  primary: () => SPACE_A,
  spaces: () => [SPACE_A, SPACE_B],
  space: (id: string) => [SPACE_A, SPACE_B].find((s) => s.id === id) ?? null,
} as unknown as Places;

let sup: Supervisor | null = null;
afterEach(async () => {
  await sup?.stopAll();
  sup = null;
});

async function start() {
  sup = new Supervisor();
  const s = sup.services;
  const store = new TestStore();
  s.provide("kernel", SupervisorKey, sup);
  s.provide("kernel", ActiveProfileKey, "p");
  s.provide("kernel", AuditLogKey, store.audit);
  const settings = new FakeSettings(sup);
  s.provide("kernel", ModuleSettingsKey, settings);
  s.provide("discord", PlaceDirectoryKey, directory);
  s.provide("kernel", PlacesKey, places);
  const party = new Party();
  await sup.register(party, { song_rounds: 5 }, true);
  const api = new ApiModule({ env: () => undefined });
  await sup.register(api, { bind: "127.0.0.1:0", token: TOKEN, panel_dir: "" }, true);
  await sup.startAll();
  return { base: api.url() ?? "", party, settings, store };
}

describe("module settings routes", () => {
  it("list each module with its card, trimmed to four facts", async () => {
    const { base } = await start();
    const list = await call<ModuleInfo[]>(base, TOKEN, "GET", "/api/modules");
    const party = list.find((m) => m.id === "party");
    expect(party).toMatchObject({ icon: "party-popper", category: "play", settings: true });
    expect(party?.card?.facts).toHaveLength(4);
    const detail = await call<ModuleDetail>(base, TOKEN, "GET", "/api/modules/party");
    expect(detail).toMatchObject({ id: "party", required: false, dependents: [] });
  });

  it("read, save, refuse per field, list the history and revert", async () => {
    const { base, party, store } = await start();
    const view = await call<ModuleSettings>(base, TOKEN, "GET", "/api/modules/party/settings");
    expect(view).toMatchObject({ can_edit: true, currency: "魚幣", revision: 0 });
    expect(view.fields.map((f) => f.path)).toContain("rewards.max_coins");

    const saved = await call<SaveSettingsResult>(
      base,
      TOKEN,
      "PUT",
      "/api/modules/party/settings",
      {
        expected: 0,
        set: { song_rounds: 12 },
      },
    );
    expect(saved).toMatchObject({ applied: "restarted", revision: 1 });
    expect(party.seen.at(-1)).toMatchObject({ song_rounds: 12 });

    const bad = await raw(base, "PUT", "/api/modules/party/settings", {
      token: TOKEN,
      json: { expected: 1, set: { song_rounds: 99 }, reset: [] },
    });
    expect(bad.status).toBe(400);
    expect((bad.body as { problems: unknown }).problems).toEqual([
      { path: "song_rounds", message: "猜歌幾首:數值過大" },
    ]);
    const stale = await raw(base, "PUT", "/api/modules/party/settings", {
      token: TOKEN,
      json: { expected: 0, set: { song_rounds: 3 }, reset: [] },
    });
    expect(stale.status).toBe(409);

    const history = await call<SettingsHistory>(
      base,
      TOKEN,
      "GET",
      "/api/modules/party/settings/history",
    );
    expect(history.items[0]).toMatchObject({ by: "panel:token", by_label: "管理 token" });

    await call(base, TOKEN, "POST", "/api/modules/party/settings/revert", {
      version: 0,
      expected: 1,
    });
    expect(party.seen.at(-1)).toMatchObject({ song_rounds: 8 });
    const audit = await store.audit.recent(10, null);
    expect(audit.map((e) => e.action)).toContain("settings.save");
    expect(audit.map((e) => e.action)).toContain("settings.revert");
  });

  it("keep the old module actions working beside the settings routes", async () => {
    const { base, party } = await start();
    const restarted = await call<ModuleInfo>(base, TOKEN, "POST", "/api/modules/party/restart");
    expect(restarted.state).toBe("running");
    expect(party.seen).toHaveLength(2);
    const unknown = await raw(base, "GET", "/api/modules/nope/settings", { token: TOKEN });
    expect(unknown.status).toBe(404);
  });

  it("run a card's action, and go without a card that is too slow", async () => {
    const { base, party } = await start();
    const done = await call<{ text: string }>(
      base,
      TOKEN,
      "POST",
      "/api/modules/party/actions/end",
    );
    expect(done.text).toBe("結束");
    expect(party.acted).toEqual(["end"]);
    const missing = await raw(base, "POST", "/api/modules/party/actions/nope", { token: TOKEN });
    expect(missing.status).toBe(404);
  });

  it("go without a card that does not answer in time", async () => {
    const { base, party } = await start();
    party.slow = true;
    const list = await call<ModuleInfo[]>(base, TOKEN, "GET", "/api/modules");
    expect(list.find((m) => m.id === "party")?.card).toBeNull();
  });

  it("read, save and list the history of one server's own values", async () => {
    const { base, settings, party } = await start();
    const view = await call<ModuleSettings>(
      base,
      TOKEN,
      "GET",
      "/api/modules/party/settings?space=S2",
    );
    expect(view.place).toEqual({ space: { id: "S2", name: "S2" }, room: null });
    expect(settings.places.at(-1)).toEqual({ space: "S2", room: null });

    const restarts = party.seen.length;
    const saved = await call<SaveSettingsResult>(
      base,
      TOKEN,
      "PUT",
      "/api/modules/party/settings?space=S2&room=55",
      { expected: 0, set: { song_rounds: 3 } },
    );
    expect(saved.applied).toBe("immediate");
    expect(settings.saves.at(-1)?.request.place).toEqual({ space: "S2", room: "55" });
    expect(party.seen).toHaveLength(restarts);

    await call<SettingsHistory>(base, TOKEN, "GET", "/api/modules/party/settings/history?space=S1");
    expect(settings.places.at(-1)).toEqual({ space: "S1", room: null });

    const unknown = await raw(base, "GET", "/api/modules/party/settings?space=nope", {
      token: TOKEN,
    });
    expect(unknown.status).toBe(404);
    const roomAlone = await raw(base, "GET", "/api/modules/party/settings?room=55", {
      token: TOKEN,
    });
    expect(roomAlone.status).toBe(400);
  });

  it("let a role assigned in one server change that server's values only", () => {
    const MOD: AccountRef = { platform: "discord", id: "2" };
    // `admin.settings.party` through a role assigned in server 8 (SPACE_B) only.
    const authorizer = new (class extends BaseAuthorizer {
      allowsSubject(subject: Subject, node: string): boolean {
        if (node !== "admin.settings.party") return false;
        return subject.context?.scope === SPACE_B.external_id;
      }
    })();
    const state = {
      optional: (key: unknown) => (key === AuthorizerKey ? authorizer : undefined),
    } as unknown as ApiState;
    const session = (write: boolean) =>
      ({
        get: () => ({ kind: "session", write, record: { account: MOD } }),
      }) as unknown as ApiContext;
    expect(mayEdit(state, session(true), "party")).toBe(false);
    expect(mayEdit(state, session(true), "party", SPACE_A)).toBe(false);
    expect(mayEdit(state, session(true), "party", SPACE_B)).toBe(true);
    expect(mayEdit(state, session(false), "party", SPACE_B)).toBe(false);
  });

  it("list the rooms for the channel picker", async () => {
    const { base } = await start();
    const answer = await call<PlaceRooms>(base, TOKEN, "GET", "/api/places/rooms?kind=text");
    expect(answer.ready).toBe(true);
    expect(answer.rooms.map((r) => r.name)).toEqual(["活動"]);
  });
});
