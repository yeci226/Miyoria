import { describe, expect, it } from "vitest";
import { initialState, parseMessage, reduce } from "../src/feed.js";
import { MAX_TOUCHES, TOUCH_SHOW_MS, TouchSet } from "../src/touch.js";

describe("touch feed", () => {
  it("parses a touch", () => {
    expect(parseMessage('{"type":"touch","x":0.25,"y":1,"part":"head"}')).toEqual({
      type: "touch",
      x: 0.25,
      y: 1,
      part: "head",
    });
    expect(parseMessage('{"type":"touch","x":0,"y":0,"part":"screen"}')).not.toBeNull();
  });

  it("drops anything out of range or of the wrong type", () => {
    for (const bad of [
      '{"type":"touch","x":-0.01,"y":0.5,"part":"head"}',
      '{"type":"touch","x":0.5,"y":1.5,"part":"head"}',
      '{"type":"touch","x":"0.5","y":0.5,"part":"head"}',
      '{"type":"touch","x":0.5,"y":0.5,"part":"arm"}',
      '{"type":"touch","x":0.5,"y":0.5}',
      '{"type":"touch","x":null,"y":0.5,"part":"body"}',
    ]) {
      expect(parseMessage(bad), bad).toBeNull();
    }
  });

  it("is not part of the reduced state", () => {
    const s = initialState();
    expect(reduce(s, { type: "touch", x: 0.5, y: 0.5, part: "face" })).toBe(s);
  });
});

describe("TouchSet", () => {
  it("keeps a touch for TOUCH_SHOW_MS", () => {
    const set = new TouchSet();
    const { touch } = set.add({ x: 0.5, y: 0.5, part: "head" }, 1_000);
    expect(set.expire(1_000 + TOUCH_SHOW_MS - 1)).toEqual([]);
    expect(set.expire(1_000 + TOUCH_SHOW_MS)).toEqual([touch.id]);
    expect(set.size).toBe(0);
  });

  it("holds at most MAX_TOUCHES, dropping the oldest", () => {
    const set = new TouchSet();
    const ids: number[] = [];
    let dropped: number[] = [];
    for (let i = 0; i < MAX_TOUCHES + 3; i++) {
      const r = set.add({ x: 0.1, y: 0.1, part: "body" }, i);
      ids.push(r.touch.id);
      dropped = dropped.concat(r.dropped);
    }
    expect(set.size).toBe(MAX_TOUCHES);
    expect(dropped).toEqual(ids.slice(0, 3));
  });
});
