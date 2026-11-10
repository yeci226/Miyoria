import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type PlaybackEvent,
  PlaybackQueue,
  type PlayerHooks,
  type PlayerPort,
} from "../src/playback/queue.js";
import { FRAME_BYTES, FRAME_MS, PlaybackSource, type SourceOptions } from "../src/playback/source.js";

/** s16le mono PCM, `ms` long, constant amplitude (easy to see fades). */
function pcm(ms: number, rate = 16_000, value = 8000): Buffer {
  const n = Math.round((ms * rate) / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(value, i * 2);
  return b;
}

/** Stands in for the AudioPlayer: pulls 20 ms frames on demand, like the real 20 ms timer would. */
class FakePort implements PlayerPort {
  source: PlaybackSource | undefined;
  hooks: PlayerHooks | undefined;
  playCalls: PlaybackSource[] = [];
  stopCalls = 0;
  autoEndOnStop = true;
  frames: ("audio" | "silence")[] = [];
  peaks: number[] = [];

  play(source: PlaybackSource, hooks: PlayerHooks): void {
    this.source = source;
    this.hooks = hooks;
    this.playCalls.push(source);
    this.frames = [];
    this.peaks = [];
    hooks.started(); // real player: Buffering -> Playing
  }

  stop(): void {
    this.stopCalls++;
    if (this.autoEndOnStop) this.drain();
  }

  /** Pull up to `n` frames; when the source ends, report idle. Returns frames pulled. */
  pull(n: number): number {
    let pulled = 0;
    while (pulled < n && this.source) {
      const r = this.source.readFrame();
      if (r.kind === "end") {
        this.finish();
        return pulled;
      }
      pulled++;
      if (r.kind === "audio") {
        expect(r.pcm.length).toBe(FRAME_BYTES);
        this.frames.push("audio");
        let peak = 0;
        for (let i = 0; i < r.pcm.length; i += 2) peak = Math.max(peak, Math.abs(r.pcm.readInt16LE(i)));
        this.peaks.push(peak);
      } else this.frames.push("silence");
    }
    return pulled;
  }

  drain(): void {
    this.pull(100_000);
  }

  finish(error?: Error): void {
    const h = this.hooks;
    this.source = undefined;
    this.hooks = undefined;
    h?.ended(error);
  }
}

const SRC: SourceOptions = { sampleRate: 16_000, maxBufferBytes: 16_000 * 2 * 30, prebufferMs: 40, maxStarveMs: 200 };

function setup(over: Partial<SourceOptions> = {}, maxQueued?: number) {
  const port = new FakePort();
  const events: PlaybackEvent[] = [];
  const queue = new PlaybackQueue({
    port,
    onEvent: (e) => events.push(e),
    createSource: (rate) => new PlaybackSource({ ...SRC, ...over, sampleRate: rate }),
    ...(maxQueued !== undefined ? { maxQueued } : {}),
  });
  const states = (play?: number) => events.filter((e) => play === undefined || e.play === play).map((e) => e.state);
  return { port, queue, events, states };
}

describe("PlaybackQueue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("plays a stream start to finish: started then finished", () => {
    const { port, queue, states } = setup();
    expect(queue.start(1, 16_000)).toEqual({ ok: true });
    expect(port.playCalls).toHaveLength(0); // nothing buffered yet

    queue.push(1, pcm(100));
    expect(port.playCalls).toHaveLength(1);
    expect(states()).toEqual(["started"]);

    queue.push(1, pcm(100));
    queue.end(1);
    port.drain();
    expect(states()).toEqual(["started", "finished"]);
    expect(queue.size).toBe(0);
    // 200 ms of audio = 10 frames (last may be padded), no underrun silence
    expect(port.frames.filter((f) => f === "audio").length).toBe(10);
    expect(port.frames.filter((f) => f === "silence").length).toBe(0);
  });

  it("waits for the prebuffer, or for play_end, before starting", () => {
    const { port, queue } = setup({ prebufferMs: 100 });
    queue.start(1, 16_000);
    queue.push(1, pcm(60));
    expect(port.playCalls).toHaveLength(0);
    queue.push(1, pcm(60));
    expect(port.playCalls).toHaveLength(1);

    queue.start(2, 16_000);
    queue.push(2, pcm(10)); // short clip, behind #1
    queue.end(2);
    port.drain(); // finishes #1 -> #2 starts straight away since it is complete
    expect(port.playCalls).toHaveLength(2);
  });

  it("queues a second playback behind the first and starts it when the first ends", () => {
    const { port, queue, states } = setup();
    queue.start(1, 16_000);
    queue.start(2, 16_000);
    queue.push(1, pcm(100));
    queue.push(2, pcm(100)); // arrives early, must not play yet
    queue.end(2);
    expect(queue.activeId).toBe(1);
    expect(port.playCalls).toHaveLength(1);
    expect(states(2)).toEqual([]);

    queue.end(1);
    port.drain();
    expect(states(1)).toEqual(["started", "finished"]);
    expect(queue.activeId).toBe(2);
    expect(port.playCalls).toHaveLength(2);
    expect(states(2)).toEqual(["started"]);

    port.drain();
    expect(states(2)).toEqual(["started", "finished"]);
    expect(queue.size).toBe(0);
  });

  it("fills underruns with silence and keeps going", () => {
    const { port, queue, states } = setup();
    queue.start(1, 16_000);
    queue.push(1, pcm(60));
    port.pull(3); // consume everything buffered
    expect(port.pull(2)).toBe(2); // starved: silence frames, not an end
    expect(port.frames.slice(-2)).toEqual(["silence", "silence"]);
    queue.push(1, pcm(40));
    queue.end(1);
    port.drain();
    expect(states()).toEqual(["started", "finished"]);
  });

  it("fails a playback that stays starved too long", () => {
    const { port, queue, events } = setup({ maxStarveMs: 100 });
    queue.start(1, 16_000);
    queue.push(1, pcm(60));
    port.drain();
    expect(events.map((e) => e.state)).toEqual(["started", "failed"]);
    expect(events[1]?.error).toMatch(/waiting for audio/);
  });

  it("play_stop with a fade ramps the volume to zero, then reports interrupted", () => {
    const { port, queue, states } = setup();
    queue.start(1, 16_000);
    queue.push(1, pcm(1000));
    port.pull(2);
    queue.stop(1, 100); // 5 frames of fade
    port.drain();

    expect(states()).toEqual(["started", "interrupted"]);
    const fadeStart = 2;
    const fade = port.peaks.slice(fadeStart);
    expect(fade).toHaveLength(5);
    expect(fade[0]).toBeGreaterThan(fade[4] as number);
    for (let i = 1; i < fade.length; i++) expect(fade[i] as number).toBeLessThanOrEqual(fade[i - 1] as number);
    expect(fade[4] as number).toBeLessThan(8000 * 0.25);
    expect(Math.abs((port.peaks[1] as number) - 8000)).toBeLessThan(160); // steady state before the fade
    expect(port.stopCalls).toBe(0); // the fade ends the stream itself
  });

  it("play_stop with fade_ms 0 cuts immediately through the player", () => {
    const { port, queue, states } = setup();
    queue.start(1, 16_000);
    queue.push(1, pcm(500));
    port.pull(1);
    queue.stop(1, 0);
    expect(port.stopCalls).toBe(1);
    expect(states()).toEqual(["started", "interrupted"]);
    expect(queue.size).toBe(0);
  });

  it("stopping a queued playback removes it without disturbing the active one", () => {
    const { port, queue, states } = setup();
    queue.start(1, 16_000);
    queue.start(2, 16_000);
    queue.push(1, pcm(100));
    queue.stop(2, 50);
    expect(states(2)).toEqual(["interrupted"]);
    expect(queue.has(2)).toBe(false);
    expect(queue.activeId).toBe(1);
    expect(port.stopCalls).toBe(0);
    queue.end(1);
    port.drain();
    expect(states(1)).toEqual(["started", "finished"]);
  });

  it("stopping the active playback before it began (prebuffering) moves on to the next", () => {
    const { port, queue, states } = setup({ prebufferMs: 500 });
    queue.start(1, 16_000);
    queue.start(2, 16_000);
    queue.push(1, pcm(100)); // below prebuffer: still waiting
    queue.push(2, pcm(100));
    queue.end(2);
    queue.stop(1, 0);
    expect(states(1)).toEqual(["interrupted"]);
    expect(queue.activeId).toBe(2);
    expect(port.playCalls).toHaveLength(1);
    port.drain();
    expect(states(2)).toEqual(["started", "finished"]);
  });

  it("clear() interrupts everything and stops the player once", () => {
    const { port, queue, states } = setup();
    queue.start(1, 16_000);
    queue.start(2, 16_000);
    queue.push(1, pcm(200));
    queue.clear();
    expect(states(1)).toEqual(["started", "interrupted"]);
    expect(states(2)).toEqual(["interrupted"]);
    expect(port.stopCalls).toBe(1);
    expect(queue.size).toBe(0);
    // late player callbacks for the dead entry are ignored
    port.finish();
    expect(states(1)).toEqual(["started", "interrupted"]);
  });

  it("clear(error) reports failed instead", () => {
    const { queue, events } = setup();
    queue.start(1, 16_000);
    queue.clear("voice connection lost");
    expect(events).toEqual([{ play: 1, state: "failed", error: "voice connection lost" }]);
  });

  it("reports failed when the player errors", () => {
    const { port, queue, events } = setup();
    queue.start(1, 16_000);
    queue.push(1, pcm(100));
    port.finish(new Error("boom"));
    expect(events).toEqual([{ play: 1, state: "started" }, { play: 1, state: "failed", error: "boom" }]);
  });

  it("reports failed if the player throws while starting", () => {
    const { port, queue, events } = setup();
    port.play = () => {
      throw new Error("no connection");
    };
    queue.start(1, 16_000);
    queue.push(1, pcm(100));
    expect(events).toEqual([{ play: 1, state: "failed", error: "no connection" }]);
    expect(queue.size).toBe(0);
  });

  it("fails on buffer overflow, before and during playback", () => {
    const small = { maxBufferBytes: 16_000 * 2 * 0.2 }; // 200 ms
    const a = setup(small);
    a.queue.start(1, 16_000);
    expect(a.queue.push(1, pcm(500))).toBe(false); // never began
    expect(a.events).toEqual([{ play: 1, state: "failed", error: "audio buffer limit exceeded" }]);

    const b = setup(small);
    b.queue.start(1, 16_000);
    b.queue.push(1, pcm(100));
    b.queue.push(1, pcm(100));
    b.queue.push(1, pcm(100)); // over the limit while playing
    b.port.drain();
    expect(b.events.map((e) => e.state)).toEqual(["started", "failed"]);
  });

  it("rejects duplicate ids and a full queue; ignores audio for unknown plays", () => {
    const { queue } = setup({}, 1);
    expect(queue.start(1, 16_000).ok).toBe(true);
    expect(queue.start(1, 16_000)).toEqual({ ok: false, error: "play 1 already exists" });
    expect(queue.start(2, 16_000).ok).toBe(true);
    const full = queue.start(3, 16_000);
    expect(full.ok).toBe(false);
    expect(queue.push(99, pcm(20))).toBe(false);
    queue.end(99);
    queue.stop(99, 0); // no throw
  });

  it("cuts a stuck fade after the failsafe delay", () => {
    const { port, queue, states } = setup();
    port.autoEndOnStop = false;
    queue.start(1, 16_000);
    queue.push(1, pcm(500));
    port.pull(1);
    queue.stop(1, 100); // the player never pulls again
    expect(states()).toEqual(["started"]);
    vi.advanceTimersByTime(100 + 750 + 10);
    expect(states()).toEqual(["started", "interrupted"]);
    expect(port.stopCalls).toBe(1);
  });

  it("resamples any source rate to 20 ms 48 kHz stereo frames", () => {
    const { port, queue } = setup();
    queue.start(1, 24_000);
    queue.push(1, pcm(200, 24_000));
    queue.end(1);
    port.drain();
    expect(port.frames.length).toBe(200 / FRAME_MS);
  });

  it("handles PCM chunks split in the middle of a sample", () => {
    const { port, queue, states } = setup();
    queue.start(1, 16_000);
    const all = pcm(100);
    queue.push(1, all.subarray(0, 1001));
    queue.push(1, all.subarray(1001));
    queue.end(1);
    port.drain();
    expect(states()).toEqual(["started", "finished"]);
    expect(port.frames.length).toBe(5);
  });
});

