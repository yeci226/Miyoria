// The bus envelope (the contract's draft plus `source`): what `eventEnvelope` and `is` give, and
// that the `Events` namespace holds every registered bus topic.

import { BUS_EVENTS } from "@miyoria/contracts/events";
import { describe, expect, it } from "vitest";
import { type ContextKey, Events, eventEnvelope, is } from "../src/index.js";

const context: ContextKey = { platform: "discord", scope: "g", channel: "c", kind: "channel" };
const account = { platform: "discord", id: "100" };
const T = "01JC0000000000000000000000";

describe("the Events namespace", () => {
  it("holds exactly the registered bus topics", () => {
    const here = new Set<unknown>(Object.values(Events));
    expect(here.size).toBe(BUS_EVENTS.length);
    for (const definition of BUS_EVENTS) expect(here.has(definition)).toBe(true);
  });
});

describe("eventEnvelope", () => {
  it("stamps the draft's keys and the source", () => {
    const env = eventEnvelope(
      "discord",
      Events.PlatformTyping,
      { context, account },
      {
        now: 0,
        turn: T,
      },
    );
    expect(env).toEqual({
      id: env.id,
      at: "1970-01-01T00:00:00.000Z",
      type: "platform.typing",
      v: 1,
      source: "discord",
      parent: null,
      turn: T,
      session: null,
      space_id: null,
      room_id: null,
      person_id: null,
      account_id: null,
      scope: null,
      key: null,
      data: { context, account },
    });
  });

  it("takes a family member's type, and refuses one the family does not cover", () => {
    const at = "2026-11-15T00:00:00.000Z";
    const payload = {
      type: "progress" as const,
      task: "t1",
      progress: { note: "half", fraction: 0.5, at },
    } as never;
    const env = eventEnvelope("worklane", Events.TaskProgress, payload, {
      type: "worklane.task.progress",
    });
    expect(env.type).toBe("worklane.task.progress");
    expect(env.data).toBe(payload);
    expect(() =>
      eventEnvelope("worklane", Events.TaskProgress, payload, { type: "worklane.task.done" }),
    ).toThrow("does not cover");
  });
});

describe("is", () => {
  it("narrows by type, family and version", () => {
    const env = eventEnvelope("discord", Events.PlatformTyping, { context, account });
    expect(is(Events.PlatformTyping, env)).toBe(true);
    expect(is(Events.PlatformReady, env)).toBe(false);
    if (is(Events.PlatformTyping, env)) expect(env.data.account.id).toBe("100");
    const task = { ...env, type: "game.minecraft.task.done", data: {} };
    expect(is(Events.TaskDone, task)).toBe(true);
    expect(is(Events.TaskFailed, task)).toBe(false);
    expect(is(Events.PlatformTyping, { ...env, v: 2 })).toBe(false);
  });
});
