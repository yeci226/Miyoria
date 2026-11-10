// v4 §5.2, §5.3: "just now", the other places, her questions across places, and the place rule.

import type { PlaceAccess, Timestamp, Whereabouts } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  fitNewest,
  OtherPlaces,
  questionOf,
  type RecentConfig,
  type RecentDeps,
  RecentLog,
  sameQuestion,
  Threads,
  Timeline,
  viewerFor,
} from "../src/index.js";
import {
  at,
  dm,
  FakeHandles,
  FakeLog,
  FakeStates,
  guild,
  recentConfig,
  voice,
} from "./recent-helpers.js";

const S = "Sora";
const T = "Tomo";
const pS = "person-sora";
const pT = "person-tomo";

function readers(
  log: FakeLog,
  options: {
    config?: Partial<RecentConfig>;
    states?: FakeStates;
    access?: PlaceAccess;
  } = {},
) {
  const handles = new FakeHandles()
    .add(S, pS, { platform: "discord", id: "s" })
    .add(T, pT, { platform: "discord", id: "t" });
  const config = recentConfig(options.config);
  const deps: RecentDeps = {
    config: () => config,
    handles: () => handles,
    access: () => options.access ?? null,
    states: () => options.states ?? null,
    utcOffsetMinutes: 480,
  };
  const recent = new RecentLog(
    () => config,
    () => log,
  );
  return {
    recent,
    timeline: new Timeline(recent, deps),
    elsewhere: new OtherPlaces(recent, deps),
    threads: new Threads(
      recent,
      () => config,
      () => handles,
      (w, win) => viewerFor(w, win, deps),
    ),
  };
}

function where(
  context: Whereabouts["context"],
  now: Timestamp,
  talking: string[] = [],
  present: string[] = talking,
): Whereabouts {
  return { context, present, talking_with: talking, now };
}

describe("questions", () => {
  it("finds the question sentences of a line", () => {
    expect(questionOf("嗨!上次面試結果怎麼樣?我很好奇")).toBe("上次面試結果怎麼樣?");
    expect(questionOf("你今天有空嗎")).toBe("你今天有空嗎");
    expect(questionOf("好喔,晚安。")).toBe("");
  });

  it("groups the same question however it is worded", () => {
    expect(sameQuestion("上次面試結果怎麼樣?", "面試結果怎麼樣呀?")).toBe(true);
    expect(sameQuestion("上次面試結果怎麼樣?", "晚餐要吃什麼?")).toBe(false);
  });
});

