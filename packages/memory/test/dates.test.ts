import type { PeopleStore, SettingsStore } from "@miyoria/store";
import type { ToolContext } from "@miyoria/tools";
import type { AccountRef, ContextKey, JsonValue, PersonId } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { memoryConfig } from "../src/config.js";
import {
  DateBook,
  DateGreeter,
  type DatesState,
  ForgetDateTool,
  fallsOn,
  localDay,
  occasionsOf,
  RememberDateTool,
  validDay,
} from "../src/dates.js";
import type { MemoryEngine, NewMemory } from "../src/engine.js";

const owen = "01PERSONOWEN0000000000000" as PersonId;
const account: AccountRef = { platform: "discord", id: "42" };
const context: ContextKey = { platform: "discord", scope: "1", channel: "2", kind: "channel" };
/** 2026-11-10 09:00 in Taiwan. */
const NOW = Date.UTC(2026, 10, 10, 1, 0, 0);

class MemorySettings implements SettingsStore {
  readonly values = new Map<string, JsonValue>();
  async get(_p: string, key: string) {
    return this.values.get(key) ?? null;
  }
  async set(_p: string, key: string, value: JsonValue | null) {
    if (value === null) this.values.delete(key);
    else this.values.set(key, structuredClone(value));
  }
  async list() {
    return new Map<string, JsonValue>();
  }
  async deletePrefix() {
    return 0;
  }
}

function fakeEngine(stored: NewMemory[]): MemoryEngine {
  return {
    config: memoryConfig(),
    personOf: async (a: AccountRef) => (a.id === "42" ? owen : null),
    nameOf: async () => "Owen",
    nameOfPerson: async () => "Owen",
    store: async (m: NewMemory) => {
      stored.push(m);
      return { type: "inserted" };
    },
  } as unknown as MemoryEngine;
}

function people(createdAt: string): PeopleStore {
  return {
    personByAccount: async (a: AccountRef) =>
      a.id === "42"
        ? { id: owen, display_name: "owen", created_at: createdAt, accounts: [] }
        : null,
  } as unknown as PeopleStore;
}

const toolCtx = { account, context } as unknown as ToolContext;

describe("calendar", () => {
  it("local_day_uses_the_offset", () => {
    // 23:30 UTC on 9 November is already the 10th in Taiwan.
    expect(localDay(Date.UTC(2026, 10, 9, 23, 30), 480)).toEqual({
      year: 2026,
      month: 11,
      day: 10,
    });
    expect(localDay(Date.UTC(2026, 10, 9, 23, 30), 0)).toEqual({ year: 2026, month: 11, day: 9 });
  });

  it("29_february_falls_on_the_28th_in_other_years", () => {
    expect(fallsOn(2, 29, { year: 2027, month: 2, day: 28 })).toBe(true);
    expect(fallsOn(2, 29, { year: 2028, month: 2, day: 28 })).toBe(false);
    expect(fallsOn(2, 29, { year: 2028, month: 2, day: 29 })).toBe(true);
    expect(validDay(2, 29)).toBe(true);
    expect(validDay(2, 30)).toBe(false);
    expect(validDay(13, 1)).toBe(false);
  });

  it("occasions_are_the_days_dates_and_the_anniversary_once_a_year", () => {
    const state: DatesState = {
      entries: [
        { id: "a", person: owen, name: "Owen", month: 11, day: 10, label: "生日", added_at: "" },
        {
          id: "b",
          person: owen,
          name: "Owen",
          month: 11,
          day: 10,
          label: "開台紀念日",
          added_at: "",
        },
        { id: "c", person: owen, name: "Owen", month: 1, day: 1, label: "生日", added_at: "" },
      ],
      greeted: { "date:b": 2026 },
    };
    const today = localDay(NOW, 480);
    const opts = { met: true, offsetMinutes: 480 };
    const got = occasionsOf(state, owen, "Owen", "2024-11-10T02:00:00Z", today, opts);
    expect(got.map((o) => o.key)).toEqual(["date:a", `met:${owen}`]);
    expect(got[0]?.text).toContain("Owen的生日");
    expect(got[1]?.text).toContain("認識滿 2 年");
    // Met today: no anniversary yet.
    const fresh = occasionsOf(state, owen, "Owen", "2026-11-10T02:00:00Z", today, opts);
    expect(fresh.map((o) => o.key)).toEqual(["date:a"]);
    expect(
      occasionsOf(state, owen, "Owen", "2024-11-10T02:00:00Z", today, { ...opts, met: false }),
    ).toHaveLength(1);
  });
});

