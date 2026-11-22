// Small closes of her initiative on the new runner: the count she reads in block 7, the morning's
// stop record.

import { transcriptTables } from "@miyoria/memory/transcript";
import { type Supervisor, sleep } from "@miyoria/runtime/kernel";
import { SettingsStoreKey, SqliteStore } from "@miyoria/store";
import {
  type Arbiter,
  type ArbiterDecision,
  ArbiterKey,
  Events,
  type LedgerView,
  toTimestamp,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { initiativeTables, type SelfHost } from "../src/index.js";
import { channel, mention, Rig, says, stopRigs, textOf, until } from "./harness.js";

afterEach(async () => {
  await stopRigs();
});

const C1 = channel("c1");
const MIN = 60_000;

function host(rig: Rig): SelfHost {
  if (rig.host === null) throw new Error("no host");
  return rig.host;
}

/** An Arbiter that only has a ledger: nothing started in it. */
function quietArbiter(): Arbiter {
  const view: LedgerView = {
    at: toTimestamp(Date.now()),
    entries: [],
    unanswered: [],
    limits: {
      initiatives_today: 0,
      initiative_cap: 12,
      unanswered_streak: 0,
      next_initiative_at: null,
      quiet_hours: null,
      paused: false,
      blocked: [],
    },
  };
  return {
    ledger: () => structuredClone(view),
    submit: async () => {
      throw new Error("not used");
    },
    record: () => "x",
    resolve: () => false,
  };
}

describe("the count of what she started today", () => {
  it("includes the starts of her initiative", async () => {
    const rig = await Rig.create({
      provide: (sup) => sup.services.provide("app", ArbiterKey, quietArbiter()),
    });
    // Nothing started yet: the count is not said.
    rig.model.push(says("嗨"));
    rig.say(mention(C1, "amy", "@她 在嗎"));
    await until(() => rig.sink.texts().length === 1, 3_000, "the first answer");
    expect(textOf(rig.model.requests[0])).not.toContain("今天你自己開了");

    host(rig).initiative.book.set({
      when: { due: Date.now() + MIN, daily: null },
      note: "看看大家",
      context: C1,
    });
    rig.shift = 2 * MIN;
    await host(rig).initiative.tick();
    await until(() => rig.model.requests.length === 2, 3_000, "her own run");
    await sleep(50);
    rig.model.push(says("好"));
    rig.say(mention(C1, "amy", "@她 還在嗎"));
    await until(() => rig.model.requests.length === 3, 3_000, "the next run");
    expect(textOf(rig.model.requests[2])).toContain("今天你自己開了 1 次話題(上限 12)");
  });
});

describe("what did not work lately", () => {
  it("is her state with its own heading, never one of the owner's rules", async () => {
    const arbiter = quietArbiter();
    const view = arbiter.ledger(null);
    const now = Date.now();
    view.limits.failed = [
      {
        capability: "送魚幣給一個人",
        reason: "不知道「Lumen」是誰,沒有送出",
        at: toTimestamp(now),
        until: toTimestamp(now + 30 * MIN),
      },
    ];
    view.limits.blocked = [{ capability: "game.start", reason: "遊戲剛被關掉了", until: null }];
    const rig = await Rig.create({
      provide: (sup) =>
        sup.services.provide("app", ArbiterKey, {
          ...arbiter,
          ledger: () => structuredClone(view),
        }),
    });
    rig.model.push(says("嗨"));
    rig.say(mention(C1, "amy", "@她 在嗎"));
    await until(() => rig.sink.texts().length === 1, 3_000, "the answer");
    const text = textOf(rig.model.requests[0]);
    expect(text).not.toContain("# 主人規則");
    expect(text).toContain("剛才沒做成的事(只是結果,不是規則");
    expect(text).toContain("送魚幣給一個人:不知道「Lumen」是誰,沒有送出");
    expect(text).toContain("game.start 暫時不行:遊戲剛被關掉了");
  });
});

/** The shift to the next noon (UTC+8): after her morning hour, whatever hour this runs at. */
function toNoon(): number {
  const day = 24 * 60 * MIN;
  const local = Date.now() + 8 * 60 * MIN;
  let noon = local - (local % day) + 12 * 60 * MIN;
  if (noon <= local) noon += day;
  return noon - local;
}

describe("the morning without a home place", () => {
  it("is recorded as stopped once a day, however often she looks", async () => {
    const rig = await Rig.create();
    const decisions = () =>
      rig
        .of<ArbiterDecision>(Events.ArbiterDecided.type)
        .filter((d) => d.impulse.startsWith("morning:"));
    rig.shift = toNoon();
    for (let i = 0; i < 3; i++) {
      await host(rig).initiative.tick();
      await sleep(20);
    }
    expect(decisions().map((d) => d.reason)).toEqual(["nobody"]);
  });

  it("is not said again after a restart the same day, but is the next day", async () => {
    const db = await SqliteStore.open(":memory:", {
      plugins: [transcriptTables, initiativeTables],
    });
    const provide = (sup: Supervisor) => sup.services.provide("app", SettingsStoreKey, db.settings);
    const morning = (rig: Rig) =>
      rig
        .of<ArbiterDecision>(Events.ArbiterDecided.type)
        .filter((d) => d.impulse.startsWith("morning:"));
    const first = await Rig.create({ store: db, provide });
    const noon = toNoon();
    first.shift = noon;
    await host(first).initiative.tick();
    await sleep(20);
    expect(morning(first)).toHaveLength(1);
    await first.stop();

    const again = await Rig.create({ store: db, provide });
    again.shift = noon;
    await host(again).initiative.tick();
    await sleep(20);
    expect(morning(again)).toHaveLength(0);
    again.shift += 24 * 60 * MIN;
    await host(again).initiative.tick();
    await sleep(20);
    expect(morning(again)).toHaveLength(1);
    await db.close();
  });
});
