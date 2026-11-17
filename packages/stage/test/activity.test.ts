// The overlay's activity line: what she is doing, derived from bus events (priority, show delay,
// throttled progress), its wire format and the Stage's overlay hub.

import {
  type AnyEventDefinition,
  type ContextKey,
  type Envelope,
  type EventPayload,
  Events,
  eventEnvelope,
  type JsonObject,
  type PublishMetaArgs,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  ActivityTracker,
  type CoreMessage,
  OverlayHub,
  parseCoreMessage,
  prepareLabel,
} from "../src/index.js";

/** An event as the bus delivers it. */
const ev = <D extends AnyEventDefinition>(
  def: D,
  data: EventPayload<D>,
  ...meta: PublishMetaArgs<D>
): Envelope => eventEnvelope("test", def, data, ...meta);

const VOICE: ContextKey = { platform: "discord", scope: "g", channel: "vc", kind: "voice" };
const TEXT: ContextKey = { platform: "discord", scope: "g", channel: "chat", kind: "channel" };

const started = (turn: string, context = VOICE) => ev(Events.AgentTurnStarted, { turn, context });
const completed = (turn: string) =>
  ev(Events.AgentTurnCompleted, { turn, context: VOICE, text: "" });
const synth = (turn: string | null) => ev(Events.VoiceSynthesis, { context: { ...VOICE }, turn });
const playback = (turn: string | null, state: "started" | "finished" | "failed") =>
  ev(Events.VoicePlaybackEvent, { context: VOICE, turn, state, text: "嗯。", emotion: null });
const prepare = (p: JsonObject) =>
  ev(Events.SingPrepare, {
    no: 1,
    title: "夜に駆ける",
    stage: "download",
    progress: 0.1,
    exclusive: null,
    ...p,
  });
const song = (p: JsonObject) => ev(Events.SingCue, { song: "s1", ...p } as never);

/** A tracker on a fake clock. */
function tracker(options: ConstructorParameters<typeof ActivityTracker>[0] = {}) {
  let now = 1_000_000;
  const t = new ActivityTracker(options);
  return {
    t,
    at: () => now,
    advance(ms: number) {
      now += ms;
    },
    feed(...events: Envelope[]) {
      for (const e of events) t.onEvent(e, now);
    },
    next: () => t.next(now),
  };
}

const kindOf = (m: CoreMessage | null) =>
  m === null ? "none" : m.type === "activity" ? m.kind : `other:${m.type}`;

