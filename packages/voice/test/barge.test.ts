// Barge-in: the decision function, ducking / pausing / resuming, echo detection and the TTS
// prefetch cache (docs/design/v2-architecture.md §3.9).

import type { AudioChunk } from "@miyoria/speech";
import type { AccountRef, ContextKey, VoiceBargeIn } from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BargeIn,
  type BargeTarget,
  type BargeThresholds,
  type BargeWho,
  BufferedAudio,
  createVad,
  decideBargeIn,
  EnergyVad,
  LinePrefetch,
  looksLikeHintEcho,
  type Production,
  registerVadEngine,
  SelfEchoGuard,
  type SpeakerRole,
} from "../src/index.js";

const T: BargeThresholds = { duckMs: 250, pauseMs: 600, focusStopMs: 3000 };

function vad(
  speaker: SpeakerRole,
  speechRunMs: number,
  over: { music?: boolean; mode?: "selective" | "stop" | "ignore" } = {},
) {
  return decideBargeIn({
    stage: "vad",
    mode: over.mode ?? "selective",
    speaker,
    speechRunMs,
    music: over.music ?? false,
    thresholds: T,
  });
}

function asr(
  speaker: SpeakerRole,
  text: string,
  over: { named?: boolean; echo?: boolean; music?: boolean } = {},
) {
  return decideBargeIn({
    stage: "asr",
    mode: "selective",
    speaker,
    text,
    named: over.named ?? false,
    echo: over.echo ?? false,
    music: over.music ?? false,
  });
}

describe("decideBargeIn", () => {
  it("the focus person pauses her after the threshold and stops her when they keep going", () => {
    expect(vad("focus", 300)).toEqual({ action: "none", reason: "focus" });
    expect(vad("focus", 600)).toEqual({ action: "pause", reason: "focus" });
    expect(vad("focus", 2999).action).toBe("pause");
    expect(vad("focus", 3000)).toEqual({ action: "stop", reason: "focus" });
  });

  it("anybody else only ducks her", () => {
    expect(vad("other", 100).action).toBe("none");
    expect(vad("other", 250)).toEqual({ action: "duck", reason: "other" });
    expect(vad("other", 20_000).action).toBe("duck");
    // No focus known: conservative, duck and do not stop.
    expect(vad("unknown", 250)).toEqual({ action: "duck", reason: "no_focus" });
    expect(vad("unknown", 20_000).action).toBe("duck");
  });

  it("a song and the ignore mode do nothing; the legacy mode stops for anyone", () => {
    expect(vad("focus", 5000, { music: true })).toEqual({ action: "none", reason: "music" });
    expect(vad("focus", 5000, { mode: "ignore" }).action).toBe("none");
    expect(vad("other", 600, { mode: "stop" })).toEqual({ action: "stop", reason: "legacy" });
    expect(vad("other", 599, { mode: "stop" }).action).toBe("none");
  });

  it("her name stops her whoever says it", () => {
    for (const who of ["focus", "other", "unknown"] as const) {
      expect(asr(who, "小深你先停", { named: true })).toEqual({ action: "stop", reason: "name" });
    }
  });

  it("the focus person's substantive content stops her; a short reply does not", () => {
    expect(asr("focus", "等一下我有話要說")).toEqual({ action: "stop", reason: "substantive" });
    expect(asr("focus", "嗯")).toEqual({ action: "resume", reason: "short_reply" });
    expect(asr("focus", "對啊對啊")).toEqual({ action: "resume", reason: "short_reply" });
    expect(asr("focus", "哈哈哈哈哈")).toEqual({ action: "resume", reason: "short_reply" });
  });

  it("content from anybody else, or from nobody known, never stops her", () => {
    expect(asr("other", "我們來打王吧大家準備")).toEqual({ action: "resume", reason: "other" });
    expect(asr("unknown", "我們來打王吧大家準備")).toEqual({
      action: "resume",
      reason: "no_focus",
    });
  });

  it("an echo is not speech, even when it contains her name", () => {
    expect(asr("focus", "我跟你說喔", { echo: true })).toEqual({
      action: "resume",
      reason: "echo",
    });
    expect(asr("other", "小深小深", { echo: true, named: true }).action).toBe("resume");
  });

  it("while a song plays only her name counts", () => {
    expect(asr("focus", "這首歌好好聽喔大家", { music: true })).toEqual({
      action: "resume",
      reason: "music",
    });
    expect(asr("other", "小深跳過", { music: true, named: true }).action).toBe("stop");
  });
});