describe("date book and tools", () => {
  it("remembers_replaces_and_forgets_the_speakers_dates", async () => {
    const settings = new MemorySettings();
    const book = new DateBook(settings, "p");
    const engine = fakeEngine([]);
    const remember = new RememberDateTool(book, engine, { now: () => NOW } as never);
    expect(await remember.call(toolCtx, { month: 3, day: 5 })).toContain("3/5 是你的生日");
    expect(await remember.call(toolCtx, { month: 3, day: 6 })).toContain("3/6");
    expect(await remember.call(toolCtx, { month: 2, day: 30 })).toBe("沒有這一天,沒有記。");
    const state = await new DateBook(settings, "p").state();
    expect(state.entries.map((e) => `${e.label} ${e.month}/${e.day}`)).toEqual(["生日 3/6"]);
    const stranger = { ...toolCtx, account: { platform: "discord", id: "9" } } as ToolContext;
    expect(await remember.call(stranger, { month: 1, day: 1 })).toContain("不知道你是誰");
    const forget = new ForgetDateTool(book, engine);
    expect(await forget.call(toolCtx, {})).toBe("忘掉你的生日了。");
    expect(await forget.call(toolCtx, {})).toBe("我沒有記你的生日。");
  });
});

describe("DateGreeter", () => {
  it("makes_a_followup_due_now_the_first_time_they_speak_on_the_day", async () => {
    const settings = new MemorySettings();
    const book = new DateBook(settings, "p");
    const stored: NewMemory[] = [];
    const engine = fakeEngine(stored);
    await book.add({ person: owen, name: "Owen", month: 11, day: 10, label: "生日" }, NOW);
    const cfg = memoryConfig().dates;
    const greeter = new DateGreeter(book, engine, people("2026-01-01T00:00:00Z"), () => cfg);
    expect(await greeter.seen(account, context, NOW)).toBe(1);
    expect(stored[0]).toMatchObject({
      kind: "followup",
      subjects: [owen],
      source_context: context,
    });
    expect(stored[0]?.content).toContain("生日快樂");
    expect(Date.parse(stored[0]?.due ?? "")).toBe(NOW);
    // Once a day per run, and once a year in the book.
    expect(await greeter.seen(account, context, NOW + 60_000)).toBe(0);
    const again = new DateGreeter(book, engine, people("2026-01-01T00:00:00Z"), () => cfg);
    expect(await again.seen(account, context, NOW + 120_000)).toBe(0);
    expect(stored).toHaveLength(1);
  });

  it("does_nothing_when_off_or_on_other_days", async () => {
    const book = new DateBook(new MemorySettings(), "p");
    await book.add({ person: owen, name: "Owen", month: 11, day: 11, label: "生日" }, NOW);
    const stored: NewMemory[] = [];
    const on = memoryConfig().dates;
    const greeter = new DateGreeter(
      book,
      fakeEngine(stored),
      people("2026-01-01T00:00:00Z"),
      () => on,
    );
    expect(await greeter.seen(account, context, NOW)).toBe(0);
    const off = { ...on, enabled: false };
    const quiet = new DateGreeter(
      book,
      fakeEngine(stored),
      people("2026-01-01T00:00:00Z"),
      () => off,
    );
    expect(await quiet.seen(account, context, NOW + 86_400_000)).toBe(0);
    expect(stored).toHaveLength(0);
  });
});
