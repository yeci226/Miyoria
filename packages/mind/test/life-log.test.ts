// Her life log (v4 §6.2 「今天的她」, §8.2): only what really ran, only what she did as herself,
// kept per day of hers across restarts, and rendered as a short summary.

import { MemorySettingsStore } from "@miyoria/store";
import {
  ACTIVITY_CHANGED_TOPIC,
  customEvent,
  type JsonValue,
  type LifeEntry,
  newEnvelope,
  type Principal,
  Principals,
  toTimestamp,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { LIFE_PREFIX, LifeBook, pointOf, renderLately, renderToday } from "../src/index.js";

const T0 = Date.parse("2026-11-10T07:00:00.000Z"); // 15:00 at UTC+8
const MIN = 60_000;
const HOUR = 60 * MIN;
const CHAT = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" as const };

function clock(start = T0) {
  let now = start;
  return {
    now: () => now,
    set: (t: number) => {
      now = t;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function book(
  c = clock(),
  store: MemorySettingsStore | null = null,
  onRecord?: (e: LifeEntry) => void,
) {
  return new LifeBook({
    store,
    profile: "p",
    clock: c,
    offsetMinutes: 480,
    dayStartHour: 6,
    keepDays: 3,
    ...(onRecord ? { onRecord } : {}),
  });
}

function decision(
  capability: string,
  args: Record<string, JsonValue>,
  principal: Principal = Principals.self(CHAT),
  allowed = true,
) {
  return newEnvelope(
    "actions",
    customEvent("gate.decision", {
      capability,
      args,
      allowed,
      at: toTimestamp(T0),
      principal: JSON.parse(JSON.stringify(principal)) as JsonValue,
    }),
  );
}

function activity(type: string, target: string | null, since: number, phase = "running") {
  return newEnvelope(
    "activity",
    customEvent(ACTIVITY_CHANGED_TOPIC, {
      activity:
        type === "idle"
          ? { type: "idle", since: toTimestamp(since) }
          : { type, target, phase, task: null, failure: null, since: toTimestamp(since) },
    }),
  );
}

describe("her life log", () => {
  it("writes her own allowed calls, never what she did for someone or what was refused", () => {
    const b = book();
    b.observe(decision("web.search", { query: "Minecraft 1.22 新生物" }));
    b.observe(
      decision(
        "web.search",
        { query: "天氣" },
        Principals.user({ platform: "discord", id: "1" }, CHAT),
      ),
    );
    b.observe(decision("web.search", { query: "x" }, Principals.self(CHAT), false));
    b.observe(decision("voice.join", {}));
    b.observe(decision("code.run", { language: "python" }));
    expect(b.today().map((e) => [e.activity, e.what])).toEqual([
      ["browse", "查了「Minecraft 1.22 新生物」"],
      ["code", "寫了一段 python"],
    ]);
  });

  it("a song someone asked for is not her practice; one she picked, or marked practice, is", () => {
    const b = book();
    const owen = { platform: "discord", id: "1" };
    b.observe(decision("sing.request", { query: "點播的歌" }, Principals.self(CHAT, owen)));
    b.observe(decision("sing.request", { query: "自己挑的歌" }));
    b.observe(
      decision(
        "sing.request",
        { query: "順便練的歌", practice: true },
        Principals.self(CHAT, owen),
      ),
    );
    expect(b.today().map((e) => e.what)).toEqual(["準備了〈自己挑的歌〉", "準備了〈順便練的歌〉"]);
  });

  it("names each kind of call in her terms", () => {
    expect(pointOf("web.read", { url: "https://minecraft.wiki/w/Mob" })).toEqual({
      activity: "browse",
      what: "讀了 minecraft.wiki 的網頁",
    });
    expect(pointOf("sing.request", { query: "夜に駆ける" })?.what).toBe("準備了〈夜に駆ける〉");
    expect(pointOf("diary.write", {})?.activity).toBe("diary");
    expect(pointOf("party.start", { game: "海龜湯" })?.what).toBe("辦了海龜湯");
    expect(pointOf("economy.give", {})).toBeNull();
  });

  it("times games and songs from the activity snapshot; a launch that failed at once is nothing", () => {
    const c = clock();
    const b = book(c);
    b.observe(activity("game", "minecraft", T0));
    c.advance(30 * MIN);
    // Still running: the tally already counts it.
    expect(b.tally().get("game")).toMatchObject({ count: 1, minutes: 30 });
    c.advance(50 * MIN);
    b.observe(activity("singing", "夜に駆ける", c.now()));
    c.advance(4 * MIN);
    b.observe(activity("idle", null, c.now()));
    b.observe(activity("game", "osu", c.now()));
    c.advance(20_000);
    b.observe(activity("idle", null, c.now()));
    expect(b.today().map((e) => [e.activity, e.what, e.minutes])).toEqual([
      ["game", "minecraft", 80],
      ["sing", "唱了〈夜に駆ける〉", 4],
    ]);
    expect(b.tally().get("game")).toMatchObject({ count: 1, minutes: 80 });
  });

  it("counts single acts by the table's minutes", () => {
    const b = book();
    b.observe(decision("web.search", { query: "a" }));
    b.observe(decision("web.search", { query: "b" }));
    expect(b.tally().get("browse")).toEqual({ count: 2, minutes: 10, last: T0 });
  });

  it("her day turns at daily_hour: 01:00 still belongs to the evening before", () => {
    const c = clock(Date.parse("2026-11-10T13:00:00.000Z")); // 21:00 local
    const b = book(c);
    b.observe(decision("web.search", { query: "晚上查的" }));
    c.set(Date.parse("2026-11-10T17:00:00.000Z")); // 01:00 local, Nov 11
    expect(b.today()).toHaveLength(1);
    expect(b.awakeMinutes()).toBe(19 * 60);
    c.set(Date.parse("2026-11-10T23:00:00.000Z")); // 07:00 local
    expect(b.today()).toHaveLength(0);
    expect(b.awakeMinutes()).toBe(60);
  });

  it("persists per day across a restart and forgets days past keep_days", async () => {
    const store = new MemorySettingsStore();
    const c = clock();
    const first = book(c, store);
    first.observe(decision("web.search", { query: "第一天" }));
    await first.flush();
    expect([...(await store.list("p", LIFE_PREFIX)).keys()]).toEqual(["mind:life:2026-11-10"]);
    const again = book(c, store);
    await again.load();
    expect(again.today().map((e) => e.what)).toEqual(["查了「第一天」"]);
    c.advance(4 * 24 * HOUR);
    const later = book(c, store);
    await later.load();
    await later.flush();
    expect(later.entries()).toEqual([]);
    expect((await store.list("p", LIFE_PREFIX)).size).toBe(0);
  });

  it("tells whoever follows it (her daily posts)", () => {
    const seen: LifeEntry[] = [];
    const b = book(clock(), null, (e) => seen.push(e));
    b.observe(decision("web.search", { query: "新番" }));
    expect(seen.map((e) => e.what)).toEqual(["查了「新番」"]);
  });
});

describe("今天的她", () => {
  const entry = (p: Partial<LifeEntry>): LifeEntry => ({
    id: "x",
    activity: "browse",
    what: "查了「A」",
    at: toTimestamp(T0),
    minutes: null,
    capability: "web.search",
    ...p,
  });

  it("says nothing when she did nothing yet", () => {
    expect(renderToday([], T0, 480)).toBeNull();
    expect(book().summary()).toBeNull();
  });

  it("one line per kind of thing, in the order she first did it", () => {
    const text = renderToday(
      [
        entry({ what: "查了「A」" }),
        entry({ activity: "game", what: "minecraft", minutes: 80, capability: "game.start" }),
        entry({ what: "查了「B」" }),
        entry({ what: "查了「C」" }),
        entry({ what: "查了「D」" }),
        entry({ activity: "sing", what: "唱了〈X〉", minutes: 4 }),
      ],
      T0,
      480,
    );
    expect(text).toBe(
      [
        "今天到 15:00 你做過的事:",
        "- 逛網路 4 次:查了「B」、查了「C」、查了「D」 等 4 件",
        "- 玩遊戲 1 小時 20 分:minecraft",
        "- 唱歌 4 分鐘:唱了〈X〉",
      ].join("\n"),
    );
  });

  it("lately: today, yesterday and the day before", () => {
    const c = clock();
    const b = book(c);
    const day = 24 * HOUR;
    const text = renderLately(
      [
        entry({ at: toTimestamp(T0 - 2 * day), what: "查了「前天」" }),
        entry({ at: toTimestamp(T0 - day), activity: "code", what: "寫了程式" }),
        entry({ what: "查了「今天」" }),
      ],
      T0,
      (at) => b.dayOf(at),
      480,
    );
    expect(text).toBe(
      [
        "今天(到 15:00):",
        "- 逛網路:查了「今天」",
        "昨天:",
        "- 寫程式:寫了程式",
        "11/08:",
        "- 逛網路:查了「前天」",
      ].join("\n"),
    );
  });

  it("the service renders today's and the last days' entries", () => {
    const c = clock();
    const b = book(c);
    b.observe(decision("web.search", { query: "新番" }));
    expect(b.summary()).toBe("今天到 15:00 你做過的事:\n- 逛網路:查了「新番」");
    expect(b.summary("lately")).toBe("今天(到 15:00):\n- 逛網路:查了「新番」");
  });
});
