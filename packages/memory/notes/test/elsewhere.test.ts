// What she read of another place (`look`, docs/design/v5-places.md §9) is that place's: the
// segment pass never shows it to the model that writes the notes of the place she read it in.

import { describe, expect, it } from "vitest";
import { ELSEWHERE_MARK, fromElsewhere } from "../../memory/src/places.js";
import { entryLine } from "../src/pass-prompt.js";
import { entry } from "./helpers.js";

describe("a tool result from another place", () => {
  it("is left out of the segment pass, while other tool results stay", () => {
    const looked = entry(3, {
      kind: "tool_result",
      tool_call_id: "c1",
      content: `${ELSEWHERE_MARK}以下是伺服器B的事\n- amy 說了一件事`,
    });
    const plain = entry(4, { kind: "tool_result", tool_call_id: "c2", content: "設好了" });
    expect(fromElsewhere(looked.content)).toBe(true);
    expect(entryLine(looked, new Map())).toBeNull();
    expect(entryLine(plain, new Map())).toBe("[4] (工具結果)設好了");
  });
});
