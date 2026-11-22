// What she writes on a card: cut to size, passed field by field, a pose only from the band's, and
// a card without her words when she cannot write.

import { PersonaHandleKey } from "@miyoria/brain/agent";
import { LlmRouterKey } from "@miyoria/llm/llm";
import { DEFAULT_CHARACTER } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  CARD_VOICE,
  type CardContext,
  cardVoice,
  checked,
  MAX_FIELDS,
  MAX_LINE,
  occasionLine,
  writeCard,
} from "../src/card-words.js";
import type { ApiState } from "../src/state.js";

const context: CardContext = {
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
  poses: ["blush", "squint", "hand"],
  names: { own: ["阿明"], others: ["小美"] },
};

/** Everything passes except a line that names 小美. */
const pass = (text: string) => (text.includes("小美") ? null : text);

describe("what a card nobody bought is for", () => {
  it("is the tier and its scene for a milestone, what the card prints for a keepsake", () => {
    expect(occasionLine({ kind: "milestone", tier: "知心", scene: "一起看流星" })).toContain(
      "「一起看流星」",
    );
    const keepsake = occasionLine({
      kind: "keepsake",
      facts: [
        { label: "第一次見面", text: "2025-03-01" },
        { label: "以前的關係", text: "朋友" },
      ],
    });
    expect(keepsake).toContain("紀念卡");
    expect(keepsake).toContain("第一次見面:2025-03-01、以前的關係:朋友");
    expect(occasionLine({ kind: "keepsake", facts: [] })).not.toContain("卡上已經印著");
  });
});

