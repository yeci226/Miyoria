// The song is streamed close to real time (the voice node buffers about a minute), with the
// vocal stem as a same-length levels track.

import { join, resolve } from "node:path";
import { systemClock } from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { paced, type SongMeta, SongMetaSchema, songBeats, songVideoPath } from "../src/index.js";

describe("paced", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends each 100 ms chunk lead_ms before it is due", async () => {
    const rate = 1000;
    const mix = new Int16Array(rate * 2).fill(1);
    const vocals = new Int16Array(rate * 2 - 50).fill(2); // a little shorter: padded with silence
    const t0 = Date.now();
    const sent: { at: number; samples: number; levels: number | undefined; last: number }[] = [];
    const done = (async () => {
      for await (const c of paced(
        mix,
        vocals,
        rate,
        500,
        systemClock,
        new AbortController().signal,
      )) {
        sent.push({
          at: Date.now() - t0,
          samples: c.samples.length,
          levels: c.levels?.length,
          last: c.levels?.at(-1) ?? -1,
        });
      }
    })();
    await vi.advanceTimersByTimeAsync(3000);
    await done;
    expect(sent).toHaveLength(20);
    expect(sent.slice(0, 6).every((c) => c.at === 0)).toBe(true);
    expect(sent[6]?.at).toBe(100);
    expect(sent[19]?.at).toBe(1400);
    expect(sent.every((c) => c.samples === 100 && c.levels === 100)).toBe(true);
    expect(sent[18]?.last).toBe(2);
    expect(sent[19]?.last).toBe(0);
  });

  it("stops when aborted", async () => {
    const stop = new AbortController();
    const got: number[] = [];
    const done = (async () => {
      for await (const c of paced(
        new Int16Array(10_000),
        null,
        1000,
        0,
        systemClock,
        stop.signal,
      )) {
        got.push(c.samples.length);
        expect(c.levels).toBeUndefined();
      }
    })();
    await vi.advanceTimersByTimeAsync(250);
    stop.abort();
    await vi.advanceTimersByTimeAsync(10);
    await done;
    expect(got.length).toBe(3);
  });
});

describe("songBeats", () => {
  it("turns the worker's seconds into ms and drops a missing or broken beat", () => {
    const base = { id: "yt-abc", play: { sample_rate: 48_000, samples: 10 } };
    const withBeats = SongMetaSchema.parse({ ...base, beats: { bpm: 128, times: [0.5, 0.97] } });
    expect(songBeats(withBeats)).toEqual({ bpm: 128, times_ms: [500, 970] });
    expect(songBeats(SongMetaSchema.parse(base))).toBeNull();
    expect(songBeats(SongMetaSchema.parse({ ...base, beats: "x" }))).toBeNull();
  });
});

describe("songVideoPath", () => {
  const dir = resolve("cache");
  const song = (id: string, file: string | null, has = true) =>
    ({ id, has_video: has, video: file === null ? null : { file } }) as unknown as SongMeta;

  it("is the video in the song's cache dir", () => {
    expect(songVideoPath(dir, song("yt-abc", "video.mp4"))).toBe(join(dir, "yt-abc", "video.mp4"));
    expect(songVideoPath(dir, song("lib-1-k+2", "video.mkv"))).toBeNull(); // not a worker id
    expect(songVideoPath(dir, song("lib-1", "video.mkv"))).toBe(join(dir, "lib-1", "video.mkv"));
  });

  it("never points anywhere else", () => {
    expect(songVideoPath(dir, song("..", "video.mp4"))).toBeNull();
    expect(songVideoPath(dir, song("x", "../../secret.mp4"))).toBeNull();
    expect(songVideoPath(dir, song("x", "video.exe"))).toBeNull();
    expect(songVideoPath(dir, song("x", null))).toBeNull();
    expect(songVideoPath(dir, song("x", "video.mp4", false))).toBeNull();
  });
});
