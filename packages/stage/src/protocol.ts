// Stage Link v1 wire format (`docs/protocols/stage-link.md`). The messages themselves are the
// contract (`@miyoria/contracts/stage-link`); this file names them the way the package does, parses
// them, and holds the helpers built on them.

import {
  ACTIVITY_DETAIL_MAX,
  ACTIVITY_LABEL_MAX,
  type Activity,
  type ActivityKind,
  BEATS_MAX,
  CLIP_REASON_MAX,
  type CoreMessageWire,
  DANMAKU_ID_MAX,
  DANMAKU_NAME_MAX,
  DANMAKU_ON_SCREEN_MAX,
  DANMAKU_QUEUE_MAX,
  DANMAKU_TEXT_MAX,
  DANMAKU_WAIT_MAX_MS,
  type DanmakuOutcome,
  type GazeTarget,
  GIFT_EXPRESSION_MAX_S,
  GIFT_EXPRESSIONS,
  GIFT_LABEL_MAX,
  GIFT_NAME_MAX,
  type GiftExpression,
  type KaraokeStageLyrics,
  type KaraokeStageScene,
  type KaraokeStageVoice,
  type LevelFrame,
  SCREEN_NAME_MAX,
  SCREEN_TEXT_MAX,
  type SongVideoAction,
  type SpeakingState,
  STAGE_LINK_CLOSE,
  STAGE_LINK_VERSION,
  StageLinkCoreMessageSchema,
  StageLinkGazeTargetSchema,
  StageLinkGiftExpressionSchema,
  StageLinkLevelFrameSchema,
  StageLinkSongVideoActionSchema,
  StageLinkSpeakingStateSchema,
  StageLinkStageMessageSchema,
  StageLinkStreamActionSchema,
  type StageMessageWire,
  type StageStatus,
  type StreamAction,
  TRANSITION_MAX_MS,
} from "@miyoria/contracts/stage-link";

export type {
  Activity,
  ActivityKind,
  DanmakuOutcome,
  GazeTarget,
  GiftExpression,
  KaraokeStageLyrics,
  KaraokeStageScene,
  KaraokeStageVoice,
  LevelFrame,
  SongVideoAction,
  SpeakingState,
  StageStatus,
  StreamAction,
};
export {
  ACTIVITY_DETAIL_MAX,
  ACTIVITY_LABEL_MAX,
  BEATS_MAX,
  CLIP_REASON_MAX,
  DANMAKU_ID_MAX,
  DANMAKU_NAME_MAX,
  DANMAKU_ON_SCREEN_MAX,
  DANMAKU_QUEUE_MAX,
  DANMAKU_TEXT_MAX,
  DANMAKU_WAIT_MAX_MS,
  GIFT_EXPRESSION_MAX_S,
  GIFT_EXPRESSIONS,
  GIFT_LABEL_MAX,
  GIFT_NAME_MAX,
  SCREEN_NAME_MAX,
  SCREEN_TEXT_MAX,
  TRANSITION_MAX_MS,
};

export const VERSION = STAGE_LINK_VERSION;

/** Close codes used by Core. */
export const CLOSE = STAGE_LINK_CLOSE;

export const StreamActionSchema = StageLinkStreamActionSchema;
export const GazeTargetSchema = StageLinkGazeTargetSchema;
export const GiftExpressionSchema = StageLinkGiftExpressionSchema;
export const SongVideoActionSchema = StageLinkSongVideoActionSchema;
export const SpeakingStateSchema = StageLinkSpeakingStateSchema;

export function parseGazeTarget(s: string): GazeTarget | null {
  const v = s.trim().toLowerCase();
  return v === "chat" || v === "game" || v === "camera" ? v : null;
}

/** An OBS scene transition: its name and, for transitions that have one, a duration. */
export interface SceneTransition {
  name: string;
  /** `null` = keep the transition's own duration (fixed transitions such as stingers). */
  duration_ms: number | null;
}

