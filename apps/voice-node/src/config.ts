// Config comes from the environment (a `.env` next to package.json is loaded if present).
import "./env.js";
import { parseLogLevel, type LogLevel } from "./log.js";

export type GoLiveVoiceMode = "hybrid" | "exclusive";
export type GoLiveEncoderPref = "auto" | "nvenc" | "software";

/** Go Live defaults; `golive_start` fields override them per request. */
export interface GoLiveConfig {
  /** `hybrid`: voice stays up (receive + TTS) while streaming. `exclusive`: voice is left during the stream and rejoined after. */
  voiceMode: GoLiveVoiceMode;
  encoder: GoLiveEncoderPref;
  nvencPreset: "p1" | "p2" | "p3" | "p4" | "p5" | "p6" | "p7";
  codec: "H264" | "H265";
  height: number;
  fps: number;
  bitrateKbps: number;
  /** Peak bitrate = bitrate * this factor. */
  bitrateMaxFactor: number;
  /** Decode the source with NVDEC (`-hwaccel auto`). */
  hwDecode: boolean;
  /** Forward the source's H.264 as-is (the source must have 1 s keyframes, no B-frames). */
  noTranscode: boolean;
  /**
   * Send the source's audio with the stream (a request's `audio` wins). Her voice reaches the
   * channel through the voice connection anyway; turning this off also removes the sender's
   * audio/video sync waits.
   */
  audio: boolean;
  /** Give up on a source that has not delivered video after this long (s). */
  startTimeoutS: number;
}

export interface Config {
  /** Self-account user token. Never logged. */
  selfToken: string;
  voiceLinkUrl: string;
  voiceLinkToken: string;
  logLevel: LogLevel;
  /** Silence after which a capture stream is closed (ms). */
  silenceMs: number;
  /** Max audio buffered for one playback (seconds of source audio). */
  playbackMaxBufferS: number;
  /** Audio accumulated before a playback starts (ms). */
  playbackPrebufferMs: number;
  /** Max time a playback may sit starved (silence-filled) waiting for Core (ms). */
  playbackMaxStarveMs: number;
  /** Stage levels endpoint (`ws://127.0.0.1:7883/levels`); unset = no lip-sync levels. */
  stageLevelsUrl: string | undefined;
  /** Multiplier on the RMS sent to the Stage (clamped to 1 after). */
  stageLevelsGain: number;
  golive: GoLiveConfig;
}

export class ConfigError extends Error {}

function str(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const v = env[name]?.trim();
  return v ? v : undefined;
}

function num(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = str(env, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new ConfigError(`${name}=${raw} is invalid (expected a number in ${min}..${max})`);
  }
  return n;
}

function oneOf<T extends string>(env: NodeJS.ProcessEnv, name: string, allowed: readonly T[], fallback: T): T {
  const raw = str(env, name);
  if (raw === undefined) return fallback;
  const v = allowed.find((a) => a.toLowerCase() === raw.toLowerCase());
  if (!v) throw new ConfigError(`${name}=${raw} is invalid (expected one of ${allowed.join(", ")})`);
  return v;
}

function bool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = str(env, name)?.toLowerCase();
  if (raw === undefined) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new ConfigError(`${name}=${raw} is invalid (expected true/false)`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const selfToken = str(env, "SELF_TOKEN");
  if (!selfToken) throw new ConfigError("SELF_TOKEN is missing (copy .env.example to .env and fill it in)");
  const voiceLinkUrl = str(env, "VOICE_LINK_URL") ?? "ws://127.0.0.1:7879/voice-link";
  if (!/^wss?:\/\//i.test(voiceLinkUrl)) {
    throw new ConfigError(`VOICE_LINK_URL must start with ws:// or wss:// (got ${voiceLinkUrl})`);
  }
  const stageLevelsUrl = str(env, "STAGE_LEVELS_URL");
  if (stageLevelsUrl !== undefined && !/^wss?:\/\//i.test(stageLevelsUrl)) {
    throw new ConfigError(`STAGE_LEVELS_URL must start with ws:// or wss:// (got ${stageLevelsUrl})`);
  }
  return {
    selfToken,
    voiceLinkUrl,
    voiceLinkToken: str(env, "VOICE_LINK_TOKEN") ?? "",
    logLevel: parseLogLevel(env.LOG_LEVEL),
    silenceMs: num(env, "SILENCE_MS", 400, 100, 5000),
    playbackMaxBufferS: num(env, "PLAYBACK_MAX_BUFFER_S", 60, 1, 600),
    playbackPrebufferMs: num(env, "PLAYBACK_PREBUFFER_MS", 60, 0, 2000),
    playbackMaxStarveMs: num(env, "PLAYBACK_MAX_STARVE_MS", 10_000, 500, 120_000),
    stageLevelsUrl,
    stageLevelsGain: num(env, "STAGE_LEVELS_GAIN", 1, 0, 100),
    golive: {
      voiceMode: oneOf(env, "GOLIVE_VOICE_MODE", ["hybrid", "exclusive"], "hybrid"),
      encoder: oneOf(env, "GOLIVE_ENCODER", ["auto", "nvenc", "software"], "auto"),
      nvencPreset: oneOf(env, "GOLIVE_NVENC_PRESET", ["p1", "p2", "p3", "p4", "p5", "p6", "p7"], "p4"),
      codec: oneOf(env, "GOLIVE_CODEC", ["H264", "H265"], "H264"),
      height: num(env, "GOLIVE_HEIGHT", 1080, 144, 2160),
      fps: num(env, "GOLIVE_FPS", 60, 1, 120),
      bitrateKbps: num(env, "GOLIVE_BITRATE_KBPS", 6000, 200, 50_000),
      bitrateMaxFactor: num(env, "GOLIVE_BITRATE_MAX_FACTOR", 1.33, 1, 4),
      hwDecode: bool(env, "GOLIVE_HWACCEL_DECODE", true),
      noTranscode: bool(env, "GOLIVE_NO_TRANSCODE", false),
      audio: bool(env, "GOLIVE_AUDIO", true),
      startTimeoutS: num(env, "GOLIVE_START_TIMEOUT_S", 120, 5, 3600),
    },
  };
}
