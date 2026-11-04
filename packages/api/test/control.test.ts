// `/api/voice/*`, `/api/songs*`, `/api/game/*` (through the gate as the panel) and
// `/api/telemetry` (the panel's chart samples).

import { ActuatorRegistry, ActuatorRegistryKey, defineCapability } from "@miyoria/actions";
import { Supervisor, SupervisorKey } from "@miyoria/kernel";
import {
  LlmRouter,
  LlmRouterKey,
  MockProvider,
  pricing,
  userMessage,
  withLlmTag,
} from "@miyoria/llm";
import { SingerKey } from "@miyoria/sing";
import { type Principal, SelfStateKey } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ActiveProfileKey, ApiModule } from "../src/index.js";
import { llmTotals, Telemetry } from "../src/telemetry.js";
import { raw } from "./support/http.js";

const TOKEN = "test-token";

const sups: Supervisor[] = [];
afterEach(async () => {
  for (const s of sups.splice(0)) await s.stopAll();
});

interface Call {
  capability: string;
  args: unknown;
  principal: Principal;
}

async function harness() {
  const sup = new Supervisor();
  sups.push(sup);
  sup.services.provide("kernel", SupervisorKey, sup);
  sup.services.provide("kernel", ActiveProfileKey, "p");
  const registry = new ActuatorRegistry({ services: sup.services, builtins: false });
  sup.services.provide("app", ActuatorRegistryKey, registry);
  const calls: Call[] = [];
  const capability = (name: string, args: z.ZodType) =>
    registry.register(
      defineCapability<unknown>({
        name,
        summary: name,
        risk: "low",
        args,
        permission: null,
        async execute(a, ctx) {
          calls.push({ capability: name, args: a, principal: ctx.principal });
          if (name === "game.start" && ctx.principal.context === null)
            throw new Error("no context");
          return `${name} ok`;
        },
      }),
    );
  const loose = z.object({}).passthrough();
  for (const name of [
    "voice.join",
    "voice.leave",
    "stream.start",
    "stream.stop",
    "sing.request",
    "sing.play",
    "sing.stop",
    "game.start",
    "game.stop",
    "game.goal",
    "share.browse",
  ]) {
    capability(name, loose);
  }
  const api = new ApiModule({ env: () => undefined });
  await sup.register(api, { bind: "127.0.0.1:0", token: TOKEN, panel_dir: "" }, true);
  await sup.startAll();
  const base = api.url();
  if (!base) throw new Error("api is not running");
  const post = (path: string, json: unknown = {}) =>
    raw(base, "POST", path, { token: TOKEN, json });
  return { sup, base, calls, post };
}

