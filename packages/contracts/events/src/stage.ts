// The stage and the live page (docs/design/v5-contracts.md §3, K12a): what the Stage node reports
// about VTube Studio and OBS, its errors and saved highlights, and a touch on her picture. Each
// type is the bus topic it is published on, and its payload is that event's data.
//
// Tiers (v5-data §2.5): the status and a touch are ticks of the stage (`ambient`, folded into
// daily counts after 14 days); an error and a saved clip are kept 90 days (`short`). The Stage
// node's status, errors and file paths are for the owner (`owner`). A touch is drawn on the public
// stage and says where and on what, never who (`public`). How a danmaku line ended on the overlay
// is a tick too (`ambient`), for the owner: the money it settles is in the ledger.

import { z } from "zod";
import { defineEvent } from "./registry.js";

/** What the Stage node reports. */
const StageStatusConnectedSchema = z.object({
  connected: z.literal(true),
  /** Connected and authenticated to VTube Studio. */
  vts: z.boolean(),
  /** Connected to OBS. */
  obs: z.boolean(),
  /** Current OBS program scene. */
  scene: z.string().nullable(),
  /** OBS is streaming. */
  streaming: z.boolean(),
  /** OBS scene names, top of OBS's scene list first. */
  scenes: z.array(z.string()),
  /** Hotkey names of the model loaded in VTube Studio. */
  hotkeys: z.array(z.string()),
  /** URL of the node's overlay page (an OBS browser source), if it serves one. */
  overlay_url: z.string().nullable(),
  /** OBS's current scene collection, as the node last read it. */
  obs_collection: z.string().nullable(),
  /** Something about OBS the owner should fix (OBS is not on Miyoria's scene collection). */
  obs_warning: z.string().nullable(),
});

/** The Stage node connected or reported a change, or went away (`connected: false`): `stage.status`. */
export const StageStatusSchema = z
  .discriminatedUnion("connected", [
    StageStatusConnectedSchema,
    z.object({ connected: z.literal(false) }),
  ])
  .meta({ id: "EventsStageStatus" });
export type StageStatusData = z.output<typeof StageStatusSchema>;

/** The Stage node reported an error: `stage.error`. */
export const StageErrorSchema = z.object({ message: z.string() }).meta({ id: "EventsStageError" });
export type StageErrorData = z.output<typeof StageErrorSchema>;

/** A highlight was saved: `stage.clip`. `path` is the file OBS wrote on the streaming PC. */
export const StageClipSchema = z
  .object({ reason: z.string(), path: z.string() })
  .meta({ id: "EventsStageClip" });
export type StageClipData = z.output<typeof StageClipSchema>;

/**
 * How a danmaku line (`economy.danmaku`, by its `id`) ended on the stage: `stage.danmaku`. Every
 * outcome but `shown` means nobody saw it (the economy gives its price back).
 */
export const StageDanmakuSchema = z
  .object({
    id: z.string(),
    outcome: z.enum(["shown", "no_overlay", "queue_full", "too_late", "cleared", "lost"]),
  })
  .meta({ id: "EventsStageDanmaku" });
export type StageDanmakuData = z.output<typeof StageDanmakuSchema>;

/** What a touch landed on, judged from where it fell on the video frame. */
export const LivePartSchema = z
  .enum(["head", "face", "body", "screen"])
  .meta({ id: "EventsLivePart" });

/** One accepted touch from the picture: `live.touch`. `x` and `y` are 0..1, origin top-left. */
export const LiveTouchSchema = z
  .object({ x: z.number(), y: z.number(), part: LivePartSchema })
  .meta({ id: "EventsLiveTouch" });
export type LiveTouchData = z.output<typeof LiveTouchSchema>;

export const StageStatus = defineEvent({
  type: "stage.status",
  v: 1,
  data: StageStatusSchema,
  scope: "owner",
  tier: "ambient",
});

export const StageError = defineEvent({
  type: "stage.error",
  v: 1,
  data: StageErrorSchema,
  scope: "owner",
  tier: "short",
});

export const StageClip = defineEvent({
  type: "stage.clip",
  v: 1,
  data: StageClipSchema,
  scope: "owner",
  tier: "short",
});

export const LiveTouch = defineEvent({
  type: "live.touch",
  v: 1,
  data: LiveTouchSchema,
  scope: "public",
  tier: "ambient",
});

export const StageDanmaku = defineEvent({
  type: "stage.danmaku",
  v: 1,
  data: StageDanmakuSchema,
  scope: "owner",
  tier: "ambient",
});

/** Every stage and live type. */
export const STAGE_EVENTS = [StageStatus, StageError, StageClip, LiveTouch, StageDanmaku] as const;
