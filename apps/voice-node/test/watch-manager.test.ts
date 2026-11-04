import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CapturePipeline } from "../src/capture.js";
import {
  type WatchEngine,
  type WatchEvent,
  type WatchHooks,
  type WatchHost,
  WatchManager,
  type WatchPlan,
} from "../src/watch/manager.js";
import { keyframeToJpeg } from "../src/watch/snapshot.js";

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

interface Run {
  plan: WatchPlan;
  hooks: WatchHooks;
  signal: AbortSignal;
  end(reason: string): void;
  fail(e: Error): void;
}

interface SetupOver {
  goLive?: boolean;
  toJpeg?: (h: Buffer, s: AbortSignal) => Promise<Buffer>;
  pipeline?: () => CapturePipeline;
  attach?: WatchHost["attach"];
  holdEngine?: boolean;
}

function setup(over: SetupOver = {}) {
  const runs: Run[] = [];
  const events: WatchEvent[] = [];
  const done: Array<[number, Buffer]> = [];
  const failed: Array<[number, string]> = [];
  const audio: Buffer[] = [];
  const requestKeyframe = vi.fn();
  const engine: WatchEngine = {
    run: (plan, hooks, signal) =>
      new Promise<string>((resolve, reject) => {
        runs.push({ plan, hooks, signal, end: resolve, fail: reject });
        if (!over.holdEngine) signal.addEventListener("abort", () => resolve("aborted"), { once: true });
      }),
    requestKeyframe,
  };
  const host: WatchHost = {
    attach: over.attach ?? (async (guild, userId) => ({ guild, channel: "vc", userId, sessionId: "s" })),
    goLiveActive: () => over.goLive ?? false,
  };
  const toJpeg = vi.fn(over.toJpeg ?? (async (h: Buffer) => Buffer.concat([Buffer.from("J:"), h])));
  const dispose = vi.fn();
  const pipeline = vi.fn(
    over.pipeline ??
      (() => ({ push: (p: Buffer) => [Buffer.from(`pcm:${p.toString()}`)], dispose }) as unknown as CapturePipeline),
  );
  const m = new WatchManager({
    engine,
    host,
    emit: (e) => events.push(e),
    snapshotDone: (id, j) => done.push([id, j]),
    snapshotFailed: (id, e) => failed.push([id, e]),
    audio: (f) => audio.push(f),
    toJpeg,
    pipeline,
    attemptMs: 1600,
  });
  return { m, runs, events, done, failed, audio, requestKeyframe, toJpeg, pipeline, dispose };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("WatchManager lifecycle", () => {
  it("start_goes_live_on_the_first_decrypted_media", async () => {
    const t = setup();
    t.m.start({ guild: "g", user_id: "u" });
    expect(t.events).toEqual([{ guild: "g", userId: "u", state: "starting" }]);
    await flush();
    expect(t.runs[0]?.plan).toMatchObject({ guild: "g", userId: "u" });
    t.runs[0]?.hooks.onLive();
    t.runs[0]?.hooks.onLive();
    expect(t.events.map((e) => e.state)).toEqual(["starting", "live"]);
    expect(t.m.activeGuild).toBe("g");
  });

  it("refuses_while_go_live_is_active", async () => {
    const t = setup({ goLive: true });
    t.m.start({ guild: "g", user_id: "u" });
    await flush();
    expect(t.runs).toHaveLength(0);
    expect(t.events).toHaveLength(1);
    expect(t.events[0]).toMatchObject({ guild: "g", userId: "u", state: "failed" });
    expect(t.events[0]?.error).toBeTruthy();
    expect(t.m.activeGuild).toBeUndefined();
  });

  it("engine_failure_becomes_failed", async () => {
    const t = setup();
    t.m.start({ guild: "g", user_id: "u" });
    await flush();
    t.runs[0]?.fail(new Error("boom"));
    await flush();
    expect(t.events.at(-1)).toEqual({ guild: "g", userId: "u", state: "failed", error: "boom" });
    expect(t.m.activeGuild).toBeUndefined();
  });

  it("engine_end_becomes_stopped", async () => {
    const t = setup();
    t.m.start({ guild: "g", user_id: "u" });
    await flush();
    t.runs[0]?.end("stream ended");
    await flush();
    expect(t.events.at(-1)).toEqual({ guild: "g", userId: "u", state: "stopped", reason: "stream ended" });
  });

  it("stop_uses_the_given_reason_and_ignores_other_guilds", async () => {
    const t = setup();
    t.m.stop("g", "nothing");
    expect(t.events).toEqual([]);
    t.m.start({ guild: "g", user_id: "u" });
    await flush();
    t.m.stop("other", "nope");
    expect(t.runs[0]?.signal.aborted).toBe(false);
    t.m.stop("g", "user asked");
    await flush();
    expect(t.events.at(-1)).toEqual({ guild: "g", userId: "u", state: "stopped", reason: "user asked" });
    expect(t.events.filter((e) => e.state === "stopped")).toHaveLength(1);
  });

  it("switching_stops_the_old_one_first", async () => {
    const t = setup();
    t.m.start({ guild: "g", user_id: "u1" });
    await flush();
    t.m.start({ guild: "g", user_id: "u2" });
    expect(t.runs[0]?.signal.aborted).toBe(true);
    await flush();
    expect(t.events.map((e) => [e.userId, e.state])).toEqual([
      ["u1", "starting"],
      ["u1", "stopped"],
      ["u2", "starting"],
    ]);
    expect(t.runs).toHaveLength(2);
    expect(t.runs[1]?.plan.userId).toBe("u2");
    expect(t.pipeline).toHaveBeenCalledTimes(2);
  });

  it("same_target_only_repeats_state", async () => {
    const t = setup();
    t.m.start({ guild: "g", user_id: "u" });
    await flush();
    t.m.start({ guild: "g", user_id: "u" });
    await flush();
    expect(t.runs).toHaveLength(1);
    expect(t.events.map((e) => e.state)).toEqual(["starting", "starting"]);
  });

  it("stopAll_waits_for_teardown", async () => {
    const t = setup();
    t.m.start({ guild: "g", user_id: "u" });
    await flush();
    await t.m.stopAll("shutdown");
    expect(t.events.at(-1)).toMatchObject({ state: "stopped", reason: "shutdown" });
    expect(t.m.activeGuild).toBeUndefined();
  });

  it("audio_frames_are_forwarded", async () => {
    const t = setup();
    t.m.start({ guild: "g", user_id: "u" });
    await flush();
    t.runs[0]?.hooks.onOpus(Buffer.from("a"));
    expect(t.audio.map((b) => b.toString())).toEqual(["pcm:a"]);
  });

  it("hook_errors_do_not_escape", async () => {
    const t = setup({
      toJpeg: async () => {
        throw new Error("ffmpeg gone");
      },
      pipeline: () =>
        ({
          push: () => {
            throw new Error("decode");
          },
        }) as unknown as CapturePipeline,
    });
    t.m.start({ guild: "g", user_id: "u" });
    await flush();
    expect(() => t.runs[0]?.hooks.onOpus(Buffer.from("a"))).not.toThrow();
    t.m.snapshot(1);
    expect(() => t.runs[0]?.hooks.onKeyframe(Buffer.from("k"))).not.toThrow();
    await flush();
    expect(t.runs[0]?.signal.aborted).toBe(false);
    expect(t.audio).toHaveLength(0);
  });
});

describe("WatchManager teardown", () => {
  it("start_after_stop_for_the_same_target_restarts", async () => {
    const t = setup({ holdEngine: true });
    t.m.start({ guild: "g", user_id: "u" });
    await flush();
    t.runs[0]?.hooks.onLive();
    t.m.stop("g", "bye");
    t.m.start({ guild: "g", user_id: "u" });
    expect(t.events.map((e) => e.state)).toEqual(["starting", "live"]);
    t.runs[0]?.end("done");
    await flush();
    expect(t.events.map((e) => e.state)).toEqual(["starting", "live", "stopped", "starting"]);
    expect(t.runs).toHaveLength(2);
  });

  it("stop_fails_pending_snapshots_and_kills_conversion_at_once", async () => {
    let sig: AbortSignal | undefined;
    const t = setup({
      holdEngine: true,
      toJpeg: (_h, s) => {
        sig = s;
        return new Promise<Buffer>(() => {});
      },
    });
    t.m.start({ guild: "g", user_id: "u" });
    await flush();
    t.m.snapshot(1);
    t.runs[0]?.hooks.onKeyframe(Buffer.from("k"));
    t.m.snapshot(2);
    t.m.stop("g", "bye");
    expect(t.failed).toEqual([
      [1, "watch ended"],
      [2, "watch ended"],
    ]);
    expect(sig?.aborted).toBe(true);
  });

  it("disposes_one_pipeline_per_job", async () => {
    const t = setup();
    t.m.start({ guild: "g", user_id: "u1" });
    await flush();
    t.m.start({ guild: "g", user_id: "u2" });
    await flush();
    expect(t.dispose).toHaveBeenCalledTimes(1);
    t.runs[1]?.end("over");
    await flush();
    expect(t.dispose).toHaveBeenCalledTimes(2);
  });

  it("disposes_the_pipeline_when_attach_fails", async () => {
    const t = setup({
      attach: async () => {
        throw new Error("no voice");
      },
    });
    t.m.start({ guild: "g", user_id: "u" });
    await flush();
    expect(t.events.at(-1)).toMatchObject({ state: "failed", error: "no voice" });
    expect(t.dispose).toHaveBeenCalledTimes(1);
  });
});

describe("WatchManager snapshots", () => {
  async function watching(over: SetupOver = {}) {
    const t = setup(over);
    t.m.start({ guild: "g", user_id: "u" });
    await flush();
    return t;
  }

  it("snapshot_asks_for_a_keyframe_and_returns_jpeg", async () => {
    const t = await watching();
    t.m.snapshot(7);
    expect(t.requestKeyframe).toHaveBeenCalledTimes(1);
    t.runs[0]?.hooks.onKeyframe(Buffer.from("k"));
    await flush();
    expect(t.done).toEqual([[7, Buffer.from("J:k")]]);
    expect(t.failed).toEqual([]);
    vi.advanceTimersByTime(10_000);
    expect(t.requestKeyframe).toHaveBeenCalledTimes(1);
  });

  it("keyframes_without_a_pending_snapshot_are_ignored", async () => {
    const t = await watching();
    t.runs[0]?.hooks.onKeyframe(Buffer.from("k"));
    await flush();
    expect(t.toJpeg).not.toHaveBeenCalled();
  });

  it("overlapping_snapshots_share_the_next_keyframe", async () => {
    const t = await watching();
    t.m.snapshot(1);
    t.m.snapshot(2);
    expect(t.requestKeyframe).toHaveBeenCalledTimes(1);
    t.runs[0]?.hooks.onKeyframe(Buffer.from("k"));
    await flush();
    expect(t.done.map(([id]) => id).sort()).toEqual([1, 2]);
    expect(t.toJpeg).toHaveBeenCalledTimes(1);
  });

  it("snapshot_retries_three_times_then_fails", async () => {
    const t = await watching();
    t.m.snapshot(3);
    expect(t.requestKeyframe).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1600);
    expect(t.requestKeyframe).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1600);
    expect(t.requestKeyframe).toHaveBeenCalledTimes(3);
    expect(t.failed).toEqual([]);
    vi.advanceTimersByTime(1600);
    expect(t.requestKeyframe).toHaveBeenCalledTimes(3);
    expect(t.failed).toHaveLength(1);
    expect(t.failed[0]?.[0]).toBe(3);
    expect(t.done).toEqual([]);
  });

  it("a_failed_conversion_counts_as_an_attempt_and_asks_again", async () => {
    let n = 0;
    const t = await watching({
      toJpeg: async (h) => {
        if (n++ === 0) throw new Error("bad frame");
        return h;
      },
    });
    t.m.snapshot(4);
    t.runs[0]?.hooks.onKeyframe(Buffer.from("k1"));
    await flush();
    expect(t.requestKeyframe).toHaveBeenCalledTimes(2);
    t.runs[0]?.hooks.onKeyframe(Buffer.from("k2"));
    await flush();
    expect(t.done).toEqual([[4, Buffer.from("k2")]]);
  });

  it("snapshot_without_a_watch_fails_at_once", () => {
    const t = setup();
    t.m.snapshot(9);
    expect(t.failed).toHaveLength(1);
    expect(t.failed[0]?.[0]).toBe(9);
  });

  it("stopping_fails_every_pending_snapshot", async () => {
    const t = await watching();
    t.m.snapshot(1);
    t.m.snapshot(2);
    t.m.stop("g", "bye");
    await flush();
    expect(t.failed).toEqual([
      [1, "watch ended"],
      [2, "watch ended"],
    ]);
    vi.advanceTimersByTime(10_000);
    expect(t.requestKeyframe).toHaveBeenCalledTimes(1);
  });

  it("late_keyframe_from_the_old_job_is_ignored", async () => {
    const t = await watching();
    const old = t.runs[0];
    t.m.start({ guild: "g", user_id: "u2" });
    await flush();
    t.m.snapshot(5);
    old?.hooks.onKeyframe(Buffer.from("old"));
    old?.hooks.onOpus(Buffer.from("old"));
    old?.hooks.onLive();
    await flush();
    expect(t.toJpeg).not.toHaveBeenCalled();
    expect(t.audio).toHaveLength(0);
    expect(t.events.filter((e) => e.state === "live")).toHaveLength(0);
    t.runs[1]?.hooks.onKeyframe(Buffer.from("new"));
    await flush();
    expect(t.done).toEqual([[5, Buffer.from("J:new")]]);
  });
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { windowsHide: true }).status === 0;