describe("PlaybackQueue ducking and pausing", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("ducks to a gain with a ramp and restores it", () => {
    const { port, queue } = setup();
    queue.start(1, 16_000);
    queue.push(1, pcm(600));
    port.pull(2);
    const full = port.peaks[1] as number; // the first frame carries the resampler's start-up ripple

    queue.duck(1, 0.5, 40); // two frames
    port.pull(4);
    // A frame's peak is its first sample: 1.0, 0.75, then the ducked 0.5.
    expect(port.peaks[3]).toBeLessThan(full);
    expect(port.peaks[3]).toBeGreaterThan(full / 2);
    expect(port.peaks[4]).toBeCloseTo(full / 2, -1);
    expect(port.peaks[5]).toBeCloseTo(full / 2, -1);

    queue.duck(1, 1, 0);
    port.pull(1);
    expect(port.peaks[6]).toBeCloseTo(full, -1);
  });

  it("pause fades out, then holds the audio untouched until resume", () => {
    const { port, queue, states } = setup();
    queue.start(1, 16_000);
    queue.push(1, pcm(400)); // 20 frames
    queue.end(1);
    port.pull(1);
    queue.pause(1, 40);
    port.pull(2); // fade-out frames
    expect(port.peaks[2]).toBeLessThan(port.peaks[0] as number);
    const buffered = port.source?.bufferedMs ?? 0;

    // Held: only silence, the buffer is not consumed and the play does not starve.
    port.pull(100);
    expect(port.frames.slice(3).every((f) => f === "silence")).toBe(true);
    expect(port.source?.bufferedMs).toBe(buffered);
    expect(states()).toEqual(["started"]);

    queue.resume(1, 40);
    port.drain();
    expect(states()).toEqual(["started", "finished"]);
    // Everything that was buffered still got played.
    expect(port.frames.filter((f) => f === "audio").length).toBe(20);
  });

  it("a ducked play that is paused and resumed keeps its duck gain", () => {
    const { port, queue } = setup();
    queue.start(1, 16_000);
    queue.push(1, pcm(1000));
    queue.duck(1, 0.5, 0);
    queue.pause(1, 0);
    port.pull(3);
    queue.resume(1, 0);
    port.pull(2);
    expect(port.peaks.at(-1)).toBeCloseTo(4000, -2);
  });

  it("a pause nobody resumes ends the play as interrupted", () => {
    const { port, queue, states } = setup({ maxPauseMs: 100 });
    queue.start(1, 16_000);
    queue.push(1, pcm(1000));
    queue.pause(1, 0);
    port.pull(20);
    expect(states()).toEqual(["started", "interrupted"]);
    expect(queue.size).toBe(0);
  });

  it("ignores controls for unknown or stopped plays", () => {
    const { queue, port } = setup();
    queue.duck(9, 0.5, 0);
    queue.pause(9, 0);
    queue.resume(9, 0);
    queue.start(1, 16_000);
    queue.push(1, pcm(200));
    queue.stop(1, 0);
    queue.pause(1, 0);
    expect(port.stopCalls).toBeGreaterThan(0);
  });
});
