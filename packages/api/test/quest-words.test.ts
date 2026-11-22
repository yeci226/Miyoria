// The quest she thinks of for someone (`quest-words.ts`): from the memories they may read, one
// short line, nobody else in it, passed like the page passes; nothing when she cannot.

import { MAX_PICK_CHARS } from "@miyoria/economy";
import { LlmRouterKey } from "@miyoria/llm/llm";
import { describe, expect, it } from "vitest";
import { type QuestContext, writeQuest } from "../src/quest-words.js";
import type { ApiState } from "../src/state.js";

const context: QuestContext = {
  name: "阿明",
  view: {
    call_name: "阿明",
    relationship: "好朋友",
    affinity: "很好",
    trust: "信任",
    familiarity: "熟",
    public_feeling: "又熬夜了吧",
  },
  memories: ["阿明在搬新家", "阿凱推薦他一首歌"],
  names: { own: ["阿明"], others: ["小美"] },
};

/** Everything passes except a text with 不行. */
const pass = (text: string) => (text.includes("不行") ? null : text);

function stateWith(router: unknown): ApiState {
  return {
    optional: (key: unknown) => (key === LlmRouterKey ? router : undefined),
  } as unknown as ApiState;
}

/** A model that answers `values` in turn (the last one again), and what it was told. */
function model(...values: unknown[]) {
  const told: string[] = [];
  return {
    told,
    router: {
      complete: async (_purpose: string, request: { messages: { content: string }[] }) => {
        told.push(request.messages[1]?.content ?? "");
        const value = values[Math.min(told.length - 1, values.length - 1)];
        return { text: JSON.stringify(value), finish_reason: "stop", usage: null };
      },
    },
  };
}

describe("the quest she thinks of", () => {
  it("is one short line from what she remembers of them, quotes and a full stop taken off", async () => {
    const m = model({ quest: "「跟她說說新家整理好了沒。」" });
    expect(await writeQuest(stateWith(m.router), context, pass)).toBe("跟她說說新家整理好了沒");
    expect(m.told[0]).toContain("阿明在搬新家");
    expect(m.told[0]).toContain("又熬夜了吧");
  });

  it("is written again without the memory a name came from, and is nothing if it still names one", async () => {
    const again = model(
      { quest: "跟她說阿凱推薦的歌好不好聽" },
      { quest: "跟她說說新家整理好了沒" },
    );
    expect(await writeQuest(stateWith(again.router), context, pass)).toBe("跟她說說新家整理好了沒");
    expect(again.told).toHaveLength(2);
    expect(again.told[1]).not.toContain("阿凱推薦");
    const still = model({ quest: "跟她說小美最近好不好" });
    expect(await writeQuest(stateWith(still.router), context, pass)).toBeNull();
  });

  it("is nothing without memories, a model, an answer, or when too long or not passed", async () => {
    const fine = model({ quest: "跟她說說新家整理好了沒" });
    expect(await writeQuest(stateWith(fine.router), { ...context, memories: [] }, pass)).toBeNull();
    expect(fine.told).toHaveLength(0);
    expect(await writeQuest(stateWith(fine.router), { ...context, names: null }, pass)).toBeNull();
    expect(await writeQuest(stateWith(undefined), context, pass)).toBeNull();
    const broken = { complete: async () => Promise.reject(new Error("the model is down")) };
    expect(await writeQuest(stateWith(broken), context, pass)).toBeNull();
    const empty = model({ quest: null });
    expect(await writeQuest(stateWith(empty.router), context, pass)).toBeNull();
    const long = model({ quest: "長".repeat(MAX_PICK_CHARS + 1) });
    expect(await writeQuest(stateWith(long.router), context, pass)).toBeNull();
    const refused = model({ quest: "這個不行" });
    expect(await writeQuest(stateWith(refused.router), context, pass)).toBeNull();
  });

  it("is not asked for once the economy stopped waiting", async () => {
    const m = model({ quest: "跟她說說新家整理好了沒" });
    const done = new AbortController();
    done.abort();
    expect(await writeQuest(stateWith(m.router), context, pass, done.signal)).toBeNull();
    expect(m.told).toHaveLength(0);
  });
});
