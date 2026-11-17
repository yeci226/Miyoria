// The reconnect helpers: backoff arithmetic, the loop's policy, and the watchdog.

import { describe, expect, it, vi } from "vitest";
import {
  Backoff,
  mayRetry,
  reconnectLoop,
  type SessionEnd,
  Watchdog,
} from "../../src/link/index.js";

describe("Backoff", () => {
  it("doubles from 1 s to 30 s and starts over on reset", () => {
    const b = new Backoff({ jitter: 0 });
    expect([1, 2, 3, 4, 5, 6, 7].map(() => b.next())).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
    ]);
    b.reset();
    expect(b.next()).toBe(1_000);
  });

  it("moves each wait by at most the jitter, never past the cap", () => {
    const low = new Backoff({ jitter: 0.2, random: () => 0 });
    const high = new Backoff({ jitter: 0.2, random: () => 1 });
    expect(low.next()).toBe(800);
    expect(high.next()).toBe(1_200);
    for (let i = 0; i < 10; i++) high.next();
    expect(high.next()).toBe(30_000);
  });
});

describe("reconnectLoop", () => {
  it("dials again after a wait, resets after a session that got through, stops when told", async () => {
    const ends: SessionEnd[] = [
      { retry: true, established: false },
      { retry: true, established: false },
      { retry: true, established: true },
      { retry: false, established: true },
    ];
    const waits: number[] = [];
    let sessions = 0;
    await reconnectLoop({
      signal: new AbortController().signal,
      initialMs: 1,
      maxMs: 100,
      jitter: 0,
      session: async () => ends[sessions++] as SessionEnd,
      onWait: (ms) => waits.push(ms),
    });
    expect(sessions).toBe(4);
    expect(waits).toEqual([1, 2, 1]);
  });

  it("counts a session that throws as one that did not get through", async () => {
    let sessions = 0;
    await reconnectLoop({
      signal: new AbortController().signal,
      initialMs: 1,
      jitter: 0,
      session: async () => {
        sessions++;
        if (sessions < 3) throw new Error("refused");
        return { retry: false, established: false };
      },
    });
    expect(sessions).toBe(3);
  });

  it("stops waiting at once when aborted", async () => {
    const stop = new AbortController();
    const loop = reconnectLoop({
      signal: stop.signal,
      initialMs: 60_000,
      session: async () => ({ retry: true, established: false }),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    stop.abort();
    await loop;
  });

  it("knows the final close codes", () => {
    expect(mayRetry(4401, [4400, 4401])).toBe(false);
    expect(mayRetry(1006, [4400, 4401])).toBe(true);
  });
});

describe("Watchdog", () => {
  it("calls when nothing bumped it for its time, and not after stop", () => {
    vi.useFakeTimers();
    try {
      let silent = 0;
      const dog = new Watchdog(100, () => silent++);
      vi.advanceTimersByTime(90);
      dog.bump();
      vi.advanceTimersByTime(90);
      expect(silent).toBe(0);
      vi.advanceTimersByTime(20);
      expect(silent).toBe(1);
      const other = new Watchdog(100, () => silent++);
      other.stop();
      vi.advanceTimersByTime(500);
      expect(silent).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
