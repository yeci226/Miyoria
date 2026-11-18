// Danmaku on the stage (docs/design/v5-play.md §11.6): the message and its bounds, the forwarder's
// part, and on the node which pages are waited for and how each line ends exactly once.

import {
  type AnyEventDefinition,
  type Envelope,
  type EventPayload,
  Events,
  eventEnvelope,
  type PublishMetaArgs,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  DANMAKU_ANSWER_GRACE_MS,
  type DanmakuDone,
  DanmakuOutbox,
  DanmakuRelay,
  danmakuMessage,
  Forwarder,
  OverlayHub,
  parseCoreMessage,
  parseStageMessage,
} from "../src/index.js";

const ev = <D extends AnyEventDefinition>(
  def: D,
  data: EventPayload<D>,
  ...meta: PublishMetaArgs<D>
): Envelope => eventEnvelope("test", def, data, ...meta);

const LINE = {
  type: "danmaku" as const,
  id: "L1",
  name: "Mia",
  text: "好可愛",
  max_on_screen: 12,
  queue_max: 20,
  max_wait_ms: 30_000,
};

describe("the messages", () => {
  it("round-trip and are bounded", () => {
    expect(parseCoreMessage(LINE)).toStrictEqual(LINE);
    expect(parseCoreMessage({ ...LINE, name: null })).toStrictEqual({ ...LINE, name: null });
    expect(parseCoreMessage({ type: "danmaku_clear" })).toStrictEqual({ type: "danmaku_clear" });
    for (const bad of [
      { ...LINE, text: "" },
      { ...LINE, text: "x".repeat(101) },
      { ...LINE, name: "x".repeat(33) },
      { ...LINE, max_on_screen: 51 },
      { ...LINE, max_wait_ms: -1 },
    ]) {
      expect(() => parseCoreMessage(bad), JSON.stringify(bad)).toThrow();
    }
    const done = { type: "danmaku_done", id: "L1", outcome: "too_late" };
    expect(parseStageMessage(done)).toStrictEqual(done);
    expect(() => parseStageMessage({ ...done, outcome: "maybe" })).toThrow();
  });

  it("danmakuMessage makes a line of the economy's event, or says it cannot", () => {
    expect(danmakuMessage({ ...LINE, name: " Mia ", text: " 好可愛 " })).toEqual({
      id: "L1",
      msg: LINE,
    });
    expect(danmakuMessage({ ...LINE, name: "  " })?.msg?.name).toBeNull();
    expect(danmakuMessage({ ...LINE, name: null })?.msg?.name).toBeNull();
    expect(danmakuMessage({ ...LINE, max_on_screen: 99, queue_max: -3 })?.msg).toMatchObject({
      max_on_screen: 50,
      queue_max: 0,
    });
    // Unusable text: answered as not shown; no id: nothing to answer.
    expect(danmakuMessage({ ...LINE, text: " " })).toEqual({ id: "L1", msg: null });
    expect(danmakuMessage({ ...LINE, id: "" })).toBeNull();
    expect(danmakuMessage("nope")).toBeNull();
  });

  it("the forwarder passes the clear on and leaves lines to the module", () => {
    const f = new Forwarder(false);
    expect(f.onEvent(ev(Events.EconomyDanmakuClear, {}))).toStrictEqual([
      { type: "danmaku_clear" },
    ]);
    const { type: _, ...line } = LINE;
    expect(f.onEvent(ev(Events.EconomyDanmaku, line))).toEqual([]);
  });
});

