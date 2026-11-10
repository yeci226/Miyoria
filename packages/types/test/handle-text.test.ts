import { describe, expect, it } from "vitest";
import {
  ephemeralHandlesIn,
  hasEphemeralHandle,
  repairHandleJson,
  repairHandleText,
} from "../src/index.js";

describe("repairHandleText", () => {
  it("leaves text without codes exactly as it is", () => {
    for (const text of ["Owen 喜歡拉麵", "p2p 連線很慢", "version 1.2 出了", "U2 的歌", ""]) {
      expect(repairHandleText(text)).toBe(text);
    }
  });

  it("resolves a code from its own definition", () => {
    expect(repairHandleText("u1=御坂,u2=Owen。u1 一直嗆 u2。")).toBe(
      "御坂,Owen。御坂 一直嗆 Owen。",
    );
    expect(repairHandleText("御坂(u1)很吵,u1 不聽勸")).toBe("御坂很吵,御坂 不聽勸");
    expect(repairHandleText("Amy（u3）說她累了")).toBe("Amy說她累了");
  });

  it("uses `sole` only for the one leftover person code", () => {
    expect(repairHandleText("u7 一直嗆我", { sole: "Owen" })).toBe("Owen 一直嗆我");
    expect(repairHandleText("u7 嗆我,u8 也是", { sole: "Owen" })).toBeNull();
    expect(repairHandleText("u7 嗆我。要有耐心。", { sole: null })).toBe("要有耐心。");
    // A place code is never a person.
    expect(repairHandleText("在 p2 少說一點", { sole: "Owen" })).toBeNull();
  });

  it("drops the sentences it cannot resolve and returns null when nothing is left", () => {
    expect(repairHandleText("u7 一直嗆我。今天天氣很好。")).toBe("今天天氣很好。");
    expect(repairHandleText("u1")).toBeNull();
    expect(repairHandleText("g3 p1")).toBeNull();
  });

  it("never returns a code", () => {
    for (const text of ["u1=u2 u2=u1 u1", "(u1)", "u1 (u2)", "a u12345 b u9", "x\nu4 說了\n好的"]) {
      const out = repairHandleText(text);
      expect(ephemeralHandlesIn(out ?? "")).toEqual([]);
    }
  });
});

describe("repairHandleJson / hasEphemeralHandle", () => {
  it("repairs every string, drops the unrepairable ones and code-named keys", () => {
    const value = {
      話題: ["u3 在抱怨", "御坂(u1)想玩 osu", 5, null],
      u4: "key with a code",
      巢: { a: "u9", b: "好" },
    };
    expect(hasEphemeralHandle(value)).toBe(true);
    const out = repairHandleJson(value);
    expect(out).toEqual({ 話題: ["御坂想玩 osu", 5, null], 巢: { b: "好" } });
    expect(hasEphemeralHandle(out ?? null)).toBe(false);
    expect(repairHandleJson("u1")).toBeUndefined();
    expect(repairHandleJson(3)).toBe(3);
  });
});
