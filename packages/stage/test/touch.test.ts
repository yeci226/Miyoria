// Touches: the bus event becomes a `touch` message (validated), the overlay hub throttles them,
// and the avatar reaction is coalesced.

import { customEvent } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  encodeMessage,
  Forwarder,
  OverlayHub,
  parseCoreMessage,
  parseTouch,
  TOUCH_TOPIC,
  TouchConfigSchema,
  TouchReaction,
  TouchThrottle,
} from "../src/index.js";

describe("touch messages", () => {
  it("live.touch becomes touch; junk is dropped", () => {
    const f = new Forwarder(false);
    const ok = { x: 0.25, y: 1, part: "head" };
    expect(f.onEvent(customEvent(TOUCH_TOPIC, ok))).toStrictEqual([{ type: "touch", ...ok }]);
    // Extra fields (names) are not forwarded.
    expect(f.onEvent(customEvent(TOUCH_TOPIC, { ...ok, name: "Owen" }))).toStrictEqual([
      { type: "touch", ...ok },
    ]);
    for (const bad of [
      { ...ok, x: -0.1 },
      { ...ok, y: 1.01 },
      { ...ok, x: "0.5" },
      { ...ok, part: "arm" },
      { x: 0.5, y: 0.5 },
      "head",
      null,
      [],
    ]) {
      expect(f.onEvent(customEvent(TOUCH_TOPIC, bad as never)), JSON.stringify(bad)).toStrictEqual(
        [],
      );
      expect(parseTouch(bad as never)).toBeNull();
    }
  });

  it("round-trips and is bounded on the wire", () => {
    const msg = { type: "touch", x: 0.5, y: 0.5, part: "screen" };
    expect(parseCoreMessage(JSON.parse(encodeMessage(parseCoreMessage(msg))))).toStrictEqual(msg);
    expect(() => parseCoreMessage({ ...msg, x: 2 })).toThrow();
    expect(() => parseCoreMessage({ ...msg, part: "leg" })).toThrow();
  });
});

describe("touch throttle", () => {
  it("lets 8 a second through", () => {
    const t = new TouchThrottle();
    const passed = Array.from({ length: 20 }, (_, i) => t.allow(1_000 + i * 10)).filter(Boolean);
    expect(passed).toHaveLength(8);
    expect(t.allow(2_005)).toBe(true);
  });

  it("the overlay hub sends them on, throttled, and only when someone listens", () => {
    let now = 5_000;
    const hub = new OverlayHub(() => now);
    hub.touch({ x: 0.1, y: 0.2, part: "head" }); // nobody listens
    const got: string[] = [];
    hub.listen((m) => got.push(m));
    for (let i = 0; i < 12; i++) hub.touch({ x: 0.1, y: 0.2, part: "face" });
    expect(got).toHaveLength(8);
    expect(JSON.parse(got[0] ?? "")).toStrictEqual({ type: "touch", x: 0.1, y: 0.2, part: "face" });
    now += 1_000;
    hub.touch({ x: 0.3, y: 0.4, part: "screen" });
    expect(got).toHaveLength(9);
    // Not kept for a client that connects later.
    expect(hub.initial().some((m) => m.includes('"touch"'))).toBe(false);
  });
});

describe("touch reaction", () => {
  const config = () => TouchConfigSchema.parse({});

  it("screen does nothing; head starts one", () => {
    const r = new TouchReaction(config());
    expect(r.touch("screen", 0)).toBe(false);
    expect(r.update(16, 16).size).toBe(0);
    expect(r.touch("head", 100)).toBe(true);
    let offsets = new Map<string, number>();
    for (let t = 100; t < 600; t += 16) offsets = new Map(r.update(16, t));
    expect(offsets.get("FaceAngleZ") ?? 0).toBeGreaterThan(5);
    expect(offsets.get("MiyoriaEyeSmile") ?? 0).toBeGreaterThan(0.5);
  });

  it("a burst extends one reaction instead of restarting it, and cooldown holds", () => {
    const r = new TouchReaction(config());
    expect(r.touch("head", 0)).toBe(true);
    expect(r.touch("head", 400)).toBe(false); // extends
    expect(r.touch("face", 1_000)).toBe(false); // still running (extended to 1900)
    expect(r.touch("head", 1_800)).toBe(false);
    expect(r.touch("head", 2_800)).toBe(true); // over, and well past the cooldown
    // A short reaction that ended inside the cooldown is not started again at once.
    const q = new TouchReaction(TouchConfigSchema.parse({ hold_ms: 300 }));
    expect(q.touch("head", 0)).toBe(true);
    expect(q.touch("head", 600)).toBe(false);
    expect(q.touch("head", 1_600)).toBe(true);
  });

  it("never runs longer than max_ms and settles back to nothing", () => {
    const r = new TouchReaction(config());
    r.touch("body", 0);
    for (let t = 500; t < 4_900; t += 500) r.touch("body", t);
    let now = 0;
    let last = new Map<string, number>();
    for (; now < 12_000; now += 16) last = new Map(r.update(16, now));
    expect(last.size).toBe(0);
  });

  it("disabled reacts to nothing and drives no parameters", () => {
    const r = new TouchReaction(TouchConfigSchema.parse({ enabled: false }));
    expect(r.touch("head", 0)).toBe(false);
  });

  it("the expression is off by default and set per part", () => {
    const r = new TouchReaction(TouchConfigSchema.parse({ face: { expression: "blush" } }));
    r.touch("head", 0);
    expect(r.expression()).toBeNull();
    const r2 = new TouchReaction(TouchConfigSchema.parse({ face: { expression: "blush" } }));
    r2.touch("face", 0);
    expect(r2.expression()).toStrictEqual({ name: "blush", seconds: 3 });
  });
});
