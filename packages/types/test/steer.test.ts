import { describe, expect, it } from "vitest";
import {
  isSteerOutcome,
  isTaskSteer,
  parseTaskEvent,
  parseTaskTopic,
  taskTopic,
} from "../src/index.js";

const steered = {
  type: "steered",
  task: "t1",
  steer: "s1",
  outcome: "applied",
  detail: "ok",
  at: "2026-11-07T00:00:00.000Z",
};

describe("steer types", () => {
  it("knows the three outcomes", () => {
    for (const o of ["applied", "rejected", "too_late"]) expect(isSteerOutcome(o)).toBe(true);
    expect(isSteerOutcome("maybe")).toBe(false);
  });

  it("parses a steered event and refuses a broken one", () => {
    expect(parseTaskEvent(steered)).toMatchObject({
      type: "steered",
      steer: "s1",
      outcome: "applied",
    });
    expect(parseTaskEvent({ ...steered, outcome: "maybe" })).toBeNull();
    expect(parseTaskEvent({ ...steered, steer: "" })).toBeNull();
    expect(parseTaskEvent({ ...steered, steer: "x".repeat(65) })).toBeNull();
  });

  it("routes the steered topic", () => {
    expect(parseTaskTopic(taskTopic("game", "steered"))).toEqual({
      owner: "game",
      type: "steered",
    });
    expect(parseTaskTopic("game.task.steered")).not.toBeNull();
  });

  it("checks a steer", () => {
    const steer = { id: "s1", task: "t1", patch: { count: 2 }, why: "w", cause: "c" };
    expect(isTaskSteer(steer)).toBe(true);
    expect(isTaskSteer({ ...steer, patch: "x" })).toBe(false);
    expect(isTaskSteer({ ...steer, task: 3 })).toBe(false);
    expect(isTaskSteer(null)).toBe(false);
  });
});
