// Stable handles in what she writes down (docs/design/v2-architecture.md §1.6): the fold's
// prompt and its notes use people's names, never `u1`; text with a code is rewritten or
// refused; and a style lesson is not a talkativeness knob.

import { MockProvider } from "@miyoria/llm/llm";
import { GLOBAL_SETTINGS_PROFILE, HANDLE_PREFIX } from "@miyoria/store";
import {
  type AccountRef,
  ConversationStatesKey,
  ephemeralHandlesIn,
  type Lesson,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dropStale,
  LessonStore,
  noteUnits,
  similarity,
  stateKey,
  touchUnits,
} from "../src/index.js";
import { AMY, OWEN, rig, stopRigs, TEXT, wait } from "./helpers.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-11-02T12:00:00.000Z"));
});

afterEach(async () => {
  await stopRigs();
  vi.useRealTimers();
});

const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

async function sayLines(r: Awaited<ReturnType<typeof rig>>, who: [AccountRef, string][], n = 16) {
  for (let i = 0; i < n; i++) {
    const [account, name] = who[i % who.length] as [AccountRef, string];
    await r.say(TEXT, account, name, `第 ${i + 1} 句`);
    await wait(100);
  }
}

describe("conversation fold names people by handle", () => {
  it("the prompt and transcript use names (Owen, Owen#2), never u1 codes, and it is the same on the next fold", async () => {
    const reply = JSON.stringify({
      recap: "Owen 和 Owen#2 在聊天。",
      notes: { 話題: ["海豚"] },
      feedback: [{ by: "Owen#2", tone: "positive", quote: "好可愛" }],
    });
    const provider = new MockProvider("p").reply(reply).reply(reply);
    const r = await rig({ provider });
    const second: AccountRef = { platform: "discord", id: "300" };
    await sayLines(r, [
      [OWEN, "Owen"],
      [second, "Owen"],
    ]);
    await wait(6_000);
    const first = provider.requests()[0]?.messages[1]?.content as string;
    expect(first).toContain("Owen: 第 1 句");
    expect(first).toContain("Owen#2: 第 2 句");
    expect(ephemeralHandlesIn(first)).toEqual([]);
    expect(ephemeralHandlesIn(provider.requests()[0]?.messages[0]?.content as string)).toEqual([
      // the instructions mention the forbidden codes as examples only
      "u1",
      "p1",
    ]);

    // The handle table was persisted for every account she saw (node-wide settings).
    const rows = await r.store.list(GLOBAL_SETTINGS_PROFILE, HANDLE_PREFIX);
    expect([...rows.values()].map((v) => (v as { handle: string }).handle).sort()).toEqual([
      "Owen",
      "Owen#2",
    ]);

    // Feedback goes to the right person by handle.
    const feedback = r.events("feedback.signal")[0];
    expect(feedback).toMatchObject({ data: { account: { id: "300" }, name: "Owen" } });

    // A different order of arrival and a rename change nothing.
    await sayLines(r, [
      [second, "Renamed"],
      [OWEN, "Owen"],
    ]);
    await wait(100_000);
    const next = provider.requests()[1]?.messages[1]?.content as string;
    expect(next).toContain("Owen#2: 第 1 句");
    expect(next).toContain("Owen: 第 2 句");
  });

  it("codes the model writes into the recap or notes never reach the stored state", async () => {
    const reply = JSON.stringify({
      recap: "代號又洗牌一輪:u1=御坂,u2=Owen。u1 一直嗆 u2。u7 也在。",
      notes: {
        話題: ["u3 在抱怨", "御坂(u1)想玩 osu"],
        u4: "key with a code",
        提醒: { 對象: "u5 要提醒" },
      },
    });
    const provider = new MockProvider("p").reply(reply);
    const r = await rig({ provider });
    await sayLines(r, [
      [OWEN, "Owen"],
      [AMY, "Amy"],
    ]);
    await wait(6_000);
    const state = r.sup.services.require(ConversationStatesKey).get(TEXT);
    expect(state?.recap).toBe("代號又洗牌一輪:御坂,Owen。御坂 一直嗆 Owen。");
    expect(state?.notes).toEqual({ 話題: ["御坂想玩 osu"], 提醒: {} });
    // (the context key itself is not text she wrote: only its recap and notes are checked)
    expect(ephemeralHandlesIn(JSON.stringify([state?.recap, state?.notes]))).toEqual([]);
    const saved = (await r.store.get("p", stateKey(TEXT))) as { recap: string; notes: unknown };
    expect(ephemeralHandlesIn(JSON.stringify([saved.recap, saved.notes]))).toEqual([]);
  });

  it("an unusable recap keeps the previous one", async () => {
    const bad = JSON.stringify({ recap: "u1 u2 u3", notes: { 話題: ["海豚"] } });
    const good = JSON.stringify({ recap: "大家在聊海豚。", notes: { 話題: ["海豚"] } });
    const provider = new MockProvider("p").reply(good).reply(bad);
    const r = await rig({ provider });
    await sayLines(r, [
      [OWEN, "Owen"],
      [AMY, "Amy"],
    ]);
    await wait(6_000);
    await sayLines(r, [
      [OWEN, "Owen"],
      [AMY, "Amy"],
    ]);
    await wait(100_000);
    expect(r.sup.services.require(ConversationStatesKey).get(TEXT)?.recap).toBe("大家在聊海豚。");
  });
});