/** The transition a `scene` message asks for, if any. */
export function sceneTransitionOf(msg: {
  transition?: string;
  transition_ms?: number;
}): SceneTransition | null {
  return msg.transition ? { name: msg.transition, duration_ms: msg.transition_ms ?? null } : null;
}

export function defaultStageStatus(): StageStatus {
  return {
    vts: false,
    obs: false,
    scene: null,
    streaming: false,
    scenes: [],
    hotkeys: [],
    overlay_url: null,
    obs_collection: null,
    obs_warning: null,
  };
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function sameStatus(a: StageStatus | null, b: StageStatus | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.vts === b.vts &&
    a.obs === b.obs &&
    a.scene === b.scene &&
    a.streaming === b.streaming &&
    a.overlay_url === b.overlay_url &&
    a.obs_collection === b.obs_collection &&
    a.obs_warning === b.obs_warning &&
    sameList(a.scenes, b.scenes) &&
    sameList(a.hotkeys, b.hotkeys)
  );
}

/**
 * Text frames sent by the Stage node, as the code handles them: a missing or `null` `id` is a
 * missing key.
 */
export type StageMessage = Settled<StageMessageWire, "id">;

/** Text frames sent by Core, as the code handles them: a `null` optional field is a missing key. */
export type CoreMessage = Settled<
  CoreMessageWire,
  "id" | "resting" | "transition" | "transition_ms" | "path" | "offset_ms" | "scene"
>;

/** `T` with `null` taken out of the types of the keys `K` (a key that was optional stays so). */
type Settled<T, K extends PropertyKey> = T extends unknown
  ? { [P in keyof T]: P extends K ? Exclude<T[P], null> : T[P] }
  : never;

/**
 * Normalises what a peer may send into what the code handles. A `null` or missing optional key is
 * dropped (`resting` keeps the key with `undefined` for `null`, as it always has); text that is
 * trimmed to nothing, and an empty `path`, count as missing.
 */
function settle(msg: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of keys) {
    if (!(key in msg)) continue;
    const value = msg[key];
    if (key === "resting") {
      if (value === null) msg[key] = undefined;
      continue;
    }
    if (value === null || value === undefined) {
      delete msg[key];
    } else if (typeof value === "string") {
      const text = key === "transition" || key === "scene" ? value.trim() : value;
      if (text === "") delete msg[key];
      else msg[key] = text;
    }
  }
}

const CORE_OPTIONAL_KEYS = [
  "id",
  "resting",
  "transition",
  "transition_ms",
  "path",
  "offset_ms",
  "scene",
] as const;

/** Parses a value as a Stage message; throws a `ZodError`. */
export function parseStageMessage(value: unknown): StageMessage {
  const msg = StageLinkStageMessageSchema.parse(value);
  settle(msg, ["id"]);
  return msg as StageMessage;
}

/** Parses a value as a Core message; throws a `ZodError`. */
export function parseCoreMessage(value: unknown): CoreMessage {
  const msg = StageLinkCoreMessageSchema.parse(value);
  settle(msg, CORE_OPTIONAL_KEYS);
  return msg as CoreMessage;
}

/** JSON text of a message (a missing `id` is left out). */
export function encodeMessage(msg: StageMessage | CoreMessage): string {
  return JSON.stringify(msg);
}

/** Status without the message fields. */
export function statusOf(msg: StageStatus): StageStatus {
  return {
    vts: msg.vts,
    obs: msg.obs,
    scene: msg.scene,
    streaming: msg.streaming,
    scenes: [...msg.scenes],
    hotkeys: [...msg.hotkeys],
    overlay_url: msg.overlay_url,
    obs_collection: msg.obs_collection,
    obs_warning: msg.obs_warning,
  };
}

export function parseLevelFrame(value: unknown): LevelFrame {
  const f = StageLinkLevelFrameSchema.parse(value);
  const out: LevelFrame = { rms: f.rms };
  if (f.t !== undefined) out.t = f.t;
  if (f.bands !== undefined) out.bands = f.bands;
  return out;
}