describe("control routes", () => {
  it("join and leave voice and go live through the gate as the panel", async () => {
    const h = await harness();
    const joined = await h.post("/api/voice/join", { guild: "g1", channel: "v1" });
    expect(joined.status).toBe(200);
    expect(joined.body).toEqual({ text: "voice.join ok" });
    expect(h.calls[0]).toMatchObject({
      capability: "voice.join",
      args: { guild: "g1", channel: "v1" },
      principal: { kind: "panel", actor: "api" },
    });
    // Not in voice and no guild: nothing to leave or stream in.
    expect((await h.post("/api/voice/leave", {})).status).toBe(400);
    expect((await h.post("/api/voice/leave", { guild: "g1" })).status).toBe(200);
    expect((await h.post("/api/voice/golive", { action: "start", guild: "g1" })).body).toEqual({
      text: "stream.start ok",
    });
    expect((await h.post("/api/voice/golive", { action: "nope", guild: "g1" })).status).toBe(422);
    expect(h.calls.map((c) => c.capability)).toEqual(["voice.join", "voice.leave", "stream.start"]);
  });

  it("serve the set list and run the song capabilities", async () => {
    const h = await harness();
    expect((await raw(h.base, "GET", "/api/songs", { token: TOKEN })).status).toBe(503);
    h.sup.services.provide("sing", SingerKey, {
      playing: () => null,
      paused: () => null,
      list: {
        all: () => [
          {
            no: 1,
            query: "夜に駆ける",
            key: 0,
            requester: null,
            requester_name: "面板",
            context: null,
            forced: true,
            state: "preparing",
            stage: "separate",
            progress: 0.4,
            error: null,
            job: "j1",
            song: null,
            queue_item: null,
            created_at: "2026-11-03T10:00:00.000Z",
            ready_at: null,
            reminders: 0,
            last_reminder_ms: null,
          },
        ],
      },
    } as never);
    const list = await raw(h.base, "GET", "/api/songs", { token: TOKEN });
    expect(list.body).toMatchObject({
      playing: null,
      songs: [{ no: 1, query: "夜に駆ける", state: "preparing", progress: 0.4, title: null }],
    });
    const asked = await h.post("/api/songs", { query: "アイドル", key: 2 });
    expect(asked.body).toMatchObject({ text: "sing.request ok", songs: [{ no: 1 }] });
    expect(h.calls[0]?.args).toEqual({ query: "アイドル", key: 2 });
    expect((await h.post("/api/songs", { query: "" })).status).toBe(422);
    expect((await h.post("/api/songs/stop", { all: true })).status).toBe(200);
    expect(h.calls[1]).toMatchObject({ capability: "sing.stop", args: { all: true } });
  });

  it("start the game only with a place to play", async () => {
    const h = await harness();
    expect((await h.post("/api/game/start", { game: "minecraft" })).status).toBe(409);
    const context = { platform: "discord", scope: "g1", channel: "v1", kind: "voice" };
    const started = await h.post("/api/game/start", { game: "minecraft", context });
    expect(started.status).toBe(200);
    expect(h.calls[0]?.principal.context).toEqual(context);
    expect((await h.post("/api/game/goal", { text: "挖鐵礦" })).status).toBe(200);
    expect((await h.post("/api/game/stop")).status).toBe(200);
  });

  it("sends her scrolling through the gate", async () => {
    const h = await harness();
    expect((await h.post("/api/share/browse")).status).toBe(200);
    expect(h.calls[0]).toMatchObject({
      capability: "share.browse",
      principal: { kind: "panel" },
    });
  });
});

