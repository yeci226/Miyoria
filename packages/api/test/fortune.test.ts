// What she writes on a fortune slip: the rank is hers only when it is one of the six, every text is
// cut to size and passed one by one, a slip with a poem that cannot be shown is no slip, and a slip
// that cannot be written is nothing (the caller gives the payment back).

import { LlmRouterKey } from "@miyoria/llm";
import { describe, expect, it } from "vitest";
import {
  checked,
  drawRank,
  FORTUNE_RANKS,
  type FortuneContext,
  issuedFortune,
  MAX_FIELD_LABEL,
  MAX_FIELD_TEXT,
  MAX_FIELDS,
  MAX_LINE,
  MAX_POEM_LINE,
  MAX_TITLE,
  RANK_WEIGHTS,
  type RawSlip,
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
};

/** Everything passes except a text that names 小美. */
const pass = (text: string) => (text.includes("小美") ? null : text);

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
          { label: "學業", text: "好好睡覺" },
          { label: "健康", text: "多喝水" },
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
          { label: "學業", text: "專心" },
        ],
        line: "小美也會來",
      }),
      pass,
    );
    expect(slip?.fields).toEqual([{ label: "學業", text: "專心" }]);
    expect(slip?.line).toBeNull();
    expect(checked(raw({ poem: ["小美來了", "二", "三", "四"] }), pass)).toBeNull();
    expect(checked(raw({ title: "小美" }), pass)).toBeNull();
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

    expect(await writeFortune(stateWith(answer({ title: "只有題" })), context, pass)).toBeNull();
    const broken = { complete: async () => Promise.reject(new Error("the model is down")) };
    expect(await writeFortune(stateWith(broken), context, pass)).toBeNull();
    expect(await writeFortune(stateWith(undefined), context, pass)).toBeNull();
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
