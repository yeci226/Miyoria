// What she writes on a fortune slip: the rank is hers only when it is one of the six, every text is
// cut to size and passed one by one, a slip with a poem that cannot be shown is no slip, and a slip
// that cannot be written is nothing (the caller gives the payment back).

import { LlmRouterKey } from "@miyoria/llm/llm";
import { describe, expect, it } from "vitest";
import {
  checked,
  drawRank,
  FORTUNE_RANKS,
  type FortuneContext,
  fitted,
  issuedFortune,
  MAX_FIELD_LABEL,
  MAX_FIELD_TEXT,
  MAX_FIELDS,
  MAX_LINE,
  MAX_POEM_LINE,
  MAX_TITLE,
  RANK_WEIGHTS,
  type RawSlip,
  repaired,
  shapeFaults,
  writeFortune,
} from "../src/fortune.js";
import type { ApiState } from "../src/state.js";

const context: FortuneContext = {
  name: "阿明",
  view: {
    call_name: "阿明",
    relationship: "好朋友",
    affinity: "很好",
    trust: "信任",
    familiarity: "熟",
    public_feeling: "又熬夜了吧",
  },
  memories: ["一起熬夜做譜"],
  date: "2026-11-08",
  names: { own: ["阿明"], others: ["小美"] },
};

/** Everything passes except a text that names 小美. */
const pass = (text: string) => (text.includes("小美") ? null : text);
/** Moderation that passes everything: only the name check is left. */
const everything = (text: string) => text;

const raw = (over: Partial<RawSlip> = {}): RawSlip => ({
  rank: "吉",
  title: "春風得意",
  poem: ["月落烏啼霜滿天", "江楓漁火對愁眠", "姑蘇城外寒山寺", "夜半鐘聲到客船"],
  fields: [],
  line: null,
  ...over,
});