describe.skipIf(!hasFfmpeg)("keyframeToJpeg", () => {
  it("scales a 1080p keyframe to 1280 wide", async () => {
    vi.useRealTimers();
    const gen = spawnSync(
      "ffmpeg",
      ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=1920x1080", "-frames:v", "1", "-c:v", "libx264", "-f", "h264", "-"],
      { windowsHide: true, maxBuffer: 1 << 26 },
    );
    const jpeg = await keyframeToJpeg(gen.stdout, new AbortController().signal);
    expect(jpeg[0]).toBe(0xff);
    expect(jpeg[1]).toBe(0xd8);
    let w = 0;
    for (let i = 2; i < jpeg.length - 9; ) {
      if (jpeg[i] !== 0xff) {
        i++;
        continue;
      }
      const mk = jpeg[i + 1] as number;
      if (mk === 0xc0 || mk === 0xc2) {
        w = jpeg.readUInt16BE(i + 7);
        break;
      }
      i += 2 + jpeg.readUInt16BE(i + 2);
    }
    expect(w).toBe(1280);
    expect(jpeg.length).toBeLessThanOrEqual(900_000);
  }, 20_000);

  it("rejects garbage", async () => {
    vi.useRealTimers();
    await expect(keyframeToJpeg(Buffer.from("not h264"), new AbortController().signal)).rejects.toThrow();
  }, 20_000);
});
