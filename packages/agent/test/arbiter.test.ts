// The agent with the Arbiter as the one gate (docs/design/v2-architecture.md §3.3): her intents
// go through it, `agent.initiative` requests become impulses, the coordinator only says
// whether the place is free, and the level's gap is the Arbiter's rule.

import { ActuatorRegistry, defaultActionsConfig } from "@miyoria/actions";
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
  type Event,
  type Intent,
  IntentSinkKey,
  type JsonValue,
  newId,
  newImpulse,
  toTimestamp,
  v2Event,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  account,
  channel,
  Harness,
  incoming,
  mention,
  noCheck,
  SlowProvider,
  stopHarnesses,
  wait,
} from "./harness.js";

beforeEach(() => {
  vi.useFakeTimers();
  // 14:00 local (UTC+8): outside quiet hours.
  vi.setSystemTime(Date.UTC(2026, 10, 3, 6, 0, 0));
});

afterEach(async () => {
  await stopHarnesses();
  vi.useRealTimers();
});

async function rig(
  mode: string,
  config: JsonValue,
  chat: MockProvider | SlowProvider,
  arbiter: JsonValue = {},
) {
  const tools = new ToolRegistry();
  const registry = new ActuatorRegistry({
    services: new ServiceRegistry(),
    tools,
    builtins: false,
  });
  registry.configure(defaultActionsConfig());
  const h = await Harness.build(mode, config, chat, null, {
    appTools: tools,
    actuators: registry,
    roll: 0.5,
    modules: [[new ArbiterModule("p"), arbiter]],
  });
  const decisions = h.sup.bus.subscribe(ARBITER_DECISION_TOPIC);
  return {
    h,
    intents: h.sup.services.require(IntentSinkKey),
    arbiter: h.sup.services.require(ArbiterKey),
    decisions: (): ArbiterDecision[] => {
      const out: ArbiterDecision[] = [];
      for (let env = decisions.tryRecv(); env !== null; env = decisions.tryRecv()) {
        if (env.event.type === "custom")
          out.push(env.event.data.payload as unknown as ArbiterDecision);
      }
      return out;
    },
  };
}

function intent(context: ContextKey, extra: Partial<Intent> = {}): Intent {
  const now = Date.now();
  return {
    id: newId(),
    capability: "chat.start",
    args: {},
    why: "想找大家聊天",
    opening: "欸,你們在聊什麼",
    context,
    about: null,
    created_at: toTimestamp(now),
    expires_at: toTimestamp(now + 120_000),
    ...extra,
  };
}

const initiative = (context: ContextKey, reason: string, hint = ""): Event => ({
  type: "agent_initiative",
  data: { context, reason, hint, about: [] },
});