describe("her fortune slip", () => {
  it("keeps a rank that is one of the six and draws one otherwise, mostly good", () => {
    for (const rank of FORTUNE_RANKS) {
      expect(checked(raw({ rank }), pass)?.rank).toBe(rank);
    }
    expect(checked(raw({ rank: "超級大吉" }), pass, () => 0)?.rank).toBe("大吉");
    expect(checked(raw({ rank: null }), pass, () => 0.999)?.rank).toBe("凶");
    // The draw follows the weights: the first 10% are 大吉, the last 5% 凶.
    const total = Object.values(RANK_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(drawRank(() => 0.05)).toBe("大吉");
    expect(drawRank(() => 0.99)).toBe("凶");
    expect(drawRank(() => 0.3)).toBe("吉");
    const good = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].filter(
      (r) => drawRank(() => r) !== "凶",
    );
    expect(good.length).toBe(9);
    expect(total).toBe(100);
  });

  it("cuts the title, poem lines, fields and her line to size, without punctuation on the poem", () => {
    const slip = checked(
      raw({
        title: "長".repeat(MAX_TITLE + 4),
        poem: [`${"一".repeat(MAX_POEM_LINE + 3)}，`, "二。", "三，", "四"],
        fields: [
          { label: "戀".repeat(MAX_FIELD_LABEL + 2), text: "文".repeat(MAX_FIELD_TEXT + 5) },
          { label: "心情", text: "好好睡覺" },
          { label: "人際", text: "點頭就好" },
          { label: "多的", text: "第四個不要" },
        ],
        line: "話".repeat(MAX_LINE + 6),
      }),
      pass,
    );
    expect(slip?.title).toBe("長".repeat(MAX_TITLE));
    expect(slip?.poem).toEqual(["一".repeat(MAX_POEM_LINE), "二", "三", "四"]);
    expect(slip?.fields).toHaveLength(MAX_FIELDS);
    expect(slip?.fields[0]).toEqual({
      label: "戀".repeat(MAX_FIELD_LABEL),
      text: `${"文".repeat(MAX_FIELD_TEXT)}…`,
    });
    expect(slip?.line).toBe(`${"話".repeat(MAX_LINE)}…`);
  });

  it("drops a field or her line that names someone else, and is no slip when the poem does", () => {
    const slip = checked(
      raw({
        fields: [
          { label: "戀愛", text: "和小美有緣" },
          { label: "心情", text: "專心" },
        ],
        line: "小美也會來",
      }),
      pass,
    );
    expect(slip?.fields).toEqual([{ label: "心情", text: "專心" }]);
    expect(slip?.line).toBeNull();
    expect(checked(raw({ poem: ["小美來了", "二", "三", "四"] }), pass)).toBeNull();
    expect(checked(raw({ title: "小美" }), pass)).toBeNull();
  });

  it("leaves off a field about their body, money, a law case or an exam", () => {
    const slip = checked(
      raw({
        fields: [
          { label: "健康", text: "多喝溫水" },
          { label: "財運", text: "會回來的" },
          { label: "學業", text: "會考上" },
          { label: "心情", text: "晴天" },
        ],
      }),
      pass,
    );
    expect(slip?.fields).toEqual([{ label: "心情", text: "晴天" }]);
  });

  it("cuts a long field or line after its last whole clause, else with an ellipsis", () => {
    const head = "今天適合慢慢來放輕鬆一點";
    const slip = checked(
      raw({
        fields: [{ label: "心情", text: `${head},不用急著把每件事都說清楚啦` }],
        line: `${"嗯".repeat(MAX_LINE - 6)}!再多講一點就超過了喔`,
      }),
      pass,
    );
    // A comma is dropped with what follows it; a sentence's own end stays.
    expect(slip?.fields[0]?.text).toBe(head);
    expect(slip?.line).toBe(`${"嗯".repeat(MAX_LINE - 6)}!`);
    // A clause end too early (it would keep less than half) is not a place to cut.
    const early = checked(raw({ line: `嗯,${"話".repeat(MAX_LINE + 4)}` }), pass);
    expect(early?.line).toBe(`嗯,${"話".repeat(MAX_LINE - 2)}…`);
  });

  it("needs a title and exactly four poem lines, whether she sent a list or one text", () => {
    expect(checked(raw({ title: null }), pass)).toBeNull();
    expect(checked(raw({ poem: ["一", "二", "三"] }), pass)).toBeNull();
    expect(checked(raw({ poem: [] }), pass)).toBeNull();
    // More than four: the first four.
    expect(checked(raw({ poem: ["一", "二", "三", "四", "五"] }), pass)?.poem).toEqual([
      "一",
      "二",
      "三",
      "四",
    ]);
    expect(checked(raw({ poem: "一\n二\n三\n四" }), pass)?.poem).toEqual(["一", "二", "三", "四"]);
  });

  function stateWith(router: unknown): ApiState {
    return {
      optional: (key: unknown) => (key === LlmRouterKey ? router : undefined),
    } as unknown as ApiState;
  }

  it("comes from her model; nothing comes when it fails, is slow or says nothing usable", async () => {
    const asked: unknown[] = [];
    const answer = (value: unknown) => ({
      complete: async (_purpose: string, request: unknown) => {
        asked.push(request);
        return { text: JSON.stringify(value), finish_reason: "stop", usage: null };
      },
    });
    const slip = await writeFortune(
      stateWith(
        answer({
          rank: "大吉",
          title: "春風得意",
          poem: ["一", "二", "三", "四"],
          fields: [{ label: "願望", text: "會實現" }],
          line: "今天也辛苦了",
        }),
      ),
      context,
      pass,
    );
    expect(slip).toEqual({
      rank: "大吉",
      title: "春風得意",
      poem: ["一", "二", "三", "四"],
      fields: [{ label: "願望", text: "會實現" }],
      line: "今天也辛苦了",
    });
    // She is told what the page shows them, and the six ranks.
    const prompt = JSON.stringify(asked[0]);
    expect(prompt).toContain("又熬夜了吧");
    expect(prompt).toContain("2026-11-08");
    for (const rank of FORTUNE_RANKS) expect(prompt).toContain(rank);
    // Nothing about their body or money, even when what she knows of them says so.
    expect(prompt).toContain("籤上也一個字都不提");
    expect(prompt).not.toMatch(/健康、|財運/);

    expect(await writeFortune(stateWith(answer({ title: "只有題" })), context, pass)).toBeNull();
    const broken = { complete: async () => Promise.reject(new Error("the model is down")) };
    expect(await writeFortune(stateWith(broken), context, pass)).toBeNull();
    expect(await writeFortune(stateWith(undefined), context, pass)).toBeNull();
  });

  it("never carries a name from her memories: written again without it, else left off", async () => {
    const told: string[] = [];
    const answers = (...values: unknown[]) => ({
      complete: async (_purpose: string, request: { messages: { content: string }[] }) => {
        told.push(request.messages[1]?.content ?? "");
        const value = values[Math.min(told.length - 1, values.length - 1)];
        return { text: JSON.stringify(value), finish_reason: "stop", usage: null };
      },
    });
    const withKai: FortuneContext = {
      ...context,
      memories: ["她說阿凱借她的錢還沒還", "一起熬夜做譜"],
    };
    const named = {
      rank: "吉",
      title: "春風得意",
      poem: ["一", "二", "三", "四"],
      fields: [{ label: "人際", text: "阿凱會來找你" }],
      line: "阿凱的事別想了",
    };
    const clean = { ...named, fields: [{ label: "心情", text: "晴" }], line: "早點睡" };
    const slip = await writeFortune(stateWith(answers(named, clean)), withKai, everything);
    expect(slip?.fields).toEqual([{ label: "心情", text: "晴" }]);
    expect(slip?.line).toBe("早點睡");
    // The second time she is not shown the memory the name came from.
    expect(told).toHaveLength(2);
    expect(told[0]).toContain("阿凱");
    expect(told[1]).not.toContain("阿凱");
    expect(told[1]).toContain("一起熬夜做譜");

    // Named twice: those texts are left off; in the poem, there is no slip.
    told.length = 0;
    const again = await writeFortune(stateWith(answers(named)), withKai, everything);
    expect(again).toMatchObject({ fields: [], line: null, poem: ["一", "二", "三", "四"] });
    expect(JSON.stringify(again)).not.toContain("阿凱");
    const inPoem = { ...named, poem: ["阿凱來了", "二", "三", "四"] };
    expect(await writeFortune(stateWith(answers(inPoem)), withKai, everything)).toBeNull();
    // A name of the directory counts as well, and without the names there is no slip at all.
    const xiaomei = { ...clean, line: "小美也在" };
    expect((await writeFortune(stateWith(answers(xiaomei)), context, everything))?.line).toBeNull();
    expect(await writeFortune(stateWith(answers(clean)), { ...context, names: null }, pass)).toBe(
      null,
    );
  });

  it("says exactly which limit a slip broke, and which can be fixed without her", () => {
    const faults = shapeFaults(
      raw({
        title: "深夜話很多的鯨魚啊",
        poem: ["月光掉進深海裡", "我們聊到星星關機", "你說,真好", "四"],
        fields: ["心情", "人際", "願望", "今天宜啊啊"].map((label) => ({ label, text: "好" })),
        line: "話".repeat(MAX_LINE + 6),
      }),
    );
    const said = faults.map((f) => f.say);
    expect(said).toContain("籤題「深夜話很多的鯨魚啊」有 9 個字,最多 8 個字");
    expect(said).toContain("籤詩第 2 句「我們聊到星星關機」有 8 個字,每句最多 7 個字");
    expect(said).toContain("籤詩第 3 句「你說,真好」中間有標點,籤詩不加標點");
    expect(said).toContain("fields 有 4 個,最多 3 個");
    expect(said).toContain("欄位名稱「今天宜啊啊」有 5 個字,最多 4 個字");
    expect(said).toContain(`line 有 ${MAX_LINE + 6} 個字,最多 ${MAX_LINE} 個字`);
    expect(faults.filter((f) => !f.fixable).map((f) => f.say)).toHaveLength(3);
    expect(shapeFaults(raw())).toEqual([]);
    expect(shapeFaults(raw({ poem: ["一", "二", "三", "四", "五"] }))).toEqual([
      { say: "籤詩要剛好 4 句,你寫了 5 句", fixable: true },
    ]);
  });

  it("fixes fields and her line only where it can without cutting a sentence", () => {
    expect(fitted("今天也辛苦了。明天再慢慢說也來得及啦,真的真的不用急", 20)).toBe(
      "今天也辛苦了。",
    );
    expect(fitted("今天真的也辛苦了,明天再慢慢說也來得及啦真的不用急", 20)).toBe(
      "今天真的也辛苦了",
    );
    // A clause too short to stand alone is not kept.
    expect(fitted("嗯,明天再慢慢說也來得及啦真的真的不用急喔喔", 20)).toBeNull();
    expect(fitted("話".repeat(25), 20)).toBeNull();
    expect(fitted("短短的", 20)).toBe("短短的");
    const fixed = repaired(
      raw({
        poem: ["一", "二", "三", "四", "五"],
        fields: [
          { label: "健康", text: "多喝水" },
          { label: "太長的名字", text: "好" },
          { label: "心情", text: "話".repeat(MAX_FIELD_TEXT + 5) },
          { label: "人際", text: "好" },
          { label: "願望", text: "會實現" },
          { label: "今天宜", text: "早睡" },
          { label: "多的", text: "不要" },
        ],
        line: `嗯。${"話".repeat(MAX_LINE + 5)}`,
      }),
    );
    expect(fixed.poem).toEqual(["一", "二", "三", "四"]);
    expect(fixed.fields).toEqual([
      { label: "人際", text: "好" },
      { label: "願望", text: "會實現" },
      { label: "今天宜", text: "早睡" },
    ]);
    expect(fixed.line).toBeNull();
    expect(shapeFaults(fixed)).toEqual([]);
  });

  it("is written again when it does not fit, then its poem alone, and is no slip after that", async () => {
    const told: { system: string; user: string }[] = [];
    const answers = (...values: unknown[]) => ({
      complete: async (_purpose: string, request: { messages: { content: string }[] }) => {
        told.push({
          system: request.messages[0]?.content ?? "",
          user: request.messages[1]?.content ?? "",
        });
        const value = values[Math.min(told.length - 1, values.length - 1)];
        return { text: JSON.stringify(value), finish_reason: "stop", usage: null };
      },
    });
    const good = {
      rank: "吉",
      title: "深夜鯨",
      poem: ["一", "二", "三", "四"],
      fields: [{ label: "心情", text: "晴" }],
      line: "早點睡",
    };
    const long = { ...good, poem: ["一", "我們聊到星星關機", "三", "四"] };

    // Fits the second time: that one is the slip.
    const second = await writeFortune(stateWith(answers(long, good)), context, everything);
    expect(second?.poem).toEqual(good.poem);
    expect(told).toHaveLength(2);
    expect(told[1]?.user).toContain("籤詩第 2 句「我們聊到星星關機」有 8 個字,每句最多 7 個字");

    // Too long twice: the poem alone is written again, the rest of the second slip stays.
    told.length = 0;
    const rest = { ...long, line: "這句留著" };
    const poem = { title: "新的題", poem: ["甲", "乙", "丙", "丁"] };
    const third = await writeFortune(stateWith(answers(long, rest, poem)), context, everything);
    expect(third).toMatchObject({ title: "深夜鯨", poem: poem.poem, line: "這句留著" });
    expect(told).toHaveLength(3);
    expect(told[2]?.system).toContain("重寫籤題和籤詩");
    expect(told[2]?.user).toContain("我們聊到星星關機");

    // Never fits: no slip, so nothing is charged.
    told.length = 0;
    expect(await writeFortune(stateWith(answers(long)), context, everything)).toBeNull();
    expect(told).toHaveLength(3);

    // Only fixable faults: asked again once, then fixed without a third call.
    told.length = 0;
    const many = {
      ...good,
      fields: ["心情", "人際", "願望", "今天宜"].map((label) => ({ label, text: "好" })),
    };
    expect(
      (await writeFortune(stateWith(answers(many)), context, everything))?.fields,
    ).toHaveLength(3);
    expect(told).toHaveLength(2);
  });

  it("reads back from the store only if it is a whole slip", () => {
    const base = {
      id: "f1",
      profile: "p",
      account: { platform: "discord", id: "1" },
      person: null,
      day: 20_765,
      issued_at: "2026-11-08T04:00:00.000Z",
      entry: "e1",
    };
    const slip = {
      rank: "吉",
      title: "春風",
      poem: ["一", "二", "三", "四"],
      fields: [{ label: "愛", text: "有" }, { nope: 1 }],
      line: null,
    };
    expect(issuedFortune({ ...base, slip: slip as never })).toEqual({
      id: "f1",
      date: "2026-11-08",
      issued_at: "2026-11-08T04:00:00.000Z",
      rank: "吉",
      title: "春風",
      poem: ["一", "二", "三", "四"],
      fields: [{ label: "愛", text: "有" }],
      line: null,
    });
    expect(issuedFortune({ ...base, slip: { ...slip, rank: "神" } as never })).toBeNull();
    expect(issuedFortune({ ...base, slip: { ...slip, poem: ["一"] } as never })).toBeNull();
    expect(issuedFortune({ ...base, slip: { ...slip, title: 5 } as never })).toBeNull();
  });
});