// ------------------------------------------------------------ ducking / pausing / resuming

const ctx: ContextKey = { platform: "discord", scope: "g1", channel: "vc1", kind: "voice" };
const alice: AccountRef = { platform: "discord", id: "alice" };
const bob: AccountRef = { platform: "discord", id: "bob" };

class FakePlayback implements BargeTarget {
  log: string[] = [];
  canPause = true;

  stop(fadeMs: number): void {
    this.log.push(`stop(${fadeMs})`);
  }

  duck(gain: number, fadeMs: number): boolean {
    this.log.push(`duck(${gain},${fadeMs})`);
    return true;
  }

  pause(fadeMs: number): boolean {
    if (!this.canPause) return false;
    this.log.push(`pause(${fadeMs})`);
    return true;
  }

  resume(fadeMs: number): boolean {
    this.log.push(`resume(${fadeMs})`);
    return true;
  }
}

function who(speaker: AccountRef, role: SpeakerRole, over: Partial<BargeWho> = {}): BargeWho {
  return { speaker, role, context: ctx, turn: { id: "turn-1", phase: "speaking" }, ...over };
}

describe("BargeIn", () => {
  let records: VoiceBargeIn[];
  let now = 0;
  const make = (mode: "selective" | "stop" | "ignore" = "selective") =>
    new BargeIn(
      mode,
      600,
      150,
      { settleMs: 1000, asrTimeoutMs: 5000, publish: (r) => records.push(r) },
      () => now,
    );

  beforeEach(() => {
    vi.useFakeTimers();
    records = [];
    now = 0;
  });
  afterEach(() => vi.useRealTimers());

  it("ducks for somebody else and brings the volume back when their talk was not for her", () => {
    const b = make();
    const p = new FakePlayback();
    b.register("g1", p, { context: ctx, turn: "turn-1" });
    expect(b.observe("g1", 100, who(alice, "other"))).toBe(false);
    expect(p.log).toEqual([]);
    expect(b.observe("g1", 300, who(alice, "other"))).toBe(false);
    expect(b.observe("g1", 900, who(alice, "other"))).toBe(false);
    expect(p.log).toEqual(["duck(0.3,120)"]); // once
    b.speechEnded("g1", alice);
    b.utterance("g1", alice);
    const d = b.verdict("g1", {
      ...who(alice, "other"),
      text: "我們來打王吧",
      named: false,
      echo: false,
    });
    expect(d.action).toBe("resume");
    expect(p.log).toEqual(["duck(0.3,120)", "duck(1,120)"]);
    expect(records.map((r) => [r.action, r.reason, r.account?.id])).toEqual([
      ["duck", "other", "alice"],
      ["resume", "other", "alice"],
    ]);
    expect(records[0]).toMatchObject({ context: ctx, turn: "turn-1" });
  });

  it("pauses for the focus person and resumes when the transcript was a short reply", () => {
    const b = make();
    const p = new FakePlayback();
    b.register("g1", p, { context: ctx, turn: "turn-1" });
    expect(b.observe("g1", 700, who(alice, "focus"))).toBe(false);
    expect(p.log).toEqual(["duck(0.3,120)", "pause(120)"]);
    b.speechEnded("g1", alice);
    b.utterance("g1", alice);
    b.verdict("g1", { ...who(alice, "focus"), text: "嗯", named: false, echo: false });
    expect(p.log).toEqual(["duck(0.3,120)", "pause(120)", "resume(120)", "duck(1,120)"]);
    expect(records.map((r) => [r.action, r.reason])).toEqual([
      ["pause", "focus"],
      ["resume", "short_reply"],
    ]);
  });

  it("stops for the focus person's substantive transcript, once, and remembers the turn", () => {
    const b = make();
    const p = new FakePlayback();
    b.register("g1", p, { context: ctx, turn: "turn-1" });
    b.observe("g1", 700, who(alice, "focus"));
    b.speechEnded("g1", alice);
    b.utterance("g1", alice);
    b.verdict("g1", {
      ...who(alice, "focus"),
      text: "等一下我有話要說",
      named: false,
      echo: false,
    });
    expect(p.log.filter((l) => l.startsWith("stop"))).toEqual(["stop(150)"]);
    expect(records.at(-1)).toMatchObject({ action: "stop", reason: "substantive", turn: "turn-1" });
    expect(b.isStopped("g1", "turn-1")).toBe(true);
    expect(b.isStopped("g1", "turn-2")).toBe(false);
    expect(b.isStopped("g1", null)).toBe(false);
    now = 31_000;
    expect(b.isStopped("g1", "turn-1")).toBe(false); // forgotten after a while
  });

  it("a long monologue by the focus person stops her without waiting for ASR", () => {
    const b = make();
    const p = new FakePlayback();
    b.register("g1", p, { context: ctx, turn: "turn-1" });
    b.observe("g1", 700, who(alice, "focus"));
    expect(b.observe("g1", 3100, who(alice, "focus"))).toBe(true);
    expect(records.at(-1)).toMatchObject({ action: "stop", reason: "focus" });
  });

  it("her name from somebody she was only ducked for stops her", () => {
    const b = make();
    const p = new FakePlayback();
    b.register("g1", p, { context: ctx, turn: "turn-1" });
    b.observe("g1", 400, who(bob, "other"));
    b.utterance("g1", bob);
    b.verdict("g1", { ...who(bob, "other"), text: "小深停一下", named: true, echo: false });
    expect(p.log).toContain("stop(150)");
    expect(records.at(-1)).toMatchObject({ action: "stop", reason: "name" });
  });

  it("two people at once: the volume comes back only when both are let go; a pause beats a duck", () => {
    const b = make();
    const p = new FakePlayback();
    b.register("g1", p, { context: ctx, turn: "turn-1" });
    b.observe("g1", 400, who(bob, "other"));
    b.observe("g1", 700, who(alice, "focus"));
    expect(p.log).toEqual(["duck(0.3,120)", "pause(120)"]);
    b.dropped("g1", alice, "echo");
    // Alice is let go, Bob is still talking: she goes on, ducked.
    expect(p.log).toEqual(["duck(0.3,120)", "pause(120)", "resume(120)"]);
    b.dropped("g1", bob, "echo");
    expect(p.log.at(-1)).toBe("duck(1,120)");
  });

  it("a hold nobody settles is let go by itself", () => {
    const b = make();
    const p = new FakePlayback();
    b.register("g1", p, { context: ctx, turn: "turn-1" });
    b.observe("g1", 400, who(bob, "other"));
    b.speechEnded("g1", bob); // no utterance follows (too short)
    vi.advanceTimersByTime(1001);
    expect(p.log).toEqual(["duck(0.3,120)", "duck(1,120)"]);
    expect(records.at(-1)).toMatchObject({ action: "resume", reason: "timeout" });
    // A transcript that never arrives: also let go.
    b.observe("g1", 400, who(bob, "other"));
    b.speechEnded("g1", bob);
    b.utterance("g1", bob);
    vi.advanceTimersByTime(5001);
    expect(p.log.at(-1)).toBe("duck(1,120)");
    expect(records.filter((r) => r.action === "resume")).toHaveLength(2);
  });

  it("talking again while the transcript is awaited keeps the hold", () => {
    const b = make();
    const p = new FakePlayback();
    b.register("g1", p, { context: ctx, turn: "turn-1" });
    b.observe("g1", 400, who(bob, "other"));
    b.speechEnded("g1", bob);
    b.observe("g1", 100, who(bob, "other")); // another run starts
    vi.advanceTimersByTime(2000);
    expect(p.log).toEqual(["duck(0.3,120)"]);
  });

  it("a line that starts while somebody talks is ducked from the start", () => {
    const b = make();
    const first = new FakePlayback();
    const t1 = b.register("g1", first, { context: ctx, turn: "turn-1" });
    b.observe("g1", 400, who(bob, "other"));
    b.unregister("g1", t1);
    const next = new FakePlayback();
    b.register("g1", next, { context: ctx, turn: "turn-1" });
    expect(next.log).toEqual(["duck(0.3,120)"]);
    b.dropped("g1", bob, "echo");
    expect(next.log).toEqual(["duck(0.3,120)", "duck(1,120)"]);
  });

  it("a node that cannot pause turns the focus person's pause into a stop", () => {
    const b = make();
    const p = new FakePlayback();
    p.canPause = false;
    b.register("g1", p, { context: ctx, turn: "turn-1" });
    b.observe("g1", 700, who(alice, "focus"));
    expect(p.log).toContain("stop(150)");
  });

  it("nothing playing: nothing happens; ignore mode never acts; the legacy mode stops anyone", () => {
    const b = make();
    expect(b.observe("g1", 5000, who(alice, "focus"))).toBe(false);
    expect(records).toEqual([]);
    const ignore = make("ignore");
    const p = new FakePlayback();
    ignore.register("g1", p);
    expect(ignore.observe("g1", 5000, who(alice, "focus"))).toBe(false);
    expect(p.log).toEqual([]);
    const legacy = make("stop");
    const q = new FakePlayback();
    legacy.register("g1", q, { context: ctx, turn: "turn-1" });
    expect(legacy.observe("g1", 650, who(bob, "other"))).toBe(true);
    expect(records.at(-1)).toMatchObject({ action: "stop", reason: "legacy" });
  });

  it("stops between two lines of a speaking turn still count for the next line", () => {
    const b = make();
    // No playback right now (a gap between two lines), but the turn is speaking.
    b.register("g1", new FakePlayback(), { context: ctx, turn: "turn-1" });
    const token = b.register("g1", new FakePlayback(), { context: ctx, turn: "turn-1" });
    b.unregister("g1", token);
    b.verdict("g1", {
      ...who(alice, "focus"),
      text: "等一下我有話要說",
      named: false,
      echo: false,
    });
    expect(b.isStopped("g1", "turn-1")).toBe(true);
    expect(records.at(-1)).toMatchObject({ action: "stop" });
  });
});

