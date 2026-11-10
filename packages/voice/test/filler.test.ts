// Filler (墊話): when a short sound of hers plays, which one, and how the sounds are cached.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AudioBuf } from "@miyoria/speech";
import type { ContextKey, TurnId } from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Filler, FillerBank, type FillerClip, type FillerDeps, trim } from "../src/index.js";

const ctx: ContextKey = { platform: "discord", scope: "g1", channel: "vc1", kind: "voice" };

function clip(text: string): FillerClip {
  return { text, sampleRate: 24_000, samples: new Int16Array(4800).fill(2000) };
}

/** A filler over fakes: what it played, and switches for what the voice module would know. */
function setup(texts = ["嗯?", "欸~"]) {
  const played: [TurnId, string][] = [];
  const state = { quiet: true, talking: false, stopped: false, random: 0 };
  const deps: FillerDeps = {
    now: () => Date.now(),
    afterMs: 600,
    clips: () => texts.map(clip),
    quiet: () => state.quiet,
    talking: () => state.talking,
    stopped: () => state.stopped,
    play: async (_context, turn, c) => {
      played.push([turn, c.text]);
    },
    random: () => state.random,
  };
  return { filler: new Filler(deps), played, state };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("filler", () => {
  it("plays once nothing of hers was heard for the threshold after her turn started", async () => {
    const { filler, played } = setup();
    filler.expect(ctx, "t1", Date.now());
    await vi.advanceTimersByTimeAsync(599);
    expect(played).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(played).toEqual([["t1", "嗯?"]]);
  });

  it("counts from when the turn started, not from when it was expected", async () => {
    const { filler, played } = setup();
    filler.expect(ctx, "t1", Date.now() - 500);
    await vi.advanceTimersByTimeAsync(100);
    expect(played).toHaveLength(1);
  });

  it("is skipped when her line is on its way, she speaks, somebody talks or she was stopped", async () => {
    const { filler, played, state } = setup();
    for (const flip of ["quiet", "talking", "stopped"] as const) {
      state.quiet = flip !== "quiet";
      state.talking = flip === "talking";
      state.stopped = flip === "stopped";
      filler.expect(ctx, `t-${flip}`, Date.now());
      await vi.advanceTimersByTimeAsync(600);
    }
    expect(played).toEqual([]);
  });

  it("is never played for a turn that ended or will say nothing", async () => {
    const { filler, played } = setup();
    filler.expect(ctx, "t1", Date.now());
    await vi.advanceTimersByTimeAsync(300);
    filler.settle("t1");
    await vi.advanceTimersByTimeAsync(1000);
    expect(played).toEqual([]);
  });

  it("never repeats the same sound back to back", async () => {
    const { filler, played } = setup();
    for (const turn of ["t1", "t2", "t3"]) {
      filler.expect(ctx, turn, Date.now());
      await vi.advanceTimersByTimeAsync(600);
    }
    expect(played.map(([, text]) => text)).toEqual(["嗯?", "欸~", "嗯?"]);
  });

  it("with one sound only, it plays every other time rather than twice in a row", async () => {
    const { filler, played } = setup(["嗯?"]);
    for (const turn of ["t1", "t2", "t3"]) {
      filler.expect(ctx, turn, Date.now());
      await vi.advanceTimersByTimeAsync(600);
    }
    expect(played.map(([turn]) => turn)).toEqual(["t1", "t3"]);
  });

  it("asks for the sounds to be made on the first expectation, and has none until then", async () => {
    let loads = 0;
    const filler = new Filler({
      load: () => loads++,
      now: () => Date.now(),
      afterMs: 600,
      clips: () => [],
      quiet: () => true,
      talking: () => false,
      stopped: () => false,
      play: async () => {
        throw new Error("nothing to play");
      },
      random: () => 0,
    });
    filler.expect(ctx, "t1", Date.now());
    await vi.advanceTimersByTimeAsync(600);
    expect(loads).toBe(1);
  });
});

describe("filler sounds", () => {
  function bank(dir: string, synth: (text: string) => AudioBuf, warn: string[] = []) {
    const calls: string[] = [];
    const b = new FillerBank({
      dir,
      voice: "deepseek-chan",
      language: "Chinese",
      lines: ["嗯?", "欸~"],
      maxMs: 1500,
      synthesize: async (text) => {
        calls.push(text);
        return synth(text);
      },
      warn: (m) => warn.push(m),
    });
    return { b, calls };
  }

  const sound = (): AudioBuf => {
    const samples = new Int16Array(24_000);
    samples.fill(3000, 4_800, 12_000); // 0.2 s of quiet, 0.3 s of her, 0.5 s of quiet
    return { sampleRate: 24_000, samples };
  };

  it("are synthesized once per voice, then read from disk", async () => {
    vi.useRealTimers();
    const dir = mkdtempSync(join(tmpdir(), "miyoria-fillers-"));
    const first = bank(dir, sound);
    expect(await first.b.load(new AbortController().signal)).toBe(0);
    expect(first.calls).toEqual(["嗯?", "欸~"]);
    // Trimmed of the silence around it (with a margin of 30 ms on each side).
    expect(first.b.clips()[0]?.samples.length).toBe(7_200 + 2 * 720);
    const again = bank(dir, sound);
    expect(await again.b.load(new AbortController().signal)).toBe(0);
    expect(again.calls).toEqual([]);
    expect(again.b.clips().map((c) => c.text)).toEqual(["嗯?", "欸~"]);
  });

  it("a failed synthesis is tried again on the next load; a sound that is too long is not used", async () => {
    vi.useRealTimers();
    const dir = mkdtempSync(join(tmpdir(), "miyoria-fillers-"));
    let fail = true;
    const warn: string[] = [];
    const { b, calls } = bank(
      dir,
      (text) => {
        if (fail) throw new Error("TTS is down");
        if (text === "欸~")
          return { sampleRate: 24_000, samples: new Int16Array(48_000).fill(3000) };
        return sound();
      },
      warn,
    );
    expect(await b.load(new AbortController().signal)).toBe(2);
    fail = false;
    expect(await b.load(new AbortController().signal)).toBe(0);
    expect(b.clips().map((c) => c.text)).toEqual(["嗯?"]);
    expect(warn.some((w) => w.includes("2000 ms long"))).toBe(true);
    // The long one is not asked for again in this run.
    await b.load(new AbortController().signal);
    expect(calls.filter((c) => c === "欸~")).toHaveLength(2);
  });

  it("trim keeps nothing of a silent clip", () => {
    expect(trim({ sampleRate: 16_000, samples: new Int16Array(1600) }).samples.length).toBe(0);
  });
});
