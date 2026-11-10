// What she writes on a card: cut to size, passed field by field, a pose only from the band's, and
// a card without her words when she cannot write.

import { LlmRouterKey } from "@miyoria/llm";
import { describe, expect, it } from "vitest";
import { type CardContext, checked, MAX_FIELDS, MAX_LINE, writeCard } from "../src/card-words.js";
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
};

/** Everything passes except a line that names 小美. */
const pass = (text: string) => (text.includes("小美") ? null : text);

describe("her words on a card", () => {
  it("are cut to size, passed one by one, and pick a pose of the band only", () => {
    const words = checked(
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
      checked({ line: "嗨", pose: "hand", stamp: null, fields: [] }, context.poses, pass),
    ).toEqual({ line: "嗨", pose: "hand", stamp: null, fields: [] });
  });

  function stateWith(router: unknown): ApiState {
    return {
      optional: (key: unknown) => (key === LlmRouterKey ? router : undefined),
    } as unknown as ApiState;
  }

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
  });
});