describe("a rewrite does not refresh a thread's age", () => {
  const T0 = Date.parse("2026-11-02T10:00:00.000Z");

  it("reworded threads keep the time of what they replace; only new threads are fresh", () => {
    const before = { 話題: ["討論要不要買新的麥克風"], 計畫: { Owen: "週三考數學" } };
    const touched = touchUnits(null, before, iso(T0), null);
    const prev = { notes: before, touched };
    const after = {
      話題: ["討論要不要買新的麥克風和防噴罩", "Amy 問起海豚"],
      計畫: { Owen: "週三考數學(很緊張)" },
    };
    const next = touchUnits(prev, after, iso(T0 + 60 * MIN), iso(T0));
    const units = noteUnits(after);
    const time = (i: number) => next[(units[i] as { id: string }).id];
    expect(time(0)).toBe(iso(T0)); // reworded: still old
    expect(time(1)).toBe(iso(T0 + 60 * MIN)); // new thread
    expect(time(2)).toBe(iso(T0)); // reworded
    // Unchanged text keeps its time as before.
    const same = touchUnits(prev, before, iso(T0 + 60 * MIN), iso(T0));
    expect(Object.values(same)).toEqual([iso(T0), iso(T0)]);
  });

  it("two near-identical items are matched one to one", () => {
    const before = { 清單: ["買麥克風", "買麥克風 2"] };
    const prev = { notes: before, touched: touchUnits(null, before, iso(T0), null) };
    const after = { 清單: ["買麥克風", "買麥克風 2", "買麥克風 3"] };
    const next = touchUnits(prev, after, iso(T0 + MIN), iso(T0));
    expect(Object.values(next).filter((t) => t === iso(T0))).toHaveLength(2);
    expect(Object.values(next).filter((t) => t === iso(T0 + MIN))).toHaveLength(1);
  });

  it("dropStale removes threads nobody touched for long, and empty containers", () => {
    const notes = { 話題: ["舊的", "新的"], 計畫: { Owen: "舊計畫" }, 氣氛: "還在聊" };
    const units = noteUnits(notes);
    const touched: Record<string, string> = {};
    for (const u of units) touched[u.id] = iso(T0 + 300 * MIN);
    for (const u of units) {
      if (u.text === "舊的" || u.text === "舊計畫") touched[u.id] = iso(T0);
    }
    const out = dropStale(notes, touched, iso(T0), T0 + 301 * MIN, 240 * MIN);
    expect(out.notes).toEqual({ 話題: ["新的"], 氣氛: "還在聊" });
    expect(out.dropped).toBe(2);
    expect(dropStale(notes, touched, iso(T0), T0 + 301 * MIN, 0).dropped).toBe(0);
  });

  it("similarity tells rewording from a different thread", () => {
    expect(similarity("週三考數學", "週三考數學(很緊張)")).toBeGreaterThan(0.5);
    expect(similarity("週三考數學", "Amy 問起海豚")).toBeLessThan(0.2);
    expect(similarity("", "")).toBe(1);
  });

  it("through a fold: reworded notes stay stale, so the next fold drops them after drop_thread_mins", async () => {
    const mk = (t: string) =>
      JSON.stringify({ recap: "在聊天。", notes: { 話題: [t], 氣氛: "輕鬆" } });
    const provider = new MockProvider("p")
      .reply(mk("討論要不要買新的麥克風"))
      .reply(mk("討論要不要買新的麥克風和防噴罩"));
    const r = await rig({
      provider,
      conversation: { drop_thread_mins: 120, stale_thread_mins: 30 },
    });
    const who: [AccountRef, string][] = [
      [OWEN, "Owen"],
      [AMY, "Amy"],
    ];
    await sayLines(r, who);
    await wait(6_000);
    const states = r.sup.services.require(ConversationStatesKey);
    const first = states.get(TEXT);
    const topicAt = (s: typeof first) =>
      s?.touched?.[noteUnits(s.notes as never).find((u) => u.slot === "話題[]")?.id ?? ""];
    expect(topicAt(first)).toBeTruthy();
    // Three hours later someone says one more thing; she rewrites the thread, it is not new.
    await wait(3 * 60 * MIN);
    await sayLines(r, who);
    await wait(100_000);
    const second = states.get(TEXT);
    expect(second?.folds).toBe(2);
    // ...so it is older than drop_thread_mins and the fold itself removed it.
    expect((second?.notes as { 話題?: string[] } | undefined)?.話題).toBeUndefined();
    // (the untouched mood line is just as old; only what the fold saw again would stay)
    expect(second?.notes).toEqual({});
  });
});