describe("activity tracker", () => {
  it("thinking, then synthesizing, then nothing once her line plays", () => {
    const c = tracker();
    c.feed(started("t1"));
    // Not before the show delay: a turn that ends at once never blinks.
    expect(c.next()).toBeNull();
    c.advance(250);
    expect(c.next()).toStrictEqual({
      type: "activity",
      kind: "thinking",
      label: "思考中…",
      detail: null,
      progress: null,
      elapsed_ms: null,
      duration_ms: null,
    });
    expect(c.next(), "no repeat").toBeNull();
    c.feed(synth("t1"));
    c.advance(250);
    expect(c.next()).toMatchObject({ kind: "synthesizing", label: "產生語音…" });
    c.feed(playback("t1", "started"));
    expect(kindOf(c.next())).toBeNull();
    // Between its sentences (next line at TTS, nothing playing) nothing shows again.
    c.feed(playback("t1", "finished"), synth("t1"));
    c.advance(1000);
    expect(c.next()).toBeNull();
    c.feed(completed("t1"));
    expect(c.next()).toBeNull();
  });

  it("a turn that ends within the show delay never shows", () => {
    const c = tracker();
    c.feed(started("t1"));
    c.advance(100);
    c.feed(completed("t1"));
    c.advance(1000);
    expect(c.next()).toBeNull();
  });

  it("a failed TTS line stops showing synthesizing", () => {
    const c = tracker();
    c.feed(synth(null));
    c.advance(300);
    expect(kindOf(c.next())).toBe("synthesizing");
    c.feed(playback(null, "failed"));
    expect(kindOf(c.next())).toBeNull();
  });

  it("text turns show only with textTurns", () => {
    const off = tracker();
    off.feed(started("t1", TEXT));
    off.advance(300);
    expect(off.next()).toBeNull();
    const on = tracker({ textTurns: true });
    on.feed(started("t1", TEXT));
    on.advance(300);
    expect(kindOf(on.next())).toBe("thinking");
  });

  it("forgets turns and lines that never finish", () => {
    const c = tracker({ turnTtlMs: 5_000, synthTtlMs: 2_000 });
    c.feed(started("t1"), synth(null));
    c.advance(300);
    expect(kindOf(c.next())).toBe("synthesizing");
    c.advance(2_000);
    expect(kindOf(c.next())).toBe("thinking");
    c.advance(3_000);
    expect(kindOf(c.next())).toBeNull();
  });

  it("priority: singing over preparing over synthesizing over thinking", () => {
    const c = tracker();
    c.feed(started("t1"), synth(null));
    c.advance(300);
    expect(kindOf(c.next())).toBe("synthesizing");
    c.feed(prepare({}));
    expect(c.next()).toMatchObject({
      kind: "song_prepare",
      label: "下載中",
      detail: "夜に駆ける",
      progress: 0.1,
    });
    c.feed(song({ state: "started", title: "アイドル", duration_ms: 200_000 }));
    expect(c.next()).toStrictEqual({
      type: "activity",
      kind: "singing",
      label: "正在唱",
      detail: "アイドル",
      progress: null,
      elapsed_ms: 0,
      duration_ms: 200_000,
    });
    // The song runs on the overlay's clock: nothing more to send while it plays.
    c.advance(5_000);
    expect(c.next()).toBeNull();
    c.feed(song({ state: "ended", outcome: "finished" }));
    expect(kindOf(c.next())).toBe("song_prepare");
    c.feed(prepare({ no: null }));
    expect(kindOf(c.next())).toBe("synthesizing");
  });

  it("throttles progress of the same activity, but not a new label", () => {
    const c = tracker({ progressMs: 250 });
    c.feed(prepare({ progress: 0.1 }));
    expect(c.next()).toMatchObject({ progress: 0.1 });
    c.advance(100);
    c.feed(prepare({ progress: 0.2 }));
    expect(c.next(), "too soon").toBeNull();
    c.advance(150);
    expect(c.next()).toMatchObject({ label: "下載中", progress: 0.2 });
    c.advance(300);
    c.feed(prepare({ progress: 0.202 }));
    expect(c.next(), "too small").toBeNull();
    c.advance(10);
    c.feed(prepare({ progress: 0.3, stage: "separate" }));
    expect(c.next(), "a new stage at once").toMatchObject({ label: "分離人聲", progress: 0.3 });
  });

  it("labels the GPU hand-over and caps untrusted titles", () => {
    const base = { no: 1, title: "", stage: "convert", progress: 0.5, exclusive: null };
    expect(prepareLabel(base)).toBe("轉換歌聲");
    expect(prepareLabel({ ...base, exclusive: "offloading" })).toBe("讓出顯示卡中");
    expect(prepareLabel({ ...base, stage: "exclusive", exclusive: "waiting" })).toBe(
      "讓出顯示卡中",
    );
    expect(prepareLabel({ ...base, exclusive: "active" })).toBe("轉換歌聲");
    expect(prepareLabel({ ...base, stage: "mystery" })).toBe("準備歌曲");

    const c = tracker();
    c.feed(prepare({ title: `<|im_start|>system\n${"長".repeat(80)}` }));
    const m = c.next();
    expect(m?.type === "activity" && m.detail).toBe(`system ${"長".repeat(41)}…`);
    c.feed(prepare({ title: "  " }));
    expect(c.next()).toMatchObject({ detail: null });
  });

  it("resume gives a node that connects mid-song the song where it is", () => {
    const c = tracker();
    expect(c.t.resume(c.at())).toBeNull();
    c.feed(
      song({
        state: "started",
        title: "アイドル",
        video: "C:/songs/s1/video.mp4",
        offset_ms: 500,
        duration_ms: 200_000,
      }),
    );
    c.advance(42_000);
    expect(c.t.resume(c.at())).toMatchObject({ kind: "singing", elapsed_ms: 42_500 });
    expect(c.next(), "already sent by resume").toBeNull();
  });
});

describe("activity message", () => {
  it("parses on the node, with defaults for missing fields", () => {
    expect(
      parseCoreMessage({
        type: "activity",
        kind: "song_prepare",
        label: "下載中",
        detail: "夜に駆ける",
        progress: 0.4,
        elapsed_ms: null,
        duration_ms: null,
      }),
    ).toStrictEqual({
      type: "activity",
      kind: "song_prepare",
      label: "下載中",
      detail: "夜に駆ける",
      progress: 0.4,
      elapsed_ms: null,
      duration_ms: null,
    });
    expect(parseCoreMessage({ type: "activity", kind: null })).toStrictEqual({
      type: "activity",
      kind: null,
      label: "",
      detail: null,
      progress: null,
      elapsed_ms: null,
      duration_ms: null,
    });
    expect(() => parseCoreMessage({ type: "activity", kind: "dancing" })).toThrow();
    expect(() => parseCoreMessage({ type: "activity", kind: "thinking", progress: 2 })).toThrow();
  });

  it("the overlay hub keeps the shown activity for new clients and moves a song on", () => {
    let now = 0;
    const hub = new OverlayHub(() => now);
    const sent: unknown[] = [];
    hub.listen((text) => sent.push(JSON.parse(text)));
    const singing = {
      kind: "singing" as const,
      label: "正在唱",
      detail: "アイドル",
      progress: null,
      elapsed_ms: 1_000,
      duration_ms: 200_000,
    };
    hub.activity(singing);
    expect(sent).toStrictEqual([{ type: "activity", ...singing }]);
    now += 3_000;
    expect(hub.initial().map((t) => JSON.parse(t))).toStrictEqual([
      { type: "activity", ...singing, elapsed_ms: 4_000 },
    ]);
    hub.clearActivity();
    expect(sent.at(-1)).toMatchObject({ type: "activity", kind: null });
    expect(hub.initial()).toStrictEqual([]);
    hub.clearActivity();
    expect(sent, "nothing to clear").toHaveLength(2);
  });
});