// 2026-11-10: she DMed S a follow-up at 11:07, S answered in the DM at 11:22 and 11:33, and from
// 12:12 she asked the same thing again in a public channel, again and again.
describe("the 2026-11-10 incident: asked and answered in a DM", () => {
  function incident(): FakeLog {
    const log = new FakeLog();
    log.her("嗨~上次面試結果怎麼樣?", at(11, 7), dm("dm-s"), [S]);
    log.say(S, "還不錯,拿到二面了", at(11, 22), dm("dm-s"));
    log.say(S, "下週二去", at(11, 33), dm("dm-s"));
    return log;
  }

  it("a turn in a channel with S as the one she talks with knows it was asked and answered, marked private", async () => {
    const r = readers(incident());
    const here = where(guild("lobby"), at(12, 12), [pS], [pS, pT]);
    const text = await r.timeline.render(here, 2000);
    expect(text).toContain("你問過 Sora「上次面試結果怎麼樣?」");
    expect(text).toContain("Sora 11:22 在和 Sora 的私訊回了:「還不錯,拿到二面了」");
    expect(text).toContain("不要在這裡引用或透露");
    const thread = await r.threads.thread(pS, here);
    expect(thread?.questions).toHaveLength(1);
    expect(thread?.questions[0]?.answered_at).toBe(at(11, 22));
    expect(thread?.questions[0]?.private).toBe(true);
  });

  it("a turn in a channel where S is present but not the one she talks with gets none of it", async () => {
    const r = readers(incident());
    const here = where(guild("lobby"), at(12, 12), [pT], [pS, pT]);
    const text = await r.timeline.render(here, 2000);
    expect(text).not.toContain("面試");
    expect(text).not.toContain("二面");
    expect(await r.threads.thread(pS, here)).toBeNull();
  });

  it("a channel without S, and someone else's DM, get none of it", async () => {
    const r = readers(incident());
    for (const here of [where(guild("lobby"), at(12, 12)), where(dm("dm-t"), at(12, 12), [pT])]) {
      const text = await r.timeline.render(here, 2000);
      expect(text).not.toContain("面試");
      expect((await r.timeline.entries(here)).some((e) => e.private)).toBe(false);
    }
  });

  it("counts every asking across places for the planners, without words", async () => {
    const log = incident();
    for (const [h, m] of [
      [12, 12],
      [12, 25],
      [12, 37],
      [12, 49],
    ] as const) {
      log.her("對了,面試結果怎麼樣?", at(h, m), guild("lobby"), [S]);
      log.say(S, "你已經在私訊問過我了", at(h, m + 1), guild("lobby"));
    }
    const r = readers(log);
    const asked = await r.threads.asked(pS, "面試的結果怎麼樣?", at(12, 50));
    expect(asked).toMatchObject({ times: 5, answered_at: at(11, 22), private: true });
    expect(asked?.last_asked_at).toBe(at(12, 49));
    expect(JSON.stringify(asked)).not.toContain("二面");
    // The channel sees all five, the DM ones marked.
    const here = where(guild("lobby"), at(12, 50), [pS]);
    const q = (await r.threads.thread(pS, here))?.questions[0];
    expect(q?.asked).toHaveLength(5);
    expect(q?.asked[0]?.private).toBe(true);
    expect(q?.asked[1]?.private).toBe(false);
    expect(await r.threads.asked(pS, "晚餐吃什麼?", at(12, 50))).toBeNull();
    // Seen from a channel where S is not the one she talks with: the channel askings only.
    const other = (await r.threads.thread(pS, where(guild("lobby"), at(12, 50), [pT])))
      ?.questions[0];
    expect(other?.asked).toHaveLength(4);
    expect(other?.answer).toBe("你已經在私訊問過我了");
  });

  it("is read again from the log after a restart", async () => {
    const log = incident();
    const first = readers(log);
    const here = where(guild("lobby"), at(12, 12), [pS]);
    const before = await first.timeline.render(here, 2000);
    const again = readers(log);
    expect(await again.timeline.render(here, 2000)).toBe(before);
  });
});