describe("telemetry", () => {
  it("samples her state and counts topics between samples", async () => {
    const h = await harness();
    h.sup.services.provide("self", SelfStateKey, {
      snapshot: () => ({
        at: "2026-11-03T10:00:00.000Z",
        mood: { valence: 0.3, arousal: 0.5, energy: 0.7 },
        boredom: 0.2,
        drives: { social: 0.4, play: 0.1, attention: 0.2, rest: 0.3, curiosity: 0.6 },
        policy: { talkativeness: {}, initiative: 0.5, initiative_why: "" },
        agenda: [],
      }),
    } as never);
    const t = new Telemetry(3);
    t.handle({ event: { type: "platform_message_created" } } as never);
    t.handle({ event: { type: "custom", data: { topic: "voice.latency" } } } as never);
    // Only turns where she said something count as replies.
    const turn = (text: string) =>
      t.handle({ event: { type: "agent_turn_completed", data: { turn: "t", text } } } as never);
    turn("好啊");
    turn("");
    turn("  ");
    const state = {
      optional: (key: unknown) => h.sup.services.get(key as never),
      now: () => Date.parse("2026-11-03T10:00:00.000Z"),
      monitor: { voice: () => ({ sessions: [] }), speaking: () => false },
    };
    const p = t.sample(state as never);
    expect(p.events.messages).toBe(1);
    expect(p.events.turns).toBe(1);
    expect(p.mood?.valence).toBe(0.3);
    expect(p.drives?.curiosity).toBe(0.6);
    expect(t.sample(state as never).events.messages).toBe(0);
    for (let i = 0; i < 3; i++) t.sample(state as never);
    expect(t.view(Date.parse("2026-11-03T10:00:00.000Z"), 60).points).toHaveLength(3);

    const served = await raw(h.base, "GET", "/api/telemetry?minutes=30", { token: TOKEN });
    expect(served.status).toBe(200);
    expect(served.body).toMatchObject({ interval_ms: 60_000 });
  });

  it("serves the LLM call inspector: filtered calls, one call in full, and the breakdowns", async () => {
    const h = await harness();
    const provider = new MockProvider("p").reply("好。");
    const router = new LlmRouter(
      new Map([["p", provider]]),
      new Map([["chat", [{ provider: "p", model: "m" }]]]),
      {
        pricing: new Map([["p:m", pricing({ input_per_mtok: 0.15, output_per_mtok: 0.6 })]]),
      },
    );
    h.sup.services.provide("llm", LlmRouterKey, router);
    await withLlmTag({ module: "mind", thought: "t1" }, () =>
      router.complete("mind", { messages: [userMessage("token: abcdefghijklmnop")] }),
    );
    await router.complete("chat", { messages: [userMessage("嗨")] });
    const get = (path: string) => raw(h.base, "GET", path, { token: TOKEN });
    const all = await get("/api/llm/calls");
    expect(all.body).toMatchObject({ matched: 2, kept: 2, next_cursor: null });
    const mind = await get("/api/llm/calls?purpose=mind&thought=t1");
    const [call] = (mind.body as { items: { id: string }[] }).items;
    expect(mind.body).toMatchObject({
      matched: 1,
      items: [{ module: "mind", pricing: { input_per_mtok: 0.15 } }],
    });
    const one = await get(`/api/llm/calls/${call?.id}`);
    expect(one.body).toMatchObject({
      call: { id: call?.id, status: "ok" },
      detail: {
        messages: [{ role: "user", content: "token: [已遮蔽]" }],
        response: { text: "好。" },
      },
    });
    expect((await get("/api/llm/calls/nope")).status).toBe(404);
    const stats = await get("/api/llm/stats?minutes=60");
    expect(stats.body).toMatchObject({
      total: { calls: 2 },
      prices: { "p:m": { input_per_mtok: 0.15, output_per_mtok: 0.6 } },
    });
    expect((await get("/api/llm/calls?status=nope")).status).toBe(400);
  });

  it("sums the LLM counters over models", () => {
    const totals = llmTotals([
      {
        name: "miyoria_llm_tokens_total",
        help: "",
        type: "counter",
        samples: [
          { name: "miyoria_llm_tokens_total", labels: { model: "a", type: "prompt" }, value: 10 },
          { name: "miyoria_llm_tokens_total", labels: { model: "b", type: "prompt" }, value: 5 },
          {
            name: "miyoria_llm_tokens_total",
            labels: { model: "a", type: "completion" },
            value: 3,
          },
        ],
      },
      {
        name: "miyoria_llm_first_token_seconds",
        help: "",
        type: "histogram",
        samples: [
          {
            name: "miyoria_llm_first_token_seconds_bucket",
            labels: { model: "a", le: "0.5" },
            value: 2,
          },
          {
            name: "miyoria_llm_first_token_seconds_bucket",
            labels: { model: "b", le: "0.5" },
            value: 1,
          },
          {
            name: "miyoria_llm_first_token_seconds_bucket",
            labels: { model: "a", le: "+Inf" },
            value: 4,
          },
          { name: "miyoria_llm_first_token_seconds_count", labels: { model: "a" }, value: 4 },
          { name: "miyoria_llm_first_token_seconds_sum", labels: { model: "a" }, value: 2.5 },
        ],
      },
    ]);
    expect(totals).toMatchObject({ prompt_tokens: 15, completion_tokens: 3 });
    expect(totals.first_token).toEqual({
      count: 4,
      sum_s: 2.5,
      buckets: [{ le_s: 0.5, count: 3 }],
    });
  });
});
