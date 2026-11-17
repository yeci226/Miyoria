// The history line: a versioned record that is the same shape the API reads it with, and the
// rebuild of `history.jsonl` from the run files.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
// The API's schema of the same line. This package does not depend on the contracts package, so
// the file is read by its path, here only.
import { EvalLiveRunSchema } from "../../../packages/contracts/events/src/eval.js";
import { liveMain } from "../src/live/cli.js";
import {
  HISTORY_FILE,
  type HistoryLine,
  HistoryLineSchema,
  historyLine,
  type LiveRun,
  rebuildHistory,
  writeRun,
} from "../src/live/run.js";
import { NO_USAGE } from "../src/live/subject.js";

const temp: string[] = [];
function tempDir(): string {
  mkdirSync(tmpdir(), { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "live-history-"));
  temp.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of temp) rmSync(dir, { recursive: true, force: true });
});

const run = (over: Partial<LiveRun> = {}): LiveRun => ({
  at: "2026-11-16T04:30:00.000Z",
  commit: "0d611db5",
  subject: "current",
  seed: "s",
  repeat: 3,
  suites: [
    {
      suite: "persona",
      headline: { score: 0.9, low_share: 0.1 },
      items: [{}, {}, {}],
      unsupported: [{ id: "voice-1", reason: "no voice" }],
    },
    { suite: "tools", headline: { success: null }, items: [], unsupported: [], stopped: "budget" },
    { suite: "memory", headline: {}, items: [], unsupported: [], skipped: "no runner" },
  ],
  usage: { ...NO_USAGE, calls: 7, prompt_tokens: 900, completion_tokens: 80 },
  models: { "b:flash": { ...NO_USAGE, calls: 7 }, "a:pro": { ...NO_USAGE } },
  usd: 0.0123,
  unpriced: [],
  duration_ms: 61_000,
  stopped: "budget",
  ...over,
});

describe("the history line", () => {
  it("is a versioned record with the counts, the cost and the chain", () => {
    expect(historyLine(run({ chain: ["a:pro", "b:flash"] }))).toEqual({
      v: 1,
      at: "2026-11-16T04:30:00.000Z",
      commit: "0d611db5",
      subject: "current",
      repeat: 3,
      suites: {
        persona: {
          headline: { score: 0.9, low_share: 0.1 },
          items: 3,
          unsupported: 1,
          stopped: false,
        },
        tools: { headline: { success: null }, items: 0, unsupported: 0, stopped: true },
      },
      tokens: { ...NO_USAGE, calls: 7, prompt_tokens: 900, completion_tokens: 80 },
      usd: 0.0123,
      duration_ms: 61_000,
      models: ["a:pro", "b:flash"],
      stopped: "budget",
    });
  });

  it("is the JSON Schema the contracts package gives the same line", () => {
    // The contract names its shapes (`id`, referred to by `$ref`) and the local copy does not:
    // compared with every reference replaced by what it names.
    const shape = (schema: z.ZodType) => {
      const { $defs, ...top } = z.toJSONSchema(schema) as Record<string, unknown>;
      const defs = ($defs ?? {}) as Record<string, unknown>;
      const flat = (v: unknown): unknown => {
        if (Array.isArray(v)) return v.map(flat);
        if (v === null || typeof v !== "object") return v;
        const o = v as Record<string, unknown>;
        if (typeof o.$ref === "string") return flat(defs[o.$ref.replace("#/$defs/", "")]);
        return Object.fromEntries(
          Object.entries(o)
            .filter(([k]) => !["id", "$id", "$schema"].includes(k))
            .map(([k, x]) => [k, flat(x)]),
        );
      };
      return flat(top);
    };
    expect(shape(HistoryLineSchema)).toEqual(shape(EvalLiveRunSchema));
  });

  it("every line it writes passes the contract, and one without a version does not", () => {
    for (const r of [run(), run({ unpriced: ["a:pro"], commit: null }), run({ suites: [] })]) {
      const line: HistoryLine = JSON.parse(JSON.stringify(historyLine(r)));
      expect(EvalLiveRunSchema.safeParse(line).success).toBe(true);
    }
    const { v: _, ...old } = historyLine(run());
    expect(EvalLiveRunSchema.safeParse(old).success).toBe(false);
    expect(EvalLiveRunSchema.safeParse({ ...old, v: 2 }).success).toBe(false);
  });
});

describe("rebuilding the history from the run files", () => {
  it("writes one line per run file, oldest first, and leaves out what is not a run", async () => {
    const dir = tempDir();
    writeRun(run({ at: "2026-11-17T04:30:00.000Z" }), dir);
    writeRun(run({ at: "2026-11-16T04:30:00.000Z", subject: "next" }), dir);
    writeFileSync(join(dir, "notes.json"), '{"hello": 1}');
    // The lines of before the record had a version.
    writeFileSync(join(dir, HISTORY_FILE), '{"at":"2026-11-16T04:30:00.000Z","suites":{}}\n');

    expect(rebuildHistory(dir)).toEqual({ runs: 2, skipped: ["notes.json"] });
    const lines = readFileSync(join(dir, HISTORY_FILE), "utf8")
      .trim()
      .split("\n")
      .map((l) => EvalLiveRunSchema.parse(JSON.parse(l)));
    expect(lines.map((l) => [l.at, l.subject])).toEqual([
      ["2026-11-16T04:30:00.000Z", "next"],
      ["2026-11-17T04:30:00.000Z", "current"],
    ]);
    // A run file that never recorded the chain: the models that answered.
    expect(lines[0]?.models).toEqual(["a:pro", "b:flash"]);
  });

  it("is `--rebuild-history` of the live CLI, which needs no config", async () => {
    const dir = tempDir();
    writeRun(run(), dir);
    const said: string[] = [];
    const code = await liveMain(["--rebuild-history", "--out", dir], {
      out: (t) => said.push(t),
      err: (t) => said.push(t),
    });
    expect(code).toBe(0);
    expect(said.join("")).toContain("1 runs written");
    expect(
      await liveMain(["--rebuild-history", "--out", join(dir, "missing")], { err: () => {} }),
    ).toBe(2);
  });
});
