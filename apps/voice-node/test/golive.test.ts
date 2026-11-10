import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { DvsEngine, ffmpegErrorMessage, LOW_LATENCY_INPUT, PASSTHROUGH_FLAGS } from "../src/golive/dvs-engine.js";
import { cachedProbe, resolveEncoder } from "../src/golive/encoder.js";
import {
  type Attach,
  type GoLiveEvent,
  type GoLiveHost,
  GoLiveManager,
  type StreamEngine,
} from "../src/golive/manager.js";
import { normalizeSource, planGoLive } from "../src/golive/plan.js";
import { type GoLiveStartMessage, parseCoreMessage } from "../src/protocol.js";

const cfg = loadConfig({ SELF_TOKEN: "x" }).golive;
const req = (over: Partial<GoLiveStartMessage> = {}): GoLiveStartMessage => ({
  type: "golive_start",
  guild: "g1",
  source: "srt://127.0.0.1:9999",
  ...over,
});

describe("golive protocol parsing", () => {
  it("parses golive_start with all optional fields", () => {
    const r = parseCoreMessage(
      JSON.stringify({
        type: "golive_start", guild: "g1", channel: "vc1", source: "rtmp://127.0.0.1/live/x",
        width: 1920, height: 1080, fps: 60, bitrate_kbps: 6000, encoder: "nvenc", audio: false, listen: true,
      }),
    );
    expect(r).toEqual({
      ok: true,
      value: {
        type: "golive_start", guild: "g1", channel: "vc1", source: "rtmp://127.0.0.1/live/x",
        width: 1920, height: 1080, fps: 60, bitrate_kbps: 6000, encoder: "nvenc", audio: false, listen: true,
      },
    });
  });

  it("parses the minimal form, treating null as absent", () => {
    const r = parseCoreMessage('{"type":"golive_start","guild":"g1","source":"a.mp4","channel":null,"fps":null}');
    expect(r).toEqual({ ok: true, value: { type: "golive_start", guild: "g1", source: "a.mp4" } });
  });

  it("rejects malformed golive_start", () => {
    for (const bad of [
      { guild: "g", source: "" },
      { guild: "g" },
      { source: "a" },
      { guild: "g", source: "a", fps: 0 },
      { guild: "g", source: "a", fps: 1.5 },
      { guild: "g", source: "a", width: "1920" },
      { guild: "g", source: "a", encoder: "quicksync" },
      { guild: "g", source: "a", audio: "yes" },
      { guild: "g", source: "x".repeat(3000) },
    ]) {
      const r = parseCoreMessage(JSON.stringify({ type: "golive_start", ...bad }));
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("parses golive_stop", () => {
    expect(parseCoreMessage('{"type":"golive_stop","guild":"g1"}')).toEqual({
      ok: true,
      value: { type: "golive_stop", guild: "g1" },
    });
    expect(parseCoreMessage('{"type":"golive_stop"}').ok).toBe(false);
  });
});

describe("normalizeSource", () => {
  it("makes ffmpeg the RTMP server by default, a client with listen:false", () => {
    expect(normalizeSource("rtmp://127.0.0.1:1935/live/miyoria")).toEqual({
      ok: true, source: "rtmp://127.0.0.1:1935/live/miyoria", inputOptions: ["-listen", "1"], live: true,
    });
    expect(normalizeSource("rtmp://127.0.0.1/live/x", false)).toMatchObject({ inputOptions: [], live: true });
  });

  it("adds mode=listener to SRT urls (mode=caller with listen:false) unless mode is explicit", () => {
    expect(normalizeSource("srt://127.0.0.1:9999")).toMatchObject({ source: "srt://127.0.0.1:9999?mode=listener" });
    expect(normalizeSource("srt://127.0.0.1:9999?latency=120")).toMatchObject({
      source: "srt://127.0.0.1:9999?latency=120&mode=listener",
    });
    expect(normalizeSource("srt://127.0.0.1:9999?mode=caller")).toMatchObject({ source: "srt://127.0.0.1:9999?mode=caller" });
    expect(normalizeSource("srt://10.0.0.5:9999", false)).toMatchObject({ source: "srt://10.0.0.5:9999?mode=caller" });
    expect(normalizeSource("srt://127.0.0.1:9999?")).toMatchObject({ source: "srt://127.0.0.1:9999?mode=listener" });
  });

  it("accepts udp / rtsp / http(s) / file urls and local paths unchanged", () => {
    for (const s of ["udp://127.0.0.1:5000", "rtsp://cam/1", "https://x.test/a.m3u8", "file:///c:/a.mp4", "sample.mp4", "C:\\video\\a.mp4", "D:/a b/c.mkv"]) {
      expect(normalizeSource(s), s).toMatchObject({ ok: true, source: s });
    }
    expect(normalizeSource("udp://127.0.0.1:5000")).toMatchObject({ live: true });
    expect(normalizeSource("sample.mp4")).toMatchObject({ live: false });
  });

  it("rejects anything that could change the ffmpeg command line or is not a source", () => {
    for (const s of [
      "", "   ", "-i evil", "--help", "pipe:0", "concat:a|b", "lavfi:color", "subfile,,start,0:a.mp4",
      "ftp://x/a", "tcp://1.2.3.4:5", "data:text/plain,hi", "rtmp://a/b\nc", "a\u0000b", `rtmp://${"x".repeat(2100)}`,
    ]) {
      expect(normalizeSource(s).ok, JSON.stringify(s)).toBe(false);
    }
  });
});

describe("planGoLive", () => {
  it("applies config defaults (height from config, width follows the aspect ratio)", () => {
    const r = planGoLive(req(), cfg);
    expect(r.ok && r.plan).toMatchObject({
      guild: "g1", source: "srt://127.0.0.1:9999?mode=listener", height: 1080, width: undefined, fps: 60,
      bitrateKbps: 6000, bitrateMaxKbps: 7980, encoder: "auto", audio: true, live: true,
    });
  });

  it("request fields override defaults; a lone width leaves the height to the aspect ratio", () => {
    const a = planGoLive(req({ width: 1280, height: 720, fps: 30, bitrate_kbps: 3000, encoder: "software", audio: false, channel: "vc9" }), cfg);
    expect(a.ok && a.plan).toMatchObject({ width: 1280, height: 720, fps: 30, bitrateKbps: 3000, encoder: "software", audio: false, channel: "vc9" });
    const b = planGoLive(req({ width: 1280 }), cfg);
    expect(b.ok && b.plan).toMatchObject({ width: 1280, height: undefined });
  });

  it("pulls an RTMP source from a hub (MediaMTX) with listen:false, listens on it by default", () => {
    const hub = "rtmp://127.0.0.1:1935/live/miyoria";
    const pull = planGoLive(req({ source: hub, listen: false }), cfg);
    expect(pull.ok && pull.plan).toMatchObject({ source: hub, inputOptions: [], live: true });
    const push = planGoLive(req({ source: hub }), cfg);
    expect(push.ok && push.plan).toMatchObject({ source: hub, inputOptions: ["-listen", "1"], live: true });
    const parsed = parseCoreMessage(JSON.stringify({ type: "golive_start", guild: "g1", source: hub, listen: false }));
    expect(parsed.ok && planGoLive(parsed.value as GoLiveStartMessage, cfg)).toMatchObject({
      ok: true,
      plan: { inputOptions: [] },
    });
  });

  it("fails with a readable error for out-of-range values and bad sources", () => {
    expect(planGoLive(req({ fps: 500 }), cfg)).toEqual({ ok: false, error: "`fps` must be in 1..120 (got 500)" });
    expect(planGoLive(req({ height: 4 }), cfg).ok).toBe(false);
    expect(planGoLive(req({ bitrate_kbps: 5 }), cfg).ok).toBe(false);
    expect(planGoLive(req({ source: "pipe:0" }), cfg).ok).toBe(false);
  });
});

describe("config", () => {
  it("reads Go Live and Stage settings", () => {
    const c = loadConfig({
      SELF_TOKEN: "x", STAGE_LEVELS_URL: "ws://127.0.0.1:7883/levels", STAGE_LEVELS_GAIN: "2",
      GOLIVE_VOICE_MODE: "EXCLUSIVE", GOLIVE_ENCODER: "nvenc", GOLIVE_FPS: "30", GOLIVE_NO_TRANSCODE: "1",
    });
    expect(c.stageLevelsUrl).toBe("ws://127.0.0.1:7883/levels");
    expect(c.stageLevelsGain).toBe(2);
    expect(c.golive).toMatchObject({ voiceMode: "exclusive", encoder: "nvenc", fps: 30, noTranscode: true, hwDecode: true });
    expect(loadConfig({ SELF_TOKEN: "x" }).golive.audio).toBe(true);
    const muted = loadConfig({ SELF_TOKEN: "x", GOLIVE_AUDIO: "false" }).golive;
    expect(muted.audio).toBe(false);
    const plan = planGoLive(req(), muted);
    expect(plan.ok && plan.plan.audio).toBe(false);
    const asked = planGoLive(req({ audio: true }), muted);
    expect(asked.ok && asked.plan.audio).toBe(true);
    expect(loadConfig({ SELF_TOKEN: "x" }).stageLevelsUrl).toBeUndefined();
    expect(() => loadConfig({ SELF_TOKEN: "x", STAGE_LEVELS_URL: "http://x" })).toThrow(/STAGE_LEVELS_URL/);
    expect(() => loadConfig({ SELF_TOKEN: "x", GOLIVE_VOICE_MODE: "both" })).toThrow(/GOLIVE_VOICE_MODE/);
  });
});

describe("resolveEncoder", () => {
  it("auto picks NVENC when the probe passes and software when not; software never probes", async () => {
    expect(await resolveEncoder("auto", async () => true)).toEqual({ encoder: "nvenc" });
    expect(await resolveEncoder("auto", async () => false)).toMatchObject({ encoder: "software", note: expect.any(String) });
    expect(await resolveEncoder("nvenc", async () => false)).toMatchObject({ encoder: "software", note: expect.stringContaining("requested") });
    const probe = vi.fn(async () => true);
    expect(await resolveEncoder("software", probe)).toEqual({ encoder: "software" });
    expect(probe).not.toHaveBeenCalled();
  });

  it("cachedProbe runs the probe once", async () => {
    const run = vi.fn(async () => true);
    const p = cachedProbe(run);
    await Promise.all([p(), p()]);
    await p();
    expect(run).toHaveBeenCalledTimes(1);
  });
});

// ── manager ────────────────────────────────────────────────────────────────

interface Harness {
  mgr: GoLiveManager;
  events: GoLiveEvent[];
  attaches: Attach[];
  detaches: [string, Attach][];
  /** Resolves the engine run normally (source ended). */
  end(): void;
  /** Fails the engine run. */
  fail(err: Error): void;
  live(): void;
  runs: { plan: unknown; attach: Attach; signal: AbortSignal }[];
}

function harness(opts: { hostError?: string; startTimeoutS?: number; kind?: Attach["kind"]; probe?: boolean } = {}): Harness {
  const events: GoLiveEvent[] = [];
  const attaches: Attach[] = [];
  const detaches: [string, Attach][] = [];
  const runs: Harness["runs"] = [];
  let hooks: { onLive(): void } | undefined;
  let finish: { resolve(): void; reject(e: Error): void } | undefined;

  const engine: StreamEngine = {
    run: (plan, attach, h, signal) =>
      new Promise<void>((resolve, reject) => {
        runs.push({ plan, attach, signal });
        hooks = h;
        finish = { resolve, reject };
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  };
  const host: GoLiveHost = {
    attach: async (plan) => {
      if (opts.hostError) throw new Error(opts.hostError);
      const a: Attach =
        (opts.kind ?? "hybrid") === "hybrid"
          ? { kind: "hybrid", guildId: plan.guild, channelId: plan.channel ?? "vc1", sessionId: "sess" }
          : { kind: "exclusive", guildId: plan.guild, channelId: plan.channel ?? "vc1" };
      attaches.push(a);
      return a;
    },
    detach: async (guild, a) => void detaches.push([guild, a]),
  };
  const mgr = new GoLiveManager({
    engine, host, emit: (e) => events.push(e), probeNvenc: async () => opts.probe ?? true,
    config: { ...cfg, startTimeoutS: opts.startTimeoutS ?? cfg.startTimeoutS },
  });
  return {
    mgr, events, attaches, detaches, runs,
    end: () => finish?.resolve(),
    fail: (e) => finish?.reject(e),
    live: () => hooks?.onLive(),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 5));
const states = (h: Harness) => h.events.map((e) => e.state);

describe("GoLiveManager", () => {
  it("goes starting -> live -> stopped (source ended) and detaches", async () => {
    const h = harness();
    h.mgr.start(req({ channel: "vc7" }));
    expect(states(h)).toEqual(["starting"]);
    await tick();
    expect(h.runs[0]?.plan).toMatchObject({ encoder: "nvenc", source: "srt://127.0.0.1:9999?mode=listener" });
    expect(h.runs[0]?.attach).toMatchObject({ kind: "hybrid", channelId: "vc7" });
    h.live();
    h.live(); // duplicate is ignored
    expect(states(h)).toEqual(["starting", "live"]);
    expect(h.mgr.snapshot()).toEqual({ guild: "g1", state: "live" });
    h.end();
    await tick();
    await h.mgr.stopAll();
    expect(h.events.at(-1)).toEqual({ guild: "g1", state: "stopped", reason: "source ended" });
    expect(h.detaches).toEqual([["g1", h.attaches[0]]]);
    expect(h.mgr.activeGuild).toBeUndefined();
  });

  it("picks the software encoder when NVENC is unavailable", async () => {
    const h = harness({ probe: false });
    h.mgr.start(req());
    await tick();
    expect(h.runs[0]?.plan).toMatchObject({ encoder: "software" });
    await h.mgr.stopAll();
  });

  it("stop() aborts the engine and reports stopped with the reason", async () => {
    const h = harness();
    h.mgr.start(req());
    await tick();
    h.live();
    h.mgr.stop("g1");
    expect(h.runs[0]?.signal.aborted).toBe(true);
    await h.mgr.stopAll();
    expect(h.events.at(-1)).toEqual({ guild: "g1", state: "stopped", reason: "stop requested" });
    expect(states(h)).toEqual(["starting", "live", "stopped"]);
  });

  it("stop() for a guild that is not streaming says so", () => {
    const h = harness();
    h.mgr.stop("g9");
    expect(h.events).toEqual([{ guild: "g9", state: "stopped", reason: "not streaming" }]);
  });

  it("reports failed with the engine's error, also when it dies before going live", async () => {
    const h = harness();
    h.mgr.start(req());
    await tick();
    h.fail(new Error("ffmpeg: Connection refused"));
    await tick();
    await h.mgr.stopAll();
    expect(h.events.at(-1)).toEqual({ guild: "g1", state: "failed", error: "ffmpeg: Connection refused" });
    expect(h.detaches).toHaveLength(1);
  });

  it("an engine that ends without ever going live is a failure", async () => {
    const h = harness();
    h.mgr.start(req());
    await tick();
    h.end();
    await tick();
    expect(h.events.at(-1)).toMatchObject({ state: "failed", error: expect.stringContaining("before any video") });
  });

  it("fails when the host cannot attach (no voice channel)", async () => {
    const h = harness({ hostError: "not in a voice channel in this guild" });
    h.mgr.start(req());
    await tick();
    expect(h.events).toEqual([
      { guild: "g1", state: "starting" },
      { guild: "g1", state: "failed", error: "not in a voice channel in this guild" },
    ]);
    expect(h.runs).toHaveLength(0);
    expect(h.detaches).toHaveLength(0); // never attached
    expect(h.mgr.activeGuild).toBeUndefined();
  });

  it("rejects a bad request without starting", () => {
    const h = harness();
    h.mgr.start(req({ source: "pipe:0" }));
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ guild: "g1", state: "failed" });
    expect(h.mgr.activeGuild).toBeUndefined();
  });

  it("allows one stream at a time: same guild re-reports, another guild fails", async () => {
    const h = harness();
    h.mgr.start(req());
    await tick();
    h.live();
    h.mgr.start(req());
    expect(h.events.at(-1)).toEqual({ guild: "g1", state: "live" });
    h.mgr.start(req({ guild: "g2" }));
    expect(h.events.at(-1)).toMatchObject({ guild: "g2", state: "failed", error: expect.stringContaining("already running") });
    expect(h.runs).toHaveLength(1);
    await h.mgr.stopAll();
  });

  it("times out a source that never delivers video", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ startTimeoutS: 5 });
      h.mgr.start(req());
      await vi.advanceTimersByTimeAsync(10);
      expect(h.runs).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(10);
      expect(h.events.at(-1)).toEqual({ guild: "g1", state: "failed", error: "no video from the source within 5 s" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not time out once live", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ startTimeoutS: 5 });
      h.mgr.start(req());
      await vi.advanceTimersByTimeAsync(10);
      h.live();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(states(h)).toEqual(["starting", "live"]);
      await h.mgr.stopAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it("can start again after a stream ended", async () => {
    const h = harness();
    h.mgr.start(req());
    await tick();
    h.live();
    h.end();
    await tick();
    h.mgr.start(req({ guild: "g2" }));
    await tick();
    expect(h.runs).toHaveLength(2);
    expect(h.events.filter((e) => e.state === "starting").map((e) => e.guild)).toEqual(["g1", "g2"]);
    await h.mgr.stopAll();
  });

  it("passes the exclusive attach through to the engine and the detach", async () => {
    const h = harness({ kind: "exclusive" });
    h.mgr.start(req());
    await tick();
    expect(h.runs[0]?.attach.kind).toBe("exclusive");
    await h.mgr.stopAll();
    expect(h.detaches[0]?.[1].kind).toBe("exclusive");
  });
});

describe("DvsEngine", () => {
  const client = { user: { id: "42" } } as never;
  const noLog = { error() {}, warn() {}, info() {}, debug() {} };
  const plan = planGoLive(req(), cfg);

  it("turns a library load failure into a readable error instead of crashing", async () => {
    const engine = new DvsEngine(client, noLog, async () => {
      throw new Error("Cannot find module 'node-av'");
    });
    if (!plan.ok) throw new Error(plan.error);
    await expect(
      engine.run(
        { ...plan.plan, encoder: "software" },
        { kind: "hybrid", guildId: "g1", channelId: "vc1", sessionId: "s" },
        { onLive() {} },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/could not load @dank074\/discord-video-stream \(Cannot find module 'node-av'\)/);
  });

  it("shortens ffmpeg failures to the exit code and the stderr tail", () => {
    const e = new Error('Command failed with exit code 1: ffmpeg -i "x" -f nut ...long...');
    expect(ffmpegErrorMessage(e, "Error opening input: No such file")).toBe(
      "ffmpeg exited with code 1: Error opening input: No such file",
    );
    expect(ffmpegErrorMessage(new Error("spawn ffmpeg ENOENT"), "")).toBe("ffmpeg: spawn ffmpeg ENOENT");
  });

  it("opens the Go Live connection before a live feed's first packets, with a short probe", async () => {
    const log: string[] = [];
    const calls: { input: string[]; output: string[]; play: Record<string, unknown> }[] = [];
    const fake = {
      Streamer: class {
        async createStream() {
          log.push("createStream");
          return {};
        }
        stopStream() {}
      },
      VoiceConnection: class {
        setSession() {}
      },
      Encoders: { nvenc: () => ({}), software: () => ({}) },
      Utils: { normalizeVideoCodec: (c: string) => c },
      prepareStream: (_src: string, opts: { customInputOptions: string[]; customFfmpegFlags: string[] }) => {
        calls.push({ input: opts.customInputOptions, output: opts.customFfmpegFlags, play: {} });
        return { command: { on() {} }, output: {}, promise: new Promise(() => {}) };
      },
      playStream: async (_out: unknown, s: { createStream(): Promise<unknown> }, opts: Record<string, unknown>) => {
        (calls.at(-1) as { play: Record<string, unknown> }).play = opts;
        log.push("playStream");
        await s.createStream();
      },
    };
    const engine = new DvsEngine(client, noLog, async () => fake as never);
    const run = (source: string, noTranscode = false) => {
      const p = planGoLive(req({ source }), cfg);
      if (!p.ok) throw new Error(p.error);
      return engine.run(
        { ...p.plan, encoder: "software", noTranscode },
        { kind: "hybrid", guildId: "g1", channelId: "vc1", sessionId: "s" },
        { onLive() {} },
        new AbortController().signal,
      );
    };

    await run("rtmp://127.0.0.1:1935/live/x");
    expect(calls[0]?.input).toEqual(expect.arrayContaining(["-analyzeduration", "500000"]));
    // Packets stay paced (a burst breaks the viewers' playback timing); the connection is reused.
    expect(calls[0]?.play.readrateInitialBurst).toBeUndefined();
    expect(log.splice(0)).toEqual(["createStream", "playStream"]);

    // Re-encoding: no extra output options; the encoder already emits Annex B.
    expect(calls[0]?.output).toEqual([]);

    await run("C:/videos/clip.mp4");
    expect(calls[1]?.input).not.toContain("-analyzeduration");
    expect(log.splice(0)).toEqual(["playStream", "createStream"]);
    // Passing the source through: its AVCC framing is converted for the demuxer.
    await run("rtmp://127.0.0.1:1935/live/x", true);
    expect(calls.at(-1)?.output).toEqual(PASSTHROUGH_FLAGS);
  });

  it("uses the spelling of the low-delay flag that current ffmpeg accepts", () => {
    expect(LOW_LATENCY_INPUT).toContain("low_delay");
    expect(LOW_LATENCY_INPUT).not.toContain("lowdelay");
  });

  it("copies the source's H.264 as Annex B when not transcoding", () => {
    expect(PASSTHROUGH_FLAGS).toEqual(["-bsf:v", "h264_mp4toannexb"]);
  });
});
