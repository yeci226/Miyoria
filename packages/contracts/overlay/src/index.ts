// @miyoria/contracts/overlay: the feed the stream overlay reads. The stage node serves it as JSON
// text frames on `GET /overlay/ws` (an OBS browser source connects); every frame is one of the
// messages below, told apart by `type`. A reader ignores a `type` it does not know.
//
// Not the stage link: `gift` here is the merged line (`{ text }`), `activity` and `status` are a
// subset of what the link carries, and `levels` is what viewers hear, not what the voice node sent.
//
// The other way, the page sends `OverlayReply` frames on the same socket: what became of each
// danmaku line (shown, or dropped and why), so a paid line that nobody saw is given back.

import { z } from "zod";
import {
  StageLinkKaraokeLyricsSchema,
  StageLinkKaraokeSceneSchema,
  StageLinkKaraokeVoiceSchema,
} from "../../stage-link/src/index.js";

/** Most bands a `levels` frame carries. */
export const OVERLAY_LEVEL_BANDS_MAX = 32;

/** A line of subtitle: the text of her turn so far, `final` when it is complete. */
export const OverlaySubtitleMessageSchema = z
  .object({ type: z.literal("subtitle"), turn: z.string(), text: z.string(), final: z.boolean() })
  .meta({ id: "OverlaySubtitleMessage" });

/** How she looks now. */
export const OverlayEmotionMessageSchema = z
  .object({ type: z.literal("emotion"), name: z.string(), intensity: z.number() })
  .meta({ id: "OverlayEmotionMessage" });

/** A line of status (`""` clears it). */
export const OverlayNoticeMessageSchema = z
  .object({ type: z.literal("notice"), text: z.string() })
  .meta({ id: "OverlayNoticeMessage" });

export const OverlayActivityKindSchema = z
  .enum(["thinking", "synthesizing", "tool", "game", "song_prepare", "singing"])
  .meta({ id: "OverlayActivityKind" });

/** What happens beside the main line (a song being prepared): `progress` `null` is waiting, no bar. */
export const OverlayActivitySideSchema = z
  .object({
    label: z.string(),
    detail: z.string().nullable().optional(),
    progress: z.number().nullable().optional(),
  })
  .meta({ id: "OverlayActivitySide" });

/**
 * What she is doing. `kind: null` hides the line (the other fields are then empty / null).
 * `progress` 0..1 or `null` (indeterminate); a song being sung has `elapsed_ms` and `duration_ms`
 * and its progress runs on the reader's clock.
 */
export const OverlayActivityMessageSchema = z
  .object({
    type: z.literal("activity"),
    kind: OverlayActivityKindSchema.nullable(),
    label: z.string(),
    detail: z.string().nullable(),
    progress: z.number().nullable(),
    elapsed_ms: z.number().nullable(),
    duration_ms: z.number().nullable(),
    /** A song being prepared beside the main line; left out when there is none. */
    secondary: OverlayActivitySideSchema.nullable().optional(),
  })
  .meta({ id: "OverlayActivityMessage" });

/** The gifts of the moment as one line (`""` clears it). */
export const OverlayGiftMessageSchema = z
  .object({ type: z.literal("gift"), text: z.string() })
  .meta({ id: "OverlayGiftMessage" });

/** A paid message; the overlay queues them and shows one at a time. */
export const OverlayScreenMessageSchema = z
  .object({
    type: z.literal("screen"),
    name: z.string(),
    text: z.string(),
  })
  .meta({ id: "OverlayScreenMessage" });

/**
 * A paid danmaku line: it enters from the right and crosses the screen in a lane. `name` is the
 * sender's display name, `null` when names are hidden. The limits come with every line (the owner
 * may change them): at most `max_on_screen` on the screen, `queue_max` waiting, and a line that
 * waited `max_wait_ms` is dropped. The page answers each line once (`OverlayReply`).
 */
export const OverlayDanmakuMessageSchema = z
  .object({
    type: z.literal("danmaku"),
    id: z.string(),
    name: z.string().nullable(),
    text: z.string(),
    max_on_screen: z.number(),
    queue_max: z.number(),
    max_wait_ms: z.number(),
  })
  .meta({ id: "OverlayDanmakuMessage" });

/** Takes every danmaku line off the screen; the waiting ones are dropped (`cleared`). */
export const OverlayDanmakuClearMessageSchema = z
  .object({ type: z.literal("danmaku_clear") })
  .meta({ id: "OverlayDanmakuClearMessage" });

export const OverlayTouchPartSchema = z
  .enum(["head", "face", "body", "screen"])
  .meta({ id: "OverlayTouchPart" });

/** A viewer's touch: `x`, `y` 0..1 on the picture (origin top-left). */
export const OverlayTouchMessageSchema = z
  .object({
    type: z.literal("touch"),
    x: z.number(),
    y: z.number(),
    part: OverlayTouchPartSchema,
  })
  .meta({ id: "OverlayTouchMessage" });