describe("DanmakuRelay", () => {
  const clock = { at: 0 };
  const relay = () => new DanmakuRelay(() => clock.at);

  it("ends a line at once when no page shows danmaku", () => {
    const r = relay();
    expect(r.line("a", 30_000)).toEqual({
      send: false,
      done: [{ id: "a", outcome: "no_overlay" }],
    });
    // The same id again is nothing.
    expect(r.line("a", 30_000)).toEqual({ send: false, done: [] });
  });

  it("is shown when one page shows it, once", () => {
    const r = relay();
    r.ready(1);
    r.ready(2);
    expect(r.line("a", 30_000)).toEqual({ send: true, done: [] });
    expect(r.shown(3, "a")).toEqual([]); // a page it did not go to
    expect(r.shown(2, "a")).toEqual([{ id: "a", outcome: "shown" }]);
    expect(r.shown(1, "a")).toEqual([]);
    expect(r.dropped(1, "a", "too_late")).toEqual([]);
    expect(r.pending).toBe(0);
  });

  it("is dropped when every page dropped it, with the last reason, or lost when they left", () => {
    const r = relay();
    r.ready(1);
    r.ready(2);
    r.line("a", 30_000);
    r.line("b", 30_000);
    expect(r.dropped(1, "a", "queue_full")).toEqual([]);
    expect(r.dropped(2, "a", "too_late")).toEqual([{ id: "a", outcome: "too_late" }]);
    expect(r.leave(1)).toEqual([]);
    expect(r.leave(2)).toEqual([{ id: "b", outcome: "lost" }]);
    expect(r.pages).toBe(0);
    // A page that joins later is not waited for by the lines before it.
    r.ready(3);
    r.line("c", 30_000);
    r.ready(4);
    expect(r.leave(3)).toEqual([{ id: "c", outcome: "lost" }]);
  });

  it("loses a line nobody answered by its wait and the grace", () => {
    const r = relay();
    clock.at = 1_000;
    r.ready(1);
    r.line("a", 10_000);
    clock.at = 1_000 + 10_000 + DANMAKU_ANSWER_GRACE_MS - 1;
    expect(r.expire()).toEqual([]);
    clock.at += 1;
    expect(r.expire()).toEqual([{ id: "a", outcome: "lost" }]);
    expect(r.shown(1, "a")).toEqual([]);
  });
});

describe("DanmakuOutbox", () => {
  it("keeps answers until taken, the newest when full", () => {
    const box = new DanmakuOutbox(2);
    box.push({ id: "a", outcome: "shown" });
    box.push({ id: "b", outcome: "lost" });
    box.push({ id: "c", outcome: "cleared" });
    expect(box.take().map((d) => d.id)).toEqual(["b", "c"]);
    expect(box.size).toBe(0);
    // What could not be sent goes back in front of what came since.
    box.push({ id: "d", outcome: "shown" });
    box.restore([{ id: "c", outcome: "cleared" }]);
    expect(box.take().map((d) => d.id)).toEqual(["c", "d"]);
  });
});

describe("the overlay hub", () => {
  function hub() {
    const h = new OverlayHub(() => 0);
    const done: DanmakuDone[] = [];
    h.onDanmakuDone = (d) => done.push(d);
    const seen: Record<string, unknown>[] = [];
    h.listen((t) => seen.push(JSON.parse(t)));
    return { h, done, seen };
  }

  it("answers no_overlay without sending when no page shows danmaku", () => {
    const { h, done, seen } = hub();
    h.join();
    h.danmaku(LINE);
    expect(done).toEqual([{ id: "L1", outcome: "no_overlay" }]);
    expect(seen).toEqual([]);
  });

  it("sends the line to the pages and takes their answers", () => {
    const { h, done, seen } = hub();
    const page = h.join();
    h.reply(page, JSON.stringify({ type: "danmaku_ready" }));
    h.danmaku(LINE);
    expect(seen).toEqual([LINE]);
    expect(h.initial().some((t) => t.includes("danmaku"))).toBe(false);
    h.reply(page, "not json");
    h.reply(page, JSON.stringify({ type: "danmaku_dropped", id: "L1", reason: "bored" }));
    expect(done).toEqual([]);
    h.reply(page, JSON.stringify({ type: "danmaku_shown", id: "L1" }));
    expect(done).toEqual([{ id: "L1", outcome: "shown" }]);
    h.danmaku({ ...LINE, id: "L2" });
    h.reply(page, JSON.stringify({ type: "danmaku_dropped", id: "L2", reason: "cleared" }));
    h.danmaku({ ...LINE, id: "L3" });
    h.leave(page);
    expect(done.slice(1)).toEqual([
      { id: "L2", outcome: "cleared" },
      { id: "L3", outcome: "lost" },
    ]);
    h.danmakuClear();
    expect(seen.at(-1)).toEqual({ type: "danmaku_clear" });
  });
});
