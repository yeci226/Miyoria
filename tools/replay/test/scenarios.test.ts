// The committed scenarios reproduce the §1.9 problems from real logs and assert the §4
// acceptance targets on the real pipeline (agent, gate, Arbiter, ActivityManager, world, self,
// mind) with a scripted LLM.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseReplayLog, type ReplayLog } from "@miyoria/runtime/replay-log";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildReport,
  formatReport,
  type ReplayClock,
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
  change: (log: ReplayLog) => void = () => undefined,
): Promise<ReplayReport> {
  const text = readFileSync(join(import.meta.dirname, "fixtures", fixture), "utf8");
  const log = parseReplayLog(text);
  change(log);
  const report = buildReport(await replay(log, { clock }));
  if (process.env.MIYORIA_REPLAY_PRINT) process.stdout.write(`${formatReport(report)}\n`);
  return report;
}

describe("replay scenarios (v2 §4 acceptance)", () => {
  it("a voice room full of 「對」「嗯」: she speaks when called (> 70%), to the caller", async () => {
    const r = await run("voice-backchannel.jsonl");
    expect(r.voice_direct_speak_rate.den).toBe(8);
    expect(r.voice_direct_speak_rate.rate ?? 0).toBeGreaterThan(0.7);
    expect(r.focus_correct_rate.rate).toBe(1);
    // Backchannels never cancel her turn.
    expect(r.cancelled_by.input ?? 0).toBe(0);
  });

  it("「@Miyoria 你可以打osu嗎」 then five interjections: answered, quoting the asker", async () => {
    const r = await run("text-mention-drowned.jsonl");
    expect(r.text_direct_reply_rate).toMatchObject({ num: 3, den: 3 });
    expect(r.focus_correct_rate).toMatchObject({ num: 3, den: 3 });
    expect(r.cancelled_by.input ?? 0).toBe(0);
  });

  it("announcements nobody answered are not her topics", async () => {
    const r = await run("announcements-not-her-topics.jsonl");
    // The eight announcements were said and nobody answered them: none counts as her topic. Her
    // own plans in the log are the new runner's and refused here; its initiative, which runs in
    // the pipeline too, records the one start of hers it made as accepted.
    expect(r.arbiter.by_verdict.accepted).toBe(9);
    expect(r.turns.filter((t) => t.reason === "initiative" && t.outcome === "sent")).toHaveLength(
      9,
    );
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
    const r = await replay(parseReplayLog(text), { clock });
    const lines = [...r.sink.speeches(), ...r.sink.messages()];
    for (const { action } of lines) expect(r.mouth?.owns(action.turn)).toBe(true);
  });
});
