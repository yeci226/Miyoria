// `GET /api/channels/levels` and `PUT /api/channels/level` against a fake agent handle.

import { AgentHandleKey, type ChannelMode } from "@miyoria/brain/agent";
import type { ChannelLevelsView } from "@miyoria/contracts/api";
import { Supervisor, SupervisorKey } from "@miyoria/runtime/kernel";
import {
  type ContextKey,
  contextKeyString,
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
  return {
    channelMode: (c: ContextKey) => modes.get(contextKeyString(c)) ?? "quiet",
    channelModeOverride: (c: ContextKey) => modes.get(contextKeyString(c)) ?? null,
    configuredChannelMode: () => "quiet",
    channelModeOverrides: () => [...modes.entries()],
    setChannelMode: async (c: ContextKey, mode: ChannelMode | null) => {
      if (mode === null) modes.delete(contextKeyString(c));
      else modes.set(contextKeyString(c), mode);
    },
  };
}

const world = {
  snapshot: () => ({ channels: [{ context: seen }] }) as unknown as WorldSnapshot,
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
      { context: set, label: null, mode: "lively", custom: true, default: "quiet" },
    ]);

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
});
