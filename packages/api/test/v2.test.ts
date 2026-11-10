// The v2 read-only routes: `/api/activity*`, `/api/arbiter/*`, `/api/affect*`, `/api/mind/goals`,
// `/api/mind/plan`, `/api/prompts*` and `/api/turns/outcomes`, against fake services.

import { SavedPromptsKey } from "@miyoria/agent";
import { Supervisor, SupervisorKey } from "@miyoria/kernel";
import { DecisionLogKey } from "@miyoria/store";
import {
  type ActivityManager,
  ActivityManagerKey,
  type ActivitySnapshot,
  type ActivityTask,
  type AffectSnapshot,
  type AffectState,
  AffectStateKey,
  type Arbiter,
  type ArbiterDecision,
  ArbiterKey,
  type ContextKey,
  type Goal,
  type GoalAgenda,
  GoalAgendaKey,
  type LedgerEntry,
  type LedgerView,
  type Mind,
  MindKey,
  type PersonCard,
  type SavedPrompt,
  type TurnOutcomeRecord,
  v2Event,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { ActiveProfileKey, ApiClient, ApiModule, summarizePrompt } from "../src/index.js";
import { raw, statusOf, waitFor } from "./support/http.js";
import { TestStore } from "./support/stores.js";

const TOKEN = "test-token";
const AT = "2026-11-02T12:00:00.000Z";
const text: ContextKey = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" };
const other: ContextKey = { platform: "discord", scope: "g1", channel: "c2", kind: "channel" };
const voice: ContextKey = { platform: "discord", scope: "g1", channel: "v1", kind: "voice" };

const SNAPSHOT: ActivitySnapshot = {
  version: 7,
  at: AT,
  presence: { type: "in", channel: voice, since: AT },
  broadcast: { type: "live", guild: "g1", golive: true, obs: true, task: null, since: AT },
  activity: {
    type: "game",
    target: "minecraft",
    phase: "running",
    task: "T1",
    failure: null,
    since: AT,
  },
  override: null,
  scene: "Gaming",
};

const TASK: ActivityTask = {
  id: "T1",
  resource: "activity",
  request: { type: "start", activity: "game", target: "minecraft", goal: null },
  by: "self",
  turn: null,
  context: null,
  status: "done",
  created_at: AT,
  ended_at: AT,
  failure: null,
  detail: "Minecraft 開好了",
};

const fakeActivity = {
  snapshot: () => SNAPSHOT,
  tasks: (limit = 20) => [TASK, { ...TASK, id: "T2" }].slice(0, limit),
} as unknown as ActivityManager;

const ENTRY: LedgerEntry = {
  id: "L1",
  at: AT,
  kind: "impulse",
  source: "plan",
  self_initiated: true,
  context: text,
  person: null,
  summary: "找 Owen 聊報告",
  outcome: "denied",
  detail: "今天主動開了 5 次",
  impulse: "I1",
  turn: null,
  task: null,
  updated_at: AT,
};

const LEDGER: LedgerView = {
  at: AT,
  entries: [ENTRY, { ...ENTRY, id: "L2", impulse: "I2", context: other }],
  limits: {
    initiatives_today: 5,
    initiative_cap: 5,
    unanswered_streak: 1,
    next_initiative_at: "2026-11-02T13:40:00.000Z",
    quiet_hours: { start_hour: 2, end_hour: 8, active: false },
    paused: false,
    blocked: [{ capability: "game.start", reason: "Minecraft 沒開", until: null }],
  },
  unanswered: [],
};

const ledgerContexts: (ContextKey | null | undefined)[] = [];
const fakeArbiter = {
  ledger: (context?: ContextKey | null) => {
    ledgerContexts.push(context);
    return LEDGER;
  },
} as unknown as Arbiter;

const decision = (impulse: string, verdict: ArbiterDecision["verdict"]): ArbiterDecision => ({
  impulse,
  source: "plan",
  verdict,
  reason: verdict === "accepted" ? null : "rate",
  detail: verdict === "accepted" ? "" : "今天主動開了 5 次,下次 21:40 之後",
  retry_at: null,
  merged_into: null,
  turn: null,
  task: null,
  at: AT,
});

const BIASES: AffectSnapshot["biases"] = {
  talkativeness: 0.2,
  initiative: -0.1,
  wants: [{ want: "chat_with", weight: 0.7, person: "owen", why: "想念 0.6 × 在意 0.8" }],
};

const AFFECT: AffectSnapshot = {
  at: AT,
  drives: {
    social: 0.7,
    play: 0.5,
    attention: 0.3,
    rest: 0.2,
    curiosity: 0.6,
    esteem: 0.3,
    hunger: 0.3,
    longing: 0.4,
  },
  boredom: 0.4,
  top: [{ name: "missing", intensity: 0.6, cause: "Owen 很久沒上線", at: AT, person: "p1" }],
  mood: { valence: 0.2, arousal: 0.5, energy: 0.7 },
  mood_line: "心情不錯、有點想念",
  shown: null,
  biases: BIASES,
};

const CARD: PersonCard = {
  person: "p1",
  handle: "owen",
  call_name: null,
  affinity: 60,
  trust: 50,
  familiarity: 40,
  attachment: 0.5,
  emotions: { missing: 0.6 },
  feeling: "有點在意他",
  label: "好朋友",
  level: 12,
  owner: true,
  blocked: false,
  last_seen: AT,
  last_together: null,
  updated_at: AT,
};

const fakeAffect = {
  snapshot: () => AFFECT,
  cards: () => [CARD],
} as unknown as AffectState;

const GOAL: Goal = {
  id: "G1",
  what: "找 Owen 問報告結果",
  why: "好幾天沒講話了",
  trigger: { kind: "when_online", person: "owen" },
  steps: [],
  status: "pending",
  expires: "2026-11-03T12:00:00.000Z",
  person: "owen",
  context: null,
  source: "plan",
  created_at: AT,
  updated_at: AT,
  closed_at: null,
  close_reason: null,
};
const DONE: Goal = { ...GOAL, id: "G0", status: "done", closed_at: AT, close_reason: null };

class FakeAgenda {
  goals = () => [GOAL];
  all = () => [GOAL, DONE];
}

const PROMPT: SavedPrompt = {
  turn: "01JC0000000000000000000T01",
  context: text,
  at: AT,
  purpose: "chat",
  reasoning: "low",
  blocks: [
    {
      key: "mood",
      authority: "data",
      source: "self",
      chars_in: 100,
      chars_out: 80,
      budget_chars: 120,
      fate: "kept",
    },
  ],
  messages: [
    { role: "system", text: "你是 Miyoria" },
    { role: "user", text: "你好" },
  ],
  prompt_tokens: 321,
};

const fakeSaved = {
  recent: (context: ContextKey | null, limit: number) =>
    [PROMPT, { ...PROMPT, turn: "T02", context: other }]
      .filter((p) => context === null || p.context.channel === context.channel)
      .slice(0, limit),
  get: (turn: string) => (turn === PROMPT.turn ? PROMPT : null),
};

const outcome = (
  turn: string,
  o: TurnOutcomeRecord["outcome"],
  context = text,
): TurnOutcomeRecord => ({
  turn,
  context,
  reason: "addressed",
  outcome: o,
  addressed_by: ["owen"],
  focus: [],
  restarts: 0,
  reasoning: "low",
  latency_ms: 900,
  at: AT,
});

const OUTCOMES = [
  outcome("O1", { type: "sent", parts: 2 }),
  outcome("O2", { type: "silence" }),
  outcome("O3", { type: "cancelled", cause: "input", by: "owen" }, other),
];

const sups: Supervisor[] = [];
afterEach(async () => {
  for (const s of sups.splice(0)) await s.stopAll();
  ledgerContexts.length = 0;
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
  return { sup, base, client: new ApiClient(base, TOKEN) };
}

const GET_ROUTES = [
  "/api/activity",
  "/api/activity/tasks",
  "/api/arbiter/ledger",
  "/api/arbiter/decisions",
  "/api/affect",
  "/api/affect/people",
  "/api/mind/goals",
  "/api/mind/plan",
  "/api/prompts",
  "/api/prompts/T",
  "/api/turns/outcomes",
];

describe("v2 routes", () => {
  it("need the token and are read-only", async () => {
    const h = await harness();
    for (const path of GET_ROUTES) {
      expect((await raw(h.base, "GET", path)).status, path).toBe(401);
      expect((await raw(h.base, "POST", path, { token: TOKEN })).status, path).toBe(405);
    }
  });

  it("are 503 while their modules are stopped", async () => {
    const h = await harness();
    expect(await statusOf(h.client.activity())).toBe(503);
    expect(await statusOf(h.client.activityTasks())).toBe(503);
    expect(await statusOf(h.client.ledger())).toBe(503);
    expect(await statusOf(h.client.affect())).toBe(503);
    expect(await statusOf(h.client.affectPeople())).toBe(503);
    expect(await statusOf(h.client.goals())).toBe(503);
    expect(await statusOf(h.client.dayPlan())).toBe(503);
    expect(await statusOf(h.client.prompts())).toBe(503);
    expect(await statusOf(h.client.prompt("T"))).toBe(503);
    expect(await statusOf(h.client.turnOutcomes())).toBe(503);
    const res = await raw(h.base, "GET", "/api/affect", { token: TOKEN });
    expect((res.body as { error: string }).error).toContain("affect module");
    // Decisions are only what the api module saw, so they work without the arbiter.
    expect(await h.client.arbiterDecisions()).toEqual({ decisions: [] });
  });

  it("serve the body state and its tasks", async () => {
    const h = await harness();
    h.sup.services.provide("activity", ActivityManagerKey, fakeActivity);
    expect(await h.client.activity()).toEqual(SNAPSHOT);
    expect(await h.client.activityTasks()).toEqual([TASK, { ...TASK, id: "T2" }]);
    expect(await h.client.activityTasks(1)).toEqual([TASK]);
    const bad = await raw(h.base, "GET", "/api/activity/tasks?limit=x", { token: TOKEN });
    expect(bad.status).toBe(400);
  });

  it("serve the ledger per context", async () => {
    const h = await harness();
    h.sup.services.provide("arbiter", ArbiterKey, fakeArbiter);
    expect(await h.client.ledger()).toEqual(LEDGER);
    expect(ledgerContexts.at(-1)).toBeNull();
    const one = await h.client.ledger(text, 1);
    expect(ledgerContexts.at(-1)).toEqual(text);
    expect(one.entries).toEqual([ENTRY]);
    expect(one.limits.blocked[0]?.reason).toBe("Minecraft 沒開");
    const bad = await raw(h.base, "GET", "/api/arbiter/ledger?context=nope", { token: TOKEN });
    expect(bad.status).toBe(400);
  });

  it("keep the arbiter's verdicts with their reasons", async () => {
    const h = await harness();
    h.sup.services.provide("arbiter", ArbiterKey, fakeArbiter);
    const publish = (d: ArbiterDecision) =>
      h.sup.bus.publish("arbiter", v2Event("arbiter.decision", d));
    publish(decision("I1", "rejected"));
    publish(decision("I2", "accepted"));
    publish(decision("I3", "deferred"));
    const all = await waitFor(async () => {
      const r = await h.client.arbiterDecisions();
      return r.decisions.length === 3 ? r : null;
    });
    expect(all.decisions.map((d) => d.impulse)).toEqual(["I3", "I2", "I1"]);
    const first = all.decisions.find((d) => d.impulse === "I1");
    expect(first?.detail).toContain("21:40");
    // Joined with the ledger entry of the impulse.
    expect(first?.summary).toBe("找 Owen 聊報告");
    expect(first?.context).toEqual(text);
    expect((await h.client.arbiterDecisions({ verdict: "rejected" })).decisions).toHaveLength(1);
    expect(
      (await h.client.arbiterDecisions({ context: other })).decisions.map((d) => d.impulse),
    ).toEqual(["I2"]);
    expect((await h.client.arbiterDecisions({ limit: 2 })).decisions).toHaveLength(2);
    // A later verdict for the same impulse replaces the earlier one.
    publish(decision("I1", "accepted"));
    const replaced = await waitFor(async () => {
      const r = await h.client.arbiterDecisions();
      return r.decisions[0]?.impulse === "I1" ? r : null;
    });
    expect(replaced.decisions).toHaveLength(3);
    expect(replaced.decisions[0]?.verdict).toBe("accepted");
    const bad = await raw(h.base, "GET", "/api/arbiter/decisions?verdict=maybe", { token: TOKEN });
    expect(bad.status).toBe(400);
  });

  it("serve affect with its biases and the person cards", async () => {
    const h = await harness();
    h.sup.services.provide("self", AffectStateKey, fakeAffect);
    const affect = await h.client.affect();
    expect(affect).toEqual(AFFECT);
    expect(affect.biases.wants[0]?.want).toBe("chat_with");
    expect(await h.client.affectPeople()).toEqual([CARD]);
  });

  it("serve goals and the day plan", async () => {
    const h = await harness();
    h.sup.services.provide("mind", GoalAgendaKey, new FakeAgenda() as unknown as GoalAgenda);
    expect(await h.client.goals()).toEqual({ goals: [GOAL], closed_included: false });
    expect(await h.client.goals(true)).toEqual({ goals: [GOAL, DONE], closed_included: true });
    // The mind does not know the day plan yet.
    expect(await statusOf(h.client.dayPlan())).toBe(503);
    const mind = { accepting: true, dayPlan: () => "下午玩 MC,晚上陪 Owen" } as unknown as Mind;
    h.sup.services.provide("mind", MindKey, mind);
    expect(await h.client.dayPlan()).toEqual({ day_plan: "下午玩 MC,晚上陪 Owen" });
    h.sup.services.provide("mind", MindKey, { accepting: true } as unknown as Mind);
    expect(await h.client.dayPlan()).toEqual({ day_plan: null });
  });

  it("an agenda without a closed list still answers", async () => {
    const h = await harness();
    h.sup.services.provide("mind", GoalAgendaKey, { goals: () => [GOAL] } as unknown as GoalAgenda);
    expect(await h.client.goals(true)).toEqual({ goals: [GOAL], closed_included: false });
  });

  it("serve saved prompts as a list and in full", async () => {
    const h = await harness();
    h.sup.services.provide("agent", SavedPromptsKey, fakeSaved as never);
    const list = await h.client.prompts();
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({
      turn: PROMPT.turn,
      context: text,
      at: AT,
      purpose: "chat",
      reasoning: "low",
      prompt_tokens: 321,
      blocks: 1,
      messages: 2,
      chars: 12,
    });
    expect(summarizePrompt(PROMPT)).toEqual(list[0]);
    expect(list[0]).not.toHaveProperty("messages", PROMPT.messages);
    expect((await h.client.prompts(other)).map((p) => p.turn)).toEqual(["T02"]);
    expect(await h.client.prompt(PROMPT.turn)).toEqual(PROMPT);
    expect(await statusOf(h.client.prompt("nope"))).toBe(404);
  });

  it("serve turn outcomes filtered by context and kind", async () => {
    const h = await harness();
    const store = new TestStore();
    const log = Object.assign(store.decisions, {
      recentOutcomes: async (_p: string, context: ContextKey | null, limit: number) =>
        OUTCOMES.filter((o) => context === null || o.context.channel === context.channel).slice(
          0,
          limit,
        ),
    });
    h.sup.services.provide("kernel", DecisionLogKey, log);
    expect((await h.client.turnOutcomes()).map((o) => o.turn)).toEqual(["O1", "O2", "O3"]);
    expect((await h.client.turnOutcomes({ limit: 1 })).map((o) => o.turn)).toEqual(["O1"]);
    expect((await h.client.turnOutcomes({ outcome: "cancelled" })).map((o) => o.turn)).toEqual([
      "O3",
    ]);
    expect((await h.client.turnOutcomes({ context: text })).map((o) => o.turn)).toEqual([
      "O1",
      "O2",
    ]);
    const bad = await raw(h.base, "GET", "/api/turns/outcomes?outcome=lost", { token: TOKEN });
    expect(bad.status).toBe(400);
  });

  it("say so when the decision log keeps no outcomes", async () => {
    const h = await harness();
    h.sup.services.provide("kernel", DecisionLogKey, new TestStore().decisions);
    const res = await raw(h.base, "GET", "/api/turns/outcomes", { token: TOKEN });
    expect(res.status).toBe(503);
    expect((res.body as { error: string }).error).toContain("turn outcomes");
  });
});
