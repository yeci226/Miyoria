// What the voice link carries that is not a JSON message: the version, the close codes, the
// binary frames and the bounds the node holds Core's messages to.

/** The protocol version a node sends in `hello`. Core closes with `BAD_HELLO` on any other. */
export const VOICE_LINK_VERSION = 1;

/** WebSocket close codes the link gives a meaning to. Core sends all of them. */
export const VOICE_LINK_CLOSE = {
  /** Malformed hello, another version, or no hello in time. The node does not retry. */
  BAD_HELLO: 4400,
  /** Wrong token. The node does not retry. */
  UNAUTHORIZED: 4401,
  /** No traffic from the node within Core's peer timeout. The node reconnects. */
  TIMEOUT: 4408,
  /** A newer connection for the same self account took over. The node does not retry. */
  REPLACED: 4409,
  /** Core is shutting down. The node reconnects. */
  GOING_AWAY: 1001,
} as const;

/**
 * The tag in the first byte of a binary frame: `[tag][id: u32 LE][PCM s16le mono ...]`.
 * `CAPTURE` goes node → Core (`id` is a `stream_open` stream, 16 kHz); `PLAYBACK` and `LEVELS` go
 * Core → node (`id` is a `play_start` play, at its `sample_rate`). `LEVELS` is the track the
 * lip-sync levels follow for a play started with `levels`, sent before the `PLAYBACK` frame of
 * the same length it goes with.
 *
 * A watched stream (the `watch` capability) has two more, node → Core. `SNAPSHOT`:
 * `[tag][id: u32 LE][JPEG]`, the picture a `watch_snapshot` with that `id` asked for.
 * `WATCH_AUDIO`: `[tag][id: u32 LE][PCM s16le mono 16 kHz]`, the stream's sound; `id` is 0, one
 * stream is watched at a time.
 */
export const VOICE_LINK_FRAME = {
  CAPTURE: 0x01,
  PLAYBACK: 0x02,
  LEVELS: 0x03,
  SNAPSHOT: 0x04,
  WATCH_AUDIO: 0x05,
} as const;

/** Bytes before the PCM of a binary frame: the tag and the id. */
export const VOICE_LINK_FRAME_HEADER_BYTES = 5;

/** Ids (`play`, `stream`) and other counters are unsigned 32-bit integers. */
export const VOICE_LINK_U32_MAX = 0xffff_ffff;

/**
 * Bounds of Core's messages, as the node checks them (and the JSON Schema states them). Node to
 * Core messages have none beyond u32.
 */
export const VOICE_LINK_LIMITS = {
  /** `guild`, `channel` and `user_id` of Core's messages: 1 to this many characters. */
  ID_MAX_LENGTH: 64,
  /** `golive_start.source`: at most this many characters. */
  SOURCE_MAX_LENGTH: 2048,
  /** `play_start.sample_rate`, in Hz. */
  PLAY_SAMPLE_RATE_MIN: 8_000,
  PLAY_SAMPLE_RATE_MAX: 192_000,
} as const;

/**
 * Optional features a node announces in `hello.capabilities`. Core sends a feature's messages only
 * to a node that announced it; names it does not know are ignored on both sides.
 * `play_duck`: `play_duck`. `play_pause`: `play_pause` and `play_resume`. `watch`: `watch_start`,
 * `watch_stop` and `watch_snapshot`, answered with `watch`, `watch_snapshot_failed` and the
 * `SNAPSHOT` and `WATCH_AUDIO` frames.
 */
export const VOICE_LINK_CAPABILITIES = ["play_duck", "play_pause", "watch"] as const;

/**
 * Writes the header of a binary frame into its first `VOICE_LINK_FRAME_HEADER_BYTES` bytes.
 * `id` is taken modulo 2^32, as `DataView.setUint32` does; a caller that must refuse other ids
 * checks them first.
 */
export function writeFrameHeader(frame: Uint8Array, tag: number, id: number): void {
  frame[0] = tag;
  new DataView(frame.buffer, frame.byteOffset, frame.byteLength).setUint32(1, id, true);
}

/** The tag and id of a binary frame, or `null` when it is shorter than its header. */
export function readFrameHeader(frame: Uint8Array): { tag: number; id: number } | null {
  if (frame.byteLength < VOICE_LINK_FRAME_HEADER_BYTES) return null;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  return { tag: frame[0] as number, id: view.getUint32(1, true) };
}
