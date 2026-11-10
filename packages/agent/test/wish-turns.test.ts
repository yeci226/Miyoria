// One turn per thing (2026-11-10): a due promise opened two turns five seconds apart, and in a
// party game a person's line could be answered twice, once by her reply and once by the game's
// note of the same line. These pin the seams of the main line that keep it to one.

import { ArbiterModule } from "@miyoria/arbiter";
import { FactsModule } from "@miyoria/facts";
import type { ChatProvider } from "@miyoria/llm";
import {
  ArbiterKey,
  EventLogKey,
  ImpulseHostKey,
  newImpulse,
  PipelineKey,
  ProposalBoardKey,
  toTimestamp,
  WishesKey,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  channel,
  done,
  Harness,
  incoming,
  mention,
  noCheck,
  Paced,
  stopHarnesses,
  textDelta,
  wait,
} from "./harness.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 10, 10, 6, 0, 0));
});

afterEach(async () => {
  await stopHarnesses();
  vi.useRealTimers();
});

/** A model that takes `ms` to say `text`. */
function slow(ms: number, text = "好喔"): Paced {
  return new Paced([
    [
      [ms, textDelta(text)],
      [0, done()],
    ],
  ]);
}

async function rig(llm: ChatProvider, mode = "normal"): Promise<Harness> {
  return Harness.build(mode, noCheck(), llm, null, {
    provide: (services) => {
      services.provide("app", PipelineKey, { pipeline: "v3" as const });
    },
    before: [[new FactsModule(null, "p"), null]],
    modules: [[new ArbiterModule("p"), { quiet_start_hour: 0, quiet_end_hour: 0 }]],
  });
}

const C = channel("c");

describe("one turn per thing", () => {
  it("opened again while a turn is on it, a claim is that turn, not a second", async () => {
    const llm = slow(3_000);
    const h = await rig(llm);
    const host = h.sup.services.require(ImpulseHostKey);
    const impulse = newImpulse(
      {
        source: "game",
        context: C,
        ttlMs: 60_000,
        why: "test",
        hint: "有事",
        reason: "game",
        claim: "notable",
        attention: { key: "game:test", repeat_after_ms: 0, revision: 1 },
      },
      Date.now(),
    );
    const first = await host.open(impulse);
    await wait(200);
    const again = await host.open({ ...impulse, id: `${impulse.id}-retry` });
    expect(first.status).toBe("started");
    expect(again).toMatchObject({ status: "started", turn: (first as { turn: string }).turn });
    await wait(5_000);
    expect(llm.requests).toHaveLength(1);
  });

  it("a promise that is over opens no turn when its claim comes late", async () => {
    const h = await rig(slow(10));
    const host = h.sup.services.require(ImpulseHostKey);
    const run = await host.open(
      newImpulse(
        {
          source: "game",
          context: C,
          ttlMs: 60_000,
          why: "mainline.commitment",
          hint: "你剛說要「問 S」,還沒做",
          reason: "commitment",
          claim: "notable",
          attention: { key: "commitment:gone", repeat_after_ms: 0, revision: 1 },
        },
        Date.now(),
      ),
    );
    expect(run).toMatchObject({ status: "refused", reason: "repeat" });
  });

  it("the turn that hears 'you asked already' cannot be a turn to ask it", async () => {
    const llm = slow(10, "嗯嗯");
    const h = await rig(llm);
    h.say(incoming(C, "S", "早安"));
    await wait(2_000);
    const wishes = h.sup.services.require(WishesKey);
    const board = h.sup.services.require(ProposalBoardKey);
    const wish = wishes.hold("S", "問 S 期末報告的結果", "goal:g1");
    h.say(mention(C, "S", "你已經在私訊問過我了"));
    await wait(10);
    expect(wishes.of("goal:g1")).toMatchObject({ key: wish?.key, state: "closed", end: "stop" });
    const outcome = await board.propose({
      what: "S 說話時順便問期末報告的結果",
      why: "關心",
      source: "plan",
      context: C,
      about: null,
      person: "S",
      goal: null,
      expires: toTimestamp(Date.now() + 600_000),
    });
    expect(outcome.state).toBe("dropped");
    expect(outcome.detail).toContain("不要再");
  });
});

describe("a person's line is answered once (party notes share its key)", () => {
  function note(h: Harness, key: string): void {
    h.sup.services.require(EventLogKey).observe({
      source: "game.party.quiz",
      silent: false,
      salience: "notable",
      attention_key: key,
      revision: 1,
      summary: "S 答對了",
      addressed_to_her: false,
      from: null,
      context: C,
    });
  }

  it("her reply first: a claim of the same line is a repeat while she is still writing", async () => {
    // Before her first line is out, nothing in the delivery ledger says the line is answered:
    // the reply turn holds its key, so a note of the line is refused, not queued for a second
    // answer once the place is free.
    const llm = slow(3_000);
    const h = await rig(llm);
    const line = mention(C, "S", "DeepSeek 答案是鯨魚");
    h.say(line);
    await wait(1_500);
    const claim = newImpulse(
      {
        source: "game",
        context: C,
        ttlMs: 60_000,
        why: "game.party.quiz",
        hint: "S 答對了",
        reason: "game",
        claim: "notable",
        attention: { key: `msg:test:${line.id.id}`, repeat_after_ms: 0, revision: 1 },
      },
      Date.now(),
    );
    const decision = await h.sup.services.require(ArbiterKey).submit(claim);
    expect(decision).toMatchObject({ verdict: "rejected", reason: "repeat" });
    await wait(6_000);
    expect(llm.requests).toHaveLength(1);
  });

  it("the note first: her reply turn to the same line is skipped", async () => {
    const llm = slow(3_000);
    // A channel she answers everything in: the reply turn comes for sure, and is no call of her.
    const h = await rig(llm, "always");
    const line = incoming(C, "S", "答案是鯨魚");
    note(h, `msg:test:${line.id.id}`);
    await wait(200);
    h.say(line);
    await wait(8_000);
    expect(llm.requests).toHaveLength(1);
    const skipped = h.traces().some((t) => t.reasons.some((r) => r.includes("已經有人回了")));
    expect(skipped).toBe(true);
  });

  it("someone who called her is answered while nothing was said to them yet", async () => {
    const llm = slow(3_000);
    const h = await rig(llm);
    const line = mention(C, "S", "DeepSeek 答案是鯨魚");
    note(h, `msg:test:${line.id.id}`);
    await wait(200);
    h.say(line);
    await wait(8_000);
    expect(llm.requests).toHaveLength(2);
  });
});
