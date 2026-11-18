// Voice Link v1 (node side). The messages are written once, in `@miyoria/contracts/voice-link`;
// see docs/protocols/voice-link.md.
//
// Text frames are JSON objects with a `type`; binary frames are audio:
//   0x01 [stream: u32 LE] [PCM s16le mono 16 kHz ...]   node -> Core (capture)
//   0x02 [play:   u32 LE] [PCM s16le mono ...]          Core -> node (playback)
//   0x03 [play:   u32 LE] [PCM s16le mono ...]          Core -> node (levels track of a play
//                                                       started with `levels`: what lip sync follows)
//   0x04 [id: u32 LE] [JPEG ...]                         node -> Core (watch: one snapshot)
//   0x05 [id = 0: u32 LE] [PCM s16le mono 16 kHz ...]    node -> Core (watch: the stream's audio)

import {
  readFrameHeader,
  VOICE_LINK_CAPABILITIES,
  VOICE_LINK_CLOSE,
  VOICE_LINK_FRAME,
  VOICE_LINK_FRAME_HEADER_BYTES,
  VOICE_LINK_LIMITS,
  VOICE_LINK_U32_MAX,
  VOICE_LINK_VERSION,
  type VoiceLinkCoreMessage,
  VoiceLinkCoreMessageSchema,
  type VoiceLinkGoLiveEncoder,
  type VoiceLinkGoLiveState,
  type VoiceLinkNodeMessageIn,
  type VoiceLinkParticipant,
  type VoiceLinkWatchState,
  writeFrameHeader,
} from "@miyoria/contracts/voice-link";

export const PROTOCOL_VERSION = VOICE_LINK_VERSION;
/**
 * Optional protocol features this node implements, announced in `hello.capabilities` so Core
 * only sends what the node understands.
 */
export const NODE_CAPABILITIES: readonly string[] = VOICE_LINK_CAPABILITIES;
export const CAPTURE_SAMPLE_RATE = 16_000;

export const FRAME_CAPTURE = VOICE_LINK_FRAME.CAPTURE;
export const FRAME_PLAYBACK = VOICE_LINK_FRAME.PLAYBACK;
export const FRAME_LEVELS = VOICE_LINK_FRAME.LEVELS;
export const FRAME_SNAPSHOT = VOICE_LINK_FRAME.SNAPSHOT;
export const FRAME_WATCH_AUDIO = VOICE_LINK_FRAME.WATCH_AUDIO;

/**
 * Close codes on which the node gives up instead of reconnecting. Core also closes with
 * `TIMEOUT` (4408) and `GOING_AWAY` (1001); the node reconnects after those, as after any other.
 */
export const CLOSE_VERSION_MISMATCH = VOICE_LINK_CLOSE.BAD_HELLO;
export const CLOSE_BAD_TOKEN = VOICE_LINK_CLOSE.UNAUTHORIZED;
export const CLOSE_REPLACED = VOICE_LINK_CLOSE.REPLACED;

export const U32_MAX = VOICE_LINK_U32_MAX;

// ── Core -> node ────────────────────────────────────────────────────────────

/** `T` with every `null` gone: what the node makes of a field Core sent as `null` (left out). */
type Present<T> = { [K in keyof T]: Exclude<T[K], null> };

/**
 * A message from Core as the rest of the node sees it: optional fields left out (never `null`),
 * `fade_ms` always a number. Core's `pong` is not among them (see `parseCoreMessage`).
 */
export type CoreMessage = Present<Exclude<VoiceLinkCoreMessage, { type: "pong" }>>;

export type GoLiveEncoderChoice = VoiceLinkGoLiveEncoder;

export type GoLiveStartMessage = Extract<CoreMessage, { type: "golive_start" }>;

export type GoLiveWireState = VoiceLinkGoLiveState;

export type WatchWireState = VoiceLinkWatchState;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string; ignorable: boolean };

/** `fade_ms` above this is taken as this. */
export const MAX_FADE_MS = 10_000;
export const MAX_SOURCE_LEN = VOICE_LINK_LIMITS.SOURCE_MAX_LENGTH;

function fail<T>(error: string, ignorable = false): ParseResult<T> {
  return { ok: false, error, ignorable };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isU32(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= U32_MAX;
}

type CoreMessageSchema = (typeof VoiceLinkCoreMessageSchema.options)[number];

/**
 * The messages the node handles, by `type`. The node never pings Core, so a `pong` from Core
 * answers nothing; it stays an unknown, ignorable type, as it always was.
 */
const HANDLED = new Map<string, CoreMessageSchema>(
  VoiceLinkCoreMessageSchema.options
    .filter((schema) => schema.shape.type.value !== "pong")
    .map((schema) => [schema.shape.type.value, schema]),
);

/** What a field must be, in the error for a message whose first bad field it is. */
const FIELD_RULES: Record<string, string> = {
  session: "a string",
  guild: "a non-empty string",
  channel: "a string",
  user_id: "a string",
  play: "a u32",
  id: "a u32",
  sample_rate: `an integer in ${VOICE_LINK_LIMITS.PLAY_SAMPLE_RATE_MIN}..${VOICE_LINK_LIMITS.PLAY_SAMPLE_RATE_MAX}`,
  fade_ms: "a non-negative number",
  gain: "a number in 0..1",
  source: `a non-empty string (max ${MAX_SOURCE_LEN} chars)`,
  width: "a positive integer",
  height: "a positive integer",
  fps: "a positive integer",
  bitrate_kbps: "a positive integer",
  encoder: "auto, nvenc or software",
  audio: "a boolean",
  listen: "a boolean",
};

/**
 * Parses and validates one text frame from Core. Unknown `type`s are reported as ignorable. A
 * refused message names its first bad field, in the order the schema lists them.
 */
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
  const schema = HANDLED.get(type);
  if (schema === undefined) return fail(`unknown message type \`${type}\``, true);

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const bad = new Set(parsed.error.issues.map((issue) => String(issue.path[0])));
    const field = Object.keys(schema.shape).find((key) => bad.has(key));
    const rule = field === undefined ? undefined : FIELD_RULES[field];
    return fail(field === undefined || rule === undefined ? `${type}: malformed` : `${type}: \`${field}\` must be ${rule}`);
  }
  // `HANDLED` has no `pong`.
  return settle(parsed.data as Exclude<VoiceLinkCoreMessage, { type: "pong" }>);
}