// ------------------------------------------------------------------------------- echoes

describe("echo detection", () => {
  const prompt = "御坂10514號、DeepSeek醬、Miyo、米優";

  it("recognizes the ASR prompt printed back, whatever its terms", () => {
    expect(looksLikeHintEcho("御坂10514號、v(t) = Vm·sin(ωt + φ)、DeepSeek醬", prompt)).toBe(true);
    expect(looksLikeHintEcho("御坂10514號 DeepSeek醬 Miyo 米優", prompt)).toBe(true);
    // Another list of terms from the same prompt, in another order.
    expect(looksLikeHintEcho("米優、DeepSeek醬、御坂10514號", prompt)).toBe(true);
  });

  it("does not drop people talking, nor somebody just calling her by a hotword", () => {
    expect(looksLikeHintEcho("DeepSeek醬", prompt)).toBe(false);
    expect(looksLikeHintEcho("米優你好", prompt)).toBe(false);
    expect(looksLikeHintEcho("這個遊戲好難", prompt)).toBe(false);
    expect(looksLikeHintEcho("你有看到御坂10514號剛剛說的嗎", prompt)).toBe(false);
    expect(looksLikeHintEcho("anything at all here", null)).toBe(false);
  });

  it("her own voice coming back is an echo while she speaks and shortly after", () => {
    let now = 1000;
    const g = new SelfEchoGuard({ now: () => now, tailMs: 5000 });
    expect(g.isEcho("g1", "我跟你說喔")).toBe(false); // she has said nothing
    g.started("g1", ["我跟你說喔其實很簡單", "ja: 私が言うとね"]);
    expect(g.isEcho("g1", "我跟你說喔")).toBe(true);
    expect(g.isEcho("g1", "我跟你說喔其實很簡單")).toBe(true);
    expect(g.isEcho("g1", "今天天氣真好欸")).toBe(false);
    expect(g.isEcho("g1", "好")).toBe(false); // too short to tell
    expect(g.isEcho("g2", "我跟你說喔")).toBe(false); // another guild
    g.ended("g1");
    now += 3000;
    expect(g.isEcho("g1", "我跟你說喔")).toBe(true); // reverb and ASR latency
    now += 3000;
    expect(g.isEcho("g1", "我跟你說喔")).toBe(false); // long gone
  });
});

