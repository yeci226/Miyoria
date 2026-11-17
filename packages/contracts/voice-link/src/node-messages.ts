// Text frames the voice node sends to Core. Core parses them with `VoiceLinkNodeMessageSchema`.
//
// A key the node leaves out is filled in by Core (`.default`): an optional string becomes `null`,
// a list `[]`. A node built before a field existed is still valid that way.

import { z } from "zod";
import { PlaybackStateSchema } from "../../wire/src/index.js";
import { VOICE_LINK_U32_MAX } from "./protocol.js";

const u32 = () => z.number().int().min(0).max(VOICE_LINK_U32_MAX);
const optionalString = () => z.string().nullable().default(null);

/** The account the node is logged in as. */
export const VoiceLinkSelfAccountSchema = z
  .object({
    /** `discord`. */
    platform: z.string(),
    id: z.string(),
  })
  .meta({ id: "VoiceLinkSelfAccount" });
export type VoiceLinkSelfAccount = z.output<typeof VoiceLinkSelfAccountSchema>;

/** Someone in the voice channel, as the node sees them. */
export const VoiceLinkParticipantSchema = z
  .object({
    user_id: z.string(),
    display_name: z.string().default(""),
    /** The node's own account. */
    is_self: z.boolean().default(false),
    muted: z.boolean().default(false),
    deafened: z.boolean().default(false),
  })
  .meta({ id: "VoiceLinkParticipant" });
export type VoiceLinkParticipant = z.output<typeof VoiceLinkParticipantSchema>;

/**
 * Go Live state: `starting` (waiting for the source, connecting to Discord), `live` (frames are
 * going out), `stopped` (asked to, the source ended, left voice), `failed` (see `error`).
 */
export const VoiceLinkGoLiveStateSchema = z
  .enum(["starting", "live", "stopped", "failed"])
  .meta({ id: "VoiceLinkGoLiveState" });
export type VoiceLinkGoLiveState = z.output<typeof VoiceLinkGoLiveStateSchema>;

/** The first message on a connection. Core answers `welcome`, or closes (`VOICE_LINK_CLOSE`). */
export const VoiceLinkHelloSchema = z
  .object({
    type: z.literal("hello"),
    /** `VOICE_LINK_VERSION`. */
    version: u32(),
    /** The shared secret (`VOICE_LINK_TOKEN`). */
    token: z.string(),
    /** A name for logs, e.g. `voice-node`. */
    node: z.string().default(""),
    self_account: VoiceLinkSelfAccountSchema,
    /** Optional features of the node (`VOICE_LINK_CAPABILITIES`); older nodes send none. */
    capabilities: z.array(z.string()).default([]),
  })
  .meta({ id: "VoiceLinkHello" });

/** The node is in a voice channel (after `join`, or after it rejoined on its own). */
export const VoiceLinkJoinedSchema = z
  .object({ type: z.literal("joined"), guild: z.string(), channel: z.string() })
  .meta({ id: "VoiceLinkJoined" });

/** The node left voice in `guild` (asked to, kicked, the channel was deleted, ...). */
export const VoiceLinkLeftSchema = z
  .object({ type: z.literal("left"), guild: z.string(), reason: optionalString() })
  .meta({ id: "VoiceLinkLeft" });

/** Everyone in the node's voice channel: sent on joining and on every change. */
export const VoiceLinkVoiceStateSchema = z
  .object({
    type: z.literal("voice_state"),
    guild: z.string(),
    channel: z.string(),
    participants: z.array(VoiceLinkParticipantSchema),
  })
  .meta({ id: "VoiceLinkVoiceState" });

/** Discord's speaking start / stop signal for one user. */
export const VoiceLinkSpeakingSchema = z
  .object({
    type: z.literal("speaking"),
    guild: z.string(),
    user_id: z.string(),
    speaking: z.boolean(),
  })
  .meta({ id: "VoiceLinkSpeaking" });

/** Someone started talking: their audio follows as `CAPTURE` frames with this `stream`. */
export const VoiceLinkStreamOpenSchema = z
  .object({
    type: z.literal("stream_open"),
    stream: u32(),
    guild: z.string(),
    channel: z.string(),
    user_id: z.string(),
    display_name: z.string().default(""),
    /** Of the `CAPTURE` frames: 16000. */
    sample_rate: u32(),
  })
  .meta({ id: "VoiceLinkStreamOpen" });

/** The speaker stopped (Discord stopped sending packets); a hint that a sentence ended. */
export const VoiceLinkStreamCloseSchema = z
  .object({ type: z.literal("stream_close"), stream: u32() })
  .meta({ id: "VoiceLinkStreamClose" });

/** State of a play: `started` (audible), `finished`, `interrupted` or `failed` (see `error`). */
export const VoiceLinkPlaybackSchema = z
  .object({
    type: z.literal("playback"),
    play: u32(),
    state: PlaybackStateSchema,
    error: optionalString(),
  })
  .meta({ id: "VoiceLinkPlayback" });

/** Go Live state of `guild`; sent again after Core reconnects. */
export const VoiceLinkGoLiveSchema = z
  .object({
    type: z.literal("golive"),
    guild: z.string(),
    state: VoiceLinkGoLiveStateSchema,
    /** Why it failed (`failed`), for people. */
    error: optionalString(),
    /** Why it ended (`stopped`), e.g. `source ended`. */
    reason: optionalString(),
  })
  .meta({ id: "VoiceLinkGoLive" });

/** A non-fatal error, e.g. a `join` that failed. Core fails the oldest waiting `join` with it. */
export const VoiceLinkNodeErrorSchema = z
  .object({ type: z.literal("error"), message: z.string() })
  .meta({ id: "VoiceLinkNodeError" });

/**
 * Heartbeat, answered with `pong`. Core pings the node (every 15 s by default). Core also answers
 * a node's ping, but the node never sends one, and it ignores a `pong` from Core.
 */
export const VoiceLinkPingSchema = z
  .object({ type: z.literal("ping") })
  .meta({ id: "VoiceLinkPing" });

/** The answer to `ping`. */
export const VoiceLinkPongSchema = z
  .object({ type: z.literal("pong") })
  .meta({ id: "VoiceLinkPong" });

/** A text frame from the node. */
export const VoiceLinkNodeMessageSchema = z
  .discriminatedUnion("type", [
    VoiceLinkHelloSchema,
    VoiceLinkJoinedSchema,
    VoiceLinkLeftSchema,
    VoiceLinkVoiceStateSchema,
    VoiceLinkSpeakingSchema,
    VoiceLinkStreamOpenSchema,
    VoiceLinkStreamCloseSchema,
    VoiceLinkPlaybackSchema,
    VoiceLinkGoLiveSchema,
    VoiceLinkNodeErrorSchema,
    VoiceLinkPingSchema,
    VoiceLinkPongSchema,
  ])
  .meta({ id: "VoiceLinkNodeMessage" });
/** A node message as Core has it after `parse`, defaults filled in. */
export type VoiceLinkNodeMessage = z.output<typeof VoiceLinkNodeMessageSchema>;
/** A node message as the node sends it: keys with a default may be left out. */
export type VoiceLinkNodeMessageIn = z.input<typeof VoiceLinkNodeMessageSchema>;