/** What the node does with a parsed message that the schema cannot say. */
function settle(msg: Exclude<VoiceLinkCoreMessage, { type: "pong" }>): ParseResult<CoreMessage> {
  switch (msg.type) {
    case "join": {
      const value = present(msg);
      if (value.channel === undefined && value.user_id === undefined) {
        return fail("join: need `channel` or `user_id`");
      }
      return { ok: true, value };
    }
    case "play_start": {
      // Anything but `true` counts as left out (the schema already turned a wrong type into that).
      const { levels, ...value } = present(msg);
      return { ok: true, value: levels === true ? { ...value, levels: true } : value };
    }
    case "play_stop":
    case "play_duck":
    case "play_pause":
    case "play_resume":
      return { ok: true, value: { ...present(msg), fade_ms: clampFadeMs(msg.fade_ms) } };
    default:
      return { ok: true, value: present(msg) };
  }
}

/** The message without its `null` and `undefined` fields. */
function present<T extends object>(msg: T): Present<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(msg)) if (value !== null && value !== undefined) out[key] = value;
  return out as Present<T>;
}

/** `fade_ms` of the play control messages: `null` = 0, else rounded and capped at `MAX_FADE_MS`. */
function clampFadeMs(fade: number | null): number {
  return fade === null ? 0 : Math.min(Math.round(fade), MAX_FADE_MS);
}

// ── node -> Core ────────────────────────────────────────────────────────────

export type Participant = VoiceLinkParticipant;

export type PlaybackState = Extract<VoiceLinkNodeMessageIn, { type: "playback" }>["state"];

/** What the node sends. It never pings Core: Core pings it. */
export type NodeMessage = Exclude<VoiceLinkNodeMessageIn, { type: "ping" }>;

export function encodeNodeMessage(msg: NodeMessage): string {
  return JSON.stringify(msg);
}

// ── binary frames ───────────────────────────────────────────────────────────

function encodeFrame(tag: number, id: number, pcm: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(VOICE_LINK_FRAME_HEADER_BYTES + pcm.byteLength);
  writeFrameHeader(out, tag, id);
  out.set(pcm, VOICE_LINK_FRAME_HEADER_BYTES);
  return out;
}

/** Builds a `0x01` capture frame. `pcm` is s16le mono 16 kHz. */
export function encodeCaptureFrame(stream: number, pcm: Uint8Array): Buffer {
  if (!isU32(stream)) throw new RangeError(`stream id out of u32 range: ${stream}`);
  return encodeFrame(FRAME_CAPTURE, stream, pcm);
}

/** Builds a `0x04` snapshot frame: `[0x04][id][JPEG]`, `id` that of the `watch_snapshot` it answers. */
export function encodeSnapshotFrame(id: number, jpeg: Uint8Array): Buffer {
  if (!isU32(id)) throw new RangeError(`snapshot id out of u32 range: ${id}`);
  return encodeFrame(FRAME_SNAPSHOT, id, jpeg);
}

/** Builds a `0x05` watch audio frame: `[0x05][id = 0][PCM s16le mono 16 kHz]`. One stream is watched at a time. */
export function encodeWatchAudioFrame(pcm: Uint8Array): Buffer {
  return encodeFrame(FRAME_WATCH_AUDIO, 0, pcm);
}

/** Builds a `0x02` playback frame (what Core sends). Used by tests and tooling. */
export function encodePlaybackFrame(play: number, pcm: Uint8Array): Buffer {
  if (!isU32(play)) throw new RangeError(`play id out of u32 range: ${play}`);
  return encodeFrame(FRAME_PLAYBACK, play, pcm);
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
  const header = readFrameHeader(buf);
  if (header === null) return fail("binary frame shorter than its 5-byte header");
  const kind = header.tag;
  if (kind !== FRAME_CAPTURE && kind !== FRAME_PLAYBACK && kind !== FRAME_LEVELS) {
    return fail(`unknown binary frame kind 0x${kind.toString(16).padStart(2, "0")}`, true);
  }
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  return { ok: true, value: { kind, id: header.id, pcm: b.subarray(VOICE_LINK_FRAME_HEADER_BYTES) } };
}
