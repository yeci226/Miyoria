// Which results a turn answering someone may tell (and so count as told).

import { describe, expect, it } from "vitest";
import { type Job, resultsFor } from "../src/mainline/hands.js";

function job(id: string, asker: string | null): Job {
  return {
    id,
    event: null,
    turn: "t",
    context: { platform: "test", scope: null, channel: "c", kind: "channel" },
    tool: "accept_food",
    state: "done",
    detail: "收下了",
    task: null,
    steer: null,
    at: 0,
    report: "turn",
    depth: 0,
    requester:
      asker === null
        ? undefined
        : { author: { account: { platform: "test", id: asker }, display_name: asker } },
  };
}

describe("resultsFor", () => {
  const jobs = [job("a", "b.netanyahu"), job("b", null), job("c", "Sakana")];

  it("a_turn_for_someone_leaves_another_persons_result_to_its_own_turn", () => {
    const told = resultsFor(jobs, [{ platform: "test", id: "Sakana" }]);
    expect(told.map((j) => j.id)).toEqual(["b", "c"]);
  });

  it("a_turn_for_nobody_in_particular_may_tell_them_all", () => {
    expect(resultsFor(jobs, null).map((j) => j.id)).toEqual(["a", "b", "c"]);
    expect(resultsFor(jobs, []).map((j) => j.id)).toEqual(["a", "b", "c"]);
  });
});
