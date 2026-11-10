// The 2026-11-07 run: told to stop Minecraft, she opened the game again within seconds. The rule
// itself is `ArbiterCore.gameClosed` (arbiter.test.ts); this is the wiring that makes it happen,
// through the module and the bus: a finished `stop` of the game holds `game.start` for her own
// starts, a crash or another activity does not, and people asking her are never held back.

import { Supervisor } from "@miyoria/kernel";
import { MemorySettingsStore, SettingsStoreKey } from "@miyoria/store";
import {
  ACTIVITY_DONE_TOPIC,
  ACTIVITY_FAILED_TOPIC,
  type ActivityRequest,
  type ArbiterDecision,
  ArbiterKey,
  ImpulseHostKey,
  type ImpulseSource,
  newImpulse,
  toTimestamp,
  v2Event,
} from "@miyoria/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArbiterModule } from "../src/index.js";
import { FakeHost, MIN, T0, textCtx } from "./helpers.js";

afterEach(() => {
  vi.useRealTimers();
});

const HERE = textCtx("games");
/** The words of the hold in the decision she is shown. */
const HOLD_TEXT = "不要自己重開";

async function build() {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  const sup = new Supervisor();
  sup.services.provide("app", ImpulseHostKey, new FakeHost());
  sup.services.provide("app", SettingsStoreKey, new MemorySettingsStore());
  await sup.register(new ArbiterModule("p"), null, true);
  await sup.startAll();
  const arbiter = sup.services.get(ArbiterKey);
  if (!arbiter) throw new Error("no arbiter");
  return { sup, arbiter };
}

const STOP_GAME: ActivityRequest = { type: "stop", activity: "game" };

function done(request: ActivityRequest) {
  return v2Event(ACTIVITY_DONE_TOPIC, {
    type: "done",
    task: "t1",
    resource: "activity",
    request,
    turn: null,
    detail: "",
    data: null,
    at: toTimestamp(Date.now()),
  });
}

function failed(request: ActivityRequest, code: "crashed") {
  return v2Event(ACTIVITY_FAILED_TOPIC, {
    type: "failed",
    task: "t2",
    resource: "activity",
    request,
    turn: null,
    code,
    detail: "",
    at: toTimestamp(Date.now()),
  });
}

function startGame(source: ImpulseSource) {
  return newImpulse(
    {
      source,
      kind: "act",
      capability: "game.start",
      context: HERE,
      ttlMs: 10 * MIN,
      why: "play",
    },
    Date.now(),
  );
}

describe("a game that was stopped stays stopped", () => {
  it("after a finished stop she cannot start it herself for an hour, people still can", async () => {
    const { sup, arbiter } = await build();
    expect(arbiter.held?.("game.start")).toBeNull();
    sup.bus.publish("activity", done(STOP_GAME));
    await vi.advanceTimersByTimeAsync(10);

    expect(arbiter.held?.("game.start")).not.toBeNull();
    const own: ArbiterDecision = await arbiter.submit(startGame("plan"));
    expect(own).toMatchObject({ verdict: "rejected", reason: "denied" });
    expect(own.detail).toContain(HOLD_TEXT);
    const asked: ArbiterDecision = await arbiter.submit(startGame("message"));
    expect(JSON.stringify(asked)).not.toContain(HOLD_TEXT);

    // Not for good, and the hold is exactly as long as configured.
    await vi.advanceTimersByTimeAsync(59 * MIN);
    expect(arbiter.held?.("game.start")).not.toBeNull();
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(arbiter.held?.("game.start")).toBeNull();
    expect(JSON.stringify(await arbiter.submit(startGame("plan")))).not.toContain(HOLD_TEXT);
    await sup.stopAll();
  });

  it("a crash, or stopping something else, does not hold the game", async () => {
    const { sup, arbiter } = await build();
    sup.bus.publish("activity", failed(STOP_GAME, "crashed"));
    sup.bus.publish("activity", done({ type: "stop", activity: "browse" }));
    sup.bus.publish("activity", done({ type: "leave_voice" }));
    await vi.advanceTimersByTimeAsync(10);
    expect(arbiter.held?.("game.start")).toBeNull();
    expect(JSON.stringify(await arbiter.submit(startGame("plan")))).not.toContain(HOLD_TEXT);
    await sup.stopAll();
  });
});
