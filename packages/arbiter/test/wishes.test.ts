// One wish, asked once (wishes.ts): 2026-11-10, the same question to S ten times in 100 minutes.
// The book on a real EventLog: what makes a wish asked, answered or closed, what `screen` says
// before something raises it again, and that a restart keeps it.

import { EventLogService } from "@miyoria/facts";
import {
  type AskedLookup,
  type ContextKey,
  type HandleDirectory,
  type PersonThreads,
  toTimestamp,
  WISH_SOURCE,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { WishBook } from "../src/index.js";
import { T0 } from "./helpers.js";

const HOUR = 3_600_000;

const C: ContextKey = { platform: "discord", scope: "g", channel: "c", kind: "channel" };
const DM: ContextKey = { platform: "discord", scope: null, channel: "dm", kind: "dm" };
const CONFIG = { followup_hours: 12, keep_hours: 48 };

async function rig(threads: PersonThreads | null = null) {
  let now = T0;
  const log = new EventLogService({ profile: "p", store: null, clock: { now: () => now } });
  const handles = {
    resolve: (h: string) => (h === "S" ? { handle: "S", person: "person-s" } : null),
  } as unknown as HandleDirectory;
  const make = () =>
    new WishBook(CONFIG, {
      now: () => now,
      log: () => log,
      threads: () => threads,
      handles: () => handles,
    });
  const book = make();
  await log.project(book);
  return {
    log,
    book,
    make,
    advance: (ms: number) => {
      now += ms;
    },
    /** S says `text` in `context`. */
    says: (text: string, context: ContextKey = C) =>
      log.observe(
        {
          source: "platform.test",
          silent: false,
          salience: "notable",
          attention_key: `msg:${now}`,
          revision: 1,
          summary: `S:${text}`,
          addressed_to_her: true,
          from: "S",
          context,
        },
        { speech: true },
      ),
    /** The hands sent S a DM. */
    dm: (text: string) => {
      log.append({
        kind: "action",
        source: "mainline.hands",
        body: { turn: "t", call: `call-${now}`, tool: "message_dm", args: { to: "S", text } },
      });
      log.append({
        kind: "result",
        source: "mainline.hands",
        body: { turn: "t", call: `call-${now}`, tool: "message_dm", state: "done", detail: "" },
      });
    },
  };
}

describe("one wish, one key", () => {
  it("a proposal, two promises and a goal about the same thing hold one wish", async () => {
    const r = await rig();
    const a = r.book.hold("S", "問 S 期末報告的結果(答應過的)", "proposal:p1");
    r.book.hold("S", "11:02 之後問 S 期末報告的結果", "commitment:c1");
    r.book.hold("S", "S 上線時問期末報告", "commitment:c2");
    r.book.hold("S", "S 說話時接話,順便問期末報告", "goal:g1");
    const other = r.book.hold("S", "問 S 生日想要什麼", "goal:g2");
    for (const h of ["commitment:c1", "commitment:c2", "goal:g1"]) {
      expect(r.book.of(h)?.key).toBe(a?.key);
    }
    expect(other?.key).not.toBe(a?.key);
    expect(r.book.hold(null, "問大家晚餐", "proposal:p3")).toBeNull();
  });

  it("a DM to them about it is asking; what they say after is the answer, anywhere", async () => {
    const r = await rig();
    const wish = r.book.hold("S", "問 S 期末報告的結果", "commitment:c1");
    r.says("早安");
    expect(r.book.of("commitment:c1")?.state).toBe("open");
    r.advance(HOUR);
    r.dm("S~期末報告的結果出來了嗎?");
    expect(r.book.of("commitment:c1")).toMatchObject({ state: "asked", asked: 1 });
    r.advance(15 * 60_000);
    r.says("還不錯,拿了 A", DM);
    await Promise.resolve();
    expect(r.book.of("commitment:c1")).toMatchObject({ state: "closed", end: "answered" });
    const written = r.log.recent(50).filter((e) => e.source === WISH_SOURCE);
    expect(written.at(-1)?.body).toMatchObject({ wish: { key: wish?.key, state: "closed" } });
  });

  it("'you asked me already' closes every wish about them for good", async () => {
    const r = await rig();
    r.book.hold("S", "問 S 期末報告的結果", "goal:g1");
    r.book.hold("S", "問 S 生日想要什麼", "goal:g2");
    r.says("你已經在私訊問過我了");
    expect(r.book.of("goal:g1")).toMatchObject({ state: "closed", end: "stop" });
    expect(r.book.of("goal:g2")).toMatchObject({ state: "closed", end: "stop" });
  });

  it("a restart keeps it: the book is rebuilt from the log", async () => {
    const r = await rig();
    r.book.hold("S", "問 S 期末報告的結果", "commitment:c1");
    r.book.close(r.book.of("commitment:c1")?.key ?? "", "answered");
    await Promise.resolve();
    const again = r.make();
    await r.log.project(again, { since: toTimestamp(T0 - HOUR) });
    expect(again.of("commitment:c1")).toMatchObject({ state: "closed", end: "answered" });
  });
});

describe("before something raises it again", () => {
  it("open: yes. Answered: never. Asked and unanswered: one follow-up, after the gap", async () => {
    const r = await rig();
    const key = r.book.hold("S", "問 S 期末報告的結果", "commitment:c1")?.key ?? "";
    const screen = () => r.book.screen({ person: "S", text: "問 S 期末報告", holder: null });
    expect((await screen()).raise).toBe(true);
    r.book.asked(key);
    const soon = await screen();
    expect(soon).toMatchObject({ raise: false });
    expect(soon.raise ? null : soon.until).toBe(toTimestamp(T0 + 12 * HOUR));
    r.advance(12 * HOUR);
    expect((await screen()).raise).toBe(true);
    r.book.asked(key);
    r.advance(24 * HOUR);
    const twice = await screen();
    expect(twice.raise ? null : twice.until).toBeNull();
    r.book.close(key, "answered");
    const answered = await screen();
    expect(answered.raise ? "" : answered.why).toContain("回答過了");
  });

  it("what the memory saw counts: asked in another place, or answered there", async () => {
    let lookup: AskedLookup | null = {
      key: "ask:S:e1",
      times: 2,
      last_asked_at: toTimestamp(T0 - 60_000),
      answered_at: null,
      private: true,
    };
    const threads = { asked: async () => lookup, thread: async () => null } as PersonThreads;
    const r = await rig(threads);
    r.book.hold("S", "問 S 期末報告的結果", "proposal:p1");
    const asked = await r.book.screen({ person: "S", text: "期末報告", holder: "proposal:p1" });
    expect(asked.raise).toBe(false);
    expect(r.book.of("proposal:p1")).toMatchObject({ state: "asked", asked: 2 });
    lookup = { ...lookup, answered_at: toTimestamp(T0) };
    await r.book.screen({ person: "S", text: "期末報告", holder: "proposal:p1" });
    expect(r.book.of("proposal:p1")).toMatchObject({ state: "closed", end: "answered" });
  });
});
