// `remind_me` (v4 §8.3): timers that survive a restart, are capped and cancellable; a due one is
// published (`mind.reminder`), her inbox on the new runner; nothing in the background speaks.

import { ActuatorRegistry } from "@miyoria/gate/actions";
import { ServiceRegistry } from "@miyoria/runtime/kernel";
import { MemorySettingsStore } from "@miyoria/store";
import { type AccountRef, type ContextKey, Principals, type Reminder } from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DeliveryOutcome,
  parseAt,
  REMINDER_PREFIX,
  RETRY_MS,
  ReminderBook,
  type ReminderLimits,
  remindCapability,
} from "../src/index.js";

const T0 = Date.parse("2026-11-10T07:00:00.000Z"); // 15:00 at UTC+8
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const OWEN: AccountRef = { platform: "discord", id: "100" };
const AMY: AccountRef = { platform: "discord", id: "200" };
const CHAT: ContextKey = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" };
const LIMITS: ReminderLimits = { max: 4, perPerson: 2, maxDays: 30, holdMins: 120 };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

const clock = { now: () => Date.now() };

function book(
  deliver: (r: Reminder, late: number) => Promise<DeliveryOutcome> = async () => ({
    status: "delivered",
    detail: "",
  }),
  store: MemorySettingsStore | null = null,
) {
  return new ReminderBook({
    store,
    profile: "p",
    clock,
    limits: LIMITS,
    offsetMinutes: 480,
    deliver,
  });
}

const input = (p: Partial<Parameters<ReminderBook["set"]>[0]> = {}) => ({
  what: "看一下烤箱",
  due: T0 + 20 * MIN,
  daily: false,
  context: CHAT,
  person: null,
  for_account: null,
  ...p,
});

describe("when", () => {
  it("reads HH:MM as the next time the clock shows it, and a full local date", () => {
    expect(parseAt("16:30", T0, 480)).toBe(Date.parse("2026-11-10T08:30:00.000Z"));
    // 09:00 already passed today (15:00 local): tomorrow.
    expect(parseAt("09:00", T0, 480)).toBe(Date.parse("2026-11-11T01:00:00.000Z"));
    expect(parseAt("2026-11-12 21:05", T0, 480)).toBe(Date.parse("2026-11-12T13:05:00.000Z"));
    expect(parseAt("25:00", T0, 480)).toBeNull();
    expect(parseAt("明天", T0, 480)).toBeNull();
  });
});

describe("her timers", () => {
  it("are capped in count, per person and in horizon, and cannot be in the past", () => {
    const b = book();
    expect(() => b.set(input({ due: T0 - MIN }))).toThrow("提醒的時間已經過了");
    expect(() => b.set(input({ due: T0 + 31 * DAY }))).toThrow("最多只能設 30 天內的提醒");
    expect(() => b.set(input({ what: "  " }))).toThrow("要提醒什麼沒有寫");
    b.set(input({ for_account: OWEN }));
    b.set(input({ for_account: OWEN }));
    expect(() => b.set(input({ for_account: OWEN }))).toThrow("這個人已經有 2 個提醒在等了");
    b.set(input({ for_account: AMY }));
    b.set(input());
    expect(() => b.set(input())).toThrow("上限 4");
  });

  it("survive a restart, and can be cancelled by key", async () => {
    const store = new MemorySettingsStore();
    const first = book(undefined, store);
    const r = first.set(input({ what: "問 Owen 考試考得怎樣", person: "Owen" }));
    expect(r.key).toMatch(/^R[0-9A-Z]{5}$/);
    await first.flush();
    const again = book(undefined, store);
    await again.load();
    expect(again.list()).toEqual([r]);
    expect(again.cancel(r.key.toLowerCase())).toBe(true);
    expect(again.cancel(r.key)).toBe(false);
    await again.flush();
    expect((await store.list("p", REMINDER_PREFIX)).size).toBe(0);
  });

  it("keep the handle of the one person a name means, and nobody for a name nobody has", () => {
    const named = new ReminderBook({
      store: null,
      profile: "p",
      clock,
      limits: LIMITS,
      offsetMinutes: 480,
      deliver: async () => ({ status: "delivered", detail: "" }),
      handleOf: (name) => (name === "Model-9 Lumen" || name === "Nobu" ? "Nobu" : null),
    });
    expect(named.set(input({ person: "Model-9 Lumen" })).person).toBe("Nobu");
    expect(named.set(input({ person: "Lumen" })).person).toBeNull();
  });

  it("come due once, with a stable attention key, then end", async () => {
    const delivered: [Reminder, number][] = [];
    const b = book(async (r, late) => {
      delivered.push([r, late]);
      return { status: "delivered", detail: "" };
    });
    const r = b.set(input());
    await b.tick();
    expect(delivered).toEqual([]);
    vi.setSystemTime(T0 + 20 * MIN);
    await b.tick();
    expect(delivered.map(([d, late]) => [d.id, d.fired, late])).toEqual([[r.id, 0, 0]]);
    expect(b.list()).toEqual([]);
  });

  it("a daily one moves to the next day and counts how often it fired", async () => {
    const delivered: Reminder[] = [];
    const b = book(async (r) => {
      delivered.push(r);
      return { status: "delivered", detail: "" };
    });
    const r = b.set(input({ daily: true, what: "喝水" }));
    vi.setSystemTime(T0 + 21 * MIN);
    await b.tick();
    expect(b.list()[0]).toMatchObject({
      id: r.id,
      fired: 1,
      due: new Date(T0 + 20 * MIN + DAY).toISOString(),
    });
    vi.setSystemTime(T0 + 20 * MIN + DAY);
    await b.tick();
    expect(delivered.map((d) => d.fired)).toEqual([0, 1]);
    expect(b.list()[0]?.fired).toBe(2);
  });

  it("held back (quiet hours) it is tried again later, and dropped once a day late", async () => {
    let held = true;
    const tries: number[] = [];
    const b = book(async () => {
      tries.push(Date.now());
      return held ? { status: "held", detail: "安靜時段" } : { status: "delivered", detail: "" };
    });
    b.set(input());
    vi.setSystemTime(T0 + 20 * MIN);
    await b.tick();
    await b.tick();
    expect(tries).toHaveLength(1);
    vi.setSystemTime(T0 + 20 * MIN + RETRY_MS);
    held = false;
    await b.tick();
    expect(tries).toHaveLength(2);
    expect(b.list()).toEqual([]);

    held = true;
    b.set(input({ due: Date.now() + MIN }));
    vi.setSystemTime(Date.now() + MIN + DAY + 1);
    await b.tick();
    expect(b.list()).toEqual([]);
    expect(tries).toHaveLength(2);
  });

  it("the loop wakes for a timer set while it sleeps", async () => {
    const delivered: string[] = [];
    const b = book(async (r) => {
      delivered.push(r.what);
      return { status: "delivered", detail: "" };
    });
    const stop = new AbortController();
    const running = b.run(stop.signal);
    await vi.advanceTimersByTimeAsync(10_000);
    b.set(input({ due: Date.now() + 90_000, what: "九十秒" }));
    await vi.advanceTimersByTimeAsync(95_000);
    expect(delivered).toEqual(["九十秒"]);
    stop.abort();
    await running;
  });
});

