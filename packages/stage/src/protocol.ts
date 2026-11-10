// Stage Link v1 wire format (`docs/protocols/stage-link.md`).

import { z } from "zod";

export const VERSION = 1;

/** Longest scene transition OBS accepts (`SetCurrentSceneTransitionDuration`), in ms. */
export const TRANSITION_MAX_MS = 20_000;

/** Close codes used by Core. */
export const CLOSE = {
  /** Malformed hello, unsupported version or no hello in time. */
  BAD_HELLO: 4400,
  /** Wrong token. */
  UNAUTHORIZED: 4401,
  /** Dead peer (no traffic within the heartbeat timeout). */
  TIMEOUT: 4408,
  /** A newer Stage connection replaced this one. */
  REPLACED: 4409,
  /** Core is shutting down. */
  GOING_AWAY: 1001,
} as const;

/** `stream` actions. */
export type StreamAction = "start" | "stop";
export const StreamActionSchema = z.enum(["start", "stop"]);

/** Where she looks. Default `camera`. */
export type GazeTarget = "chat" | "game" | "camera";
export const GazeTargetSchema = z.enum(["chat", "game", "camera"]);

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

/** Expressions the economy can show for a gift (`stage.expression`); the avatar config maps them to files. */
export const GIFT_EXPRESSIONS = ["heart", "blush", "squint", "big_bowl"] as const;
export type GiftExpression = (typeof GIFT_EXPRESSIONS)[number];
export const GiftExpressionSchema = z.enum(GIFT_EXPRESSIONS);

/** Longest time a gift expression stays on, in seconds. */
export const GIFT_EXPRESSION_MAX_S = 15;

/** Longest giver name / gift label the overlay line takes (code units). */
export const GIFT_NAME_MAX = 32;
export const GIFT_LABEL_MAX = 24;

/** Longest payer name / message / song title a screen card takes (code units). */
export const SCREEN_NAME_MAX = 32;
export const SCREEN_TEXT_MAX = 200;
export const SCREEN_SONG_MAX = 128;

/** `song_video` actions. */
export type SongVideoAction = "play" | "stop";
export const SongVideoActionSchema = z.enum(["play", "stop"]);

/**
 * What she is doing, for the overlay's activity line: `thinking` (a turn runs, nothing said yet),
 * `synthesizing` (her line is at TTS), `song_prepare` (the song worker makes a song), `singing`.
 */
export type ActivityKind = "thinking" | "synthesizing" | "song_prepare" | "singing";

/** Longest activity `label` / `detail` (code units). */
export const ACTIVITY_LABEL_MAX = 40;
export const ACTIVITY_DETAIL_MAX = 120;

/**
 * An `activity` message. `kind: null` hides the line (the other fields are then empty / null).
 * `label` is the short zh-TW text, `detail` the song it is about (already escaped and capped),
 * `progress` 0..1 or `null` (indeterminate). A song being sung has `elapsed_ms` (how far into it
 * it was when the message was sent) and `duration_ms`, so its progress runs on the receiver's
 * clock instead.
 */
export interface Activity {
  kind: ActivityKind | null;
  label: string;
  detail: string | null;
  progress: number | null;
  elapsed_ms: number | null;
  duration_ms: number | null;
}

/** `speaking` states. */
export type SpeakingState = "started" | "stopped";
export const SpeakingStateSchema = z.enum(["started", "stopped"]);

/** What the Stage node reports in `status`. */
export interface StageStatus {
  /** Connected and authenticated to VTube Studio. */
  vts: boolean;
  /** Connected to OBS. */
  obs: boolean;
  /** Current OBS program scene. */
  scene: string | null;
  /** OBS is streaming. */
  streaming: boolean;
  /** OBS scene names, top of OBS's scene list first. */
  scenes: string[];
  /** Hotkey names of the model loaded in VTube Studio. */
  hotkeys: string[];
  /** URL of the node's overlay page (an OBS browser source), if it serves one. */
  overlay_url: string | null;
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
    sameList(a.scenes, b.scenes) &&
    sameList(a.hotkeys, b.hotkeys)
  );
}

const requestId = z
  .number()
  .int()
  .nonnegative()
  .max(0xffff_ffff)
  .nullish()
  .transform((v) => v ?? undefined);

