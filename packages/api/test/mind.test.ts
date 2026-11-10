// `/api/mind*`: her thought journal, the approvals of high-risk actions and the pause switch.

import { ActuatorRegistry, ActuatorRegistryKey } from "@miyoria/actions";
import { ServiceRegistry, Supervisor, SupervisorKey } from "@miyoria/kernel";
import {
  type AccountRef,
  AuthorizerKey,
  BaseAuthorizer,
  type Mind,
  MindKey,
  type Subject,
  type Thought,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { ActiveProfileKey, ApiClient, ApiModule } from "../src/index.js";
import { mindRoutes } from "../src/mind.js";
import type { ApiContext, ApiState } from "../src/state.js";
import { raw, statusOf } from "./support/http.js";

const TOKEN = "test-token";

const THOUGHT: Thought = {
  id: "01JC0000000000000000000001",
  at: "2026-11-02T12:00:00.000Z",
  triggers: [
    { kind: "salient", detail: "Owen 進了語音", context: null, at: "2026-11-02T12:00:00.000Z" },
  ],
  thought: "就說我剛好路過。",
  changes: ["多話程度 voice 0.80(30 分鐘)"],
  intents: [],
  tokens: 1200,
  error: null,
  ms: 3000,
};

const fakeMind: Mind = {
  accepting: true,
  suggest: () => true,
  thoughts: (limit = 50) => [THOUGHT].slice(0, limit),
  stats: () => ({
    calls_last_hour: 1,
    max_calls_per_hour: 12,
    calls_total: 4,
    tokens_total: 4800,
    last_at: THOUGHT.at,
    next_heartbeat_at: null,
    idle_reason: null,
  }),
};

const sups: Supervisor[] = [];
afterEach(async () => {
  for (const s of sups.splice(0)) await s.stopAll();
});

async function harness() {
  const sup = new Supervisor();
  sups.push(sup);
  sup.services.provide("kernel", SupervisorKey, sup);
  sup.services.provide("kernel", ActiveProfileKey, "p");
  const registry = new ActuatorRegistry({ services: sup.services, builtins: false });
  sup.services.provide("app", ActuatorRegistryKey, registry);
  const api = new ApiModule({ env: () => undefined });
  await sup.register(api, { bind: "127.0.0.1:0", token: TOKEN, panel_dir: "" }, true);
  await sup.startAll();
  const base = api.url();
  if (!base) throw new Error("api is not running");
  return { sup, base, registry, client: new ApiClient(base, TOKEN) };
}

describe("mind routes", () => {
  it("serve her journal and status", async () => {
    const h = await harness();
    expect(await statusOf(h.client.thoughts())).toBe(503);
    expect(await h.client.mind()).toEqual({
      paused: false,
      running: false,
      accepting: false,
      stats: null,
      pending_approvals: 0,
      emergency: null,
    });
    h.sup.services.provide("mind", MindKey, fakeMind);
    expect(await h.client.thoughts(10)).toEqual([
      { ...THOUGHT, has_input: false, has_reasoning: false },
    ]);
    // One thought in full.
    const one = await raw(h.base, "GET", `/api/mind/thoughts/${THOUGHT.id}`, { token: TOKEN });
    expect(one.body).toEqual(THOUGHT);
    expect((await raw(h.base, "GET", "/api/mind/thoughts/nope", { token: TOKEN })).status).toBe(
      404,
    );
    expect((await h.client.mind()).stats?.calls_total).toBe(4);
    expect((await raw(h.base, "GET", "/api/mind/thoughts")).status).toBe(401);
  });

  it("pause and resume her autonomy", async () => {
    const h = await harness();
    expect((await h.client.autonomyPause(true)).paused).toBe(true);
    expect(h.registry.paused).toBe(true);
    expect((await h.client.autonomyPause(false)).paused).toBe(false);
  });

  it("the emergency stop answers step by step, and the view remembers it", async () => {
    const h = await harness();
    const view = await h.client.autonomyPause(true);
    expect(view.emergency?.by).toBeTruthy();
    expect(view.emergency?.steps.map((s) => s.step)).toEqual([
      "pause",
      "silence",
      "song",
      "stream",
      "voice",
      "game",
    ]);
    // Nothing can confirm the broadcast over here: that is said, not swallowed.
    const stream = view.emergency?.steps.find((s) => s.step === "stream");
    expect(stream).toMatchObject({ ok: false, detail: "活動管理沒有啟用,確認不了" });
    expect((await h.client.mind()).emergency).toEqual(view.emergency);
    const back = await h.client.autonomyPause(false);
    expect(back.emergency?.steps).toMatchObject([{ step: "resume", ok: true }]);
  });

  it("list pending approvals and answer them", async () => {
    const h = await harness();
    const answer = h.registry.escalations.wait(
      "01JCAPPROVAL00000000000000",
      "t.high (self)",
      60_000,
      undefined,
      {
        capability: "t.high",
        summary: "測試",
        principal: "self",
        args: { note: "x" },
        why: "想試試",
        review: "不確定",
      },
    );
    const [pending] = await h.client.approvals();
    expect(pending).toMatchObject({
      id: "01JCAPPROVAL00000000000000",
      capability: "t.high",
      why: "想試試",
    });
    expect(await h.client.answerApproval("01JCAPPROVAL00000000000000", true)).toEqual([]);
    expect(await answer).toMatchObject({ approved: true, reason: "approved by panel:api" });
    expect(await statusOf(h.client.answerApproval("01JCAPPROVAL00000000000000", false))).toBe(404);
  });

  it("need the owner-level node from panel sessions", async () => {
    const services = new ServiceRegistry();
    const registry = new ActuatorRegistry({ services, builtins: false });
    const granted = new Set<string>();
    class Auth extends BaseAuthorizer {
      allowsSubject(subject: Subject, node: string): boolean {
        return granted.has(`${subject.account.id}|${node}`);
      }
    }
    services.provide("t", ActuatorRegistryKey, registry);
    services.provide("t", AuthorizerKey, new Auth());
    const state = {
      optional: (key: never) => services.get(key),
      service: (key: never) => services.require(key),
      audit: async () => {},
    } as unknown as ApiState;
    const owen: AccountRef = { platform: "discord", id: "1" };
    const c = {
      get: () => ({ kind: "session", write: true, record: { account: owen } }),
      req: { param: () => "x", query: () => undefined },
    } as unknown as ApiContext;
    const pause = mindRoutes(state).find((r) => r.path === "/api/mind/pause");
    await expect(pause?.handler(c)).rejects.toMatchObject({ status: 403 });
    expect(registry.paused).toBe(false);
    granted.add("1|owner.autonomy.approve");
    const ok = await pause?.handler(c);
    expect(ok?.status).toBe(200);
    expect(registry.paused).toBe(true);
  });
});
