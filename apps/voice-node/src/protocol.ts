// Voice Link v1 (node side). See docs/protocols/voice-link.md.
//
// Text frames are JSON objects with a `type`; binary frames are audio:
//   0x01 [stream: u32 LE] [PCM s16le mono 16 kHz ...]   node -> Core (capture)
//   0x02 [play:   u32 LE] [PCM s16le mono ...]          Core -> node (playback)
//   0x03 [play:   u32 LE] [PCM s16le mono ...]          Core -> node (levels track of a play
//                                                       started with `levels`: what lip sync follows)
//   0x04 [id: u32 LE] [JPEG ...]                         node -> Core (watch: one snapshot)
//   0x05 [PCM s16le mono 16 kHz ...]                     node -> Core (watch: the stream's audio, no id)

export const PROTOCOL_VERSION = 1;
/**
 * Optional protocol features this node implements, announced in `hello.capabilities` so Core
 * only sends what the node understands.
 */
export const NODE_CAPABILITIES: readonly string[] = ["play_duck", "play_pause"];
export const CAPTURE_SAMPLE_RATE = 16_000;

export const FRAME_CAPTURE = 0x01;
export const FRAME_PLAYBACK = 0x02;
export const FRAME_LEVELS = 0x03;
export const FRAME_SNAPSHOT = 0x04;
export const FRAME_WATCH_AUDIO = 0x05;

/** WebSocket close codes the protocol assigns meaning to. */
export const CLOSE_VERSION_MISMATCH = 4400;
export const CLOSE_BAD_TOKEN = 4401;
export const CLOSE_REPLACED = 4409;

export const U32_MAX = 0xffff_ffff;

// ── Core -> node ────────────────────────────────────────────────────────────

export type CoreMessage =
  | { type: "welcome"; session: string }
  | { type: "join"; guild: string; channel?: string; user_id?: string }
  | { type: "leave"; guild: string }
  | { type: "play_start"; play: number; guild: string; sample_rate: number; levels?: boolean }
  | { type: "play_end"; play: number }
  | { type: "play_stop"; play: number; fade_ms: number }
  /** Volume of a play (0..1, 1 = normal), ramped over `fade_ms`; stays until changed. */
  | { type: "play_duck"; play: number; gain: number; fade_ms: number }
  /** Fade the play out and hold it; buffered audio waits. */
  | { type: "play_pause"; play: number; fade_ms: number }
  /** Continue a paused play with a fade-in. */
  | { type: "play_resume"; play: number; fade_ms: number }
  | GoLiveStartMessage
  | { type: "golive_stop"; guild: string }
  | { type: "watch_start"; guild: string; user_id: string }
  | { type: "watch_stop"; guild: string }
  | { type: "watch_snapshot"; id: number }
  | { type: "ping" };

export type GoLiveEncoderChoice = "auto" | "nvenc" | "software";

export interface GoLiveStartMessage {
  type: "golive_start";
  guild: string;
  channel?: string;
  source: string;
  width?: number;
  height?: number;
  fps?: number;
  bitrate_kbps?: number;
  encoder?: GoLiveEncoderChoice;
  /** Send the source's audio track (default true). */
  audio?: boolean;
  /** Have the node's ffmpeg wait for the source to connect (default: true for rtmp://, SRT without `mode=`). */
  listen?: boolean;
}

export type GoLiveWireState = "starting" | "live" | "stopped" | "failed";
export type WatchWireState = "starting" | "live" | "stopped" | "failed";

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string; ignorable: boolean };

const MIN_PLAY_RATE = 8_000;
const MAX_PLAY_RATE = 192_000;
export const MAX_FADE_MS = 10_000;