// -------------------------------------------------------------------------- VAD engine seam

describe("VAD engine seam", () => {
  const settings = {
    engine: "energy",
    sampleRate: 16_000,
    sileroModel: null,
    sileroThreshold: 0.5,
  } as const;

  it("builds the energy detector by default and falls back when an engine is missing", () => {
    expect(createVad(settings)).toBeInstanceOf(EnergyVad);
    const missing: string[] = [];
    expect(createVad({ ...settings, engine: "silero" }, (e) => missing.push(e))).toBeInstanceOf(
      EnergyVad,
    );
    expect(missing).toEqual(["silero"]);
  });

  it("uses a registered engine, and falls back when it fails to load", () => {
    const fake = { frameLen: 512, isSpeech: () => true };
    registerVadEngine("silero", () => fake);
    expect(createVad({ ...settings, engine: "silero" })).toBe(fake);
    registerVadEngine("silero", () => {
      throw new Error("no model");
    });
    const missing: string[] = [];
    expect(createVad({ ...settings, engine: "silero" }, (e) => missing.push(e))).toBeInstanceOf(
      EnergyVad,
    );
    expect(missing).toEqual(["silero"]);
  });
});

// ------------------------------------------------------------------------------ TTS prefetch

function audio(): BufferedAudio {
  return new BufferedAudio();
}

