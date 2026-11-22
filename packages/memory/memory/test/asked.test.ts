// 2026-11-22, in a busy channel: right after answering one person, in the same turn and without
// replying to anyone, she asked another person something by name. The tracker recorded the
// question as asked of the first person (the one her turn was for) and took that person's "?" to
// a different line of hers as the answer; the two people's debts got mixed up. The names here are
// made up: Nobu (the person of the turn, going by "Model-9 Lumen") and 白雪1032號 (asked by name,
// written with spaces as she wrote it).

import type { Handle, Timestamp, Whereabouts } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { type RecentConfig, RecentLog, Threads, Timeline, viewerFor } from "../src/index.js";
import { at, FakeHandles, FakeLog, guild, recentConfig } from "./recent-helpers.js";

const N = "Nobu";
const B = "白雪1032號";
const pN = "person-nobu";
const pB = "person-shirayuki";
const LOBBY = guild("lobby");

const REPLY = "抱歉抱歉,剛剛那半碗現在補給你!";
const QUESTION = "順便問一下,白雪 1032 號,你上次說要去逛市集;逛得怎麼樣,有順路去書展嗎?";

function readers(log: FakeLog, config: Partial<RecentConfig> = {}) {
  const handles = new FakeHandles()
    .add(N, pN, { platform: "discord", id: "n" })
    .add(B, pB, { platform: "discord", id: "b" });
  const cfg = recentConfig(config);
  const deps = {
    config: () => cfg,
    handles: () => handles,
    access: () => null,
    states: () => null,
    utcOffsetMinutes: 480,
  };
  const recent = new RecentLog(
    () => cfg,
    () => log,
  );
  return {
    timeline: new Timeline(recent, deps),
    threads: new Threads(
      recent,
      () => cfg,
      () => handles,
      (w, win) => viewerFor(w, win, deps),
    ),
  };
}

const where = (now: Timestamp, talking: string[]): Whereabouts => ({
  context: LOBBY,
  present: [pN, pB],
  talking_with: talking,
  now,
});

/** The turn as it went: her reply to Nobu, then her question to 白雪1032號, both "for" Nobu. */
function incident(to?: { reply: readonly Handle[]; question: readonly Handle[] }): FakeLog {
  const log = new FakeLog();
  log.say(B, "我晚點要去逛市集", at(15, 20), LOBBY);
  log.say(N, "我的半碗呢?", at(15, 50), LOBBY, { addressed: true, name: "Model-9 Lumen" });
  log.her(REPLY, at(15, 53), LOBBY, [N], to === undefined ? undefined : [...to.reply]);
  log.her(QUESTION, at(15, 53), LOBBY, [N], to === undefined ? undefined : [...to.question]);
  // Nobu's "?" replies to the first line, not to the question.
  log.say(N, "?", at(15, 54), LOBBY, { reply: { self: true, text: REPLY }, name: "Model-9 Lumen" });
  return log;
}

describe("the 2026-11-22 incident: a question by name in a turn for someone else", () => {
  for (const [label, to] of [
    ["an older line, without whom it was said to", undefined],
    ["a line recorded as said to whom it names", { reply: [N], question: [B] }],
  ] as const) {
    it(`asks it of the one it names, not of the person of the turn (${label})`, async () => {
      const r = readers(incident(to));
      const now = at(15, 55);
      expect(await r.threads.questionsTo(N, where(now, [pN]))).toEqual([]);
      const asked = await r.threads.questionsTo(B, where(now, [pB]));
      expect(asked).toHaveLength(1);
      expect(asked[0]?.answered_at).toBeNull();
      const text = await r.timeline.render(where(now, [pN, pB]), 4000);
      expect(text).not.toContain(`你問過 ${N}`);
      expect(text).toContain(`你問過 ${B}「`);
      expect(text).toContain("還沒回你");
      // What they said to her is theirs by handle, not by the nickname of the moment.
      const elsewhere = await r.timeline.render(
        { ...where(now, [pN]), context: guild("other") },
        4000,
      );
      expect(elsewhere).toContain(`${N}對你說:「我的半碗呢?」`);
      expect(elsewhere).not.toContain("Model-9 Lumen");
    });
  }

  it("asks a line said to nobody in particular of nobody, whoever the turn was for", async () => {
    const log = new FakeLog();
    log.say(N, "我的半碗呢?", at(15, 50), LOBBY, { addressed: true });
    log.her("大家晚餐都吃什麼?", at(15, 53), LOBBY, [N], []);
    const r = readers(log);
    expect(await r.threads.questionsTo(N, where(at(15, 55), [pN]))).toEqual([]);
  });

  it("takes a reply to the question, or a line said to her there, as the answer", async () => {
    const replied = incident({ reply: [N], question: [B] });
    replied.say(B, "逛了!書展人超多", at(16, 0), LOBBY, {
      reply: { self: true, text: QUESTION },
    });
    const one = await readers(replied).threads.questionsTo(B, where(at(16, 1), [pB]));
    expect(one[0]?.answered_at).toBe(at(16, 0));

    const called = incident({ reply: [N], question: [B] });
    called.say(B, "我在忙,等等跟你說", at(15, 58), LOBBY);
    called.say(B, "@她 逛了!書展人超多", at(16, 0), LOBBY, { addressed: true });
    const two = await readers(called).threads.questionsTo(B, where(at(16, 1), [pB]));
    expect(two[0]?.answered_at).toBe(at(16, 0));
  });

  it("does not take their next line to someone else, or a reply to another line, as the answer", async () => {
    const log = incident({ reply: [N], question: [B] });
    log.say(B, "等等,我先回別人", at(15, 56), LOBBY);
    log.say(B, "好喔", at(15, 57), LOBBY, { reply: { self: true, text: REPLY } });
    log.say(B, "你說什麼", at(15, 58), LOBBY, { reply: { self: false, text: "別人說的話" } });
    const asked = await readers(log).threads.questionsTo(B, where(at(16, 0), [pB]));
    expect(asked[0]?.answered_at).toBeNull();
  });
});