describe("the agent with the Arbiter", () => {
  it("her intents go through the Arbiter, which counts them and says when she may again", async () => {
    const chat = new MockProvider("chat").reply("嗨大家!").reply("又是我");
    const r = await rig("normal", noCheck(), chat, { min_gap_secs: 0, gap_text_secs: 600 });
    const c = channel("c");
    const first = await r.intents.submit(intent(c));
    expect(first.status).toBe("started");
    await wait(100);
    expect(r.h.sink.texts()).toEqual(["嗨大家!"]);
    expect(r.decisions().find((d) => d.source === "plan")).toMatchObject({
      verdict: "accepted",
      turn: first.turn,
    });
    const limits = r.arbiter.ledger(c).limits;
    expect(limits.initiatives_today).toBe(1);
    expect(limits.next_initiative_at).not.toBeNull();
    // The mind snapshot's ceiling and her prompts see the same rule.
    expect(r.intents.ceiling?.(c)?.blocked).toMatch(/^the arbiter: next in \d+ min$/);

    const again = await r.intents.submit(intent(c));
    expect(again.status).toBe("denied");
    expect(again.detail).toMatch(/^cooldown: /);
    await wait(100);
    expect(r.h.sink.texts()).toEqual(["嗨大家!"]);
  });

  it("an announcement is not her own start: no level gap, not counted", async () => {
    const chat = new MockProvider("chat").reply("我要唱囉").reply("下一首").reply("第三首");
    const r = await rig("quiet", noCheck(), chat);
    const c = channel("c");
    for (const _ of [1, 2, 3]) {
      r.h.publish(initiative(c, "song_start", "下一首要開始了"));
      await wait(100);
    }
    expect(r.h.sink.texts()).toEqual(["我要唱囉", "下一首", "第三首"]);
    expect(r.decisions().map((d) => [d.source, d.verdict])).toEqual([
      ["song", "accepted"],
      ["song", "accepted"],
      ["song", "accepted"],
    ]);
    expect(r.arbiter.ledger(c).limits.initiatives_today).toBe(0);
    // Her trace still says what it was.
    expect(r.h.traces().at(-1)?.reasons[0]).toBe("initiative:song_start");
  });

  it("the quiet level's gap is the Arbiter's rule for her own starts", async () => {
    const chat = new MockProvider("chat").reply("欸大家").reply("這關好難");
    const r = await rig("quiet", noCheck(), chat, { min_gap_secs: 0, gap_text_secs: 60 });
    const c = channel("c");
    expect((await r.intents.submit(intent(c))).status).toBe("started");
    await wait(100);
    await wait(2 * 60_000);
    const again = await r.intents.submit(intent(c));
    expect(again).toMatchObject({ status: "denied" });
    expect(again.detail).toMatch(/^ceiling: 這個頻道的等級限制/);
    // Live game commentary is not her starting a conversation.
    r.h.publish(initiative(c, "game", "打到王了"));
    await wait(100);
    expect(r.h.sink.texts()).toEqual(["欸大家", "這關好難"]);
  });

  it("a busy place defers an impulse until the turn in flight is done", async () => {
    const chat = new SlowProvider(2000);
    const r = await rig("always", noCheck(), chat, { retry_ms: 500 });
    const c = channel("c");
    r.h.say(incoming(c, "Owen", "在嗎"));
    await wait(1600);
    expect(chat.calls).toBe(1);
    r.h.sup.bus.publish(
      "sing",
      v2Event(
        ARBITER_IMPULSE_TOPIC,
        newImpulse(
          {
            source: "song",
            context: c,
            ttlMs: 60_000,
            why: "報幕",
            hint: "要唱了",
            reason: "song_start",
          },
          Date.now(),
        ),
      ),
    );
    await wait(100);
    expect(r.decisions().map((d) => [d.verdict, d.reason])).toEqual([["deferred", "busy"]]);
    expect(chat.calls, "does not interrupt her reply").toBe(1);
    await wait(3000);
    expect(chat.calls, "starts once the context is free").toBe(2);
    expect(r.decisions().map((d) => d.verdict)).toContain("accepted");
    // No "skipped" trace for it: the Arbiter waited instead.
    expect(r.h.traces().some((t) => t.reasons.some((x) => x.startsWith("skipped")))).toBe(false);
  });

  // 2026-11-10: right after her reply in a DM, a followup turn and the turn telling its result
  // answered 「失敗了誒」 a second time.
  it("a followup about someone waits a minute after she answered them; one about another does not", async () => {
    const chat = new MockProvider("chat")
      .reply("在啊")
      .reply("Amy 你的貓還好嗎")
      .reply("考試考得怎樣?");
    const r = await rig("always", noCheck(), chat, { retry_ms: 5_000 });
    const c = channel("c");
    r.h.say(mention(c, "Owen", "在嗎"));
    await wait(3000);
    expect(r.h.sink.texts()).toEqual(["在啊"]);
    const followup = (who: string, hint: string) =>
      r.h.sup.bus.publish(
        "memory",
        v2Event(
          ARBITER_IMPULSE_TOPIC,
          newImpulse(
            {
              source: "followup",
              context: c,
              account: account(who),
              about: [account(who)],
              ttlMs: 5 * 60_000,
              why: "之前說好要問的",
              hint,
              reason: "followup",
            },
            Date.now(),
          ),
        ),
      );
    followup("Amy", "問 Amy 的貓");
    await wait(100);
    expect(r.h.sink.texts()).toEqual(["在啊", "Amy 你的貓還好嗎"]);
    followup("Owen", "問 Owen 考試");
    await wait(100);
    expect(r.decisions().map((d) => [d.verdict, d.reason, d.detail])).toContainEqual([
      "deferred",
      "busy",
      "she just answered them",
    ]);
    await wait(40_000);
    expect(r.h.sink.texts(), "still waiting").toHaveLength(2);
    await wait(30_000);
    expect(r.h.sink.texts()).toEqual(["在啊", "Amy 你的貓還好嗎", "考試考得怎樣?"]);
  });

  it("a result someone waits for does not wait for that", async () => {
    const chat = new MockProvider("chat").reply("在啊").reply("跑完了,結果是 42");
    const r = await rig("always", noCheck(), chat);
    const c = channel("c");
    r.h.say(mention(c, "Owen", "幫我跑一下"));
    await wait(3000);
    r.h.publish({
      type: "agent_initiative",
      data: { context: c, reason: "action_result", hint: "結果:42", about: [account("Owen")] },
    });
    await wait(100);
    expect(r.h.sink.texts()).toEqual(["在啊", "跑完了,結果是 42"]);
  });
});
