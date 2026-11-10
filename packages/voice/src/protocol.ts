// Voice Link v1 wire format (`docs/protocols/voice-link.md`).

import { z } from "zod";

export const VERSION = 1;

/** Close codes used by Core. */
export const CLOSE = {
  /** Malformed hello, unsupported version or no hello in time. */
  BAD_HELLO: 4400,
  /** Wrong token. */
  UNAUTHORIZED: 4401,
  /** A newer connection for the same self account replaced this one. */
  REPLACED: 4409,
  /** Dead peer (no traffic within the heartbeat timeout). */
  TIMEOUT: 4408,
  /** Core is shutting down. */
  GOING_AWAY: 1001,
} as const;

/** Binary frame tag of captured audio (node → Core). */
export const TAG_CAPTURE = 0x01;
/** Binary frame tag of playback audio (Core → node). */
export const TAG_PLAYBACK = 0x02;
/**
 * Binary frame tag of a playback's levels track (Core → node, plays started with `levels`):
 * what the lip-sync levels follow instead of the audio, sent before the `0x02` frame it goes with.
 */
export const TAG_LEVELS = 0x03;

/** Binary frame tag of a watch snapshot (node → Core): `[0x04][id: u32 LE][JPEG]`. */
export const TAG_SNAPSHOT = 0x04;
/** Binary frame tag of a watched stream's audio (node → Core): `[0x05][PCM s16le mono 16 kHz]`, no id. */
export const TAG_WATCH_AUDIO = 0x05;

const u32 = () => z.number().int().min(0).max(0xffff_ffff);
const optString = () => z.string().nullable().default(null);

export const SelfAccountSchema = z.object({ platform: z.string(), id: z.string() });
export type SelfAccount = z.output<typeof SelfAccountSchema>;

export const WireParticipantSchema = z.object({
  user_id: z.string(),
  display_name: z.string().default(""),
  is_self: z.boolean().default(false),
  muted: z.boolean().default(false),
  deafened: z.boolean().default(false),
});
export type WireParticipant = z.output<typeof WireParticipantSchema>;

export const WirePlaybackStateSchema = z.enum(["started", "finished", "interrupted", "failed"]);
export type WirePlaybackState = z.output<typeof WirePlaybackStateSchema>;

/** Go Live state reported by the node. */
export const WireGoLiveStateSchema = z.enum(["starting", "live", "stopped", "failed"]);
export type WireGoLiveState = z.output<typeof WireGoLiveStateSchema>;

/** Watch state reported by the node. */
export const WireWatchStateSchema = z.enum(["starting", "live", "stopped", "failed"]);
export type WireWatchState = z.output<typeof WireWatchStateSchema>;

/** Text frames sent by the voice node. */
export const NodeMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    version: u32(),
    token: z.string(),
    node: z.string().default(""),
    self_account: SelfAccountSchema,
    /** Optional features of the node (`play_duck`, `play_pause`); older nodes send none. */
    capabilities: z.array(z.string()).default([]),
  }),
  z.object({ type: z.literal("joined"), guild: z.string(), channel: z.string() }),
  z.object({ type: z.literal("left"), guild: z.string(), reason: optString() }),
  z.object({
    type: z.literal("voice_state"),
    guild: z.string(),
    channel: z.string(),
    participants: z.array(WireParticipantSchema),
  }),
  z.object({
    type: z.literal("speaking"),
    guild: z.string(),
    user_id: z.string(),
    speaking: z.boolean(),
  }),
  z.object({
    type: z.literal("stream_open"),
    stream: u32(),
    guild: z.string(),
    channel: z.string(),
    user_id: z.string(),
    display_name: z.string().default(""),
    sample_rate: u32(),
  }),
  z.object({ type: z.literal("stream_close"), stream: u32() }),
  z.object({
    type: z.literal("playback"),
    play: u32(),
    state: WirePlaybackStateSchema,
    error: optString(),
  }),
  z.object({
    type: z.literal("golive"),
    guild: z.string(),
    state: WireGoLiveStateSchema,
    error: optString(),
    reason: optString(),
  }),
  z.object({
    type: z.literal("watch"),
    guild: z.string(),
    user_id: z.string(),
    state: WireWatchStateSchema,
    error: optString(),
    reason: optString(),
  }),
  z.object({ type: z.literal("watch_snapshot_failed"), id: u32(), error: z.string() }),
  z.object({ type: z.literal("error"), message: z.string() }),
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("pong") }),
]);
export type NodeMessage = z.output<typeof NodeMessageSchema>;

