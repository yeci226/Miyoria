// Stable handles in what she writes down (docs/design/v2-architecture.md §1.6): the fold's
// prompt and its notes use people's names, never `u1`; text with a code is rewritten or
// refused; a style lesson is not a talkativeness knob; and the migration repairs old rows.

import { MockProvider } from "@miyoria/llm";
import { GLOBAL_SETTINGS_PROFILE, HANDLE_PREFIX, MemorySettingsStore } from "@miyoria/store";
import {
  type AccountRef,
  ConversationStatesKey,
  ephemeralHandlesIn,
  type JsonValue,
  type Lesson,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dropStale,
  LESSON_PREFIX,
  LessonStore,
  noteUnits,
  repairEphemeralHandles,
  STATE_PREFIX,
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
    const feedback = r.events("feedback.signal")[0]?.event;
    expect(feedback).toMatchObject({ data: { payload: { account: { id: "300" }, name: "Owen" } } });

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

describe("migration of already polluted data", () => {
  const people: Record<string, string> = { "p-owen": "Owen", "p-amy": "Amy" };
  const options = (settings: MemorySettingsStore) => ({
    settings,
    profile: "p",
    handleOfPerson: (p: string) => people[p] ?? null,
  });

  async function fixture(): Promise<MemorySettingsStore> {
    const s = new MemorySettingsStore();
    const base = {
      created_at: "2026-11-02T00:00:00.000Z",
      expires_at: null,
      scope: null,
      talk: null,
    };
    const put = (id: string, text: string, person: string | null) =>
      s.set("p", `${LESSON_PREFIX}${id}`, { ...base, id, text, person, source: "daily" });
    await put("01", "u7 一直嗆我", "p-owen"); // recoverable: the lesson is about Owen
    await put("02", "u7 一直嗆我,u8 也是。要有耐心。", "p-owen"); // two codes: no guessing
    await put("03", "u9", null); // nothing left
    await put("04", "Owen 不喜歡被打斷", "p-owen"); // clean
    await put("05", "代號又洗牌一輪:u1=御坂。u1 嗆人時要冷靜", null); // defined in the text
    const state = {
      context: TEXT,
      updated_at: "2026-11-02T09:00:00.000Z",
      folded_up_to: null,
      folds: 3,
      lines: 40,
      recap: "代號又洗牌一輪:u1=御坂,u2=Owen。u1 一直嗆 u2,u4 沒說話。",
      notes: { 話題: ["u3 抱怨", "Owen 想玩 osu"], 氣氛: "輕鬆" },
    };
    await s.set("p", stateKey(TEXT), state as unknown as JsonValue);
    await s.set("p", "self:state", {
      emotions: { joy: 0.4 },
      agenda: [
        {
          id: "a1",
          text: "u7 的生日要記得",
          why: "u7 說過",
          person: "p-amy",
          status: "open",
        },
        {
          id: "a2",
          text: "提醒御坂(u1)明天有活動。早點睡。",
          why: "",
          person: null,
          status: "open",
        },
        { id: "a3", text: "學 Owen 喜歡的拉麵店", why: "想多聊", person: "p-owen", status: "open" },
      ],
    });
    return s;
  }

  it("resolves what the record itself says, drops the rest, never guesses", async () => {
    const s = await fixture();
    const report = await repairEphemeralHandles(options(s));
    expect(report).toEqual({
      lessons_fixed: 3,
      lessons_dropped: 1,
      conversations: 1,
      agenda: 2,
      errors: 0,
    });

    const lessons = await s.list("p", LESSON_PREFIX);
    const text = (id: string) =>
      (lessons.get(`${LESSON_PREFIX}${id}`) as { text: string } | undefined)?.text;
    expect(text("01")).toBe("Owen 一直嗆我"); // the one code of a lesson about Owen
    expect(text("02")).toBe("要有耐心。"); // two codes: the sentence goes
    expect(text("03")).toBeUndefined(); // only a code: the lesson goes
    expect(text("04")).toBe("Owen 不喜歡被打斷");
    expect(text("05")).toBe("代號又洗牌一輪:御坂。御坂 嗆人時要冷靜");

    const state = (await s.get("p", stateKey(TEXT))) as {
      recap: string;
      notes: unknown;
      folds: number;
      touched: Record<string, string>;
    };
    // "u4 沒說話" has a code the text does not define: its whole sentence goes, nothing is guessed.
    expect(state.recap).toBe("代號又洗牌一輪:御坂,Owen。");
    expect(state.notes).toEqual({ 話題: ["Owen 想玩 osu"], 氣氛: "輕鬆" });
    expect(state.folds).toBe(3);
    // Ages follow the surviving threads.
    expect(Object.keys(state.touched)).toHaveLength(2);

    const self = (await s.get("p", "self:state")) as {
      emotions: unknown;
      agenda: { id: string; text: string; why: string; person: string | null }[];
    };
    expect(self.emotions).toEqual({ joy: 0.4 }); // shape and other fields untouched
    expect(self.agenda.map((a) => a.text)).toEqual([
      "某人 的生日要記得", // not guessed: marked
      "提醒御坂明天有活動。早點睡。",
      "學 Owen 喜歡的拉麵店",
    ]);
    expect(self.agenda[0]?.why).toBe(""); // the reason is only a code: gone
    expect(self.agenda[0]?.person).toBe("p-amy"); // the (untrusted) person field is left alone

    for (const [key, value] of [...(await s.list("p", ""))]) {
      if (key.startsWith(STATE_PREFIX)) continue; // checked above (its context key is not text)
      expect(ephemeralHandlesIn(JSON.stringify(value)), key).toEqual([]);
    }
  });

  it("is idempotent: a second run changes nothing", async () => {
    const s = await fixture();
    await repairEphemeralHandles(options(s));
    const snapshot = JSON.stringify([...(await s.list("p", ""))]);
    const again = await repairEphemeralHandles(options(s));
    expect(again).toEqual({
      lessons_fixed: 0,
      lessons_dropped: 0,
      conversations: 0,
      agenda: 0,
      errors: 0,
    });
    expect(JSON.stringify([...(await s.list("p", ""))])).toBe(snapshot);
  });

  it("does nothing on an empty or clean store", async () => {
    const s = new MemorySettingsStore();
    await s.set("p", `${STATE_PREFIX}x`, { not: "a state" } as unknown as JsonValue);
    expect((await repairEphemeralHandles(options(s))).errors).toBe(0);
    expect(await s.get("p", "self:state")).toBeNull();
    expect(await s.get("p", `${STATE_PREFIX}x`)).toEqual({ not: "a state" });
  });
});
