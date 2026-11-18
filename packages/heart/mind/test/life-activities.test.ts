// The activity table of v4 §8.1 and who decides (§8.2): every want leads to something real, rows
// whose package is not running are skipped, and her day stays varied.

import type { LifeActivityId } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  activityOfCapability,
  FUTURE_CAPABILITIES,
  LIFE_ACTIVITIES,
  type LifeSituation,
  type LifeTally,
  lifeActivity,
  lifeOptions,
  lifeTable,
  overShare,
} from "../src/index.js";

const T0 = Date.parse("2026-11-10T07:00:00.000Z"); // 15:00 at UTC+8
const MIN = 60_000;

/** What is registered in a running app today (web, sandbox, sing, game, economy). */
const TODAY = new Set([
  "web.search",
  "web.read",
  "code.run",
  "sing.request",
  "sing.play",
  "game.start",
  "economy.post_bounty",
  "chat.start",
  "chat.dm",
]);

function situation(p: Partial<LifeSituation> = {}): LifeSituation {
  return {
    now: T0,
    hour: 15,
    capabilities: TODAY,
    energy: 0.6,
    people: 1,
    voicePeople: 0,
    done: new Map(),
    awakeMinutes: 9 * 60,
    gameShare: 0.35,
    held: () => null,
    budgetOk: true,
    doing: null,
    ...p,
  };
}

function done(entries: [LifeActivityId, Partial<LifeTally>][]): Map<LifeActivityId, LifeTally> {
  return new Map(entries.map(([id, t]) => [id, { count: 1, minutes: 0, last: null, ...t }]));
}

describe("the activity table", () => {
  it("has every row of §8.1, each tied to capabilities", () => {
    expect(LIFE_ACTIVITIES.map((a) => a.label)).toEqual([
      "逛網路",
      "寫日記",
      "寫程式",
      "練歌",
      "玩遊戲",
      "整理回憶",
      "經營",
      "關心人",
      "辦活動",
      "唱歌",
    ]);
    for (const a of LIFE_ACTIVITIES) expect(a.capabilities.length).toBeGreaterThan(0);
    expect(lifeActivity("browse").capabilities).toContain("web.search");
    expect(lifeActivity("event").capabilities).toEqual([FUTURE_CAPABILITIES.party]);
  });

  it("skips rows whose capability is not registered yet, and lights them up once it is", () => {
    const table = lifeTable(situation({ hour: 21 }));
    const reason = (id: LifeActivityId) => table.find((r) => r.activity.id === id)?.reason;
    expect(reason("diary")).toBe("還不能做(功能沒開)");
    expect(reason("recap")).toBe("還不能做(功能沒開)");
    expect(reason("browse")).toBeNull();
    const withDiary = lifeTable(
      situation({ hour: 21, capabilities: new Set([...TODAY, FUTURE_CAPABILITIES.diary]) }),
    );
    expect(withDiary.find((r) => r.activity.id === "diary")).toMatchObject({
      capability: "diary.write",
      reason: null,
    });
  });

  it("prefers her own workspace for code once the sandbox has one", () => {
    const opt = (caps: Set<string>) =>
      lifeOptions(situation({ capabilities: caps }), ["curiosity"]).find(
        (o) => o.activity.id === "code",
      )?.capability;
    expect(opt(TODAY)).toBe("code.run");
    expect(opt(new Set([...TODAY, FUTURE_CAPABILITIES.workspace]))).toBe("workspace.write");
  });

  it("checks people, time of day and energy", () => {
    const ids = (s: LifeSituation) => lifeOptions(s).map((o) => o.activity.id);
    // Business needs someone around; an event needs two in voice (and the party package).
    expect(ids(situation({ people: 0 }))).not.toContain("business");
    expect(ids(situation())).toContain("business");
    const party = new Set([...TODAY, FUTURE_CAPABILITIES.party]);
    expect(ids(situation({ capabilities: party, voicePeople: 1 }))).not.toContain("event");
    expect(ids(situation({ capabilities: party, voicePeople: 3 }))).toContain("event");
    // No coding at 03:00, no practice past midnight; tired: no code either.
    expect(ids(situation({ hour: 3 }))).not.toContain("code");
    expect(ids(situation({ hour: 0 }))).not.toContain("practice");
    expect(ids(situation({ energy: 0.2 }))).not.toContain("code");
    expect(ids(situation({ energy: 0.2 }))).toContain("browse");
  });

  it("owner rules, holds and a tight budget come first", () => {
    const held = situation({ held: (c) => (c === "web.search" ? "主人說今天不要上網" : null) });
    const browse = lifeTable(held).find((r) => r.activity.id === "browse");
    expect(browse).toMatchObject({ capability: null, reason: "主人說今天不要上網" });
    expect(lifeOptions(situation({ budgetOk: false }))).toEqual([]);
  });

  it("varies her day: never-done first, cooldowns, times a day and the share of her day", () => {
    const fresh = lifeOptions(situation(), ["explore", "curiosity"]);
    expect(fresh[0]).toMatchObject({ fit: 1, why: "今天還沒做過" });
    // Browsed 20 minutes ago: not again yet; code comes first.
    const browsed = situation({ done: done([["browse", { minutes: 5, last: T0 - 20 * MIN }]]) });
    expect(lifeOptions(browsed, ["explore"]).map((o) => o.activity.id)).toEqual(["code"]);
    // Browsed long ago: allowed again, after what she has not done today.
    const earlier = situation({
      done: done([["browse", { minutes: 5, last: T0 - 3 * 60 * MIN }]]),
    });
    const order = lifeOptions(earlier, ["explore"]);
    expect(order.map((o) => o.activity.id)).toEqual(["code", "browse"]);
    expect(order[1]?.why).toBe("今天做過 1 次");
    // The diary once a day.
    const wrote = situation({
      hour: 22,
      capabilities: new Set([...TODAY, FUTURE_CAPABILITIES.diary]),
      done: done([["diary", { count: 1 }]]),
    });
    expect(lifeOptions(wrote).map((o) => o.activity.id)).not.toContain("diary");
  });

  it("caps games hardest: past the share of her waking day she does not start another", () => {
    const game = lifeActivity("game");
    expect(overShare(game, { count: 2, minutes: 180, last: null }, 9 * 60, 0.35)).toBeNull();
    expect(overShare(game, { count: 3, minutes: 200, last: null }, 9 * 60, 0.35)).toBe(
      "今天玩遊戲已經 3 小時 20 分,超過今天的 35%",
    );
    // Early in the day a share is of at least an hour.
    expect(overShare(game, { count: 1, minutes: 30, last: null }, 10, 0.35)).toContain("30 分鐘");
    expect(activityOfCapability("game.start")?.id).toBe("game");
    expect(activityOfCapability("chat.start")).toBeNull();
  });
});