describe("remind_me", () => {
  function setup() {
    const services = new ServiceRegistry();
    const registry = new ActuatorRegistry({ services, builtins: false, clock });
    const b = book();
    registry.register(remindCapability(b));
    return { registry, b };
  }

  it("is a low-risk tool with a Traditional Chinese description", () => {
    const { registry } = setup();
    const cap = registry.get("self.remind");
    expect(cap).toMatchObject({ risk: "low", permission: "tools.remind" });
    expect(cap?.tool?.name).toBe("remind_me");
    expect(cap?.tool?.description).toContain("設一個提醒給自己");
  });

  it("she sets, lists and cancels her own; a person only sees and cancels theirs", async () => {
    const { registry, b } = setup();
    const self = Principals.self(CHAT);
    const set = await registry.invoke({
      principal: self,
      capability: "self.remind",
      args: { what: "看一下烤箱", in_minutes: 20 },
      why: null,
      turn: null,
    });
    expect(set.status).toBe("done");
    if (set.status !== "done") return;
    expect(set.result.text).toMatch(
      /^提醒設好了,還沒到時間,到時候才會提醒你:R[0-9A-Z]{5} 11\/10 15:20:看一下烤箱$/,
    );
    const forOwen = await registry.invoke({
      principal: Principals.self(CHAT, OWEN),
      capability: "self.remind",
      args: { what: "提醒 Owen 交報告", at: "21:00", daily: true },
      why: null,
      turn: null,
    });
    expect(forOwen.status).toBe("done");
    expect(b.list().map((r) => [r.what, r.daily, r.for_account?.id ?? null])).toEqual([
      ["看一下烤箱", false, null],
      ["提醒 Owen 交報告", true, "100"],
    ]);
    const key = b.list()[0]?.key ?? "";
    // Amy can neither see nor cancel hers (the gate lets her ask: give her the node).
    const amy = Principals.command(AMY, CHAT, false);
    const list = await registry.invoke({
      principal: amy,
      capability: "self.remind",
      args: { action: "list" },
      why: null,
      turn: null,
    });
    expect(list.status === "done" && list.result.text).toBe("沒有在等的提醒。");
    const cancel = await registry.invoke({
      principal: amy,
      capability: "self.remind",
      args: { action: "cancel", id: key },
      why: null,
      turn: null,
    });
    expect(cancel.status).toBe("failed");
    const mine = await registry.invoke({
      principal: self,
      capability: "self.remind",
      args: { action: "cancel", id: key },
      why: null,
      turn: null,
    });
    expect(mine.status === "done" && mine.result.text).toBe(`取消了 ${key}:看一下烤箱`);
  });

  it("refuses unclear times in her words", async () => {
    const { registry } = setup();
    const ask = (args: Record<string, unknown>) =>
      registry.invoke({
        principal: Principals.self(CHAT),
        capability: "self.remind",
        args: { what: "x", ...args } as never,
        why: null,
        turn: null,
      });
    const both = await ask({ in_minutes: 5, at: "16:00" });
    expect(both.status === "failed" && both.error).toContain("只能給一個");
    const none = await ask({});
    expect(none.status === "failed" && none.error).toContain("沒有說什麼時候");
    const bad = await ask({ at: "等一下" });
    expect(bad.status === "failed" && bad.error).toContain("看不懂時間");
    const far = await ask({ in_minutes: 31 * 24 * 60 });
    expect(far.status === "failed" && far.error).toContain("30 天");
  });
});