const chunk = (n: number): AudioChunk => ({ sampleRate: 24_000, samples: new Int16Array(n) });

/** A producer whose synthesis the test finishes by hand. */
function manual(name: string, log: string[]) {
  let finish: () => void = () => undefined;
  let signal: AbortSignal | null = null;
  const buf = audio();
  const producer = async (s: AbortSignal): Promise<Production> => {
    signal = s;
    log.push(`start ${name}`);
    buf.push(chunk(10));
    const done = new Promise<void>((resolve) => {
      finish = () => {
        buf.end();
        resolve();
      };
      s.addEventListener("abort", () => resolve(), { once: true });
    });
    return { line: { provider: "p", said: name, sampleRate: 24_000, audio: buf }, done };
  };
  return {
    producer,
    finish: () => finish(),
    get signal() {
      return signal;
    },
  };
}

describe("LinePrefetch", () => {
  it("synthesizes lines in the order asked, at most `limit` at a time", async () => {
    const p = new LinePrefetch({ limit: 1, ttlMs: 0 });
    const log: string[] = [];
    const a = manual("a", log);
    const b = manual("b", log);
    p.start("a", "g1", a.producer);
    p.start("b", "g1", b.producer);
    await vi.waitFor(() => expect(log).toEqual(["start a"]));
    // b waits for a's slot.
    const taken = p.take("a");
    expect((await taken)?.said).toBe("a");
    expect(log).toEqual(["start a"]);
    a.finish();
    await vi.waitFor(() => expect(log).toEqual(["start a", "start b"]));
    b.finish();
    expect((await p.take("b"))?.said).toBe("b");
    expect(p.take("b")).toBeNull(); // taken once
    expect(p.size).toBe(0);
  });

  it("runs up to the limit concurrently", async () => {
    const p = new LinePrefetch({ limit: 2, ttlMs: 0 });
    const log: string[] = [];
    const lines = ["a", "b", "c"].map((n) => manual(n, log));
    for (const [i, l] of lines.entries()) p.start(String(i), "g1", l.producer);
    await vi.waitFor(() => expect(log).toEqual(["start a", "start b"]));
    lines[0]?.finish();
    await vi.waitFor(() => expect(log).toEqual(["start a", "start b", "start c"]));
  });

  it("cancelling a group aborts what is being synthesized and drops what waits", async () => {
    const p = new LinePrefetch({ limit: 1, ttlMs: 0 });
    const log: string[] = [];
    const a = manual("a", log);
    const b = manual("b", log);
    const other = manual("o", log);
    p.start("a", "g1", a.producer);
    p.start("b", "g1", b.producer);
    await vi.waitFor(() => expect(log).toEqual(["start a"]));
    p.cancelGroup("g1");
    expect(a.signal?.aborted).toBe(true);
    expect(p.size).toBe(0);
    expect(p.take("a")).toBeNull();
    // b never started and never will; the freed slot serves the next line.
    p.start("o", "g2", other.producer);
    await vi.waitFor(() => expect(log).toEqual(["start a", "start o"]));
    expect(b.signal).toBeNull();
  });

  it("drops a line nobody takes after the ttl", async () => {
    vi.useFakeTimers();
    try {
      const p = new LinePrefetch({ limit: 1, ttlMs: 1000 });
      const a = manual("a", []);
      p.start("a", "g1", a.producer);
      await vi.advanceTimersByTimeAsync(0);
      expect(p.has("a")).toBe(true);
      await vi.advanceTimersByTimeAsync(1001);
      expect(p.has("a")).toBe(false);
      expect(a.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failed synthesis rejects the take, and does not leave an unhandled rejection", async () => {
    const p = new LinePrefetch({ limit: 1, ttlMs: 0 });
    p.start("a", "g1", async () => {
      throw new Error("tts down");
    });
    p.start("b", "g1", async () => {
      throw new Error("tts down again");
    });
    await expect(p.take("a")).rejects.toThrow("tts down");
    await new Promise((r) => setTimeout(r, 10)); // b is never taken
  });

  it("keeps at most twice the limit, dropping the oldest", async () => {
    const p = new LinePrefetch({ limit: 1, ttlMs: 0 });
    const lines = ["a", "b", "c"].map((n) => manual(n, []));
    for (const [i, l] of lines.entries()) p.start(String(i), "g1", l.producer);
    expect(p.has("0")).toBe(false);
    expect(p.has("1")).toBe(true);
    expect(p.has("2")).toBe(true);
  });
});

describe("BufferedAudio", () => {
  it("replays everything pushed, then ends; abandoning stops the producer", async () => {
    const buf = new BufferedAudio();
    buf.push(chunk(1));
    buf.push(chunk(2));
    const it = buf[Symbol.asyncIterator]();
    expect((await it.next()).value?.samples.length).toBe(1);
    const pending = it.next();
    expect((await pending).value?.samples.length).toBe(2);
    const waiting = it.next();
    buf.push(chunk(3));
    expect((await waiting).value?.samples.length).toBe(3);
    buf.end();
    expect((await it.next()).done).toBe(true);

    let abandoned = false;
    const other = new BufferedAudio(() => {
      abandoned = true;
    });
    other.push(chunk(1));
    const o = other[Symbol.asyncIterator]();
    await o.next();
    await o.return?.();
    expect(abandoned).toBe(true);
    expect(other.abandoned).toBe(true);
  });

  it("surfaces a producer failure to the reader after the audio that arrived", async () => {
    const buf = new BufferedAudio();
    buf.push(chunk(1));
    buf.fail(new Error("stream broke"));
    const it = buf[Symbol.asyncIterator]();
    expect((await it.next()).done).toBe(false);
    await expect(it.next()).rejects.toThrow("stream broke");
  });
});
