// The overlay's activity line: what she is doing, derived from bus events (priority, show delay,
// throttled progress), its wire format and the Stage's overlay hub.

import { SONG_PREPARE_STAGES } from "@miyoria/contracts/events";
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
  STAGE_LABELS,
  toolLabel,
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

  it("priority: singing, then what she does, then the song being prepared beside it", () => {
    const c = tracker();
    c.feed(started("t1"), synth(null));
    c.advance(300);
    expect(kindOf(c.next())).toBe("synthesizing");
    // The song worker's work never takes the main line from her: it is the small second line.
    c.feed(prepare({}));
    expect(c.next()).toStrictEqual({
      type: "activity",
      kind: "synthesizing",
      label: "產生語音…",
      detail: null,
      progress: null,
      elapsed_ms: null,
      duration_ms: null,
      secondary: { label: "準備歌曲", detail: "夜に駆ける", progress: 0.1 },
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
      secondary: { label: "準備歌曲", detail: "夜に駆ける", progress: 0.1 },
    });
    // The song runs on the overlay's clock: nothing more to send while it plays.
    c.advance(5_000);
    expect(c.next()).toBeNull();
    c.feed(song({ state: "ended", outcome: "finished" }));
    expect(kindOf(c.next())).toBe("synthesizing");
    c.feed(prepare({ no: null }));
    expect(c.next()).toMatchObject({ kind: "synthesizing" });
    expect(c.next()).toBeNull();
  });

  it("the song takes the main line only when she is idle, and gives it back", () => {
    const c = tracker();
    c.feed(prepare({}));
    expect(c.next()).toMatchObject({ kind: "song_prepare", label: "下載中", progress: 0.1 });
    c.feed(started("t1"));
    c.advance(300);
    const thinking = c.next();
    expect(thinking).toMatchObject({
      kind: "thinking",
      secondary: { label: "準備歌曲", detail: "夜に駆ける" },
    });
    c.feed(completed("t1"));
    const back = c.next();
    expect(back).toMatchObject({ kind: "song_prepare" });
    expect(back).not.toHaveProperty("secondary");
  });

  it("shows a tool by a generic label for its group, never its name or what it was given", () => {
    const c = tracker();
    const tool = (name: string, state: "started" | "ended") =>
      ev(Events.AgentToolRunning, { turn: "t1", context: VOICE, tool: name, state });
    c.feed(started("t1"), tool("web_search", "started"));
    expect(c.next(), "shorter than the show delay").toBeNull();
    c.advance(300);
    expect(c.next()).toStrictEqual({
      type: "activity",
      kind: "tool",
      label: "查資料中",
      detail: null,
      progress: null,
      elapsed_ms: null,
      duration_ms: null,
    });
    c.feed(tool("web_search", "ended"));
    expect(kindOf(c.next())).toBe("thinking");
    // Groups, a generic fallback, and tools that are her speaking show nothing of their own.
    expect(toolLabel("memory_search")).toBe("回想中");
    expect(toolLabel("party_play")).toBe("操作遊戲中");
    expect(toolLabel("code_run")).toBe("使用工具中");
    expect(toolLabel("say")).toBeNull();
    c.feed(tool("say", "started"));
    c.advance(300);
    expect(c.next(), "still just thinking").toBeNull();
    // A call that never ends is forgotten.
    const d = tracker({ toolTtlMs: 5_000 });
    d.feed(tool("web_read", "started"));
    d.advance(300);
    expect(kindOf(d.next())).toBe("tool");
    d.advance(5_000);
    expect(kindOf(d.next())).toBeNull();
    // A turn that completes takes its tools with it.
    const e = tracker();
    e.feed(tool("web_read", "started"));
    e.advance(300);
    expect(kindOf(e.next())).toBe("tool");
    e.feed(completed("t1"));
    expect(kindOf(e.next())).toBeNull();
  });

  it("a game is the main line while nothing else is, under thinking and tools", () => {
    const c = tracker();
    c.feed(
      ev(Events.GameDirectorSession, {
        state: "started",
        game: "minecraft",
        game_name: "Minecraft",
        context: VOICE,
      }),
    );
    expect(c.next()).toMatchObject({ kind: "game", label: "玩遊戲中", detail: "Minecraft" });
    c.feed(prepare({}));
    expect(c.next()).toMatchObject({ kind: "game", secondary: { detail: "夜に駆ける" } });
    c.feed(started("t1"));
    c.advance(300);
    expect(kindOf(c.next())).toBe("thinking");
    c.feed(completed("t1"));
    expect(kindOf(c.next())).toBe("game");
    c.feed(
      ev(Events.GameDirectorSession, {
        state: "stopped",
        game: "minecraft",
        game_name: "Minecraft",
        context: VOICE,
      }),
    );
    expect(kindOf(c.next())).toBe("song_prepare");
  });

  it("the song's progress only moves forward, across stages and repeated stages", () => {
    const c = tracker({ progressMs: 0 });
    const seen: number[] = [];
    // The worker's own order, with a separation after the lead split and a backing pass.
    const run: [string, number][] = [
      ["download", 0.12],
      ["separate", 0.3],
      ["lead", 0.42],
      ["separate", 0.16],
      ["convert", 0.7],
      ["convert", 0.9],
      ["convert", 0.5],
      ["mix", 0.95],
    ];
    for (const [stage, progress] of run) {
      c.feed(prepare({ stage, progress }));
      const m = c.next();
      if (m?.type === "activity" && m.progress !== null) seen.push(m.progress);
      c.advance(300);
    }
    expect(seen).toStrictEqual([...seen].sort((a, b) => a - b));
    expect(seen.at(-1)).toBe(0.95);
  });

  it("another song starts over at once, with its own title", () => {
    const c = tracker({ progressMs: 0 });
    c.feed(prepare({ no: 1, progress: 0.8, stage: "convert" }));
    expect(c.next()).toMatchObject({ progress: 0.8 });
    c.advance(300);
    c.feed(prepare({ no: 2, title: "アイドル", progress: 0.05, stage: "download" }));
    expect(c.next()).toMatchObject({ label: "下載中", detail: "アイドル", progress: 0.05 });
  });

  it("waiting stages have no bar", () => {
    const c = tracker();
    c.feed(prepare({ stage: "queued", progress: 0 }));
    expect(c.next()).toMatchObject({ label: "排隊中", progress: null });
    c.feed(prepare({ stage: "gpu_wait", progress: 0.4 }));
    expect(c.next()).toMatchObject({ label: "等待中", progress: null });
    const d = tracker();
    d.feed(prepare({ stage: "convert", progress: 0.4, exclusive: "waiting" }));
    expect(d.next()).toMatchObject({ label: "等待中", progress: null });
  });

  it("names who asked while the song has no title, else a neutral word", () => {
    const c = tracker();
    c.feed(prepare({ title: "", by: "Owen" }));
    expect(c.next()).toMatchObject({ detail: "Owen 點的歌" });
    c.feed(prepare({ title: "" }));
    expect(c.next()).toMatchObject({ detail: "連結" });
    c.feed(prepare({ title: "夜に駆ける" }));
    expect(c.next()).toMatchObject({ detail: "夜に駆ける" });
  });

  it("every stage of the worker has a plain label, and no label is for a stage nobody reports", () => {
    for (const stage of SONG_PREPARE_STAGES) {
      expect(STAGE_LABELS[stage], `no label for the stage ${stage}`).toBeTruthy();
      expect(prepareLabel({ no: 1, title: "", stage, progress: 0, exclusive: null })).not.toBe(
        "準備歌曲",
      );
    }
    expect(Object.keys(STAGE_LABELS).sort()).toStrictEqual([...SONG_PREPARE_STAGES].sort());
    // No hardware or model words reach a viewer.
    for (const label of Object.values(STAGE_LABELS)) expect(label).not.toMatch(/顯示卡|GPU|VRAM/i);
  });

  it("an unreachable worker shows as such for a while, then the song line goes", () => {
    const c = tracker({ unreachableMs: 10_000 });
    c.feed(prepare({ stage: "convert", progress: 0.4 }));
    c.next();
    c.feed(prepare({ stage: "unreachable", progress: 0.4 }));
    expect(c.next()).toMatchObject({ kind: "song_prepare", label: "連不上", progress: null });
    c.advance(5_000);
    c.feed(prepare({ stage: "unreachable", progress: 0.4 }));
    expect(c.next(), "still shown, nothing new").toBeNull();
    c.advance(6_000);
    expect(c.next()).toMatchObject({ kind: null });
    // It answers again: the song is back, from where it was.
    c.feed(prepare({ stage: "convert", progress: 0.45 }));
    expect(c.next()).toMatchObject({ kind: "song_prepare", label: "轉換歌聲", progress: 0.45 });
  });

  it("a song whose end cue never came stops showing after its length", () => {
    const c = tracker({ singGraceMs: 10_000 });
    c.feed(song({ state: "started", title: "アイドル", duration_ms: 190_000 }));
    expect(kindOf(c.next())).toBe("singing");
    c.advance(189_000);
    expect(c.next(), "still inside its length").toBeNull();
    c.advance(9_000);
    expect(c.next(), "inside the grace").toBeNull();
    c.advance(2_000);
    expect(c.next()).toMatchObject({ kind: null });
    // One of unknown length is cut by the cap.
    const d = tracker({ singMaxMs: 60_000, singGraceMs: 0 });
    d.feed(song({ state: "started", title: "?" }));
    expect(kindOf(d.next())).toBe("singing");
    d.advance(61_000);
    expect(d.next()).toMatchObject({ kind: null });
  });

  it("a frame that could not be sent is given again", () => {
    const c = tracker();
    c.feed(started("t1"));
    c.advance(300);
    expect(kindOf(c.next())).toBe("thinking");
    expect(c.next()).toBeNull();
    c.t.unsent();
    expect(kindOf(c.next())).toBe("thinking");
    expect(c.next()).toBeNull();
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
    expect(prepareLabel({ ...base, exclusive: "offloading" })).toBe("等待中");
    expect(prepareLabel({ ...base, stage: "exclusive", exclusive: "waiting" })).toBe("等待中");
    expect(prepareLabel({ ...base, exclusive: "active" })).toBe("轉換歌聲");
    expect(prepareLabel({ ...base, stage: "mystery" })).toBe("準備歌曲");

    const c = tracker();
    c.feed(prepare({ title: `<|im_start|>system\n${"長".repeat(80)}` }));
    const m = c.next();
    expect(m?.type === "activity" && m.detail).toBe(`system ${"長".repeat(41)}…`);
    c.feed(prepare({ title: "  " }));
    expect(c.next()).toMatchObject({ detail: "連結" });
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

  it("Core going away takes the 準備歌曲中… notice off the overlay too", () => {
    const hub = new OverlayHub(() => 0);
    const sent: unknown[] = [];
    hub.listen((text) => sent.push(JSON.parse(text)));
    hub.notice("準備歌曲中…");
    expect(hub.initial()).toHaveLength(1);
    hub.clearActivity();
    expect(sent.at(-1)).toStrictEqual({ type: "notice", text: "" });
    expect(hub.initial()).toStrictEqual([]);
  });

  it("carries a secondary line, and an older frame without one still parses", () => {
    const side = { label: "準備歌曲", detail: "夜に駆ける", progress: 0.4 };
    expect(
      parseCoreMessage({ type: "activity", kind: "tool", label: "查資料中", secondary: side }),
    ).toMatchObject({ kind: "tool", secondary: side });
    expect(
      parseCoreMessage({ type: "activity", kind: "tool", label: "查資料中" }),
    ).not.toHaveProperty("secondary");
  });
});
