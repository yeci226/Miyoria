import { describe, expect, it } from "vitest";
import { ActionCall } from "../src/decision.js";
import { eventKey, goalKey, matchesEvent, Narration, similar } from "../src/narration.js";

describe("keys", () => {
  it("names what happened, not how it was said", () => {
    expect(eventKey("craft_finished", { item: "stone_pickaxe", crafted: 1, text: "x" })).toBe(
      "game:craft:stone_pickaxe",
    );
    expect(eventKey("craft_finished", { item: "stone_pickaxe", crafted: 4, text: "y" })).toBe(
      "game:craft:stone_pickaxe",
    );
    expect(eventKey("advancement", { title: "石器時代" })).toBe("game:advancement:石器時代");
    expect(eventKey("damage", { attacker: "zombie", amount: 5, health: 3 })).toBe(
      "game:damage:zombie",
    );
    expect(eventKey("reflex", { kind: "lava" })).toBe("game:reflex:lava");
    expect(eventKey("night_started", {})).toBe("game:night_started");
    expect(eventKey("night_started", null)).toBe("game:night_started");
  });

  it("does not depend on the order of a list", () => {
    expect(eventKey("hostile_near", { new_types: ["zombie", "creeper"] })).toBe(
      eventKey("hostile_near", { new_types: ["creeper", "zombie"] }),
    );
    expect(eventKey("item_picked", { items: { diamond: 2, coal: 1 } })).toBe(
      "game:item_picked:coal+diamond",
    );
  });

  it("a goal for an item is the same thing as making it", () => {
    expect(goalKey("做石鎬", new ActionCall("obtain", { item: "stone_pickaxe" }))).toBe(
      "game:craft:stone_pickaxe",
    );
    expect(goalKey("蓋房子!", new ActionCall("build", { what: "house" }))).toBe("game:goal:蓋房子");
    expect(goalKey("蓋房子", null)).toBe("game:goal:蓋房子");
  });

  it("matches a kind or a kind with its subject", () => {
    const events = ["death", "reflex:lava"];
    expect(matchesEvent(events, "death", null)).toBe(true);
    expect(matchesEvent(events, "reflex", { kind: "lava" })).toBe(true);
    expect(matchesEvent(events, "reflex", { kind: "fight" })).toBe(false);
  });
});

describe("what a free line is about", () => {
  // Her lines of 2026-11-07, in order (the hints behind them were not recorded). A long line can
  // be too far from the first one and still close to one in between: that is why every line is
  // remembered under its key.
  const SAME = [
    "ふん、石のツルハシできた!",
    "見て、石のツルハシできたよ、えへへ。",
    "よし、石のツルハシができた!",
    "ふふ、石のツルハシができたぞ。これでやっとまともな装備ってわけ。",
    "ふん、石のツルハシができたぞ。木のツルハシじゃ石掘るの遅すぎるからな、これくらいでちょうどいい。",
    "ふん、石のツルハシができたのよ。木のツルハシで石を掘るの、遅すぎてやってられないわ。",
    "ふふん、石のツルハシができたよ。木のツルハシじゃ石を掘るのが遅すぎるからね、これでやっと一人前ってわけ。",
    "ふふん、石のツルハシができたんだよ、木のツルハシじゃ石を掘るのが遅すぎるからね。",
  ];

  it("a line about a noted fact has the key of the fact", () => {
    const n = new Narration();
    n.note("game:craft:stone_pickaxe", "做好了 石鎬×1");
    expect(n.keyOf("石鎬做好了,木鎬挖石頭太慢")).toBe("game:craft:stone_pickaxe");
  });

  it("the same line reworded keeps the key of the first", () => {
    const n = new Narration();
    const key = n.keyOf(SAME[0] as string);
    n.said(key, SAME[0] as string);
    for (const line of SAME.slice(1)) {
      expect(n.keyOf(line)).toBe(key);
      n.said(key, line);
    }
  });

  it("a chain of rewordings stays one thing", () => {
    const n = new Narration();
    n.note("game:craft:stone_pickaxe", "做好了 石鎬×1");
    const first = "石鎬做好了,木鎬太慢";
    const key = n.keyOf(first);
    n.said(key, first);
    // Nothing like the fact, but close to what she said about it.
    expect(similar("木鎬太慢了,挖不動", "做好了 石鎬×1")).toBe(false);
    expect(n.keyOf("木鎬太慢了,挖不動")).toBe("game:craft:stone_pickaxe");
  });

  it("different things are different", () => {
    const n = new Narration();
    n.note("game:craft:stone_pickaxe", "做好了 石鎬×1");
    expect(n.keyOf("這裡的風景好漂亮喔")).toMatch(/^game:remark:/);
    expect(similar("又看到殭屍了", "又看到骷髏了")).toBe(false);
    expect(similar("", "石鎬")).toBe(false);
  });

  it("a free line's own key is stable", () => {
    const n = new Narration();
    expect(n.keyOf("這裡的風景好漂亮喔")).toBe(n.keyOf("這裡的風景好漂亮喔!"));
  });

  it("remembers a bounded number of topics and lines", () => {
    const n = new Narration();
    for (let i = 0; i < 100; i++) n.said(`k${i}`, `第 ${i} 句`);
    expect(n.lines()).toHaveLength(6);
    expect(n.lines().at(-1)).toBe("第 99 句");
  });
});
