// The phase-5 acceptance scenarios (docs/design/v2-architecture.md §4): "Owen 上線就去找他"
// fires at the right time and becomes an Impulse; over a synthetic day, Plan's empty-run rate
// stays under 30%.

import { ActuatorRegistry, ActuatorRegistryKey, defineCapability } from "@miyoria/actions";
import { getLogger, ServiceRegistry } from "@miyoria/kernel";
import { LlmRouter, LlmRouterKey, parseModelRef } from "@miyoria/llm";
import {
  type AffectSnapshot,
  AffectStateKey,
  ArbiterKey,
  customEvent,
  type Envelope,
  type Event,
  GoalAgendaKey,
  type JsonValue,
  type NewProposal,
  ProposalBoardKey,
  toTimestamp,
  WorldStateKey,
} from "@miyoria/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { GoalBook, Journal, MindLoop, mindConfig, ruleDigest } from "../src/index.js";
import { callKind, card, FakeAffect, FakeArbiter, ScriptedProvider, texts } from "./fakes.js";
import { FakeWorld, OWEN, rig, salient, stopRigs, wait } from "./helpers.js";

afterEach(async () => {
  await stopRigs();
  vi.useRealTimers();
});

const MIN = 60_000;
const HOUR = 60 * MIN;

/** The goal key the data shows for a goal that fired (`G7XK2P:...(到了)`). */
function firedKey(data: string): string | null {
  return /- (G[0-9A-Z]{5}):[^\n]*(到了)/.exec(data)?.[1] ?? null;
}

function cameOnline(score: number): Event {
  return customEvent("world.salient", {
    kind: "came_online",
    key: `came_online:${OWEN.id}`,
    account: { ...OWEN },
    person: "person-owen",
    display_name: "Owen",
    context: null,
    detail: "Owen 上線了",
    score,
    count: 1,
    first_at: toTimestamp(Date.now()),
    at: toTimestamp(Date.now()),
  });
}

describe("Owen 上線就去找他", () => {
  it("a when_online goal fires when he comes online and becomes an Impulse for the Arbiter", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-11-02T12:30:00.000Z")); // 20:30 at UTC+8
    const arbiter = new FakeArbiter();
    const provider = new ScriptedProvider((req) => {
      const key = firedKey(texts(req).data);
      return JSON.stringify(
        key === null
          ? {}
          : {
              thought: "他上線了,去找他。",
              impulses: [
                {
                  kind: "speak",
                  capability: "chat.dm",
                  person: "Owen",
                  why: "說好要問他報告",
                  hint: "報告怎麼樣了",
                  goal: key,
                },
              ],
            },
      );
    });
    const r = await rig(provider, { arbiter, config: { min_interval_secs: 0 } });
    r.world.online.clear();
    await wait(10);
    const agenda = r.sup.services.require(GoalAgendaKey);
    const goal = agenda.add({
      what: "等 Owen 上線問報告結果",
      why: "好幾天沒跟他講話了",
      trigger: { kind: "when_online", person: "Owen" },
      expires: toTimestamp(Date.now() + 24 * HOUR),
      person: "Owen",
      source: "plan",
    });
    // Offline: the goal does not wake her (and `whenever` would not either).
    await wait(29 * MIN);
    expect(provider.requests().filter((q) => firedKey(texts(q).data) !== null)).toEqual([]);
    expect(arbiter.impulses).toEqual([]);

    // 21:00: he comes online (a quiet presence change, not even salient enough on its own).
    r.world.online.add(OWEN.id);
    const at = Date.now();
    r.publish(cameOnline(0.3));
    await wait(5000);
    const fired = provider.requests().filter((q) => firedKey(texts(q).data) !== null);
    expect(fired).toHaveLength(1);
    expect(callKind(fired[0] as never)).toBe("plan");
    expect(texts(fired[0]).data).toContain("你之前定的目標,觸發條件到了");
    expect(arbiter.impulses).toHaveLength(1);
    const impulse = arbiter.impulses[0];
    expect(impulse).toMatchObject({
      source: "agenda",
      kind: "speak",
      capability: "chat.dm",
      target: { person: "Owen", account: OWEN },
      goal: goal.id,
      hint: "報告怎麼樣了",
      priority: "initiative",
    });
    expect(Date.parse(impulse?.created_at ?? "") - at).toBeLessThan(5000);
    // Accepted: the goal is done, and the journal says so.
    expect(agenda.goal(goal.id)?.status).toBe("done");
    expect(
      r
        .mind()
        .thoughts()[0]
        ?.intents.map((i) => [i.capability, i.status]),
    ).toEqual([["chat.dm", "started"]]);
  });
});

