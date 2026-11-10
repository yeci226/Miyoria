import { readFileSync } from "node:fs";
import { join } from "node:path";
import { characterCore, ephemeralHandlesIn, type Goal } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  isEmptyPlan,
  MindReplyError,
  PLAN_FORMAT,
  type PlanInput,
  parsePlanReply,
  planMessages,
} from "../src/index.js";
import { FakeAffect, limits } from "./fakes.js";

const PROFILE = join(import.meta.dirname, "../../../profiles/deepseek-chan/persona");
const persona = ["identity.md", "style.md"]
  .map((f) => readFileSync(join(PROFILE, f), "utf8"))
  .join("\n\n");

const goal: Goal = {
  id: "01JD0000000000000000GOAL01",
  what: "等 Owen 上線問報告結果",
  why: "好幾天沒跟他講話了",
  trigger: { kind: "when_online", person: "Owen" },
  steps: [],
  status: "active",
  expires: "2026-11-04T12:00:00.000Z",
  person: "Owen",
  context: null,
  source: "plan",
  created_at: "2026-11-02T10:00:00.000Z",
  updated_at: "2026-11-02T10:00:00.000Z",
  closed_at: null,
  close_reason: null,
};

function input(p: Partial<PlanInput> = {}): PlanInput {
  const affect = new FakeAffect().snapshot();
  affect.top = [{ name: "missing", intensity: 0.6, cause: "Owen 好久沒來", at: "", person: null }];
  return {
    name: "DeepSeek-chan",
    core: characterCore(persona),
    time: "2026-11-02 20:00(星期一)",
    daily: false,
    wakes: [{ kind: "goal_trigger", detail: "Owen 上線了", context: null }],
    affect,
    self: null,
    capabilities: [{ name: "game.start", summary: "開始玩遊戲", risk: "medium", params: ["game"] }],
    maxImpulses: 2,
    limits: {
      source: "arbiter",
      limits: limits({
        initiatives_today: 5,
        unanswered_streak: 3,
        next_initiative_at: "2026-11-02T13:40:00.000Z",
        blocked: [{ capability: "game.start", reason: "Minecraft 沒開", until: null }],
      }),
      entries: [],
      unanswered: [],
      waits: [],
    },
    now: Date.parse("2026-11-02T12:00:00.000Z"),
    utcOffsetMinutes: 480,
    world: "Owen 在線,在玩 Terraria。",
    places: [
      {
        ref: "discord:111:222",
        context: { platform: "discord", scope: "111", channel: "222", kind: "channel" },
        label: "文字頻道 雜談",
        note: "最近 6 則",
        here: false,
      },
    ],
    people: [
      {
        ref: "Owen",
        account: { platform: "discord", id: "100" },
        person: "person-owen",
        name: "Owen",
        relation: "朋友,在意 0.8",
        feeling: "有點在意他",
        doing: "在玩 Terraria",
      },
    ],
    goals: [goal],
    fired: new Set([goal.id]),
    desires: [
      {
        want: "find_person",
        label: "找 Owen 聊天",
        weight: 0.68,
        why: "想念 0.6 × 在意 0.8,他在線",
        person: "Owen",
        capability: "chat.dm",
        goal: null,
      },
    ],
    suggestions: [],
    recent: [],
    dayPlan: "Owen 通常 9 點後上線,等他來再開台。",
    memories: null,
    ...p,
  };
}

const textOf = (i: PlanInput) => {
  const m = planMessages(i);
  return {
    system: String(m[0]?.content),
    data: m
      .slice(1)
      .map((x) => String(x.content))
      .join("\n"),
  };
};