/** Text frames sent by Core. Optional fields are left out when unset. */
export type CoreMessage =
  | { type: "welcome"; session: string }
  | { type: "join"; guild: string; channel?: string; user_id?: string }
  | { type: "leave"; guild: string }
  /** `levels`: `0x03` frames follow with the track the lip-sync levels use (older nodes ignore it). */
  | { type: "play_start"; play: number; guild: string; sample_rate: number; levels?: boolean }
  | { type: "play_end"; play: number }
  | { type: "play_stop"; play: number; fade_ms: number }
  /**
   * Sets the volume of a play (`gain` 0..1, 1 = normal) with a ramp of `fade_ms`; it stays until
   * changed. Only sent to nodes whose hello `capabilities` has `play_duck`.
   */
  | { type: "play_duck"; play: number; gain: number; fade_ms: number }
  /** Fades the play out and holds it (buffered audio waits). Needs capability `play_pause`. */
  | { type: "play_pause"; play: number; fade_ms: number }
  /** Continues a paused play with a fade-in. Needs capability `play_pause`. */
  | { type: "play_resume"; play: number; fade_ms: number }
  /** Starts a Go Live stream of `source` (see `docs/protocols/voice-link.md`). */
  | {
      type: "golive_start";
      guild: string;
      channel?: string;
      source: string;
      width?: number;
      height?: number;
      fps?: number;
      bitrate_kbps?: number;
      encoder?: string;
      audio?: boolean;
      listen?: boolean;
    }
  | { type: "golive_stop"; guild: string }
  | { type: "watch_start"; guild: string; user_id: string }
  | { type: "watch_stop"; guild: string }
  | { type: "watch_snapshot"; id: number }
  | { type: "ping" }
  | { type: "pong" };

/** Serializes a Core message; `undefined` fields are dropped (serde `skip_serializing_if`). */
export function coreMessageJson(msg: CoreMessage): string {
  return JSON.stringify(msg);
}

/** `[tag][id: u32 LE][PCM s16le ...]`. */
export function encodeAudio(tag: number, id: number, samples: Int16Array): Uint8Array {
  const out = new Uint8Array(5 + samples.length * 2);
  const v = new DataView(out.buffer);
  out[0] = tag;
  v.setUint32(1, id, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(5 + i * 2, samples[i] as number, true);
  return out;
}

/** Parses a binary frame into `{ tag, id, samples }`. A trailing odd byte is ignored. */
export function decodeAudio(
  frame: Uint8Array,
): { tag: number; id: number; samples: Int16Array } | null {
  if (frame.length < 5) return null;
  const v = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const count = (frame.length - 5) >> 1;
  const samples = new Int16Array(count);
  for (let i = 0; i < count; i++) samples[i] = v.getInt16(5 + i * 2, true);
  return { tag: frame[0] as number, id: v.getUint32(1, true), samples };
}

/** Parses a `0x04` frame. Null when shorter than its 5-byte header. */
export function decodeSnapshot(frame: Uint8Array): { id: number; jpeg: Buffer } | null {
  if (frame.length < 5) return null;
  const b = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
  return { id: b.readUInt32LE(1), jpeg: b.subarray(5) };
}

/** Parses a `0x05` frame's PCM. The input need not be aligned; a trailing odd byte is ignored. */
export function decodeWatchAudio(frame: Uint8Array): Int16Array {
  const count = Math.max(0, (frame.length - 1) >> 1);
  const v = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const out = new Int16Array(count);
  for (let i = 0; i < count; i++) out[i] = v.getInt16(1 + i * 2, true);
  return out;
}