function fail<T>(error: string, ignorable = false): ParseResult<T> {
  return { ok: false, error, ignorable };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function reqId(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  return typeof v === "string" && v.length > 0 && v.length <= 64 ? v : undefined;
}

function optId(o: Record<string, unknown>, key: string): { ok: true; v: string | undefined } | { ok: false } {
  const v = o[key];
  if (v === undefined || v === null) return { ok: true, v: undefined };
  return typeof v === "string" && v.length > 0 && v.length <= 64 ? { ok: true, v } : { ok: false };
}

export function isU32(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= U32_MAX;
}

/** Parses and validates one text frame from Core. Unknown `type`s are reported as ignorable. */
export function parseCoreMessage(text: string): ParseResult<CoreMessage> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail("invalid JSON");
  }
  if (!isRecord(raw)) return fail("message is not a JSON object");
  const type = raw.type;
  if (typeof type !== "string") return fail("missing string field `type`");

  switch (type) {
    case "welcome": {
      const session = raw.session;
      if (typeof session !== "string" || session.length === 0) return fail("welcome: `session` must be a string");
      return { ok: true, value: { type, session } };
    }
    case "ping":
      return { ok: true, value: { type } };
    case "join": {
      const guild = reqId(raw, "guild");
      if (!guild) return fail("join: `guild` must be a non-empty string");
      const channel = optId(raw, "channel");
      const userId = optId(raw, "user_id");
      if (!channel.ok) return fail("join: `channel` must be a string");
      if (!userId.ok) return fail("join: `user_id` must be a string");
      if (channel.v === undefined && userId.v === undefined) {
        return fail("join: need `channel` or `user_id`");
      }
      const value: CoreMessage = { type, guild };
      if (channel.v !== undefined) value.channel = channel.v;
      if (userId.v !== undefined) value.user_id = userId.v;
      return { ok: true, value };
    }
    case "leave": {
      const guild = reqId(raw, "guild");
      if (!guild) return fail("leave: `guild` must be a non-empty string");
      return { ok: true, value: { type, guild } };
    }
    case "play_start": {
      const play = raw.play;
      const guild = reqId(raw, "guild");
      const rate = raw.sample_rate;
      if (!isU32(play)) return fail("play_start: `play` must be a u32");
      if (!guild) return fail("play_start: `guild` must be a non-empty string");
      if (
        typeof rate !== "number" ||
        !Number.isInteger(rate) ||
        rate < MIN_PLAY_RATE ||
        rate > MAX_PLAY_RATE
      ) {
        return fail(`play_start: \`sample_rate\` must be an integer in ${MIN_PLAY_RATE}..${MAX_PLAY_RATE}`);
      }
      const value: Extract<CoreMessage, { type: "play_start" }> = { type, play, guild, sample_rate: rate };
      if (raw.levels === true) value.levels = true;
      return { ok: true, value };
    }
    case "play_end": {
      const play = raw.play;
      if (!isU32(play)) return fail("play_end: `play` must be a u32");
      return { ok: true, value: { type, play } };
    }
    case "play_stop": {
      const play = raw.play;
      if (!isU32(play)) return fail("play_stop: `play` must be a u32");
      const fade = raw.fade_ms;
      let fadeMs = 0;
      if (fade !== undefined && fade !== null) {
        if (typeof fade !== "number" || !Number.isFinite(fade) || fade < 0) {
          return fail("play_stop: `fade_ms` must be a non-negative number");
        }
        fadeMs = Math.min(Math.round(fade), MAX_FADE_MS);
      }
      return { ok: true, value: { type, play, fade_ms: fadeMs } };
    }
    case "play_duck": {
      const play = raw.play;
      if (!isU32(play)) return fail("play_duck: `play` must be a u32");
      const gain = raw.gain;
      if (typeof gain !== "number" || !Number.isFinite(gain) || gain < 0 || gain > 1) {
        return fail("play_duck: `gain` must be a number in 0..1");
      }
      const fadeMs = parseFadeMs(raw.fade_ms);
      if (fadeMs === undefined) return fail("play_duck: `fade_ms` must be a non-negative number");
      return { ok: true, value: { type, play, gain, fade_ms: fadeMs } };
    }
    case "play_pause":
    case "play_resume": {
      const play = raw.play;
      if (!isU32(play)) return fail(`${type}: \`play\` must be a u32`);
      const fadeMs = parseFadeMs(raw.fade_ms);
      if (fadeMs === undefined) return fail(`${type}: \`fade_ms\` must be a non-negative number`);
      return { ok: true, value: { type, play, fade_ms: fadeMs } };
    }
    case "golive_start":
      return parseGoLiveStart(raw);
    case "golive_stop": {
      const guild = reqId(raw, "guild");
      if (!guild) return fail("golive_stop: `guild` must be a non-empty string");
      return { ok: true, value: { type, guild } };
    }
    case "watch_start": {
      const guild = reqId(raw, "guild");
      const userId = reqId(raw, "user_id");
      if (!guild) return fail("watch_start: `guild` must be a non-empty string");
      if (!userId) return fail("watch_start: `user_id` must be a non-empty string");
      return { ok: true, value: { type, guild, user_id: userId } };
    }
    case "watch_stop": {
      const guild = reqId(raw, "guild");
      if (!guild) return fail("watch_stop: `guild` must be a non-empty string");
      return { ok: true, value: { type, guild } };
    }
    case "watch_snapshot": {
      const id = raw.id;
      if (!isU32(id)) return fail("watch_snapshot: `id` must be a u32");
      return { ok: true, value: { type, id } };
    }
    default:
      return fail(`unknown message type \`${type}\``, true);
  }
}