describe("her words on a card", () => {
  it("are cut to size, passed one by one, and pick a pose of the band only", () => {
    const { words } = checked(
      {
        line: "長".repeat(MAX_LINE + 10),
        pose: "cold",
        stamp: "認證損友",
        fields: [
          { label: "稱號", text: "深夜作譜人" },
          { label: "回憶", text: "和小美一起" },
          { label: "期待", text: "早點睡" },
          { label: "多的", text: "a" },
          { label: "再多", text: "b" },
        ],
      },
      context.poses,
      pass,
    );
    expect(words.line).toBe(`${"長".repeat(MAX_LINE)}…`);
    // A picture outside the band is not hers to choose: the card picks one.
    expect(words.pose).toBeNull();
    expect(words.stamp).toBe("認證損友");
    // The field naming someone else is left off; at most MAX_FIELDS stay.
    expect(words.fields).toEqual([
      { label: "稱號", text: "深夜作譜人" },
      { label: "期待", text: "早點睡" },
      { label: "多的", text: "a" },
    ]);
    expect(words.fields.length).toBeLessThanOrEqual(MAX_FIELDS);
    expect(
      checked({ line: "嗨", pose: "hand", stamp: null, fields: [] }, context.poses, pass).words,
    ).toEqual({ line: "嗨", pose: "hand", stamp: null, fields: [] });
  });

  it("never name a tier, and carry no chat markup", () => {
    const { words } = checked(
      {
        line: "<emo:happy>又來啦,今天也要討飯喔",
        pose: null,
        stamp: "摯友認證",
        fields: [
          { label: "稱號", text: "深夜好朋友" },
          { label: "今天", text: "被你抓到在摸魚" },
        ],
      },
      context.poses,
      pass,
    );
    expect(words.line).toBe("又來啦,今天也要討飯喔");
    expect(words.stamp).toBeNull();
    expect(words.fields).toEqual([{ label: "今天", text: "被你抓到在摸魚" }]);
  });

  function stateWith(router: unknown, persona?: unknown): ApiState {
    return {
      optional: (key: unknown) =>
        key === LlmRouterKey ? router : key === PersonaHandleKey ? persona : undefined,
    } as unknown as ApiState;
  }

  it("are written by her whole persona and examples, with the card's own rules", async () => {
    const asked: { messages: { content: string }[] }[] = [];
    const router = {
      complete: async (_purpose: string, request: { messages: { content: string }[] }) => {
        asked.push(request);
        return { text: JSON.stringify({ line: "嗨" }), finish_reason: "stop", usage: null };
      },
    };
    const persona = {
      corePrompt: () => "# 你是鯨魚\n\n開場。\n\n# 說話風格\n\n- 短、口語,帶尾音",
      examples: () => ["## 被餵白飯\n\n**阿明**:請你吃飯\n**鯨魚**:<emo:happy>好耶"],
      names: () => ["鯨魚"],
      displayName: () => "鯨魚",
    };
    await writeCard(stateWith(router, persona), context, pass);
    const system = asked[0]?.messages[0]?.content ?? "";
    // Her speaking style and examples, not only the opening of the persona.
    expect(system).toContain("短、口語,帶尾音");
    expect(system).toContain("<examples");
    expect(system).toContain("好耶</reply>");
    expect(system).toContain(CARD_VOICE);
    expect(system).toContain("摯友");
    // A milestone, with a scene or without, asks for nothing added and nobody's part swapped.
    for (const scene of [null, "一起看流星"]) {
      const told = occasionLine({ kind: "milestone", tier: "知心", scene });
      expect(told).toContain("只說寫到的事:不加任何沒寫到的話、動作、反應、時間或後來的事");
      expect(told).toContain("是他問你的,就不要寫成你問他");
    }
  });

  it("come from her model, and the card goes out without them when it fails", async () => {
    const asked: unknown[] = [];
    const router = {
      complete: async (_purpose: string, request: { messages: { content: string }[] }) => {
        asked.push(request);
        return {
          text: JSON.stringify({
            line: "這張卡給你,別弄丟了",
            pose: "squint",
            stamp: null,
            fields: [{ label: "稱號", text: "深夜作譜人" }],
          }),
          finish_reason: "stop",
          usage: null,
        };
      },
    };
    const words = await writeCard(stateWith(router), context, pass);
    expect(words).toEqual({
      line: "這張卡給你,別弄丟了",
      pose: "squint",
      stamp: null,
      fields: [{ label: "稱號", text: "深夜作譜人" }],
    });
    // She is told what the page shows them, and which pictures she may use.
    const prompt = JSON.stringify(asked[0]);
    expect(prompt).toContain("又熬夜了吧");
    expect(prompt).toContain("blush");

    const broken = { complete: async () => Promise.reject(new Error("the model is down")) };
    expect(await writeCard(stateWith(broken), context, pass)).toBeNull();
    expect(await writeCard(stateWith(undefined), context, pass)).toBeNull();
    // Without the names nothing she wrote could be shown: she is not asked.
    asked.length = 0;
    expect(await writeCard(stateWith(router), { ...context, names: null }, pass)).toBeNull();
    expect(asked).toHaveLength(0);
  });
});