const StageStatusFields = {
  vts: z.boolean().default(false),
  obs: z.boolean().default(false),
  scene: z.string().nullable().default(null),
  streaming: z.boolean().default(false),
  // Added after v1 shipped; older nodes leave them out.
  scenes: z.array(z.string()).default([]),
  hotkeys: z.array(z.string()).default([]),
  overlay_url: z.string().nullable().default(null),
};

/** Text frames sent by the Stage node. `id` answers a Core request. */
export type StageMessage =
  | { type: "hello"; version: number; token: string; node: string; capabilities: string[] }
  | ({ type: "status"; id?: number } & StageStatus)
  | { type: "error"; message: string; id?: number }
  | { type: "ping" }
  | { type: "pong" };

const StageMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    version: z.number().int().nonnegative(),
    token: z.string(),
    node: z.string().default(""),
    capabilities: z.array(z.string()).default([]),
  }),
  z.object({ type: z.literal("status"), ...StageStatusFields, id: requestId }),
  z.object({ type: z.literal("error"), message: z.string(), id: requestId }),
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("pong") }),
]);

/** Text frames sent by Core. */
export type CoreMessage =
  | { type: "welcome"; session: string }
  /**
   * `resting`: not a moment of a line but how she looks while nothing else is shown, until the
   * next `resting` one (`neutral`: nothing stands out). An older node shows it for a moment.
   */
  | { type: "emotion"; name: string; intensity: number; resting?: boolean }
  | { type: "subtitle"; turn: string; text: string; final: boolean }
  | { type: "speaking"; state: SpeakingState }
  /**
   * `transition` (an OBS transition name) and `transition_ms` (its duration) are set as OBS's
   * current transition before the switch; left out, OBS uses whatever is current.
   */
  | { type: "scene"; name: string; transition?: string; transition_ms?: number; id?: number }
  | { type: "stream"; action: StreamAction; id?: number }
  | { type: "avatar_hotkey"; name: string; id?: number }
  | { type: "gaze"; target: GazeTarget }
  /**
   * Shows a gift expression for `seconds` (the node maps `expression` to a VTS expression file),
   * then takes it off and restores her own. Answered (with `id`) once it is on.
   */
  | { type: "avatar_expression"; expression: GiftExpression; seconds: number; id?: number }
  /** Someone fed her something (`economy.gift`); the overlay merges gifts into one line. */
  | { type: "gift"; name: string; item: string; count: number; label: string }
  /**
   * A paid message or a song dedication (`economy.screen`). Unlike gifts they are not merged: the
   * overlay queues them and shows one at a time. `song` is the title for a dedication, else null.
   */
  | {
      type: "screen";
      kind: "message" | "dedication";
      name: string;
      text: string;
      song: string | null;
    }
  /**
   * The song she sings has a video: `play` shows `path` (a file in the song worker's cache on
   * the streaming PC) in the media source, muted, `offset_ms` into the song at the moment the
   * message was sent, in `scene` when the scene director switches to a `sing` scene (else the
   * current one); `stop` stops and clears it.
   */
  | {
      type: "song_video";
      action: SongVideoAction;
      song: string;
      path?: string;
      offset_ms?: number;
      scene?: string;
    }
  /** A line of status for the overlay (`""` clears it), e.g. 「準備歌曲中…」. */
  | { type: "notice"; text: string }
  /** What she is doing now, for the overlay's activity line. */
  | ({ type: "activity" } & Activity)
  /** Asks for a `status` (with the same `id`). */
  | { type: "status_request"; id?: number }
  | { type: "ping" }
  | { type: "pong" };

const CoreMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("welcome"), session: z.string() }),
  z.object({
    type: z.literal("emotion"),
    name: z.string(),
    intensity: z.number(),
    // Added after v1 shipped; older Cores leave it out (older nodes ignore it).
    resting: z
      .boolean()
      .nullish()
      .transform((v) => v ?? undefined),
  }),
  z.object({ type: z.literal("subtitle"), turn: z.string(), text: z.string(), final: z.boolean() }),
  z.object({ type: z.literal("speaking"), state: SpeakingStateSchema }),
  z.object({
    type: z.literal("scene"),
    name: z.string(),
    // Added after v1 shipped; older Cores leave them out (older nodes ignore them).
    transition: z
      .string()
      .nullish()
      .transform((v) => (v?.trim() ? v.trim() : undefined)),
    transition_ms: z
      .number()
      .int()
      .min(0)
      .max(TRANSITION_MAX_MS)
      .nullish()
      .transform((v) => v ?? undefined),
    id: requestId,
  }),
  z.object({ type: z.literal("stream"), action: StreamActionSchema, id: requestId }),
  z.object({ type: z.literal("avatar_hotkey"), name: z.string(), id: requestId }),
  z.object({ type: z.literal("gaze"), target: GazeTargetSchema }),
  z.object({
    type: z.literal("avatar_expression"),
    expression: GiftExpressionSchema,
    seconds: z.number().min(1).max(GIFT_EXPRESSION_MAX_S),
    id: requestId,
  }),
  z.object({
    type: z.literal("gift"),
    name: z.string().max(GIFT_NAME_MAX),
    item: z.string().max(32),
    count: z.number().int().min(1).max(99),
    label: z.string().max(GIFT_LABEL_MAX),
  }),
  z.object({
    type: z.literal("screen"),
    kind: z.enum(["message", "dedication"]),
    name: z.string().max(SCREEN_NAME_MAX),
    text: z.string().max(SCREEN_TEXT_MAX),
    song: z.string().max(SCREEN_SONG_MAX).nullable(),
  }),
  z.object({
    type: z.literal("song_video"),
    action: SongVideoActionSchema,
    song: z.string().max(128),
    path: z
      .string()
      .max(1024)
      .nullish()
      .transform((v) => v || undefined),
    offset_ms: z
      .number()
      .min(0)
      .max(86_400_000)
      .nullish()
      .transform((v) => v ?? undefined),
    scene: z
      .string()
      .nullish()
      .transform((v) => (v?.trim() ? v.trim() : undefined)),
  }),
  z.object({ type: z.literal("notice"), text: z.string().max(200) }),
  z.object({
    type: z.literal("activity"),
    kind: z.enum(["thinking", "synthesizing", "song_prepare", "singing"]).nullable(),
    label: z.string().max(ACTIVITY_LABEL_MAX).default(""),
    detail: z.string().max(ACTIVITY_DETAIL_MAX).nullable().default(null),
    progress: z.number().min(0).max(1).nullable().default(null),
    elapsed_ms: z.number().min(0).max(86_400_000).nullable().default(null),
    duration_ms: z.number().positive().max(86_400_000).nullable().default(null),
  }),
  z.object({ type: z.literal("status_request"), id: requestId }),
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("pong") }),
]);

/** Optional keys that are left out when missing. */
const OPTIONAL_KEYS = ["id", "transition", "transition_ms", "path", "offset_ms", "scene"] as const;

/** Drops missing optional keys, like serde's `skip_serializing_if = "Option::is_none"`. */
function dropMissingId<T extends object>(msg: T): T {
  const record = msg as Record<string, unknown>;
  for (const key of OPTIONAL_KEYS) {
    if (key in record && record[key] === undefined) delete record[key];
  }
  return msg;
}

/** Parses a value as a Stage message; throws a `ZodError`. */
export function parseStageMessage(value: unknown): StageMessage {
  return dropMissingId(StageMessageSchema.parse(value));
}

/** Parses a value as a Core message; throws a `ZodError`. */
export function parseCoreMessage(value: unknown): CoreMessage {
  return dropMissingId(CoreMessageSchema.parse(value));
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
  };
}

/**
 * One playback level sample, sent by the voice node to the Stage lip-sync endpoint
 * (`ws://127.0.0.1:7883/levels`).
 */
export interface LevelFrame {
  /**
   * Playback position in milliseconds (start of the window, 0 at the start of each playback).
   * Frames without it are placed by arrival time.
   */
  t?: number;
  /** RMS of the audio being played, 0..1. */
  rms: number;
  /** RMS per analysis band, lowest first (vowel shapes); optional. */
  bands?: number[];
}

const LevelFrameSchema = z.object({
  t: z.number().optional(),
  rms: z.number(),
  bands: z.array(z.number()).max(32).optional(),
});

export function parseLevelFrame(value: unknown): LevelFrame {
  const f = LevelFrameSchema.parse(value);
  const out: LevelFrame = { rms: f.rms };
  if (f.t !== undefined) out.t = f.t;
  if (f.bands !== undefined) out.bands = f.bands;
  return out;
}
