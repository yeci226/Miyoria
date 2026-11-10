// The committed scenarios reproduce the §1.9 problems from real logs and assert the §4
// acceptance targets on the real pipeline (agent, gate, Arbiter, ActivityManager, world, self,
// mind) with a scripted LLM.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pipeline } from "@miyoria/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildReport,
  formatReport,
  parseReplayLog,
  type ReplayClock,
  type ReplayLog,
  type ReplayReport,
  replay,
} from "../src/index.js";

const clock: ReplayClock = {
  setNow: (ms) => {
    vi.useFakeTimers();
    vi.setSystemTime(ms);
  },
  advance: async (ms) => {
    await vi.advanceTimersByTimeAsync(ms);
  },
};

afterEach(() => {
  vi.useRealTimers();
});

async function run(
  fixture: string,
  pipeline: Pipeline,
  change: (log: ReplayLog) => void = () => undefined,
): Promise<ReplayReport> {
  const text = readFileSync(join(import.meta.dirname, "fixtures", fixture), "utf8");
  const log = parseReplayLog(text);
  change(log);
  const report = buildReport(await replay(log, { clock, pipeline }));
  if (process.env.MIYORIA_REPLAY_PRINT) process.stdout.write(`${formatReport(report)}\n`);
  return report;
}

describe.each(["v2", "v3"] as const)("replay scenarios (v2 §4 acceptance), %s", (pipeline) => {
  it("a voice room full of 「對」「嗯」: she speaks when called (> 70%), to the caller", async () => {
    const r = await run("voice-backchannel.jsonl", pipeline);
    expect(r.voice_direct_speak_rate.den).toBe(8);
    expect(r.voice_direct_speak_rate.rate ?? 0).toBeGreaterThan(0.7);
    expect(r.focus_correct_rate.rate).toBe(1);
    // Backchannels never cancel her turn.
    expect(r.cancelled_by.input ?? 0).toBe(0);
  });

  it("「@Miyoria 你可以打osu嗎」 then five interjections: answered, quoting the asker", async () => {
    const r = await run("text-mention-drowned.jsonl", pipeline);
    expect(r.text_direct_reply_rate).toMatchObject({ num: 3, den: 3 });
    expect(r.focus_correct_rate).toMatchObject({ num: 3, den: 3 });
    expect(r.cancelled_by.input ?? 0).toBe(0);
  });

  it("announcements nobody answered are not her topics: her own plans are not blocked", async () => {
    const r = await run("announcements-not-her-topics.jsonl", pipeline, (log) => {
      // Under V3 a plan the scripted reply already said word for word is held as a repeat (§8:
      // text similarity is the second line of defence), which is not what this scenario is about.
      if (pipeline === "v3" && log.meta.llm)
        log.meta.llm.replies = ["今天過得怎樣", "開始囉", "結束"];
    });
    expect(r.arbiter.self_initiated_block_rate.den).toBe(4);
    expect(r.arbiter.self_initiated_block_rate.rate ?? 1).toBeLessThan(0.2);
    // The eight announcements were said and nobody answered them: none counts as her topic.
    expect(r.arbiter.by_verdict.accepted).toBe(12);
    expect(r.arbiter.topics_ignored).toBe(0);
    expect(r.activity.residual).toEqual([]);
  });
});

describe("the main line under V3", () => {
  const fixtures = readdirSync(join(import.meta.dirname, "fixtures")).filter((f) =>
    f.endsWith(".jsonl"),
  );

  it.each(fixtures)("%s: every line that went out is one of the main line's", async (fixture) => {
    const text = readFileSync(join(import.meta.dirname, "fixtures", fixture), "utf8");
    const r = await replay(parseReplayLog(text), { clock, pipeline: "v3" });
    const lines = [...r.sink.speeches(), ...r.sink.messages()];
    for (const { action } of lines) expect(r.mouth?.owns(action.turn)).toBe(true);
  });

  it("she says the same plan again only if it is news: the repeat is held, not lost", async () => {
    const r = await run("announcements-not-her-topics.jsonl", "v3");
    expect(r.arbiter.blocked_by_reason.repeat).toBeGreaterThan(0);
    expect(r.arbiter.blocked_by_reason.unanswered ?? 0).toBe(0);
    expect(r.arbiter.topics_ignored).toBe(0);
  });
});