describe("the Plan prompt", () => {
  it("shows what people just said, and that a stop request holds", () => {
    const heard = ["Owen: 你不要再玩 Minecraft 了"];
    const [system, data] = planMessages(input({ heard })).map((m) => String(m.content));
    expect(data).toContain("大家剛對你說的話");
    expect(data).toContain("你不要再玩 Minecraft 了");
    expect(system).toContain("叫你停下或別做某件事");
  });

  it("has a short system: her core, the task, the limits, her numbers, a format of empty values", () => {
    const { system } = textOf(input());
    expect(system.startsWith("你是 DeepSeek-chan\n")).toBe(true);
    // Not the chat persona: no speaking style, no <silence/> / <emo> rules.
    expect(system).not.toMatch(/silence|<emo|說話風格/);
    expect(system).not.toContain(persona.slice(-200));
    expect(system).toContain("# 限制");
    expect(system).toContain("今天你主動開了 5 次話題(上限 12)");
    expect(system).toContain("最近連續 3 次主動開口沒人接");
    expect(system).toContain("下次可以主動開口:21:40 之後");
    expect(system).toContain("game.start 暫時做不到");
    expect(system).toContain("心情:心情不錯");
    expect(system).toContain("想念 0.60");
    expect(system).toContain(PLAN_FORMAT);
    expect(PLAN_FORMAT).not.toMatch(/0\.\d|-0|"chat\.start"/);
  });

  it("keeps names, the world, her goals, desires and plan in data blocks", () => {
    const { system, data } = textOf(input());
    for (const derived of ["Owen", "Terraria", "雜談", "報告", "Minecraft 沒開"]) {
      expect(system, derived).not.toContain(derived);
      expect(data, derived).toContain(derived);
    }
    expect(data).toContain("1. 找 Owen 聊天(想念 0.6 × 在意 0.8,他在線)");
    expect(data).toContain("GOAL01:等 Owen 上線問報告結果;觸發:Owen 上線時(到了)");
    expect(data).toContain("你今天的計畫");
    expect(data).toContain("game.start 暫時做不到:Minecraft 沒開");
  });

  it("has no per-call codes anywhere: people by handle, places by context string", () => {
    const { system, data } = textOf(input());
    expect(ephemeralHandlesIn(system)).toEqual([]);
    expect(ephemeralHandlesIn(data)).toEqual([]);
    expect(data).toContain("- discord:111:222:文字頻道 雜談");
    expect(data).toContain("- Owen,朋友,在意 0.8,在玩 Terraria;你對他的感覺:有點在意他");
  });

  it("asks for the day plan only on the first Plan of the day, with its material", () => {
    const daily = textOf(
      input({
        daily: true,
        wakes: [{ kind: "daily", detail: "", context: null }],
        habits: ["- Owen:通常 21:05 左右出現(最近 14 天裡有 7 天),今天還沒看到"],
        yesterday: ["- 20:30 game.start:想玩"],
        reactions: ["- Owen:回覆你 4 次"],
      }),
    );
    expect(daily.system).toContain("在 day_plan 寫一份粗的今天");
    expect(daily.data).toContain("大家通常什麼時候出現");
    expect(daily.data).toContain("你昨天做了什麼");
    expect(daily.data).toContain("大家最近的反應");
    expect(textOf(input()).system).toContain("day_plan 留空");
  });
});

describe("her Plan reply", () => {
  it("parses goals and impulses, bounded, dropping broken parts", () => {
    const reply = parsePlanReply(
      `好,我想想。\n${JSON.stringify({
        thought: "Owen 上線了,去找他。",
        goals: {
          add: [
            {
              what: "晚上開台玩 Minecraft",
              trigger: { kind: "at", time: "21:30" },
              expires_in_hours: 6,
            },
            { what: "", why: "", trigger: { kind: "whenever" } },
            { what: "等他", trigger: { kind: "when_online", person: "Owen" }, expires_in_hours: 0 },
          ],
          edit: [{ goal: "GGOAL01", why: "他上線了", trigger: null }],
          done: ["GGOAL01", ""],
          drop: [{ goal: "GX", why: "不想了" }, "GY"],
        },
        impulses: [
          {
            kind: "speak",
            capability: "chat.dm",
            person: "Owen",
            why: "想他",
            hint: "報告怎樣",
            goal: "GGOAL01",
            expires_in_min: 99,
          },
          { kind: "", capability: "", place: null },
          { kind: "act", capability: "game.start", args: { game: "minecraft" }, why: "想玩" },
          { kind: "act", capability: "sing.request" },
        ],
        day_plan: "",
      })}`,
      2,
    );
    expect(reply.thought).toBe("Owen 上線了,去找他。");
    expect(reply.add.map((g) => [g.what, g.trigger, g.expiresInHours])).toEqual([
      ["晚上開台玩 Minecraft", { kind: "at", time: "21:30", inMin: null }, 6],
      ["等他", { kind: "when_online", person: "Owen" }, null],
    ]);
    expect(reply.edit).toEqual([
      {
        goal: "GGOAL01",
        what: null,
        why: "他上線了",
        trigger: null,
        steps: null,
        expiresInHours: null,
      },
    ]);
    expect(reply.done).toEqual(["GGOAL01"]);
    expect(reply.drop).toEqual([
      { goal: "GX", why: "不想了" },
      { goal: "GY", why: "" },
    ]);
    expect(reply.impulses.map((i) => [i.kind, i.capability, i.expiresInMin])).toEqual([
      ["speak", "chat.dm", 15],
      ["act", "game.start", 2],
    ]);
    expect(reply.dayPlan).toBeNull();
    expect(isEmptyPlan(reply)).toBe(false);
  });

  it("copying the format's empty values is an empty plan", () => {
    expect(isEmptyPlan(parsePlanReply(PLAN_FORMAT, 2))).toBe(true);
    expect(isEmptyPlan(parsePlanReply("{}", 2))).toBe(true);
    expect(() => parsePlanReply("我不知道", 2)).toThrow(MindReplyError);
  });
});
