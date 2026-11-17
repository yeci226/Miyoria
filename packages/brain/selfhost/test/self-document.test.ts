// Her document about herself is in the pinned block (3), whole, and the block changes only when
// the document does.

import { type SelfDocument, SelfDocumentKey } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { channel, mention, Rig, says, stopRigs, until } from "./harness.js";

afterEach(async () => {
  await stopRigs();
});

const C1 = channel("c1");

function pinnedWith(
  request: { messages: readonly { content: unknown }[] } | undefined,
  mark: string,
) {
  const messages = request?.messages ?? [];
  return messages.findIndex((m) => String(m.content).includes(mark));
}

describe("her self document in the pinned block", () => {
  it("is there whole, and block 3 changes on the next run after a rewrite, not before", async () => {
    const long = Array.from({ length: 12 }, (_, i) => `第${i}件關於我自己的事 ${"字".repeat(120)}`);
    const state = { text: long.join("\n"), reads: 0 };
    const self: SelfDocument = {
      read: (budget) => {
        state.reads++;
        return state.text.slice(0, budget);
      },
    };
    const rig = await Rig.create({
      provide: (sup) => sup.services.provide("app", SelfDocumentKey, self),
    });
    rig.model.push(says("嗯"), says("好"), says("對"));
    rig.say(mention(C1, "amy", "@她 在嗎"));
    await until(() => rig.sink.texts().length === 1, 3_000, "the first answer");
    const first = rig.model.requests[0];
    const at = pinnedWith(first, "第11件關於我自己的事");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThan((first?.messages.length ?? 0) - 1);
    const block = String(first?.messages[at]?.content);
    expect(block).toContain("第0件關於我自己的事");

    rig.say(mention(C1, "amy", "@她 還在嗎"));
    await until(() => rig.sink.texts().length === 2, 3_000, "the second answer");
    expect(String(rig.model.requests[1]?.messages[at]?.content)).toBe(block);

    state.text = "我最近在學畫畫";
    rig.say(mention(C1, "amy", "@她 你在做什麼"));
    await until(() => rig.sink.texts().length === 3, 3_000, "the third answer");
    const changed = String(rig.model.requests[2]?.messages[at]?.content);
    expect(changed).toContain("我最近在學畫畫");
    expect(changed).not.toContain("第11件關於我自己的事");
  });
});
