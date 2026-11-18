// Voice Link v1 wire format (`docs/protocols/voice-link.md`). The messages are written once, in
// `@miyoria/contracts/voice-link`; this file keeps the names Core's code uses for them.

import {
  readFrameHeader,
  VOICE_LINK_CLOSE,
  VOICE_LINK_FRAME,
  VOICE_LINK_FRAME_HEADER_BYTES,
  VOICE_LINK_VERSION,
  type VoiceLinkCoreMessageIn,
  VoiceLinkGoLiveEncoderSchema,
  VoiceLinkGoLiveStateSchema,
  VoiceLinkNodeMessageSchema,
  VoiceLinkParticipantSchema,
  VoiceLinkSelfAccountSchema,
  writeFrameHeader,
} from "@miyoria/contracts/voice-link";
import { PlaybackStateSchema } from "@miyoria/contracts/wire";
import type { z } from "zod";

export const VERSION = VOICE_LINK_VERSION;

/** Close codes used by Core. */
export const CLOSE = VOICE_LINK_CLOSE;

/** Binary frame tag of captured audio (node → Core). */
export const TAG_CAPTURE = VOICE_LINK_FRAME.CAPTURE;
/** Binary frame tag of playback audio (Core → node). */
export const TAG_PLAYBACK = VOICE_LINK_FRAME.PLAYBACK;
/**
 * Binary frame tag of a playback's levels track (Core → node, plays started with `levels`):
 * what the lip-sync levels follow instead of the audio, sent before the `0x02` frame it goes with.
 */
export const TAG_LEVELS = VOICE_LINK_FRAME.LEVELS;
/** A picture of the watched stream (node → Core): the id is its `watch_snapshot`'s, then a JPEG. */
export const TAG_SNAPSHOT = VOICE_LINK_FRAME.SNAPSHOT;
/** The watched stream's sound (node → Core): PCM s16le mono 16 kHz; the id is not used. */
export const TAG_WATCH_AUDIO = VOICE_LINK_FRAME.WATCH_AUDIO;
/** The capability of a node that can watch a stream. */
export const CAPABILITY_WATCH = "watch";

export const SelfAccountSchema = VoiceLinkSelfAccountSchema;
export type SelfAccount = z.output<typeof SelfAccountSchema>;

export const WireParticipantSchema = VoiceLinkParticipantSchema;
export type WireParticipant = z.output<typeof WireParticipantSchema>;

export const WirePlaybackStateSchema = PlaybackStateSchema;

/** Go Live state reported by the node. */
export const WireGoLiveStateSchema = VoiceLinkGoLiveStateSchema;

/** Go Live encoders the node knows. */
export const GoLiveEncoderSchema = VoiceLinkGoLiveEncoderSchema;
export type GoLiveEncoder = z.output<typeof GoLiveEncoderSchema>;

/** Text frames sent by the voice node. */
export const NodeMessageSchema = VoiceLinkNodeMessageSchema;
export type NodeMessage = z.output<typeof NodeMessageSchema>;

/** Text frames sent by Core. Optional fields are left out when unset. */
export type CoreMessage = VoiceLinkCoreMessageIn;

/** Serializes a Core message; `undefined` fields are dropped. */
export function coreMessageJson(msg: CoreMessage): string {
  return JSON.stringify(msg);
}

/** `[tag][id: u32 LE][PCM s16le ...]`. */
export function encodeAudio(tag: number, id: number, samples: Int16Array): Uint8Array {
  const out = new Uint8Array(VOICE_LINK_FRAME_HEADER_BYTES + samples.length * 2);
  writeFrameHeader(out, tag, id);
  const v = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    v.setInt16(VOICE_LINK_FRAME_HEADER_BYTES + i * 2, samples[i] as number, true);
  }
  return out;
}

/** Parses a binary frame into `{ tag, id, samples }`. A trailing odd byte is ignored. */
export function decodeAudio(
  frame: Uint8Array,
): { tag: number; id: number; samples: Int16Array } | null {
  const header = readFrameHeader(frame);
  if (header === null) return null;
  const v = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const count = (frame.length - VOICE_LINK_FRAME_HEADER_BYTES) >> 1;
  const samples = new Int16Array(count);
  for (let i = 0; i < count; i++) {
    samples[i] = v.getInt16(VOICE_LINK_FRAME_HEADER_BYTES + i * 2, true);
  }
  return { tag: header.tag, id: header.id, samples };
}
