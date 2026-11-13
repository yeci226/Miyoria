// StreamEngine on top of @dank074/discord-video-stream (WebRTC Go Live sender, DAVE-capable).
//
//   source ──ffmpeg (NVENC / x264, via prepareStream)──> NUT ──demux/packetize (playStream)──> Discord Go Live
//
// Voice coexistence ("hybrid", the default): Go Live is a *separate* WebRTC connection that Discord
// creates with STREAM_CREATE; all it needs from the voice session is the voice session id. So the
// @discordjs/voice connection keeps owning the voice channel (receive + TTS playback), and the Streamer
// is handed a never-started VoiceConnection "shell" that only carries that session id - the same trick
// the Phase 0 spike proved out (spikes/voice-node, GOLIVE_VOICE=hybrid). It pokes one private field of
// the Streamer, hence the experimental label in the docs.
//
// "exclusive" fallback: the library's own joinVoice() (always self-deafened, no receive) owns the voice
// channel while streaming.
//
// The library is imported lazily: its native dependencies (node-av, zeromq, sharp, node-datachannel)
// are only loaded when someone actually goes live, and a load failure becomes a `failed` event instead
// of taking the voice node down.
import type * as Dvs from "@dank074/discord-video-stream";
import type { Client } from "@lng2004/discord.js-selfbot-v13";
import type { Logger } from "../log.js";
import type { Attach, EngineHooks, StreamEngine } from "./manager.js";
import type { GoLivePlan, ResolvedEncoder } from "./plan.js";

type DvsModule = typeof Dvs;

const STDERR_KEEP = 12;

/**
 * ffmpeg input options for live feeds (RTMP / SRT / UDP / RTSP): no read-ahead buffering, low-delay
 * decoding, and a short probe. ffmpeg's default probe reads up to 5 s of the feed before it outputs
 * anything, and everything that queues up before the first packet is sent stays in the stream as
 * delay: playStream() paces packets to real time counted from that first send.
 */
export const LOW_LATENCY_INPUT = [
  "-fflags", "nobuffer",
  "-flags", "low_delay",
  "-flush_packets", "1",
  "-max_delay", "100000",
  "-analyzeduration", "500000",
  "-probesize", "1000000",
];

/**
 * After LOW_LATENCY_INPUT when the feed is pulled from a server (MediaMTX): the pull joins mid-GOP,
 * and 0.5 s of probing ends before the next keyframe brings the picture size ("Could not find codec
 * parameters ... unspecified size", then nut cannot write its header). Waiting for a keyframe is
 * time spent before the first packet, not a queue: nothing is buffered while it waits.
 */
export const PULL_PROBE_INPUT = ["-analyzeduration", "3000000", "-probesize", "5000000"];

/** Output options when the source's H.264 is copied: AVCC framing → Annex B. */
export const PASSTHROUGH_FLAGS = ["-bsf:v", "h264_mp4toannexb"];

/** The library's error message echoes the whole command line; keep the exit code and the last stderr lines. */
export function ffmpegErrorMessage(e: unknown, stderrTail: string): string {
  const raw = e instanceof Error ? e.message : String(e);
  const code = /^Command failed with exit code (-?\d+)/.exec(raw);
  const head = code ? `ffmpeg exited with code ${code[1]}` : `ffmpeg: ${(raw.split(/\r?\n/)[0] ?? "").slice(0, 200)}`;
  return stderrTail ? `${head}: ${stderrTail}` : head;
}

export class DvsEngine implements StreamEngine {
  private dvs: DvsModule | undefined;
  private streamer: Dvs.Streamer | undefined;

  constructor(
    private readonly client: Client<true>,
    private readonly log: Logger,
    /** Test hook / alternative loader. */
    private readonly load: () => Promise<DvsModule> = () => import("@dank074/discord-video-stream"),
  ) {}

