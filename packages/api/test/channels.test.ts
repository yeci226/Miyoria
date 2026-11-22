// `GET /api/channels/levels` and `PUT /api/channels/level` against a fake agent handle.

import { AgentHandleKey, type ChannelMode } from "@miyoria/brain/agent";
import type { ChannelLevelsView } from "@miyoria/contracts/api";
import { Supervisor, SupervisorKey } from "@miyoria/runtime/kernel";
import {
  type ContextKey,
  contextKeyString,
  type Places,
  PlacesKey,
  type SpaceRef,
  type WorldSnapshot,
  type WorldState,
  WorldStateKey,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { ActiveProfileKey, ApiModule } from "../src/index.js";
import { raw } from "./support/http.js";

const TOKEN = "test-token";
const seen: ContextKey = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" };
const set: ContextKey = { platform: "discord", scope: "g1", channel: "c2", kind: "channel" };

/** The parts of `AgentHandle` the routes use; the configured mode is `quiet`. */
function fakeHandle() {
  const modes = new Map<string, ChannelMode>([
    [contextKeyString(set), "lively"],
    ["discord:g1:voice:v1", "mention-only"],
  ]);
  const spaces = new Map<string, ChannelMode>();
  return {
    channelMode: (c: ContextKey) =>
      modes.get(contextKeyString(c)) ?? spaces.get(c.scope ?? "") ?? "quiet",
    channelModeOverride: (c: ContextKey) => modes.get(contextKeyString(c)) ?? null,
    configuredChannelMode: (c: ContextKey) => spaces.get(c.scope ?? "") ?? "quiet",
    channelModeOverrides: () => [...modes.entries()],
    spaceChannelMode: (c: ContextKey) => spaces.get(c.scope ?? "") ?? null,
    configuredSpaceMode: (c: ContextKey) => (c.scope === "g2" ? "mention-only" : "quiet"),
    setChannelMode: async (
      c: ContextKey,
      mode: ChannelMode | null,
      options: { scope?: string } = {},
    ) => {
      const key = options.scope === "space" ? (c.scope ?? "") : contextKeyString(c);
      const map = options.scope === "space" ? spaces : modes;
      if (mode === null) map.delete(key);
      else map.set(key, mode);
    },
  };
}

/** Two Spaces: S1 (guild g1, primary) and S2 (guild g2). */
function twoSpaces(): Places {
  const list: SpaceRef[] = [
    {
      id: "S1",
      platform: "discord",
      external_id: "g1",
      name: "一號",
      primary: true,
      established: true,
    },
    {
      id: "S2",
      platform: "discord",
      external_id: "g2",
      name: "二號",
      primary: false,
      established: false,
    },
  ];
  return {
    primary: () => list[0] ?? null,
    spaces: () => list,
    space: (id: string) => list.find((s) => s.id === id) ?? null,
  } as unknown as Places;
}

const other: ContextKey = { platform: "discord", scope: "g2", channel: "c9", kind: "channel" };
const world = {
  snapshot: () =>
    ({ channels: [{ context: seen }, { context: other }] }) as unknown as WorldSnapshot,
} as unknown as WorldState;

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
  const call = (method: string, path: string, json?: unknown) =>
    raw(base, method, path, { token: TOKEN, ...(json !== undefined && { json }) });
  return { sup, call };
}

describe("channel levels", () => {
  it("list the levels and the text channels seen or set, and change one", async () => {
    const h = await harness();
    expect((await h.call("GET", "/api/channels/levels")).status).toBe(503);
    h.sup.services.provide("agent", AgentHandleKey, fakeHandle() as never);
    h.sup.services.provide("world", WorldStateKey, world);

    const view = (await h.call("GET", "/api/channels/levels")).body as ChannelLevelsView;
    expect(view.levels.map((l) => [l.mode, l.label])).toEqual([
      ["off", "關閉"],
      ["mention-only", "只回提及"],
      ["quiet", "安靜"],
      ["normal", "一般"],
      ["lively", "活躍"],
      ["always", "每則都回"],
    ]);
    // The voice override is not a text channel.
    expect(view.channels).toEqual([
      { context: seen, label: null, mode: "quiet", custom: false, default: "quiet" },
      { context: other, label: null, mode: "quiet", custom: false, default: "quiet" },
      { context: set, label: null, mode: "lively", custom: true, default: "quiet" },
    ]);
    // Without Spaces there is no server level.
    expect(view.space).toBeNull();

    // The old name still works; `null` resets.
    let res = await h.call("PUT", "/api/channels/level", { context: seen, mode: "ambient" });
    expect(res.body).toMatchObject({ mode: "normal", custom: true });
    res = await h.call("PUT", "/api/channels/level", { context: set, mode: null });
    expect(res.body).toMatchObject({ mode: "quiet", custom: false });
    res = await h.call("PUT", "/api/channels/level", { context: seen, mode: "loud" });
    expect(res.status).toBe(400);
    const voice = { ...seen, kind: "voice" };
    res = await h.call("PUT", "/api/channels/level", { context: voice, mode: "quiet" });
    expect(res.status).toBe(400);
  });

  it("show one Space's channels and its own level, and set the level of a whole Space", async () => {
    const h = await harness();
    h.sup.services.provide("agent", AgentHandleKey, fakeHandle() as never);
    h.sup.services.provide("world", WorldStateKey, world);
    h.sup.services.provide("kernel", PlacesKey, twoSpaces());

    let view = (await h.call("GET", "/api/channels/levels")).body as ChannelLevelsView;
    expect(view.channels.map((c) => c.context.channel)).toEqual(["c1", "c2"]);
    expect(view.space).toEqual({
      id: "S1",
      name: "一號",
      mode: "quiet",
      custom: false,
      default: "quiet",
    });
    view = (await h.call("GET", "/api/channels/levels?space=S2")).body as ChannelLevelsView;
    expect(view.channels.map((c) => c.context.channel)).toEqual(["c9"]);
    expect(view.space).toMatchObject({ id: "S2", mode: "mention-only", custom: false });

    let res = await h.call("PUT", "/api/channels/space-level?space=S2", { mode: "normal" });
    expect(res.body).toEqual({
      id: "S2",
      name: "二號",
      mode: "normal",
      custom: true,
      default: "mention-only",
    });
    view = (await h.call("GET", "/api/channels/levels?space=S2")).body as ChannelLevelsView;
    expect(view.channels[0]).toMatchObject({ mode: "normal", custom: false, default: "normal" });
    res = await h.call("PUT", "/api/channels/space-level?space=S2", { mode: null });
    expect(res.body).toMatchObject({ mode: "mention-only", custom: false });
    expect((await h.call("GET", "/api/channels/levels?space=nope")).status).toBe(404);
    expect((await h.call("PUT", "/api/channels/space-level", { mode: "loud" })).status).toBe(400);
  });
});
