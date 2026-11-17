// Text frames Core sends to the voice node. The node parses them with these schemas, after it has
// checked `type` against the union's tags, so that a type it does not know stays ignorable.
//
// Core leaves an unset optional field out. The node also takes `null` for one and treats it as
// left out. What the schemas cannot say is the node's code after `parse`: `join` needs `channel`
// or `user_id`; `fade_ms` is rounded and capped at 10 s; `levels` counts only when it is `true`.

import { z } from "zod";
import { VoiceLinkPingSchema, VoiceLinkPongSchema } from "./node-messages.js";
import { VOICE_LINK_LIMITS, VOICE_LINK_U32_MAX } from "./protocol.js";

const u32 = () => z.number().int().min(0).max(VOICE_LINK_U32_MAX);
/** A Discord id (guild, channel, user). */
const id = () => z.string().min(1).max(VOICE_LINK_LIMITS.ID_MAX_LENGTH);
/** A positive u32 that may be left out. */
const optionalCount = () => z.number().int().min(1).max(VOICE_LINK_U32_MAX).nullish();
/** Fade time of a play control, in ms. Left out (or `null`) means 0. */
const fadeMs = () => z.number().min(0).nullable().default(0);

/** The answer to a good `hello`: the link is ready. */
export const VoiceLinkWelcomeSchema = z
  .object({ type: z.literal("welcome"), session: z.string().min(1) })
  .meta({ id: "VoiceLinkWelcome" });

/**
 * Join voice in `guild`: `channel` if given, else the channel `user_id` is in now. One of the two
 * is required. The node answers `joined` and `voice_state`, or `error`.
 */
export const VoiceLinkJoinSchema = z
  .object({
    type: z.literal("join"),
    guild: id(),
    channel: id().nullish(),
    user_id: id().nullish(),
  })
  .meta({ id: "VoiceLinkJoin" });

/** Leave voice in `guild`. The node answers `left`. */
export const VoiceLinkLeaveSchema = z
  .object({ type: z.literal("leave"), guild: id() })
  .meta({ id: "VoiceLinkLeave" });

/**
 * Start a play: `PLAYBACK` frames with this `play` follow (PCM s16le mono at `sample_rate`), then
 * `play_end`. The node queues plays behind each other.
 */
export const VoiceLinkPlayStartSchema = z
  .object({
    type: z.literal("play_start"),
    play: u32(),
    guild: id(),
    sample_rate: z
      .number()
      .int()
      .min(VOICE_LINK_LIMITS.PLAY_SAMPLE_RATE_MIN)
      .max(VOICE_LINK_LIMITS.PLAY_SAMPLE_RATE_MAX),
    /**
     * `true`: `LEVELS` frames follow too, the track her lip sync follows instead of the audio.
     * Older nodes ignore it, and the node never refuses a message over it: anything but `true`
     * is taken as left out.
     */
    levels: z.boolean().optional().catch(undefined),
  })
  .meta({ id: "VoiceLinkPlayStart" });

/** No more audio for `play`: the node plays what it has, then answers `playback` `finished`. */
export const VoiceLinkPlayEndSchema = z
  .object({ type: z.literal("play_end"), play: u32() })
  .meta({ id: "VoiceLinkPlayEnd" });

/** Stop `play` now (barge-in), fading out over `fade_ms`. */
export const VoiceLinkPlayStopSchema = z
  .object({ type: z.literal("play_stop"), play: u32(), fade_ms: fadeMs() })
  .meta({ id: "VoiceLinkPlayStop" });

/**
 * Set the volume of `play` to `gain` (1 = normal) over `fade_ms`; it stays until changed. Only
 * sent to nodes whose hello has the `play_duck` capability.
 */
export const VoiceLinkPlayDuckSchema = z
  .object({
    type: z.literal("play_duck"),
    play: u32(),
    gain: z.number().min(0).max(1),
    fade_ms: fadeMs(),
  })
  .meta({ id: "VoiceLinkPlayDuck" });

/** Fade `play` out and hold it; buffered audio waits. Needs capability `play_pause`. */
export const VoiceLinkPlayPauseSchema = z
  .object({ type: z.literal("play_pause"), play: u32(), fade_ms: fadeMs() })
  .meta({ id: "VoiceLinkPlayPause" });

/** Continue a paused `play`, fading in. Needs capability `play_pause`. */
export const VoiceLinkPlayResumeSchema = z
  .object({ type: z.literal("play_resume"), play: u32(), fade_ms: fadeMs() })
  .meta({ id: "VoiceLinkPlayResume" });

/** Go Live encoder: `auto` (NVENC when it opens, else x264), `nvenc`, `software`. */
export const VoiceLinkGoLiveEncoderSchema = z
  .enum(["auto", "nvenc", "software"])
  .meta({ id: "VoiceLinkGoLiveEncoder" });
export type VoiceLinkGoLiveEncoder = z.output<typeof VoiceLinkGoLiveEncoderSchema>;

/**
 * Start a Go Live stream of `source` in `guild`. Fields left out take the node's defaults. The
 * node answers with `golive` states.
 */
export const VoiceLinkGoLiveStartSchema = z
  .object({
    type: z.literal("golive_start"),
    guild: id(),
    /** `rtmp://`, `srt://`, `udp://`, `rtsp://`, `http(s)://`, `file://` or a local path; not blank. */
    source: z.string().max(VOICE_LINK_LIMITS.SOURCE_MAX_LENGTH).regex(/\S/),
    /** The voice channel to stream in. Left out: the one she is in. */
    channel: id().nullish(),
    width: optionalCount(),
    height: optionalCount(),
    fps: optionalCount(),
    bitrate_kbps: optionalCount(),
    encoder: VoiceLinkGoLiveEncoderSchema.nullish(),
    /** Send the source's audio track. Left out: yes. */
    audio: z.boolean().nullish(),
    /** The node's ffmpeg waits for the source to connect. Left out: yes for `rtmp://`, and SRT without `mode=`. */
    listen: z.boolean().nullish(),
  })
  .meta({ id: "VoiceLinkGoLiveStart" });

/** Stop the Go Live stream in `guild`. */
export const VoiceLinkGoLiveStopSchema = z
  .object({ type: z.literal("golive_stop"), guild: id() })
  .meta({ id: "VoiceLinkGoLiveStop" });

/** A text frame from Core. */
export const VoiceLinkCoreMessageSchema = z
  .discriminatedUnion("type", [
    VoiceLinkWelcomeSchema,
    VoiceLinkJoinSchema,
    VoiceLinkLeaveSchema,
    VoiceLinkPlayStartSchema,
    VoiceLinkPlayEndSchema,
    VoiceLinkPlayStopSchema,
    VoiceLinkPlayDuckSchema,
    VoiceLinkPlayPauseSchema,
    VoiceLinkPlayResumeSchema,
    VoiceLinkGoLiveStartSchema,
    VoiceLinkGoLiveStopSchema,
    VoiceLinkPingSchema,
    VoiceLinkPongSchema,
  ])
  .meta({ id: "VoiceLinkCoreMessage" });
/** A Core message as the node has it after `parse` (before its own normalising). */
export type VoiceLinkCoreMessage = z.output<typeof VoiceLinkCoreMessageSchema>;
/** A Core message as Core sends it: optional fields may be left out. */
export type VoiceLinkCoreMessageIn = z.input<typeof VoiceLinkCoreMessageSchema>;
