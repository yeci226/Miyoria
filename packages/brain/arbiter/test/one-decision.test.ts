// One decision on what she starts herself (docs/design/v4-plan.md §7.6). Five limiters used to
// overlap: the Arbiter's gaps between her starts, the Floor's wait after lines nobody answered,
// the channel level's start gap, mind's `SelfStarts` and `unanswered.ts`. Under the Floor each of
// their waits is one input of `FloorCore.check`, and the latest of them is the one answer, with
// one reason and one retry time. And the three things other modules asked of it: the daily-post
// channel needs nobody there, pats may claim, a party game is a show.

import { EventLogService } from "@miyoria/memory/facts";
import { Supervisor } from "@miyoria/runtime/kernel";
import {
  type DeliveryLedger,
  EventLogKey,
  FloorKey,
  ImpulseHostKey,
  PartyStatusKey,
} from "@miyoria/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArbiterModule, FloorConfigSchema, FloorCore, type StartFacts } from "../src/index.js";
import { FakeHost, MIN, T0, textCtx, voiceCtx } from "./helpers.js";

const TEXT = textCtx("c");
const ROOM = voiceCtx("v");

afterEach(() => {
  vi.useRealTimers();
});

function floor(now: () => number) {
  return new FloorCore(FloorConfigSchema.parse({}), 3, {
    now,
    ledger: () =>
      ({
        mayClaim: () => true,
        delivered: () => null,
        saidLately: () => null,
      }) as unknown as DeliveryLedger,
    humans: (c) => (c.kind === "voice" ? 2 : null),
  });
}

function start(p: Partial<StartFacts> = {}): StartFacts {
  return {
    lastAnywhere: null,
    lastHere: null,
    minGapMs: 0,
    baseGapMs: 0,
    placeGapMs: 0,
    misses: 0,
    levelGapMs: 0,
    afterSpeechUntil: null,
    clock: (at) => new Date(at).toISOString().slice(11, 16),
    ...p,
  };
}

describe("the waits on her own starts are one decision", () => {
  const now = T0;

  it("each limit still holds her back, with its own reason", () => {
    const f = floor(() => now);
    const gap = f.check("wish", ROOM, null, start({ lastAnywhere: now - 30_000, minGapMs: MIN }));
    expect(gap).toMatchObject({ reason: "cooldown", retryAt: now + 30_000 });
    const missed = f.check(
      "wish",
      ROOM,
      null,
      start({ lastHere: now - 10 * MIN, baseGapMs: 5 * MIN, placeGapMs: 20 * MIN, misses: 2 }),
    );
    expect(missed).toMatchObject({ reason: "unanswered", retryAt: now + 10 * MIN });
    expect(missed?.detail).toContain("連續 2 次沒人接");
    const level = f.check(
      "wish",
      ROOM,
      null,
      start({
        lastHere: now - MIN,
        baseGapMs: 5 * MIN,
        placeGapMs: 5 * MIN,
        levelGapMs: 3 * 60 * MIN,
      }),
    );
    expect(level).toMatchObject({ reason: "ceiling", retryAt: now + 179 * MIN });
    const spoke = f.check("wish", ROOM, null, start({ afterSpeechUntil: now + 5_000 }));
    expect(spoke).toMatchObject({ reason: "cooldown", retryAt: now + 5_000 });
  });

  it("the latest wait is the one answer, and nothing else she says is held by her start gaps", () => {
    const f = floor(() => now);
    const all = start({
      lastAnywhere: now - 10_000,
      minGapMs: MIN,
      lastHere: now - MIN,
      baseGapMs: 5 * MIN,
      placeGapMs: 10 * MIN,
      misses: 1,
      afterSpeechUntil: now + 5_000,
    });
    expect(f.check("wish", ROOM, null, all)).toMatchObject({
      reason: "unanswered",
      retryAt: now + 9 * MIN,
    });
    expect(f.startsAt(ROOM, all)).toBe(now + 9 * MIN);
    expect(f.check("notable", ROOM, null, all)).toBeNull();
  });
});

describe("what other modules asked of the Floor", () => {
  it("a wish for a text channel nobody is in is refused", () => {
    const f = floor(() => T0);
    expect(f.check("wish", TEXT)?.reason).toBe("nobody");
  });

  async function moduleRig() {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const sup = new Supervisor();
    const log = new EventLogService({ profile: "p", store: null });
    const host = new FakeHost();
    const playing = new Set<string>();
    sup.services.provide("app", EventLogKey, log);
    sup.services.provide("app", ImpulseHostKey, host);
    sup.services.provide("app", PartyStatusKey, {
      running: (c) => (playing.has(c.channel) ? { game: "song", title: "猜歌" } : null),
    });
    await sup.register(new ArbiterModule("p"), {}, true);
    await sup.startAll();
    return { sup, log, host, playing };
  }

  it("a batch of pats written notable may claim the mic; an ambient one is only known", async () => {
    const r = await moduleRig();
    const pats = (notable: boolean, revision: number) =>
      r.log.observe({
        source: "live.pat",
        silent: !notable,
        salience: notable ? "notable" : "ambient",
        attention_key: "live:pat",
        revision,
        summary: "3 個人摸了摸你的頭",
        addressed_to_her: false,
        from: null,
        context: TEXT,
      });
    pats(false, 1);
    pats(true, 2);
    await vi.advanceTimersByTimeAsync(10);
    expect(r.host.opened.map((i) => [i.attention?.key, i.attention?.revision])).toEqual([
      ["live:pat", 2],
    ]);
    await r.sup.stopAll();
  });

  it("a running party game counts as performing for her talk budget", async () => {
    const r = await moduleRig();
    const f = r.sup.services.require(FloorKey);
    expect(f.budget(ROOM).performing).toBe(false);
    r.playing.add(ROOM.channel);
    expect(f.budget(ROOM)).toMatchObject({ performing: true, allowed: 6 + 8 });
    await r.sup.stopAll();
  });
});