describe("just now", () => {
  it("lists songs, games and voice across places, oldest first, in local time", async () => {
    const log = new FakeLog();
    log.happen("sing", "正在唱:夜に駆ける", at(14, 0), "song:yoru");
    log.happen("sing", "唱完了:yoru", at(14, 4), "song:yoru");
    log.happen("game.session", "正在玩 Minecraft", at(14, 10), "game:session:mc");
    log.happen("voice.presence", "語音頻道裡有:Sora", at(14, 1), "voice:members:v", voice("v"));
    log.happen(
      "voice.presence",
      "語音頻道裡有:Sora、Tomo",
      at(14, 3),
      "voice:members:v",
      voice("v"),
    );
    log.happen("game.director", "完成目標:做一把石鎬", at(14, 20), "game:goal:pick");
    const r = readers(log);
    const text = await r.timeline.render(where(guild("lobby"), at(14, 30)), 2000);
    expect(text.split("\n")).toEqual([
      "- 14:00 唱了〈夜に駆ける〉",
      "- 14:01 語音 語音裡有:Sora、Tomo",
      "- 14:10 開始玩 Minecraft",
      "- 14:20 遊戲裡完成目標:做一把石鎬",
    ]);
  });

  it("shows who talked to her elsewhere and what she answered, not this place", async () => {
    const log = new FakeLog();
    log.say(T, "米優你剛剛唱什麼", at(15, 0), guild("music"), { addressed: true });
    log.her("夜に駆ける!", at(15, 1), guild("music"));
    log.say(T, "這裡的話", at(15, 2), guild("lobby"), { addressed: true });
    const r = readers(log);
    const text = await r.timeline.render(where(guild("lobby"), at(15, 5)), 2000);
    expect(text).toBe("- 15:00 別的文字頻道 Tomo對你說:「米優你剛剛唱什麼」;你回:「夜に駆ける!」");
  });

  it("keeps out other guilds, hidden channels and places someone here cannot see", async () => {
    const log = new FakeLog();
    log.say(T, "別的伺服器", at(15, 0), guild("x", "g2"), { addressed: true });
    log.say(T, "管理員頻道", at(15, 1), guild("mods"), { addressed: true });
    log.say(T, "秘密頻道", at(15, 2), guild("secret"), { addressed: true });
    log.say(T, "大廳", at(15, 3), guild("hall"), { addressed: true });
    const access: PlaceAccess = { canSee: (_a, place) => place.channel !== "secret" };
    const r = readers(log, { config: { hidden_channels: ["mods"] }, access });
    const here: Whereabouts = {
      ...where(guild("lobby"), at(15, 5)),
      accounts: [{ platform: "discord", id: "t" }],
    };
    expect(await r.timeline.render(here, 2000)).toBe("- 15:03 別的文字頻道 Tomo對你說:「大廳」");
  });

  it("fits the newest entries into the budget", () => {
    expect(fitNewest(["aaaa", "bbbb", "cc"], 9)).toEqual(["bbbb", "cc"]);
    expect(fitNewest(["aaaa"], 3)).toEqual([]);
  });

  it("reuses one read of the log for cache_secs", async () => {
    const log = new FakeLog();
    log.happen("sing", "正在唱:a", at(14, 0), "song:a");
    const r = readers(log, { config: { cache_secs: 10 } });
    await r.timeline.render(where(guild("lobby"), at(14, 30)), 500);
    await r.elsewhere.render(where(guild("lobby"), at(14, 30)), 500);
    expect(log.queries).toBe(1);
    await r.timeline.render(where(guild("lobby"), at(14, 31)), 500);
    expect(log.queries).toBe(2);
  });
});

describe("elsewhere", () => {
  it("a voice turn sees the text channel: its recap with its age and its last lines", async () => {
    const log = new FakeLog();
    log.say(T, "等等要開團嗎", at(20, 0), guild("lobby"));
    log.her("好啊我也要", at(20, 1), guild("lobby"));
    log.say(S, "九點集合", at(20, 3), guild("lobby"));
    log.say(S, "語音這邊", at(20, 4), voice("v"));
    const states = new FakeStates().add(guild("lobby"), "大家在約晚上的副本", at(19, 50));
    const r = readers(log, { states });
    const text = await r.elsewhere.render(where(voice("v"), at(20, 5)), 2000);
    expect(text).toBe(
      [
        "[別的文字頻道](最後一句 20:03)",
        "提要(19:50 寫的,之後還有新的話):大家在約晚上的副本",
        "- Tomo:等等要開團嗎",
        "- 你:好啊我也要",
        "- Sora:九點集合",
      ].join("\n"),
    );
    // And the text channel sees voice.
    const back = await r.elsewhere.places(where(guild("lobby"), at(20, 5)));
    expect(back.map((p) => p.place.label)).toEqual(["語音"]);
  });

  it("never lists DMs, other guilds or quiet places, and shows nothing in a DM", async () => {
    const log = new FakeLog();
    log.say(S, "私訊的話", at(20, 0), dm("dm-s"));
    log.say(T, "別的伺服器", at(20, 0), guild("x", "g2"));
    log.say(T, "很久以前", at(19, 0), guild("old"));
    log.say(T, "大廳", at(20, 0), guild("hall"));
    const r = readers(log);
    const here = where(guild("lobby"), at(20, 5), [pS]);
    expect((await r.elsewhere.places(here)).map((p) => p.lines)).toEqual([["Tomo:大廳"]]);
    expect(await r.elsewhere.render(where(dm("dm-t"), at(20, 5), [pT]), 2000)).toBe("");
  });
});