  async run(
    plan: GoLivePlan & { encoder: ResolvedEncoder },
    attach: Attach,
    hooks: EngineHooks,
    signal: AbortSignal,
  ): Promise<void> {
    const dvs = await this.loadLibrary();
    const streamer = (this.streamer ??= new dvs.Streamer(this.client));
    signal.throwIfAborted();

    // "Live" = the Go Live WebRTC connection is established; playStream() calls createStream() once
    // it has demuxed the first packets, so this also means the source is delivering video.
    const createStream = streamer.createStream.bind(streamer);
    let early: ReturnType<typeof createStream> | undefined;
    streamer.createStream = async () => {
      const conn = await (early ?? createStream());
      early = undefined;
      hooks.onLive();
      return conn;
    };

    // Aborting this also kills ffmpeg (prepareStream ties the process to the signal).
    const inner = new AbortController();
    const onAbort = (): void => inner.abort();
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      if (attach.kind === "hybrid") {
        this.adoptVoiceSession(dvs, streamer, attach);
      } else {
        await streamer.joinVoice(attach.guildId, attach.channelId);
        this.log.info("golive: exclusive mode, library voice connection is up (self-deafened)");
      }
      signal.throwIfAborted();
      // A live feed: open the Go Live connection now instead of after the first packets. Otherwise
      // the feed queues up while Discord answers STREAM_CREATE, and since packets are paced to real
      // time from the first send, that queue never drains (sending it in a burst instead breaks the
      // viewers' playback timing: they only see a spinner).
      if (plan.live) {
        early = createStream();
        early.catch(() => {});
      }

      const stderr: string[] = [];
      const { command, output, promise } = dvs.prepareStream(
        plan.source,
        {
          encoder: this.encoderFor(dvs, plan),
          noTranscoding: plan.noTranscode,
          ...(plan.width !== undefined ? { width: plan.width } : {}),
          ...(plan.height !== undefined ? { height: plan.height } : {}),
          frameRate: plan.fps,
          bitrateVideo: plan.bitrateKbps,
          bitrateVideoMax: plan.bitrateMaxKbps,
          videoCodec: dvs.Utils.normalizeVideoCodec(plan.codec),
          includeAudio: plan.audio,
          hardwareAcceleratedDecoding: plan.hwDecode,
          // Not the library's `minimizeLatency`: it passes `-flags lowdelay`, which current ffmpeg builds
          // reject ("Error setting option flags to value lowdelay"); the flag is spelled `low_delay`.
          minimizeLatency: false,
          customInputOptions: [
            ...plan.inputOptions,
            ...(plan.live ? LOW_LATENCY_INPUT : []),
            ...(plan.pull ? PULL_PROBE_INPUT : []),
          ],
          // Copied H.264 from RTMP / MP4 is length-prefixed (AVCC); the library's demuxer parses
          // Annex B, so convert the stream framing (no re-encode).
          customFfmpegFlags: plan.noTranscode ? PASSTHROUGH_FLAGS : [],
          logLevel: "warning",
        },
        inner.signal,
      );
      command.on("start", (cmd: string) => this.log.debug("golive: ffmpeg:", cmd));
      command.on("stderr", (line: string) => {
        stderr.push(line);
        if (stderr.length > STDERR_KEEP) stderr.shift();
        this.log.debug("golive: ffmpeg:", line);
      });

      // ffmpeg dying (bad URL, missing binary, OBS gone) must fail the run even if playStream is still
      // waiting for input that will never come.
      const ffmpegFailed = new Promise<never>((_, reject) => {
        promise.catch((e: unknown) => {
          const detail = stderr.filter((l) => l.trim()).slice(-4).join(" | ");
          reject(new Error(ffmpegErrorMessage(e, detail)));
        });
      });
      ffmpegFailed.catch(() => {});

      // playStream() cannot be cancelled while it waits for Discord to answer STREAM_CREATE (its signal is
      // only honoured afterwards), so a stop during start-up has to win the race here.
      const aborted = new Promise<never>((_, reject) => {
        inner.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      aborted.catch(() => {});

      const playing = dvs.playStream(output, streamer, { type: "go-live" }, inner.signal);
      playing.catch(() => {});
      await Promise.race([playing, ffmpegFailed, aborted]);
    } finally {
      signal.removeEventListener("abort", onAbort);
      inner.abort();
      delete (streamer as unknown as Record<string, unknown>).createStream;
      this.releaseVoice(streamer, attach);
    }
  }

  private async loadLibrary(): Promise<DvsModule> {
    if (this.dvs) return this.dvs;
    try {
      this.dvs = await this.load();
    } catch (e) {
      throw new Error(
        `could not load @dank074/discord-video-stream (${e instanceof Error ? e.message : String(e)}); ` +
          "run `pnpm install --ignore-workspace` in apps/voice-node",
      );
    }
    return this.dvs;
  }

  private encoderFor(dvs: DvsModule, plan: GoLivePlan & { encoder: ResolvedEncoder }): Dvs.EncoderSettingsGetter {
    if (plan.encoder === "nvenc") {
      // The NVENC block is separate from the 3D / CUDA cores, so a game running on the same GPU barely notices.
      // p1-p3 = lowest latency, p4 = balanced. No AQ: it costs latency.
      return dvs.Encoders.nvenc({ preset: plan.nvencPreset, spatialAq: false, temporalAq: false });
    }
    return dvs.Encoders.software({
      x264: { preset: "superfast", tune: "zerolatency" },
      x265: { preset: "superfast", tune: "zerolatency" },
    });
  }

  /** Hybrid: register a never-started VoiceConnection that only carries the @discordjs/voice session id. */
  private adoptVoiceSession(
    dvs: DvsModule,
    streamer: Dvs.Streamer,
    attach: Extract<Attach, { kind: "hybrid" }>,
  ): void {
    const shell = new dvs.VoiceConnection(streamer, attach.guildId, this.client.user.id, attach.channelId, () => {});
    // Sets session_id only; without tokens the shell never opens a voice websocket of its own.
    shell.setSession(attach.sessionId);
    (streamer as unknown as { _voiceConnection?: Dvs.VoiceConnection })._voiceConnection = shell;
    this.log.debug(`golive: hybrid, reusing voice session ${attach.sessionId.slice(0, 8)}...`);
  }

  private releaseVoice(streamer: Dvs.Streamer, attach: Attach): void {
    try {
      streamer.stopStream(); // STREAM_DELETE + close the Go Live connection
    } catch (e) {
      this.log.debug("golive: stopStream failed:", e);
    }
    if (attach.kind === "exclusive") {
      try {
        streamer.leaveVoice(); // sends the voice-state leave; the host rejoins afterwards
      } catch (e) {
        this.log.debug("golive: leaveVoice failed:", e);
      }
    } else {
      // Do NOT call leaveVoice(): it would pull the account out of the channel the real voice
      // connection is using. Just forget the shell.
      (streamer as unknown as { _voiceConnection?: unknown })._voiceConnection = undefined;
    }
  }
}
