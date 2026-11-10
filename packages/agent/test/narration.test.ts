// End to end with the real Arbiter and the real agent: game narration that repeats itself or
// talks to nobody stops, and what she owes people still comes out (她變啞巴 is the other way to
// fail, docs/design/v3-architecture.md §21).

import { ActuatorRegistry, defaultActionsConfig, defineCapability } from "@miyoria/actions";
import { ArbiterModule } from "@miyoria/arbiter";
import { ServiceRegistry } from "@miyoria/kernel";
import { MockProvider } from "@miyoria/llm";
import { ToolRegistry } from "@miyoria/tools";
import {
  ARBITER_DECISION_TOPIC,
  ARBITER_IMPULSE_TOPIC,
  type ArbiterDecision,
  ArbiterKey,
  type ContextKey,
  type Impulse,
  type ImpulseInput,
  type Intent,
  IntentSinkKey,
  newId,
  newImpulse,
  toTimestamp,
  v2Event,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { channel, Harness, incoming, noCheck, stopHarnesses, wait } from "./harness.js";

beforeEach(() => {
  vi.useFakeTimers();
  // 14:00 local (UTC+8): outside quiet hours.
  vi.setSystemTime(Date.UTC(2026, 10, 3, 6, 0, 0));
});

afterEach(async () => {
  await stopHarnesses();
  vi.useRealTimers();
});

async function rig(lines: number) {
  const chat = new MockProvider("chat");
  for (let i = 1; i <= lines; i++) chat.reply(`第 ${i} 句`);
  const tools = new ToolRegistry();
  const registry = new ActuatorRegistry({
    services: new ServiceRegistry(),
    tools,
    builtins: false,
  });
  registry.configure(defaultActionsConfig());
  const ran: string[] = [];
  registry.register(
    defineCapability({
      name: "game.goal",
      summary: "換遊戲目標",
      risk: "low",
      args: z.object({}),
      permission: null,
      execute: async () => {
        ran.push("game.goal");
        return "目標換好了";
      },
    }),
  );
  const h = await Harness.build("always", noCheck(), chat, null, {
    appTools: tools,
    actuators: registry,
    roll: 0.5,
    modules: [[new ArbiterModule("p"), { min_gap_secs: 0, gap_text_secs: 0 }]],
  });
  const decisions = h.sup.bus.subscribe(ARBITER_DECISION_TOPIC);
  return {
    h,
    ran,
    arbiter: h.sup.services.require(ArbiterKey),
    intents: h.sup.services.require(IntentSinkKey),
    async publish(input: Omit<ImpulseInput, "ttlMs" | "why">): Promise<void> {
      const impulse: Impulse = newImpulse({ ttlMs: 60_000, why: "測試", ...input }, Date.now());
      h.sup.bus.publish("test", v2Event(ARBITER_IMPULSE_TOPIC, impulse));
      await wait(100);
    },
    decisions(): ArbiterDecision[] {
      const out: ArbiterDecision[] = [];
      for (let env = decisions.tryRecv(); env !== null; env = decisions.tryRecv()) {
        if (env.event.type === "custom") {
          out.push(env.event.data.payload as unknown as ArbiterDecision);
        }
      }
      return out;
    },
  };
}

type Rig = Awaited<ReturnType<typeof rig>>;

function narrate(r: Rig, context: ContextKey, key: string): Promise<void> {
  return r.publish({
    source: "game",
    context,
    hint: "(你正在直播玩 Minecraft)實況:石鎬做好了",
    reason: "game",
    coalesce_key: "game",
    attention: { key, repeat_after_ms: 45 * 60_000 },
  });
}

describe("game narration through the real Arbiter and agent", () => {
  it("the same event asked for 25 times starts one turn", async () => {
    const r = await rig(5);
    const c = channel("c");
    for (let i = 0; i < 25; i++) {
      await narrate(r, c, "game:craft:stone_pickaxe");
      await wait(15_000);
    }
    expect(r.h.sink.texts()).toEqual(["第 1 句"]);
    const rejected = r.decisions().filter((d) => d.verdict === "rejected");
    expect(rejected).toHaveLength(24);
    expect(rejected.every((d) => d.reason === "repeat")).toBe(true);
  });

  it("talking to nobody stops after three lines, and a person speaking brings her back", async () => {
    const r = await rig(10);
    const c = channel("c");
    for (let i = 0; i < 8; i++) await narrate(r, c, `game:remark:${i}`);
    expect(r.h.sink.texts()).toEqual(["第 1 句", "第 2 句", "第 3 句"]);
    expect(r.arbiter.ledger(c).limits.waiting_for_response).toBe(true);

    r.h.say(incoming(c, "Owen", "哈哈"));
    await wait(1000);
    expect(r.h.sink.texts()).toHaveLength(4);
    expect(r.arbiter.ledger(c).limits.waiting_for_response).toBe(false);

    await narrate(r, c, "game:remark:back");
    expect(r.h.sink.texts()).toHaveLength(5);
  });

  it("what she owes people comes out while she is waiting", async () => {
    const r = await rig(10);
    const c = channel("c");
    for (let i = 0; i < 3; i++) await narrate(r, c, `game:remark:${i}`);
    expect(r.arbiter.ledger(c).limits.waiting_for_response).toBe(true);

    await r.publish({ source: "game", context: c, hint: "剛剛死掉了", reason: "game" });
    expect(r.h.sink.texts(), "a death").toHaveLength(4);
    await r.publish({ source: "song", context: c, hint: "要唱了", reason: "song_start" });
    expect(r.h.sink.texts(), "a song announcement").toHaveLength(5);
    await r.publish({ source: "followup", context: c, hint: "好了", reason: "action_result" });
    expect(r.h.sink.texts(), "a result she promised").toHaveLength(6);
    await r.publish({ source: "game", context: c, hint: "完成了觀眾的請求", reason: "game" });
    expect(r.h.sink.texts(), "a requested goal").toHaveLength(7);
    // None of that was narration, and nobody spoke: she is still waiting.
    expect(r.arbiter.ledger(c).limits.waiting_for_response).toBe(true);

    r.h.say(incoming(c, "Owen", "Miyo 你在嗎"));
    await wait(1000);
    expect(r.h.sink.texts(), "a reply").toHaveLength(8);
  });

  it("she acts on her own while waiting; her words about it wait", async () => {
    const r = await rig(10);
    const c = channel("c");
    for (let i = 0; i < 3; i++) await narrate(r, c, `game:remark:${i}`);
    const now = Date.now();
    const intent: Intent = {
      id: newId(),
      capability: "game.goal",
      args: {},
      why: "想換目標",
      opening: "我要去挖鐵了",
      context: c,
      about: null,
      created_at: toTimestamp(now),
      expires_at: toTimestamp(now + 120_000),
    };
    const outcome = await r.intents.submit(intent);
    await wait(100);
    expect(r.ran).toEqual(["game.goal"]);
    expect(outcome.status).toBe("done");
    expect(outcome.detail).toContain("not talking");
    expect(r.h.sink.texts()).toHaveLength(3);

    // With someone there the same intent talks.
    r.h.say(incoming(c, "Owen", "嗯"));
    await wait(1000);
    const texts = r.h.sink.texts().length;
    const again = await r.intents.submit({ ...intent, id: newId() });
    await wait(100);
    expect(again.status).toBe("started");
    expect(r.h.sink.texts()).toHaveLength(texts + 1);
  });

  it("her Plan sees she is waiting: chat.start is blocked before it asks", async () => {
    const r = await rig(5);
    const c = channel("c");
    for (let i = 0; i < 3; i++) await narrate(r, c, `game:remark:${i}`);
    expect(r.intents.ceiling?.(c)?.blocked).toMatch(/nobody answered/);
    r.h.say(incoming(c, "Owen", "嗯"));
    await wait(1000);
    expect(r.intents.ceiling?.(c)?.blocked ?? "").not.toMatch(/nobody answered/);
  });
});
