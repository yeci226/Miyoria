// @miyoria/contracts/overlay: the feed the stream overlay reads. The stage node serves it as JSON
// text frames on `GET /overlay/ws` (an OBS browser source connects); every frame is one of the
// messages below, told apart by `type`. A reader ignores a `type` it does not know.
//
// Not the stage link: `gift` here is the merged line (`{ text }`), `activity` and `status` are a
// subset of what the link carries, and `levels` is what viewers hear, not what the voice node sent.

import { z } from "zod";

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
  .enum(["thinking", "synthesizing", "song_prepare", "singing"])
  .meta({ id: "OverlayActivityKind" });

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
  })
  .meta({ id: "OverlayActivityMessage" });

/** The gifts of the moment as one line (`""` clears it). */
export const OverlayGiftMessageSchema = z
  .object({ type: z.literal("gift"), text: z.string() })
  .meta({ id: "OverlayGiftMessage" });

export const OverlayScreenKindSchema = z
  .enum(["message", "dedication"])
  .meta({ id: "OverlayScreenKind" });

/** A paid message or a song dedication; the overlay queues them and shows one at a time. */
export const OverlayScreenMessageSchema = z
  .object({
    type: z.literal("screen"),
    kind: OverlayScreenKindSchema,
    name: z.string(),
    text: z.string(),
    song: z.string().nullable(),
  })
  .meta({ id: "OverlayScreenMessage" });

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

/** Every frame of the feed. */
export const OverlayMessageSchema = z
  .discriminatedUnion("type", [
    OverlaySubtitleMessageSchema,
    OverlayEmotionMessageSchema,
    OverlayNoticeMessageSchema,
    OverlayActivityMessageSchema,
    OverlayGiftMessageSchema,
    OverlayScreenMessageSchema,
    OverlayTouchMessageSchema,
    OverlaySpeakingMessageSchema,
    OverlayLevelsMessageSchema,
    OverlayStatusMessageSchema,
  ])
  .meta({ id: "OverlayMessage" });
export type OverlayMessage = z.output<typeof OverlayMessageSchema>;
