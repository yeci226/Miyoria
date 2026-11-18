import { describe, expect, it } from "vitest";
import {
  DanmakuLanes,
  type DanmakuGeometry,
  type DanmakuLimits,
  type DanmakuPlaced,
  type DanmakuStep,
  laneCount,
  xAt,
} from "../src/danmaku.js";
import { parseMessage } from "../src/feed.js";

const GEO: DanmakuGeometry = { width: 1920, lanes: 4, speed: 160, gap: 40 };
const LIMITS: DanmakuLimits = { maxOnScreen: 12, queueMax: 20, maxWaitMs: 30_000 };

/** Deterministic RNG (mulberry32), so the random runs are the same every time. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Records every answer and every line placed, and checks each line is answered at most once. */
class Log {
  readonly shown: string[] = [];
  readonly dropped = new Map<string, string>();
  readonly placed = new Map<string, DanmakuPlaced>();
  readonly finished: string[] = [];

  take(step: DanmakuStep): DanmakuStep {
    for (const p of step.started) {
      expect(this.answered(p.id), `${p.id} answered twice`).toBe(false);
      this.shown.push(p.id);
      this.placed.set(p.id, p);
    }
    for (const d of step.dropped) {
      expect(this.answered(d.id), `${d.id} answered twice`).toBe(false);
      this.dropped.set(d.id, d.reason);
    }
    this.finished.push(...step.finished);
    return step;
  }

  answered(id: string): boolean {
    return this.shown.includes(id) || this.dropped.has(id);
  }
}

describe("parseMessage, danmaku frames", () => {
  const frame = (o: unknown): string => JSON.stringify(o);
  const line = { type: "danmaku", id: "d1", name: "Owen", text: "加油", max_on_screen: 12, queue_max: 20, max_wait_ms: 30_000 };

  it("reads a line as the contract has it", () => {
    expect(parseMessage(frame(line))).toStrictEqual(line);
    expect(parseMessage(frame({ ...line, name: null }))).toStrictEqual({ ...line, name: null });
    expect(parseMessage(frame({ ...line, name: "  " }))).toStrictEqual({ ...line, name: null });
    expect(parseMessage(frame({ ...line, text: " 加油 ", extra: 1 }))).toStrictEqual(line);
  });

  it("clamps the limits to the contract's ranges, and falls back when one is not a number", () => {
    expect(parseMessage(frame({ ...line, max_on_screen: 0, queue_max: -1, max_wait_ms: 9e9 }))).toMatchObject({
      max_on_screen: 1,
      queue_max: 0,
      max_wait_ms: 600_000,
    });
    expect(parseMessage(frame({ ...line, max_on_screen: "5", queue_max: null, max_wait_ms: 2.7 }))).toMatchObject({
      max_on_screen: 12,
      queue_max: 20,
      max_wait_ms: 2,
    });
  });

  it("drops a line it could neither show nor answer", () => {
    for (const bad of [
      { ...line, id: "" },
      { ...line, id: 5 },
      { ...line, id: "x".repeat(65) },
      { ...line, text: "  " },
      { ...line, text: undefined },
    ]) {
      expect(parseMessage(frame(bad)), JSON.stringify(bad)).toBeNull();
    }
  });

  it("reads danmaku_clear", () => {
    expect(parseMessage(frame({ type: "danmaku_clear", x: 1 }))).toStrictEqual({ type: "danmaku_clear" });
  });
});

describe("laneCount", () => {
  it("is the whole lanes that fit the band, at least one", () => {
    expect(laneCount(336, 44)).toBe(7);
    expect(laneCount(440, 44)).toBe(10);
    expect(laneCount(439.9, 44)).toBe(9);
    expect(laneCount(20, 44)).toBe(1);
    expect(laneCount(0, 44)).toBe(1);
    expect(laneCount(300, 0)).toBe(1);
  });
});