describe("lessons", () => {
  const lesson = (over: Partial<Lesson>): Lesson => ({
    id: over.id ?? "l1",
    text: "x",
    person: null,
    scope: null,
    talk: null,
    created_at: "2026-11-02T00:00:00.000Z",
    expires_at: null,
    source: "daily",
    ...over,
  });

  it("a style lesson never becomes a talkativeness offset; a talk lesson still does", () => {
    const store = new LessonStore(null, "p", 25);
    store.add(lesson({ id: "a", text: "別一直講同一個梗,換點新的", talk: -1 }));
    store.add(lesson({ id: "b", text: "語氣再溫柔一點", talk: -1 }));
    expect(store.talkShift(null, [])).toBe(0);
    // About how much she talks: it nudges, within the cap.
    store.add(lesson({ id: "c", text: "在這裡安靜一點", talk: -1 }));
    expect(store.talkShift(null, [])).toBeCloseTo(-0.1);
    // The owner's own lessons are taken as set.
    store.add(lesson({ id: "d", text: "自訂的備註", talk: 1, source: "panel" }));
    expect(store.talkShift(null, [])).toBeCloseTo(0);
  });

  it("refuses a lesson that only says a code and rewrites one with a definition", () => {
    const store = new LessonStore(null, "p", 25);
    expect(store.add(lesson({ id: "a", text: "u7 一直嗆我" }))).toBe(false);
    expect(store.add(lesson({ id: "b", text: "御坂(u1)不喜歡被打斷" }))).toBe(true);
    expect(store.all().map((l) => l.text)).toEqual(["御坂不喜歡被打斷"]);
  });
});