export const MAX_SOURCE_LEN = 2048;

function optInt(o: Record<string, unknown>, key: string): { ok: true; v: number | undefined } | { ok: false } {
  const v = o[key];
  if (v === undefined || v === null) return { ok: true, v: undefined };
  return typeof v === "number" && Number.isInteger(v) && v > 0 && v <= U32_MAX ? { ok: true, v } : { ok: false };
}

function optBool(o: Record<string, unknown>, key: string): { ok: true; v: boolean | undefined } | { ok: false } {
  const v = o[key];
  if (v === undefined || v === null) return { ok: true, v: undefined };
  return typeof v === "boolean" ? { ok: true, v } : { ok: false };
}

function parseGoLiveStart(raw: Record<string, unknown>): ParseResult<CoreMessage> {
  const guild = reqId(raw, "guild");
  if (!guild) return fail("golive_start: `guild` must be a non-empty string");
  const source = raw.source;
  if (typeof source !== "string" || source.trim().length === 0 || source.length > MAX_SOURCE_LEN) {
    return fail(`golive_start: \`source\` must be a non-empty string (max ${MAX_SOURCE_LEN} chars)`);
  }
  const channel = optId(raw, "channel");
  if (!channel.ok) return fail("golive_start: `channel` must be a string");
  const value: GoLiveStartMessage = { type: "golive_start", guild, source };
  if (channel.v !== undefined) value.channel = channel.v;
  for (const key of ["width", "height", "fps", "bitrate_kbps"] as const) {
    const n = optInt(raw, key);
    if (!n.ok) return fail(`golive_start: \`${key}\` must be a positive integer`);
    if (n.v !== undefined) value[key] = n.v;
  }
  const encoder = raw.encoder;
  if (encoder !== undefined && encoder !== null) {
    if (encoder !== "auto" && encoder !== "nvenc" && encoder !== "software") {
      return fail("golive_start: `encoder` must be auto, nvenc or software");
    }
    value.encoder = encoder;
  }
  for (const key of ["audio", "listen"] as const) {
    const b = optBool(raw, key);
    if (!b.ok) return fail(`golive_start: \`${key}\` must be a boolean`);
    if (b.v !== undefined) value[key] = b.v;
  }
  return { ok: true, value };
}

// ── node -> Core ────────────────────────────────────────────────────────────

export interface Participant {
  user_id: string;
  display_name: string;
  is_self: boolean;
  muted: boolean;
  deafened: boolean;
}

export type PlaybackState = "started" | "finished" | "interrupted" | "failed";

