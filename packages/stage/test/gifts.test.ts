// Gifts: the protocol messages, the `stage.expression` capability, a gift expression on the model
// (and her own face coming back), and the overlay's merged gift line.

import { ActuatorRegistry } from "@miyoria/actions";
import { ServiceRegistry } from "@miyoria/kernel";
import { ToolRegistry } from "@miyoria/tools";
import { customEvent, Principals } from "@miyoria/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AvatarLoop,
  AvatarProfile,
  DEFAULT_GIFT_EXPRESSIONS,
  encodeMessage,
  Forwarder,
  GIFT_MERGE_MS,
  GIFT_SHOW_MS,
  GiftMerger,
  Levels,
  OverlayHub,
  parseCoreMessage,
  parseStageConfig,
  Random,
  type StageLink,
  stageCapabilities,
} from "../src/index.js";
import type { VtsClient } from "../src/vts.js";
import { Watch } from "../src/watch.js";

afterEach(() => vi.useRealTimers());

describe("gift messages", () => {
  it("avatar_expression is validated and round-trips", () => {
    const msg = { type: "avatar_expression", expression: "heart", seconds: 5, id: 3 };
    expect(parseCoreMessage(JSON.parse(encodeMessage(parseCoreMessage(msg))))).toStrictEqual(msg);
    // Without an id the key is left out.
    expect(encodeMessage(parseCoreMessage({ ...msg, id: undefined }))).not.toContain("id");
    for (const bad of [
      { ...msg, expression: "wink" },
      { ...msg, seconds: 0.5 },
      { ...msg, seconds: 16 },
      { ...msg, seconds: "5" },
    ]) {
      expect(() => parseCoreMessage(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it("gift round-trips and is bounded", () => {
    const msg = { type: "gift", name: "Owen", item: "rice", count: 2, label: "一碗白飯" };
    expect(parseCoreMessage(msg)).toStrictEqual(msg);
    expect(() => parseCoreMessage({ ...msg, count: 0 })).toThrow();
    expect(() => parseCoreMessage({ ...msg, name: "x".repeat(33) })).toThrow();
  });

  it("the forwarder turns economy.gift into gift and drops junk", () => {
    const f = new Forwarder(false);
    const gift = { name: " Owen ", item: "dessert", count: 3.9, label: "一份甜點" };
    expect(f.onEvent(customEvent("economy.gift", gift))).toStrictEqual([
      { type: "gift", name: "Owen", item: "dessert", count: 3, label: "一份甜點" },
    ]);
    for (const bad of [
      { ...gift, name: "" },
      { ...gift, label: " " },
      { ...gift, item: 4 },
      { ...gift, count: 0 },
      "nope",
    ]) {
      expect(f.onEvent(customEvent("economy.gift", bad as never)), JSON.stringify(bad)).toEqual([]);
    }
  });
});

describe("stage.expression capability", () => {
  function setup(connected: boolean, fail?: string) {
    const calls: [string, number][] = [];
    const link = {
      isConnected: () => connected,
      status: () => null,
      expression: async (expression: string, seconds: number) => {
        if (fail) throw new Error(fail);
        calls.push([expression, seconds]);
      },
    } as unknown as StageLink;
    const registry = new ActuatorRegistry({
      services: new ServiceRegistry(),
      tools: new ToolRegistry(),
      builtins: false,
    });
    for (const c of stageCapabilities(link)) registry.register(c);
    const ask = (args: Record<string, unknown>) =>
      registry.invoke({
        principal: Principals.panel("api"),
        capability: "stage.expression",
        args: args as never,
        why: null,
        turn: null,
      });
    return { calls, ask, registry };
  }

  it("shows the expression when the node is connected, and is not her tool", async () => {
    const s = setup(true);
    const out = await s.ask({ expression: "squint", seconds: 6 });
    expect(out.status).toBe("done");
    expect(s.calls).toEqual([["squint", 6]]);
    expect(s.registry.get("stage.expression")?.tool ?? null).toBeNull();
  });

  it("fails when the node is not connected, or the node refuses", async () => {
    const down = await setup(false).ask({ expression: "heart", seconds: 5 });
    expect(down).toMatchObject({
      status: "failed",
      error: expect.stringContaining("not connected"),
    });
    const refused = await setup(true, "VTube Studio is not connected").ask({
      expression: "heart",
      seconds: 5,
    });
    expect(refused).toMatchObject({ status: "failed" });
  });

  it("takes only the four expressions, 1 to 15 seconds", async () => {
    const s = setup(true);
    for (const args of [
      { expression: "cry", seconds: 5 },
      { expression: "heart", seconds: 0 },
      { expression: "heart", seconds: 16 },
      { expression: "heart" },
    ]) {
      expect((await s.ask(args)).status, JSON.stringify(args)).toBe("denied");
    }
    expect(s.calls).toEqual([]);
  });
});

describe("gift expression on the model", () => {
  it("maps the four expressions to files, configurable", () => {
    const p = AvatarProfile.parse(null);
    expect(Object.fromEntries(p.giftExpressions)).toStrictEqual(DEFAULT_GIFT_EXPRESSIONS);
    expect(DEFAULT_GIFT_EXPRESSIONS).toStrictEqual({
      heart: "爱心眼.exp3.json",
      blush: "脸红.exp3.json",
      squint: "＞＜.exp3.json",
      big_bowl: "钢盆.exp3.json",
    });
    const own = AvatarProfile.parse({
      gift_expression: { heart: "my.exp3.json", nope: "x.exp3.json", blush: "hotkey" },
    });
    expect(own.giftExpressions.get("heart")).toBe("my.exp3.json");
    // A hotkey is not an expression file, an unknown name is skipped: defaults stay.
    expect(own.giftExpressions.get("blush")).toBe(DEFAULT_GIFT_EXPRESSIONS.blush);
    expect(own.giftExpressions.size).toBe(4);
    expect(own.clone().giftExpressions.get("heart")).toBe("my.exp3.json");
  });

  const profile = () =>
    AvatarProfile.parse({
      emotion: {
        happy: { expression: "爱心眼.exp3.json" },
        sad: { expression: "流泪.exp3.json" },
      },
    });

  function rig(options: { vts?: boolean; failOn?: string } = {}) {
    const config = parseStageConfig(
      { motion: { seed: 9 }, lipsync: { latency_ms: 0 }, vts: { emotion_hold_ms: 60_000 } },
      profile(),
    );
    /** `file:on|off`, in order. */
    const sent: string[] = [];
    const on = new Set<string>();
    const client = {
      isClosed: () => false,
      setExpression: async (file: string, active: boolean) => {
        if (options.failOn === file && active) throw new Error("no such expression");
        sent.push(`${file}:${active ? "on" : "off"}`);
        if (active) on.add(file);
        else on.delete(file);
      },
      triggerHotkey: async () => {},
    } as unknown as VtsClient;
    let now = 1_000;
    const loop = new AvatarLoop(
      config,
      new Levels(config.lipsync),
      new Watch<VtsClient | null>(options.vts === false ? null : client),
      { now: () => now },
      new Random(9),
    );
    const step = async (ms: number) => {
      for (let t = 0; t < ms; t += 100) {
        now += 100;
        loop.frame(100, now);
      }
      await new Promise((r) => setTimeout(r, 0));
    };
    return { loop, sent, on, step, mark: () => sent.splice(0) };
  }

  it("fails without VTube Studio or with a file the model refuses", async () => {
    await expect(rig({ vts: false }).loop.gift("heart", 3)).rejects.toThrow("not connected");
    const r = rig({ failOn: DEFAULT_GIFT_EXPRESSIONS.blush });
    await expect(r.loop.gift("blush", 3)).rejects.toThrow("no such expression");
    // Nothing is held: her own expression still works afterwards.
    r.loop.emotion("sad", 1);
    await r.step(100);
    expect([...r.on]).toContain("流泪.exp3.json");
  });

  it("is on for its seconds, then off", async () => {
    const r = rig();
    await r.loop.gift("blush", 3);
    expect(r.sent).toEqual(["脸红.exp3.json:on"]);
    await r.step(2_000);
    expect([...r.on]).toEqual(["脸红.exp3.json"]);
    await r.step(1_500);
    expect([...r.on]).toEqual([]);
    expect(r.sent.at(-1)).toBe("脸红.exp3.json:off");
  });

  it("wins over her emotion, which comes back afterwards", async () => {
    const r = rig();
    r.loop.emotion("sad", 1);
    await r.step(100);
    expect([...r.on]).toEqual(["流泪.exp3.json"]);
    r.mark();

    await r.loop.gift("blush", 4);
    // Her tears go off for the gift.
    expect(r.sent).toEqual(["流泪.exp3.json:off", "脸红.exp3.json:on"]);
    // A new emotion marker meanwhile is held back, not shown.
    r.loop.emotion("happy", 1);
    await r.step(2_000);
    expect([...r.on]).toEqual(["脸红.exp3.json"]);

    await r.step(2_500);
    // The gift is off and her current emotion (happy now, not the sad one) is on.
    expect([...r.on]).toEqual(["爱心眼.exp3.json"]);
  });

  it("a gift that is her own accent's file stays on afterwards", async () => {
    const r = rig();
    r.loop.emotion("happy", 1);
    await r.step(100);
    r.mark();
    await r.loop.gift("heart", 3);
    await r.step(3_500);
    expect([...r.on]).toEqual(["爱心眼.exp3.json"]);
  });

  it("a newer gift replaces the one showing and restarts the time", async () => {
    const r = rig();
    await r.loop.gift("blush", 3);
    await r.step(2_000);
    await r.loop.gift("squint", 4);
    expect([...r.on]).toEqual(["＞＜.exp3.json"]);
    await r.step(3_000);
    expect([...r.on]).toEqual(["＞＜.exp3.json"]);
    await r.step(1_500);
    expect([...r.on]).toEqual([]);
  });
});

describe("gift line merge", () => {
  const rice = (name: string, count = 1) => ({ name, item: "rice", count, label: "一碗白飯" });

  it("one giver, one bowl", () => {
    const m = new GiftMerger();
    expect(m.add(rice("Owen"), 0)).toBe("Owen 餵了她一碗白飯");
  });

  it("merges gifts of the same item within 60 s, counting people and bowls", () => {
    const m = new GiftMerger();
    m.add(rice("Owen"), 0);
    expect(m.add(rice("Owen"), 5_000)).toBe("Owen 餵了她 2 碗白飯");
    m.add(rice("小明"), 10_000);
    m.add(rice("Mia"), 20_000);
    expect(m.add(rice("阿翔"), 59_000)).toBe("Owen 和另外 3 人餵了她 5 碗白飯");
  });

  it("starts over after 60 s and keeps items apart", () => {
    const m = new GiftMerger();
    m.add(rice("Owen"), 0);
    m.add(rice("Mia"), 1_000);
    expect(m.add(rice("Mia"), GIFT_MERGE_MS)).toBe("Mia 餵了她一碗白飯");
    const dessert = { name: "Owen", item: "dessert", count: 1, label: "一份甜點" };
    expect(m.add(dessert, GIFT_MERGE_MS + 1)).toBe("Owen 餵了她一份甜點");
    expect(m.add(rice("Mia"), GIFT_MERGE_MS + 2)).toBe("Mia 餵了她 2 碗白飯");
  });

  it("a gift of several counts for all of them; other items are handed over", () => {
    const m = new GiftMerger();
    expect(m.add(rice("Owen", 3), 0)).toBe("Owen 餵了她 3 碗白飯");
    expect(m.add({ name: "Owen", item: "letter", count: 1, label: "一封信" }, 0)).toBe(
      "Owen 送了她一封信",
    );
    expect(m.add({ name: "Mia", item: "expression", count: 2, label: "表情" }, 0)).toBe(
      "Mia 送了她 表情 x2",
    );
  });

  it("fades after 8 s from the latest gift", () => {
    const m = new GiftMerger();
    m.add(rice("Owen"), 0);
    expect(m.current(GIFT_SHOW_MS - 1)).toBe("Owen 餵了她一碗白飯");
    expect(m.current(GIFT_SHOW_MS)).toBeNull();
    m.add(rice("Mia"), 6_000);
    expect(m.current(6_000 + GIFT_SHOW_MS - 1)).toContain("和另外 1 人");
    expect(m.expire(6_000 + GIFT_SHOW_MS)).toBe(true);
    expect(m.current(6_000 + GIFT_SHOW_MS)).toBeNull();
  });

  it("ignores unusable gifts and cleans names", () => {
    const m = new GiftMerger();
    expect(m.add(rice(""), 0)).toBeNull();
    expect(m.add({ ...rice("a"), label: " " }, 0)).toBeNull();
    expect(m.add({ ...rice("a"), count: 0 }, 0)).toBeNull();
    expect(m.add(rice("Ow\nen\u0007"), 0)).toBe("Ow en 餵了她一碗白飯");
  });
});

describe("overlay gift line", () => {
  it("sends the merged line, clears it after 8 s and shows it to new clients", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const hub = new OverlayHub(() => Date.now());
    const got: unknown[] = [];
    hub.listen((t) => got.push(JSON.parse(t)));
    const gift = (name: string) => hub.gift({ name, item: "rice", count: 1, label: "一碗白飯" });

    gift("Owen");
    expect(got).toEqual([{ type: "gift", text: "Owen 餵了她一碗白飯" }]);
    expect(hub.initial().map((t) => JSON.parse(t))).toContainEqual({
      type: "gift",
      text: "Owen 餵了她一碗白飯",
    });

    vi.advanceTimersByTime(5_000);
    gift("Mia");
    expect(got.at(-1)).toEqual({ type: "gift", text: "Owen 和另外 1 人餵了她 2 碗白飯" });
    // The first timer was replaced: nothing clears at 8 s.
    vi.advanceTimersByTime(4_000);
    expect(got).toHaveLength(2);
    vi.advanceTimersByTime(4_100);
    expect(got.at(-1)).toEqual({ type: "gift", text: "" });
    expect(
      hub
        .initial()
        .map((t) => JSON.parse(t))
        .some((m) => m.type === "gift"),
    ).toBe(false);

    // A gift inside the 60 s window continues the count.
    gift("Owen");
    expect(got.at(-1)).toEqual({ type: "gift", text: "Owen 和另外 1 人餵了她 3 碗白飯" });
  });
});