export const OverlaySpeakingStateSchema = z
  .enum(["started", "stopped"])
  .meta({ id: "OverlaySpeakingState" });

export const OverlaySpeakingMessageSchema = z
  .object({ type: z.literal("speaking"), state: OverlaySpeakingStateSchema })
  .meta({ id: "OverlaySpeakingMessage" });

/**
 * Her voice level as viewers hear it, once per avatar frame while there is audio and once with
 * `rms: 0` when it stops. `bands` are the lip-sync bands, lowest first; left out when there are none.
 */
export const OverlayLevelsMessageSchema = z
  .object({
    type: z.literal("levels"),
    rms: z.number(),
    bands: z.array(z.number()).max(OVERLAY_LEVEL_BANDS_MAX).optional(),
  })
  .meta({ id: "OverlayLevelsMessage" });

/** Whether the stage is connected to Core, VTube Studio and OBS, and what OBS shows. */
export const OverlayStatusMessageSchema = z
  .object({
    type: z.literal("status"),
    core: z.boolean(),
    vts: z.boolean(),
    obs: z.boolean(),
    scene: z.string().nullable(),
    streaming: z.boolean(),
  })
  .meta({ id: "OverlayStatusMessage" });

/**
 * The karaoke room the stream shows (docs/design/karaoke.md 「做了什麼第五步」), as the stage link
 * carries it, with `position_ms` moved to the moment this frame was sent. The scene plays the
 * round's sound itself (it is in the stream's own audio), so no lip-sync latency is taken off.
 * `room: null` ends the scene. A page that connects gets the latest one.
 */
export const OverlayKaraokeMessageSchema = StageLinkKaraokeSceneSchema.extend({
  type: z.literal("karaoke"),
}).meta({ id: "OverlayKaraokeMessage" });

/**
 * The words, picture and backing of the round shown: `video` and `backing.path` are URLs on the
 * overlay's own server (the stage serves the files Core named, while that round is shown), `null`
 * without one.
 */
export const OverlayKaraokeLyricsMessageSchema = StageLinkKaraokeLyricsSchema.extend({
  type: z.literal("karaoke_lyrics"),
}).meta({ id: "OverlayKaraokeLyricsMessage" });

/** A piece of the relayed voice, as the stage link carries it (not kept for later pages). */
export const OverlayKaraokeVoiceMessageSchema = StageLinkKaraokeVoiceSchema.extend({
  type: z.literal("karaoke_voice"),
}).meta({ id: "OverlayKaraokeVoiceMessage" });

/** Every frame of the feed. */
export const OverlayMessageSchema = z
  .discriminatedUnion("type", [
    OverlaySubtitleMessageSchema,
    OverlayEmotionMessageSchema,
    OverlayNoticeMessageSchema,
    OverlayActivityMessageSchema,
    OverlayGiftMessageSchema,
    OverlayScreenMessageSchema,
    OverlayDanmakuMessageSchema,
    OverlayDanmakuClearMessageSchema,
    OverlayTouchMessageSchema,
    OverlaySpeakingMessageSchema,
    OverlayLevelsMessageSchema,
    OverlayStatusMessageSchema,
    OverlayKaraokeMessageSchema,
    OverlayKaraokeLyricsMessageSchema,
    OverlayKaraokeVoiceMessageSchema,
  ])
  .meta({ id: "OverlayMessage" });
export type OverlayMessage = z.output<typeof OverlayMessageSchema>;

// ---------------------------------------------------------------------------------------------
// The page to the stage node
// ---------------------------------------------------------------------------------------------

/**
 * This page shows danmaku (its danmaku layer is on): sent once after it connects. The node waits
 * for the answers of these pages only; with none open, a line is given back at once.
 */
export const OverlayDanmakuReadySchema = z
  .object({ type: z.literal("danmaku_ready") })
  .meta({ id: "OverlayDanmakuReady" });

/** A danmaku line entered the screen (sent once, when it starts to cross). */
export const OverlayDanmakuShownSchema = z
  .object({ type: z.literal("danmaku_shown"), id: z.string() })
  .meta({ id: "OverlayDanmakuShown" });

/**
 * A danmaku line will never show: the queue was full when it came (`queue_full`), it waited longer
 * than `max_wait_ms` (`too_late`), or the layer was cleared while it waited (`cleared`).
 */
export const OverlayDanmakuDroppedSchema = z
  .object({
    type: z.literal("danmaku_dropped"),
    id: z.string(),
    reason: z.enum(["queue_full", "too_late", "cleared"]),
  })
  .meta({ id: "OverlayDanmakuDropped" });

/** Every frame the page sends. The node ignores a `type` it does not know. */
export const OverlayReplySchema = z
  .discriminatedUnion("type", [
    OverlayDanmakuReadySchema,
    OverlayDanmakuShownSchema,
    OverlayDanmakuDroppedSchema,
  ])
  .meta({ id: "OverlayReply" });
export type OverlayReply = z.output<typeof OverlayReplySchema>;