export type NodeMessage =
  | {
      type: "hello";
      version: number;
      token: string;
      node: string;
      self_account: { platform: "discord"; id: string };
      /** Optional features this node implements ({@link NODE_CAPABILITIES}). */
      capabilities?: string[];
    }
  | { type: "joined"; guild: string; channel: string }
  | { type: "left"; guild: string; reason?: string }
  | { type: "voice_state"; guild: string; channel: string; participants: Participant[] }
  | { type: "speaking"; guild: string; user_id: string; speaking: boolean }
  | {
      type: "stream_open";
      stream: number;
      guild: string;
      channel: string;
      user_id: string;
      display_name: string;
      sample_rate: number;
    }
  | { type: "stream_close"; stream: number }
  | { type: "playback"; play: number; state: PlaybackState; error?: string }
  | { type: "golive"; guild: string; state: GoLiveWireState; error?: string; reason?: string }
  | {
      type: "watch";
      guild: string;
      user_id: string;
      state: WatchWireState;
      reason?: string;
      error?: string;
    }
  | { type: "watch_snapshot_failed"; id: number; error: string }
  | { type: "error"; message: string }
  | { type: "pong" };

export function encodeNodeMessage(msg: NodeMessage): string {
  return JSON.stringify(msg);
}

// ── binary frames ───────────────────────────────────────────────────────────

/** Builds a `0x01` capture frame. `pcm` is s16le mono 16 kHz. */
export function encodeCaptureFrame(stream: number, pcm: Uint8Array): Buffer {
  if (!isU32(stream)) throw new RangeError(`stream id out of u32 range: ${stream}`);
  const out = Buffer.allocUnsafe(5 + pcm.byteLength);
  out[0] = FRAME_CAPTURE;
  out.writeUInt32LE(stream, 1);
  out.set(pcm, 5);
  return out;
}

/** Builds a `0x04` snapshot frame: `[0x04][id: u32 LE][JPEG]`. */
export function encodeSnapshotFrame(id: number, jpeg: Uint8Array): Buffer {
  if (!isU32(id)) throw new RangeError(`snapshot id out of u32 range: ${id}`);
  const out = Buffer.allocUnsafe(5 + jpeg.byteLength);
  out[0] = FRAME_SNAPSHOT;
  out.writeUInt32LE(id, 1);
  out.set(jpeg, 5);
  return out;
}

/** Builds a `0x05` watch audio frame: `[0x05][PCM s16le mono 16 kHz]`. No id: only one stream is watched at a time. */
export function encodeWatchAudioFrame(pcm: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(1 + pcm.byteLength);
  out[0] = FRAME_WATCH_AUDIO;
  out.set(pcm, 1);
  return out;
}

/** Builds a `0x02` playback frame (what Core sends). Used by tests and tooling. */
export function encodePlaybackFrame(play: number, pcm: Uint8Array): Buffer {
  if (!isU32(play)) throw new RangeError(`play id out of u32 range: ${play}`);
  const out = Buffer.allocUnsafe(5 + pcm.byteLength);
  out[0] = FRAME_PLAYBACK;
  out.writeUInt32LE(play, 1);
  out.set(pcm, 5);
  return out;
}

export interface BinaryFrame {
  kind: typeof FRAME_CAPTURE | typeof FRAME_PLAYBACK | typeof FRAME_LEVELS;
  /** stream id (0x01) or play id (0x02, 0x03) */
  id: number;
  /** A view into the input buffer (no copy). */
  pcm: Buffer;
}

/** Decodes a binary frame. Returns an error string for malformed / unknown frames. */
export function decodeBinaryFrame(buf: Uint8Array): ParseResult<BinaryFrame> {
  if (buf.byteLength < 5) return fail("binary frame shorter than its 5-byte header");
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  const kind = b[0];
  if (kind !== FRAME_CAPTURE && kind !== FRAME_PLAYBACK && kind !== FRAME_LEVELS) {
    return fail(`unknown binary frame kind 0x${(kind ?? 0).toString(16).padStart(2, "0")}`, true);
  }
  return { ok: true, value: { kind, id: b.readUInt32LE(1), pcm: b.subarray(5) } };
}

/** `fade_ms` of the play control messages: absent = 0, else a non-negative number (capped). */
function parseFadeMs(fade: unknown): number | undefined {
  if (fade === undefined || fade === null) return 0;
  if (typeof fade !== "number" || !Number.isFinite(fade) || fade < 0) return undefined;
  return Math.min(Math.round(fade), MAX_FADE_MS);
}