describe("DanmakuLanes", () => {
  it("starts a line at once in the top lane, at the right edge, and moves it at the one speed", () => {
    const lanes = new DanmakuLanes(GEO);
    const step = lanes.receive({ id: "a", width: 300 }, LIMITS, 1000);
    expect(step.started).toEqual([{ id: "a", lane: 0, width: 300, startX: 1920, startAt: 1000, speed: 160 }]);
    expect(lanes.x("a", 1000)).toBe(1920);
    expect(lanes.x("a", 2000)).toBe(1760);
    // done once its tail passes the left edge: (1920 + 300) / 160 s after it entered
    expect(lanes.tick(1000 + 13_875).finished).toEqual([]);
    expect(lanes.tick(1000 + 13_876).finished).toEqual(["a"]);
    expect(lanes.x("a", 20_000)).toBeNull();
  });

  it("puts the next line in the topmost free lane, and reuses a lane once its tail is a gap in", () => {
    const lanes = new DanmakuLanes(GEO);
    const log = new Log();
    log.take(lanes.receive({ id: "a", width: 400 }, LIMITS, 0));
    log.take(lanes.receive({ id: "b", width: 100 }, LIMITS, 0));
    log.take(lanes.receive({ id: "c", width: 100 }, LIMITS, 0));
    expect([...log.placed.values()].map((p) => p.lane)).toEqual([0, 1, 2]);
    // b's tail is a gap in after (100 + 40) / 160 s; a's after (400 + 40) / 160 s
    log.take(lanes.receive({ id: "d", width: 50 }, LIMITS, 875));
    expect(log.placed.get("d")?.lane).toBe(1);
    log.take(lanes.receive({ id: "e", width: 50 }, LIMITS, 2750));
    expect(log.placed.get("e")?.lane).toBe(0);
  });

  it("never lets two lines of a lane overlap (random widths and arrivals)", () => {
    for (const seed of [1, 2, 3, 42, 1234]) {
      const rand = rng(seed);
      const geo: DanmakuGeometry = { width: 1504, lanes: 1 + Math.floor(rand() * 7), speed: 160, gap: 40 };
      const lanes = new DanmakuLanes(geo);
      const log = new Log();
      const limits: DanmakuLimits = { maxOnScreen: 3 + Math.floor(rand() * 20), queueMax: 30, maxWaitMs: 20_000 };
      let now = 0;
      let n = 0;
      for (let frame = 0; frame < 6000; frame++) {
        now += 16 + rand() * 4;
        if (rand() < 0.05) log.take(lanes.receive({ id: `l${n++}`, width: 40 + rand() * 900 }, limits, now));
        log.take(lanes.tick(now));
        expect(lanes.onScreen).toBeLessThanOrEqual(limits.maxOnScreen);
        // every pair crossing in one lane keeps at least the gap between them
        const byLane = new Map<number, DanmakuPlaced[]>();
        for (const id of log.shown) {
          const x = lanes.x(id, now);
          const p = log.placed.get(id) as DanmakuPlaced;
          if (x === null) continue;
          byLane.set(p.lane, [...(byLane.get(p.lane) ?? []), p]);
        }
        for (const inLane of byLane.values()) {
          inLane.sort((p, q) => p.startAt - q.startAt);
          for (let i = 1; i < inLane.length; i++) {
            const ahead = inLane[i - 1] as DanmakuPlaced;
            const behind = inLane[i] as DanmakuPlaced;
            expect(xAt(behind, now) - (xAt(ahead, now) + ahead.width)).toBeGreaterThanOrEqual(geo.gap - 1e-6);
          }
        }
      }
      // every line got exactly one answer, or is still waiting
      expect(log.shown.length + log.dropped.size + lanes.waiting).toBe(n);
      expect(log.shown.length).toBeGreaterThan(0);
    }
    // Many random runs: a slow machine needs more than the default five seconds.
  }, 30_000);

  it("holds at most maxOnScreen, and lets the rest wait in order", () => {
    const lanes = new DanmakuLanes({ ...GEO, lanes: 10 });
    const log = new Log();
    const limits = { ...LIMITS, maxOnScreen: 2 };
    for (const id of ["a", "b", "c", "d"]) log.take(lanes.receive({ id, width: 200 }, limits, 0));
    expect(log.shown).toEqual(["a", "b"]);
    expect(lanes.waiting).toBe(2);
    // a and b leave after (1920 + 200) / 160 s; then c and d start, c first
    log.take(lanes.tick(13_000));
    expect(log.shown).toEqual(["a", "b"]);
    log.take(lanes.tick(13_251));
    expect(log.finished).toEqual(["a", "b"]);
    expect(log.shown).toEqual(["a", "b", "c", "d"]);
    expect(lanes.waiting).toBe(0);
  });

  it("serves the queue first in, first out, as lanes free up", () => {
    const lanes = new DanmakuLanes({ ...GEO, lanes: 1 });
    const log = new Log();
    for (const id of ["a", "b", "c"]) log.take(lanes.receive({ id, width: 120 }, LIMITS, 0));
    expect(log.shown).toEqual(["a"]);
    // a's tail is a gap in after (120 + 40) / 160 = 1 s
    log.take(lanes.tick(999));
    expect(log.shown).toEqual(["a"]);
    log.take(lanes.tick(1000));
    expect(log.shown).toEqual(["a", "b"]);
    // a line arriving now waits behind c even if a lane were free
    log.take(lanes.receive({ id: "d", width: 10 }, LIMITS, 1500));
    log.take(lanes.tick(2000));
    log.take(lanes.tick(3000));
    expect(log.shown).toEqual(["a", "b", "c", "d"]);
  });

  it("drops a line at once when queueMax lines already wait (queue_full)", () => {
    const lanes = new DanmakuLanes({ ...GEO, lanes: 1 });
    const log = new Log();
    const limits = { ...LIMITS, queueMax: 2 };
    for (const id of ["a", "b", "c", "d", "e"]) log.take(lanes.receive({ id, width: 500 }, limits, 0));
    expect(log.shown).toEqual(["a"]);
    expect([...log.dropped]).toEqual([
      ["d", "queue_full"],
      ["e", "queue_full"],
    ]);
    expect(lanes.waiting).toBe(2);
  });

  it("with queueMax 0, a line that cannot start now is dropped", () => {
    const lanes = new DanmakuLanes({ ...GEO, lanes: 1 });
    const log = new Log();
    const limits = { ...LIMITS, queueMax: 0 };
    log.take(lanes.receive({ id: "a", width: 500 }, limits, 0));
    log.take(lanes.receive({ id: "b", width: 500 }, limits, 10));
    expect(log.shown).toEqual(["a"]);
    expect(log.dropped.get("b")).toBe("queue_full");
    expect(lanes.waiting).toBe(0);
  });

  it("drops a line that waited maxWaitMs without a lane (too_late)", () => {
    const lanes = new DanmakuLanes({ ...GEO, lanes: 1 });
    const log = new Log();
    const limits = { ...LIMITS, maxWaitMs: 2000 };
    log.take(lanes.receive({ id: "a", width: 1000 }, limits, 0)); // lane free again after 6.5 s
    log.take(lanes.receive({ id: "b", width: 10 }, limits, 100));
    log.take(lanes.tick(2099));
    expect(log.dropped.size).toBe(0);
    log.take(lanes.tick(2100));
    expect(log.dropped.get("b")).toBe("too_late");
    expect(lanes.waiting).toBe(0);
  });

  it("clear takes every line off and drops the waiting ones; the ones crossing get no new answer", () => {
    const lanes = new DanmakuLanes({ ...GEO, lanes: 1 });
    const log = new Log();
    for (const id of ["a", "b", "c"]) log.take(lanes.receive({ id, width: 500 }, LIMITS, 0));
    const step = log.take(lanes.clear());
    expect(step.started).toEqual([]);
    expect(step.finished).toEqual(["a"]);
    expect(step.dropped).toEqual([
      { id: "b", reason: "cleared" },
      { id: "c", reason: "cleared" },
    ]);
    expect(lanes.onScreen).toBe(0);
    // the lane is free at once
    log.take(lanes.receive({ id: "d", width: 500 }, LIMITS, 10));
    expect(log.placed.get("d")?.lane).toBe(0);
  });

  it("forgets the waiting lines without an answer when the socket goes, and lets crossing ones finish", () => {
    const lanes = new DanmakuLanes({ ...GEO, lanes: 1 });
    const log = new Log();
    for (const id of ["a", "b", "c"]) log.take(lanes.receive({ id, width: 500 }, LIMITS, 0));
    expect(lanes.disconnect()).toEqual(["b", "c"]);
    expect(lanes.waiting).toBe(0);
    expect(lanes.onScreen).toBe(1);
    const later = log.take(lanes.tick(60_000));
    expect(later.finished).toEqual(["a"]);
    expect(later.dropped).toEqual([]);
    expect(log.dropped.size).toBe(0);
  });

  it("takes the latest limits from each line", () => {
    const lanes = new DanmakuLanes({ ...GEO, lanes: 10 });
    const log = new Log();
    log.take(lanes.receive({ id: "a", width: 100 }, { ...LIMITS, maxOnScreen: 1 }, 0));
    log.take(lanes.receive({ id: "b", width: 100 }, { ...LIMITS, maxOnScreen: 1 }, 0));
    expect(log.shown).toEqual(["a"]);
    // the owner raises the cap: b (waiting) and c start
    log.take(lanes.receive({ id: "c", width: 100 }, { ...LIMITS, maxOnScreen: 3 }, 10));
    expect(log.shown).toEqual(["a", "b", "c"]);
    // and lowers it with a shorter wait: d waits, then runs out of the new time
    log.take(lanes.receive({ id: "d", width: 100 }, { ...LIMITS, maxOnScreen: 1, maxWaitMs: 500 }, 20));
    expect(log.shown).toEqual(["a", "b", "c"]);
    log.take(lanes.tick(520));
    expect(log.dropped.get("d")).toBe("too_late");
    // a smaller queue applies to the next line that comes
    log.take(lanes.receive({ id: "e", width: 100 }, { ...LIMITS, maxOnScreen: 1, queueMax: 0 }, 600));
    expect(log.dropped.get("e")).toBe("queue_full");
  });

  it("answers a repeated frame of the same line only once", () => {
    const lanes = new DanmakuLanes({ ...GEO, lanes: 1 });
    const log = new Log();
    log.take(lanes.receive({ id: "a", width: 500 }, LIMITS, 0));
    log.take(lanes.receive({ id: "a", width: 500 }, LIMITS, 5));
    log.take(lanes.receive({ id: "b", width: 500 }, LIMITS, 10));
    log.take(lanes.receive({ id: "b", width: 500 }, LIMITS, 15));
    expect(lanes.waiting).toBe(1);
    log.take(lanes.tick(60_000));
    expect(log.shown).toEqual(["a", "b"]);
  });

  it("keeps lanes apart when the frame is resized mid-stream", () => {
    const lanes = new DanmakuLanes({ ...GEO, lanes: 2 });
    const log = new Log();
    log.take(lanes.receive({ id: "a", width: 300 }, LIMITS, 0));
    // the frame grows: faster lines, wider band, more lanes
    lanes.setGeometry({ width: 2560, lanes: 3, speed: 213, gap: 53 });
    log.take(lanes.receive({ id: "b", width: 400 }, LIMITS, 100));
    expect(log.placed.get("b")?.lane).toBe(1);
    log.take(lanes.receive({ id: "c", width: 400 }, LIMITS, 100));
    expect(log.placed.get("c")?.lane).toBe(2);
    // a faster line waits longer behind a slow one so it never reaches its tail
    for (let t = 200; t < 20_000; t += 16) {
      log.take(lanes.tick(t));
      if (lanes.waiting === 0 && log.shown.length < 4) log.take(lanes.receive({ id: "d", width: 200 }, LIMITS, t));
      const a = log.placed.get("a") as DanmakuPlaced;
      const d = log.placed.get("d");
      if (d && d.lane === 0 && lanes.x("a", t) !== null) {
        expect(xAt(d, t)).toBeGreaterThanOrEqual(xAt(a, t) + a.width);
      }
    }
    expect(log.shown).toContain("d");
  });
});
