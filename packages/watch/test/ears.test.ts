import { describe, expect, it, vi } from "vitest";
import { boost, listenTo, MAX_GAIN, SILENCE_RMS, TARGET_RMS } from "../src/ears.js";

const rmsOf = (f: Int16Array): number => {
  let s = 0;
  for (const v of f) s += v * v;
  return Math.sqrt(s / f.length);
};

/** `amp` sine at 200 Hz, 16 kHz, `n` samples. */
function sine(amp: number, n: number, offset = 0): Int16Array {
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = Math.round(amp * Math.sin((2 * Math.PI * 200 * (i + offset)) / 16_000));
  }
  return out;
}

describe("boost", () => {
  it("makes quiet speech loud enough without clipping", () => {
    const state = { rms: 0 };
    let last: Int16Array = new Int16Array(0);
    for (let i = 0; i < 60; i++) last = boost(sine(141, 320, i * 320), state);
    expect(rmsOf(last)).toBeGreaterThan(1000);
    expect(Math.max(...last.map(Math.abs))).toBeLessThan(32767);
  });

  it("leaves silence alone", () => {
    const state = { rms: 0 };
    const frame = new Int16Array(320);
    expect(Array.from(boost(frame, state))).toEqual(Array.from(frame));
    const hiss = sine(5, 320); // rms about 3.5, below SILENCE_RMS
    expect(SILENCE_RMS).toBeGreaterThan(3.6);
    expect(Array.from(boost(hiss, { rms: 0 }))).toEqual(Array.from(hiss));
  });

  it("clips instead of overflowing, and does not touch the input", () => {
    const state = { rms: 100 };
    const loud = sine(30_000, 320);
    const copy = Int16Array.from(loud);
    const out = boost(loud, state);
    expect(Array.from(loud)).toEqual(Array.from(copy));
    expect(Math.max(...out)).toBe(32767);
    expect(Math.min(...out)).toBe(-32768);
    // The sign survives: no wrap-around.
    for (let i = 0; i < out.length; i++) {
      expect(Math.sign(out[i] as number)).toBe(Math.sign(loud[i] as number));
    }
  });

  it("uses the documented constants", () => {
    expect([TARGET_RMS, MAX_GAIN, SILENCE_RMS]).toEqual([3000, 32, 10]);
  });
});

async function* speech(): AsyncGenerator<Int16Array> {
  for (let i = 0; i < 60; i++) yield sine(5000, 320, i * 320); // 1.2 s of voice
  for (let i = 0; i < 60; i++) yield new Int16Array(320); // then quiet
}

describe("listenTo", () => {
  it("turns speech into a line", async () => {
    const lines: string[] = [];
    const transcribe = vi.fn(async () => "你好");
    await listenTo(speech(), { transcribe }, (t) => lines.push(t), new AbortController().signal);
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(lines).toEqual(["你好"]);
  });

  it("ignores null results", async () => {
    const lines: string[] = [];
    await listenTo(
      speech(),
      { transcribe: async () => null },
      (t) => lines.push(t),
      new AbortController().signal,
    );
    expect(lines).toEqual([]);
  });

  it("keeps listening after a failing transcribe", async () => {
    async function* twice(): AsyncGenerator<Int16Array> {
      yield* speech();
      yield* speech();
    }
    const lines: string[] = [];
    let n = 0;
    const transcribe = vi.fn(async () => {
      if (++n === 1) throw new Error("asr down");
      return "第二句";
    });
    await listenTo(twice(), { transcribe }, (t) => lines.push(t), new AbortController().signal);
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(lines).toEqual(["第二句"]);
  });

  it("does not wait for a slow transcribe before reading more audio", async () => {
    async function* twice(): AsyncGenerator<Int16Array> {
      yield* speech();
      yield* speech();
    }
    let release!: (v: string | null) => void;
    const first = new Promise<string | null>((r) => {
      release = r;
    });
    let calls = 0;
    const transcribe = vi.fn(() => (++calls === 1 ? first : Promise.resolve("x")));
    const p = listenTo(twice(), { transcribe }, () => {}, new AbortController().signal);
    // The second segment is reached while the first is still pending.
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(2));
    release("x");
    await p;
  });

  it("returns when aborted even if the audio never yields", async () => {
    const ctl = new AbortController();
    const never = { [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }) };
    const p = listenTo(never, { transcribe: async () => "x" }, () => {}, ctl.signal);
    ctl.abort();
    await expect(p).resolves.toBeUndefined();
  });
});
