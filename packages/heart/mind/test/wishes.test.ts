// Goals and timers as holders of a wish (`@miyoria/types` `wish.ts`). 2026-11-10 11:47: her Plan
// added "whenever S speaks, ... also ask about X" after she had asked S by DM and S had answered;
// it sat in her prompt and she asked again each time S spoke. A timer must not become a fourth
// way to raise the same thing.

import {
  type ContextKey,
  sameWish,
  toTimestamp,
  type Wish,
  type WishEnd,
  type Wishes,
  type WishVerdict,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { GoalBook, ReminderBook, ReminderError } from "../src/index.js";

const T0 = Date.parse("2026-11-10T03:47:00.000Z");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const CHAT: ContextKey = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" };
const clock = { now: () => T0 };

/** The arbiter's book as far as goals and timers use it: one wish per person and topic. */
class Book implements Wishes {
  readonly wishes: Wish[] = [];

  hold(person: string | null, text: string, holder: string): Wish | null {
    if (person === null) return null;
    const same = this.find(person, text);
    if (same) {
      same.holders.push(holder);
      return structuredClone(same);
    }
    const wish: Wish = {
      key: `wish:${person}:${holder}`,
      person,
      topic: text,
      holders: [holder],
      state: "open",
      made_at: toTimestamp(T0),
      asked_at: null,
      asked: 0,
      closed_at: null,
      end: null,
    };
    this.wishes.push(wish);
    return structuredClone(wish);
  }

  of(holder: string): Wish | null {
    return this.wishes.find((w) => w.holders.includes(holder)) ?? null;
  }

  find(person: string | null, text: string): Wish | null {
    return this.wishes.find((w) => w.person === person && sameWish(text, w.topic, person)) ?? null;
  }

  async screen(): Promise<WishVerdict> {
    return { raise: true, wish: null };
  }

  asked(key: string): void {
    const w = this.wishes.find((x) => x.key === key);
    if (w) Object.assign(w, { state: "asked", asked: w.asked + 1, asked_at: toTimestamp(T0) });
  }

  close(key: string, end: WishEnd): void {
    const w = this.wishes.find((x) => x.key === key);
    if (w) Object.assign(w, { state: "closed", end, closed_at: toTimestamp(T0) });
  }
}

function goals(book: Book): GoalBook {
  return new GoalBook({
    store: null,
    profile: "p",
    clock,
    maxDays: 14,
    defaultDays: 3,
    wishes: () => book,
  });
}

function timers(book: Book): ReminderBook {
  return new ReminderBook({
    store: null,
    profile: "p",
    clock,
    limits: { max: 4, perPerson: 2, maxDays: 30, holdMins: 120 },
    offsetMinutes: 480,
    deliver: async () => ({ status: "delivered", detail: "" }),
    wishes: () => book,
  });
}

describe("a goal about a person is a wish", () => {
  it("one asked and answered already is not added, however the Plan words it", () => {
    const book = new Book();
    const asked = book.hold("S", "問 S 期末報告的結果", "proposal:p1") as Wish;
    book.asked(asked.key);
    book.close(asked.key, "answered");
    const g = goals(book).add({
      what: "S 說話時接話,也順便問期末報告",
      why: "關心",
      trigger: { kind: "whenever" },
      expires: toTimestamp(T0 + DAY),
      person: "S",
      context: CHAT,
      source: "plan",
    });
    expect(g).toMatchObject({ status: "dropped", close_reason: "對方已經回答了" });
  });

  it("is done once she asked, wherever she did; a goal with more keeps the rest", () => {
    const book = new Book();
    const g = goals(book);
    const only = g.add({
      what: "問 S 期末報告的結果",
      why: "關心",
      trigger: { kind: "whenever" },
      expires: toTimestamp(T0 + DAY),
      person: "S",
      context: CHAT,
      source: "plan",
    });
    const more = g.add({
      what: "S 上線時陪他聊天",
      why: "想念",
      trigger: { kind: "whenever" },
      expires: toTimestamp(T0 + DAY),
      steps: ["陪他聊遊戲", "問期末報告的結果"],
      person: "S",
      context: CHAT,
      source: "plan",
    });
    const wish = book.of(`goal:${only.id}`) as Wish;
    expect(book.of(`goal:${more.id}`)?.key).toBe(wish.key);
    book.asked(wish.key);
    g.wished(book.of(`goal:${only.id}`) as Wish);
    expect(g.goal(only.id)?.status).toBe("done");
    expect(g.goal(more.id)).toMatchObject({ status: "pending", steps: ["陪他聊遊戲"] });
  });

  it("'stop asking' drops it", () => {
    const book = new Book();
    const g = goals(book);
    const goal = g.add({
      what: "問 S 期末報告的結果",
      why: "關心",
      trigger: { kind: "whenever" },
      expires: toTimestamp(T0 + DAY),
      person: "S",
      context: CHAT,
      source: "plan",
    });
    const wish = book.of(`goal:${goal.id}`) as Wish;
    book.close(wish.key, "stop");
    g.wished(book.of(`goal:${goal.id}`) as Wish);
    expect(g.goal(goal.id)).toMatchObject({
      status: "dropped",
      close_reason: "對方說問過了,不要再問",
    });
  });
});

describe("a timer about a person is the same wish, not a fourth way to raise it", () => {
  const input = (what: string, daily = false) => ({
    what,
    due: T0 + 20 * MIN,
    daily,
    context: CHAT,
    person: "S",
    for_account: null,
  });

  it("one about what they answered already is refused, in her words", () => {
    const book = new Book();
    const wish = book.hold("S", "問 S 期末報告的結果", "commitment:c1") as Wish;
    book.close(wish.key, "answered");
    expect(() => timers(book).set(input("問 S 期末報告怎麼樣"))).toThrow(ReminderError);
  });

  it("a one-off timer goes once she asked; a daily one stays", () => {
    const book = new Book();
    const t = timers(book);
    const once = t.set(input("問 S 期末報告的結果"));
    const daily = t.set(input("每天問 S 期末報告的結果", true));
    const wish = book.of(`reminder:${once.id}`) as Wish;
    book.asked(wish.key);
    t.wished(book.of(`reminder:${once.id}`) as Wish);
    expect(t.list().map((r) => r.id)).toEqual([daily.id]);
  });
});