describe("nobody else on a card", () => {
  /** Moderation that passes everything: only the name check is left. */
  const everything = (text: string) => text;
  /** A model answering `values` in turn (the last one again after that), and what it was told. */
  function answers(...values: unknown[]) {
    const told: string[] = [];
    const router = {
      complete: async (_purpose: string, request: { messages: { content: string }[] }) => {
        told.push(request.messages[1]?.content ?? "");
        const value = values[Math.min(told.length - 1, values.length - 1)];
        return { text: JSON.stringify(value), finish_reason: "stop", usage: null };
      },
    };
    const state = {
      optional: (key: unknown) => (key === LlmRouterKey ? router : undefined),
    } as unknown as ApiState;
    return { state, told };
  }
  // 阿凱 is in no directory: only the memory she is given names him.
  const withKai: CardContext = {
    ...context,
    name: "小晴",
    view: { ...context.view, call_name: "小晴", public_feeling: null },
    memories: ["她說阿凱推薦的那首歌很好聽", "一起聊過下雨天的事"],
    names: { own: ["小晴"], others: ["小美"] },
  };
  const named = {
    line: "小晴～阿凱推的那首歌我還在循環",
    stamp: "雨天鯨",
    fields: [
      { label: "今天的BGM", text: "阿凱推的那首" },
      { label: "下雨天", text: "一起聽歌耍廢" },
    ],
  };
  const clean = { line: "小晴～下雨天要不要一起耍廢", stamp: "雨天鯨", fields: [] };

  it("is written again without the memory a name came from", async () => {
    const { state, told } = answers(named, clean);
    const words = await writeCard(state, withKai, everything);
    expect(words).toEqual({ line: clean.line, pose: null, stamp: "雨天鯨", fields: [] });
    expect(told).toHaveLength(2);
    expect(told[0]).toContain("阿凱");
    expect(told[1]).not.toContain("阿凱");
    expect(told[1]).toContain("一起聊過下雨天的事");
  });

  it("leaves off what still names someone, and the rest stands", async () => {
    const { state, told } = answers(named);
    const words = await writeCard(state, withKai, everything);
    expect(told).toHaveLength(2);
    expect(words).toEqual({
      line: null,
      pose: null,
      stamp: "雨天鯨",
      fields: [{ label: "下雨天", text: "一起聽歌耍廢" }],
    });
    expect(JSON.stringify(words)).not.toContain("阿凱");
  });

  it("counts the directory's names, and asks once only when nothing names anyone", async () => {
    const { state, told } = answers({ ...clean, stamp: "小美的鯨" });
    expect((await writeCard(state, withKai, everything))?.stamp).toBeNull();
    expect(told).toHaveLength(2);
    const plain = answers(clean);
    expect((await writeCard(plain.state, withKai, everything))?.line).toBe(clean.line);
    expect(plain.told).toHaveLength(1);
    // Their own names and plain words of a memory are not someone else.
    const own = answers({ ...clean, line: "小晴,下雨天那首歌還在循環" });
    expect((await writeCard(own.state, withKai, everything))?.line).toContain("小晴");
    expect(own.told).toHaveLength(1);
  });

  it("covers a milestone's scene the same way", async () => {
    const scene: CardContext = {
      ...withKai,
      memories: [],
      occasion: { kind: "milestone", tier: "知心", scene: "那天阿凱也在,我們聊到天亮" },
    };
    const { state, told } = answers({ ...clean, line: "阿凱那天也在欸" }, clean);
    expect((await writeCard(state, scene, everything))?.line).toBe(clean.line);
    expect(told[1]).not.toContain("阿凱");
    // Asked again without the scene, she is told to pick from what she remembers.
    expect(told[1]).toContain("從上面你記得的事裡挑一件");
  });
});

describe("how her card words sound, by profile", () => {
  it("is word for word what it always was for the first character", () => {
    expect(cardVoice()).toBe(CARD_VOICE);
    expect(cardVoice(DEFAULT_CHARACTER)).toBe(CARD_VOICE);
    expect(CARD_VOICE).toContain(
      "- 卡上的字就是你在聊天裡會說的話:短、口語,有你的尾音、吐槽和鯨魚的小毛病,像隨手寫在卡背的一兩句。",
    );
  });

  it("names another profile's nature, or none", () => {
    const cat = cardVoice({ ...DEFAULT_CHARACTER, creature: "黑貓" });
    expect(cat).toContain("有你的尾音、吐槽和黑貓的小毛病,");
    expect(cat).not.toContain("鯨魚");
    const none = cardVoice({ ...DEFAULT_CHARACTER, creature: "" });
    expect(none).toContain("有你的尾音和吐槽,像隨手寫在卡背的一兩句。");
    expect(none).not.toContain("鯨魚");
    expect(none.replace("有你的尾音和吐槽,", "有你的尾音、吐槽和鯨魚的小毛病,")).toBe(CARD_VOICE);
  });
});
