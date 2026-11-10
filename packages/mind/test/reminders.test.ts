// `remind_me` (v4 §8.3): timers that survive a restart, are capped and cancellable, and come back
// as a proposal to the main line with a stable attention key; nothing in the background speaks.

import { ActuatorRegistry } from "@miyoria/actions";
import { ServiceRegistry } from "@miyoria/kernel";
import { MemorySettingsStore } from "@miyoria/store";
import {
  type AccountRef,
  ArbiterKey,
  type ContextKey,
  type NewProposal,
  Principals,
  type ProposalBoard,
  ProposalBoardKey,
  type ProposalOutcome,
  type Reminder,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DeliveryOutcome,
  deliverer,
  parseAt,
  REMINDER_PREFIX,
  RETRY_MS,
  ReminderBook,
  type ReminderLimits,
  remindCapability,
  reminderText,
} from "../src/index.js";
import { FakeArbiter, limits as ledgerLimits } from "./fakes.js";

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

class FakeBoard implements ProposalBoard {
  readonly proposals: NewProposal[] = [];
  state: ProposalOutcome["state"] = "open";
  async propose(p: NewProposal): Promise<ProposalOutcome> {
    this.proposals.push(structuredClone(p));
    return {
      id: "P1",
      state: this.state,
      detail: this.state === "dropped" ? "主人規則" : "",
      turn: null,
    };
  }
  open() {
    return [];
  }
}

describe("delivery", () => {
  const due = (p: Partial<Reminder> = {}): Reminder => ({
    id: "01JREMINDER0000000000ABCDE",
    key: "RABCDE",
    what: "問 Owen 考試考得怎樣",
    due: new Date(T0).toISOString(),
    daily: false,
    context: CHAT,
    person: "Owen",
    for_account: null,
    fired: 0,
    created_at: new Date(T0 - DAY).toISOString(),
    ...p,
  });

  it("is a proposal for the main line, not a line: she decides what to say", async () => {
    const services = new ServiceRegistry();
    const board = new FakeBoard();
    services.provide("agent", ProposalBoardKey, board);
    const deliver = deliverer(services, clock, LIMITS, 480);
    expect(await deliver(due(), 0)).toEqual({ status: "delivered", detail: "" });
    expect(board.proposals[0]).toMatchObject({
      what: "你自己設的提醒到了:問 Owen 考試考得怎樣。要不要說、怎麼說由你決定。",
      source: "agenda",
      context: CHAT,
      person: "Owen",
      attention: {
        key: "reminder:01JREMINDER0000000000ABCDE",
        revision: 1,
        repeat_after_ms: 120 * MIN,
      },
    });
    expect(board.proposals[0]?.capability).toBeUndefined();
    board.state = "dropped";
    expect(await deliver(due({ fired: 3 }), 0)).toEqual({ status: "dropped", detail: "主人規則" });
    expect(board.proposals[1]?.attention?.revision).toBe(4);
  });

  it("waits out quiet hours and a pause", async () => {
    const services = new ServiceRegistry();
    const arbiter = new FakeArbiter();
    const board = new FakeBoard();
    services.provide("arbiter", ArbiterKey, arbiter);
    services.provide("agent", ProposalBoardKey, board);
    const deliver = deliverer(services, clock, LIMITS, 480);
    arbiter.view = {
      limits: ledgerLimits({ quiet_hours: { start_hour: 1, end_hour: 7, active: true } }),
    };
    expect((await deliver(due(), 0)).status).toBe("held");
    arbiter.view = { limits: ledgerLimits({ paused: true }) };
    expect((await deliver(due(), 0)).status).toBe("held");
    expect(board.proposals).toEqual([]);
  });

  it("without the main line it is an impulse for the Arbiter", async () => {
    const services = new ServiceRegistry();
    const arbiter = new FakeArbiter();
    services.provide("arbiter", ArbiterKey, arbiter);
    const deliver = deliverer(services, clock, LIMITS, 480);
    expect((await deliver(due({ for_account: OWEN }), 7)).status).toBe("delivered");
    expect(arbiter.impulses[0]).toMatchObject({
      source: "agenda",
      kind: "speak",
      target: { context: CHAT, person: "Owen", account: OWEN },
      coalesce_key: "reminder:01JREMINDER0000000000ABCDE",
      attention: { key: "reminder:01JREMINDER0000000000ABCDE", revision: 1 },
    });
    expect(arbiter.impulses[0]?.hint).toContain("晚了 7 分鐘");
    expect((await deliverer(new ServiceRegistry(), clock, LIMITS, 480)(due(), 0)).status).toBe(
      "held",
    );
  });

  it("says whose timer it is and how late", () => {
    expect(reminderText(due({ for_account: OWEN }), 2, 480)).toBe(
      "有人請你設的提醒到了:問 Owen 考試考得怎樣。要不要說、怎麼說由你決定。",
    );
    expect(reminderText(due(), 30, 480)).toContain("(本來是 11/10 15:00,晚了 30 分鐘)");
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
    expect(set.result.text).toMatch(/^好了,R[0-9A-Z]{5} 11\/10 15:20:看一下烤箱$/);
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