describe("a synthetic day", () => {
  it("keeps Plan's empty-run rate under 30% and acts at the right times", async () => {
    vi.useFakeTimers();
    const start = Date.parse("2026-11-02T22:00:00.000Z"); // 06:00 Nov 3 at UTC+8
    vi.setSystemTime(start);
    const localHour = () => new Date(Date.now() + 8 * HOUR).getUTCHours();

    const services = new ServiceRegistry();
    const arbiter = new FakeArbiter();
    services.provide("app", ArbiterKey, arbiter);
    const world = new FakeWorld();
    world.online.clear();
    services.provide("app", WorldStateKey, world);
    // Her feelings over the day: bored and wanting to play after lunch, missing Owen at night.
    const affect = new FakeAffect();
    affect.cardList.push(card("Owen", "person-owen", { attachment: 0.8 }));
    const base = affect.snapshot();
    affect.snapshot = (): AffectSnapshot => {
      const h = localHour();
      const s = structuredClone(base);
      if (h >= 13 && h < 15) {
        s.boredom = 0.8;
        s.drives.play = 0.7;
        s.biases.wants = [{ want: "play", weight: 0.7, person: null, why: "想玩遊戲、有點無聊" }];
      }
      if (h >= 21) {
        s.top = [{ name: "missing", intensity: 0.5, cause: "", at: "", person: "person-owen" }];
        s.biases.wants = [{ want: "find_person", weight: 0.65, person: "Owen", why: "想念Owen" }];
      }
      return s;
    };
    const owenCard = affect.cardList[0];
    if (owenCard) owenCard.emotions = { missing: 0.5 };
    services.provide("app", AffectStateKey, affect);
    const registry = new ActuatorRegistry({ services, builtins: false, publish: () => {} });
    for (const name of ["chat.start", "chat.dm", "game.start", "voice.join"]) {
      registry.register(
        defineCapability({
          name,
          summary: name,
          risk: "low",
          args: z.looseObject({}),
          permission: null,
          async execute() {
            return "ok";
          },
        }),
      );
    }
    services.provide("app", ActuatorRegistryKey, registry);

    // Her judgment, scripted: act when there is a reason (a fired goal, an ended activity, a
    // strong wish at the top of her list), otherwise nothing.
    const provider = new ScriptedProvider((req) => {
      const { data } = texts(req);
      if (callKind(req) === "plan_daily") {
        return JSON.stringify({
          thought: "今天想等 Owen。",
          day_plan: "下午有空玩一下 Minecraft;Owen 通常晚上來,等他再開台。",
          goals: {
            add: [
              { what: "晚上開台", trigger: { kind: "at", time: "21:30" }, expires_in_hours: 20 },
              {
                what: "找 Owen 聊天",
                trigger: { kind: "when_online", person: "Owen" },
                person: "Owen",
                expires_in_hours: 20,
              },
            ],
          },
        });
      }
      const key = firedKey(data);
      if (key !== null) {
        return JSON.stringify({
          impulses: [
            { kind: "speak", capability: "chat.dm", person: "Owen", why: "想他", goal: key },
          ],
        });
      }
      if (data.includes("剛剛的活動結束了")) {
        return JSON.stringify({
          goals: {
            add: [
              {
                what: "跟大家分享今天挖到的鑽石",
                trigger: { kind: "whenever" },
                expires_in_hours: 8,
              },
            ],
          },
        });
      }
      if (data.includes("1. 玩遊戲")) {
        return JSON.stringify({
          impulses: [
            { kind: "act", capability: "game.start", args: { game: "minecraft" }, why: "好無聊" },
          ],
        });
      }
      if (data.includes("1. 找 Owen 聊天")) {
        return JSON.stringify({
          impulses: [{ kind: "speak", capability: "chat.dm", person: "Owen", why: "想他" }],
        });
      }
      return '{"thought": "沒什麼想做的。"}';
    });
    const router = new LlmRouter(
      new Map([["p", provider]]),
      new Map([["mind", [parseModelRef("p:mind")]]]),
    );
    services.provide("app", LlmRouterKey, router);

    const config = mindConfig();
    const clock = { now: () => Date.now() };
    const goals = new GoalBook({ store: null, profile: "p", clock, maxDays: 14, defaultDays: 3 });
    const loop = new MindLoop({
      config,
      profile: "p",
      name: "DeepSeek-chan",
      persona: () => "你是住在深海的鯨魚娘。",
      services,
      clock,
      publish: () => {},
      log: getLogger("test"),
      journal: new Journal(null, "p", 500, () => {}, {
        batch: 50,
        digestsKeep: 10,
        condense: async (t) => ruleDigest(t),
      }),
      goals,
      store: null,
    });
    const env = (event: Event): Envelope =>
      ({
        id: "e",
        source: "test",
        ts: toTimestamp(Date.now()),
        correlation: null,
        causation: null,
        event,
      }) as unknown as Envelope;
    const activity = (a: JsonValue) =>
      customEvent("activity.changed", {
        version: 1,
        at: toTimestamp(Date.now()),
        presence: { type: "none" },
        broadcast: { type: "off" },
        activity: a,
        override: null,
        scene: null,
      });
    const controller = new AbortController();
    const running = loop.run(controller.signal);
    const until = async (hour: number, minute = 0) => {
      const target = start + ((hour - 6 + 24) % 24) * HOUR + minute * MIN;
      await vi.advanceTimersByTimeAsync(Math.max(target - Date.now(), 0));
    };

    await until(13, 30);
    loop.observe(
      env(
        activity({
          type: "game",
          target: "minecraft",
          phase: "running",
          task: null,
          failure: null,
          since: toTimestamp(Date.now()),
        }),
      ),
    );
    await until(15);
    loop.observe(env(activity({ type: "idle", since: toTimestamp(Date.now()) })));
    await until(21);
    world.online.add(OWEN.id);
    loop.observe(env(cameOnline(0.9)));
    await until(5, 59); // the next morning, just before her next day plan
    controller.abort();
    await running;

    const stats = loop.planStats();
    expect(stats.runs).toBeGreaterThanOrEqual(5);
    expect(stats.empty / stats.runs).toBeLessThan(0.3);
    // Her impulses happened when they made sense.
    const at = (i: { created_at: string }) =>
      new Date(Date.parse(i.created_at) + 8 * HOUR).getUTCHours();
    const game = arbiter.impulses.filter((i) => i.capability === "game.start");
    expect(game.map(at)).toEqual([13]);
    const owen = arbiter.impulses.filter((i) => i.target.person === "Owen");
    expect(owen.length).toBeGreaterThanOrEqual(1);
    // Only once he is there (21:00 on her first day).
    expect(owen.every((i) => Date.parse(i.created_at) >= start + 15 * HOUR)).toBe(true);
    expect(owen.some((i) => i.source === "agenda")).toBe(true);
    // Far fewer calls than a 3-minute heartbeat (480 a day).
    expect(provider.requests().length).toBeLessThan(20);
  });
});

describe("her Plan under the main line (pipeline v3)", () => {
  it("decides what she wants and writes it down; it runs nothing, and opens no turn", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-11-02T12:30:00.000Z"));
    const proposals: NewProposal[] = [];
    const arbiter = new FakeArbiter();
    const provider = new ScriptedProvider(() =>
      JSON.stringify({
        thought: "好想進語音。",
        impulses: [
          {
            kind: "act",
            capability: "voice.join",
            person: null,
            place: null,
            args: { channel: "v1", guild: "g1" },
            why: "想找大家",
            hint: "我來了",
          },
        ],
      }),
    );
    const r = await rig(provider, {
      arbiter,
      extra: (sup) => {
        sup.services.provide("app", ProposalBoardKey, {
          propose: async (p) => {
            proposals.push(p);
            return { id: p.id ?? "", state: "taken", detail: "", turn: "t1" };
          },
          open: () => [],
        });
      },
    });
    r.publish(salient("想做點事"));
    await wait(10_000);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      capability: "voice.join",
      why: "想找大家",
      what: "我來了",
      source: "plan",
    });
    expect(arbiter.impulses).toEqual([]);
    expect(r.intents.intents).toEqual([]);
  });
});
