// What a voice turn reads without waiting (contributors.ts `Warm`): the kept value at once and a
// refresh for the next turn, a short wait only when nothing is kept, never another audience's.

import { sleep } from "@miyoria/kernel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readWarm, Warm, type WarmRead } from "../src/contributors.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const read = (signal = new AbortController().signal): WarmRead => ({
  now: () => Date.now(),
  maxAgeMs: 60_000,
  waitMs: 400,
  signal,
});

describe("kept warm", () => {
  it("the first read waits briefly; later reads take the kept value and refresh it", async () => {
    const warm = new Warm<string>();
    let n = 0;
    const load = async () => {
      n += 1;
      await sleep(1000);
      return `v${n}`;
    };
    const first = readWarm(warm, "alice,bob", read(), load);
    await vi.advanceTimersByTimeAsync(400);
    expect(await first, "late: left out").toBeUndefined();
    await vi.advanceTimersByTimeAsync(600);
    // Kept now: read without waiting, while the next value loads.
    const second = readWarm(warm, "alice,bob", read(), load);
    await vi.advanceTimersByTimeAsync(0);
    expect(await second).toBe("v1");
    await vi.advanceTimersByTimeAsync(1000);
    expect(warm.peek("alice,bob", Date.now(), 60_000)).toBe("v2");
  });

  it("is never another audience's: other people wait for their own value", async () => {
    const warm = new Warm<string>();
    await warm.refresh(
      "alice,bob",
      () => Date.now(),
      async () => "for alice and bob",
    );
    expect(warm.peek("alice,carol", Date.now(), 60_000)).toBeUndefined();
    const other = readWarm(warm, "alice,carol", read(), async () => "for alice and carol");
    await vi.advanceTimersByTimeAsync(0);
    expect(await other).toBe("for alice and carol");
  });

  it("an old value is not used, and one load runs at a time", async () => {
    const warm = new Warm<string>();
    await warm.refresh(
      "k",
      () => Date.now(),
      async () => "old",
    );
    await vi.advanceTimersByTimeAsync(61_000);
    expect(warm.peek("k", Date.now(), 60_000)).toBeUndefined();
    let loads = 0;
    const slow = async () => {
      loads += 1;
      await sleep(5000);
      return "new";
    };
    const a = readWarm(warm, "k", read(), slow);
    const b = readWarm(warm, "k", read(), slow);
    await vi.advanceTimersByTimeAsync(400);
    expect([await a, await b]).toEqual([undefined, undefined]);
    expect(loads).toBe(1);
  });
});
