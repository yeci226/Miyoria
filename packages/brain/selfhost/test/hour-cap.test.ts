// The hourly cap of a conversation in the text host: `[modules.agent]` `session_tokens_per_hour` (the
// scripted model has no price, so the hour is counted in tokens) is the cap the run is held to, the
// one waiting is told when she is back, and the outcome says what it was.

import { Events, type TurnOutcomeRecord } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { HOUR_CAP_LINE } from "../../agent/src/index.js";
import { channel, mention, Rig, says, stopRigs, until } from "./harness.js";

afterEach(async () => {
  await stopRigs();
});

const C1 = channel("c1");
const MINUTE = 60_000;
const USAGE = { prompt_tokens: 1000, completion_tokens: 100, cached_prompt_tokens: 0 };

const outcomes = (rig: Rig) => rig.of<TurnOutcomeRecord>(Events.AgentTurnOutcome.type);

async function spentThenAsked(config: Record<string, number>): Promise<Rig> {
  const rig = await Rig.create({ config });
  rig.model.push(says("嗨"), says("又是我"));
  rig.say(mention(C1, "amy", "@她 在嗎"));
  await until(() => outcomes(rig).length === 1, 3_000, "the first answer");
  const host = rig.host;
  if (host === null) throw new Error("no host");
  // 1,100 tokens of a model without a price, 15 minutes ago; the first answer took 110.
  host.runner.spend.add(host.sessionOf(C1), Date.now() + rig.shift - 15 * MINUTE, null, USAGE);
  rig.say(mention(C1, "amy", "@她 還在嗎"));
  await until(() => outcomes(rig).length === 2, 3_000, "the second outcome");
  return rig;
}

describe("the hourly cap of a conversation", () => {
  it("is the one [modules.agent] sets: she says when she is back, with no model call", async () => {
    const rig = await spentThenAsked({ session_tokens_per_hour: 1000 });
    expect(rig.model.requests).toHaveLength(1);
    await until(() => rig.sink.texts().length === 2, 3_000, "the notice");
    expect(rig.sink.texts()).toEqual(["嗨", HOUR_CAP_LINE(45)]);
    expect(outcomes(rig)[1]?.outcome).toEqual({ type: "error", error: "over_budget" });
  });

  it("the default of 3,000,000 tokens lets the same hour through", async () => {
    const rig = await spentThenAsked({});
    expect(rig.model.requests).toHaveLength(2);
    expect(outcomes(rig)[1]?.outcome).toEqual({ type: "sent", parts: 1 });
  });
});
