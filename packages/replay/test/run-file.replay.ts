// `pnpm replay <file>` runs this file (vitest.replay.config.ts) so the replay gets Vitest's fake
// timers: the log in `MIYORIA_REPLAY_FILE` is replayed and the report is written to
// `MIYORIA_REPLAY_OUT` (`.txt` text and `.json`).

import { readFileSync, writeFileSync } from "node:fs";
import { it, vi } from "vitest";
import { buildReport, formatReport, parseReplayLog, replay } from "../src/index.js";

it("replays the log", async () => {
  const file = process.env.MIYORIA_REPLAY_FILE;
  const out = process.env.MIYORIA_REPLAY_OUT;
  if (!file || !out) throw new Error("MIYORIA_REPLAY_FILE and MIYORIA_REPLAY_OUT must be set");
  const seed = Number(process.env.MIYORIA_REPLAY_SEED ?? "1");
  try {
    const run = await replay(parseReplayLog(readFileSync(file, "utf8")), {
      pipeline: process.env.MIYORIA_PIPELINE === "v2" ? "v2" : "v3",
      seed: Number.isFinite(seed) ? seed : 1,
      clock: {
        setNow: (ms) => {
          vi.useFakeTimers();
          vi.setSystemTime(ms);
        },
        advance: async (ms) => {
          await vi.advanceTimersByTimeAsync(ms);
        },
      },
    });
    const report = buildReport(run);
    writeFileSync(`${out}.json`, `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(`${out}.txt`, `${formatReport(report)}\n`);
  } finally {
    vi.useRealTimers();
  }
});
