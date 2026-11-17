// @miyoria/contracts/stage-link: the link between Core and the stage (the process that draws her),
// and the lip-sync level frames the voice node sends it (`docs/protocols/stage-link.md`).
//
// Two directions: `StageMessage` (text frames the stage node sends) and `CoreMessage` (text frames
// Core sends), each a union on `type`. These schemas describe the wire, so they accept what a peer
// may send: a `null` where a field is optional, no value where a field was added after v1. What the
// receiver makes of those (trim, `null` to missing) is its code, after `parse`.
//
// Within version 1 changes are additive only (docs/design/v5-contracts.md §2.7). A receiver checks
// `type` against the union's tags before `parse` and ignores a type it does not know.

import { z } from "zod";

/** Protocol version a `hello` carries. */
export const STAGE_LINK_VERSION = 1;

/** Close codes used by Core. */
export const STAGE_LINK_CLOSE = {
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

/** Longest scene transition OBS accepts (`SetCurrentSceneTransitionDuration`), in ms. */
export const TRANSITION_MAX_MS = 20_000;

/** Expressions the economy can show for a gift (`stage.expression`); the avatar config maps them to files. */
export const GIFT_EXPRESSIONS = ["heart", "blush", "squint", "big_bowl"] as const;

/** Longest time a gift expression stays on, in seconds. */
export const GIFT_EXPRESSION_MAX_S = 15;

/** Longest giver name / gift item / gift label the overlay line takes (code units). */
export const GIFT_NAME_MAX = 32;
export const GIFT_ITEM_MAX = 32;
export const GIFT_LABEL_MAX = 24;
/** Most gifts of one kind a message counts. */
export const GIFT_COUNT_MAX = 99;

/** Longest payer name / message / song title a screen card takes (code units). */
export const SCREEN_NAME_MAX = 32;
export const SCREEN_TEXT_MAX = 200;
export const SCREEN_SONG_MAX = 128;

/** Longest highlight reason (code units). */
export const CLIP_REASON_MAX = 120;
/** Longest file path a message carries (code units). */
export const PATH_MAX = 1024;
/** Longest song title of a `song_video` / `beat` message (code units). */
export const SONG_MAX = 128;
/** Longest `notice` text (code units). */
export const NOTICE_MAX = 200;

/** Most beats a `beat` message carries (as `MAX_BEATS` in `@miyoria/types`). */
export const BEATS_MAX = 2_000;
/** Largest tempo of a `beat` message. */
export const BPM_MAX = 400;
/** A song position or length: a day, in ms. */
export const DAY_MS = 86_400_000;

/** Longest activity `label` / `detail` (code units). */
export const ACTIVITY_LABEL_MAX = 40;
export const ACTIVITY_DETAIL_MAX = 120;

/** Most bands a level frame carries. */
export const LEVEL_BANDS_MAX = 32;

/** `stream` actions. */
export const StageLinkStreamActionSchema = z
  .enum(["start", "stop"])
  .meta({ id: "StageLinkStreamAction" });
export type StreamAction = z.output<typeof StageLinkStreamActionSchema>;

/** Where she looks. Default `camera`. */
export const StageLinkGazeTargetSchema = z
  .enum(["chat", "game", "camera"])
  .meta({ id: "StageLinkGazeTarget" });
export type GazeTarget = z.output<typeof StageLinkGazeTargetSchema>;

export const StageLinkGiftExpressionSchema = z
  .enum(GIFT_EXPRESSIONS)
  .meta({ id: "StageLinkGiftExpression" });
export type GiftExpression = z.output<typeof StageLinkGiftExpressionSchema>;

/** `song_video` actions. */
export const StageLinkSongVideoActionSchema = z
  .enum(["play", "stop"])
  .meta({ id: "StageLinkSongVideoAction" });
export type SongVideoAction = z.output<typeof StageLinkSongVideoActionSchema>;

/** `speaking` states. */
export const StageLinkSpeakingStateSchema = z
  .enum(["started", "stopped"])
  .meta({ id: "StageLinkSpeakingState" });
export type SpeakingState = z.output<typeof StageLinkSpeakingStateSchema>;

/** A paid message or a song dedication. */
export const StageLinkScreenKindSchema = z
  .enum(["message", "dedication"])
  .meta({ id: "StageLinkScreenKind" });
export type ScreenKind = z.output<typeof StageLinkScreenKindSchema>;

/** What a viewer's touch landed on. */
export const StageLinkTouchPartSchema = z
  .enum(["head", "face", "body", "screen"])
  .meta({ id: "StageLinkTouchPart" });
export type TouchPart = z.output<typeof StageLinkTouchPartSchema>;

/**
 * What she is doing, for the overlay's activity line: `thinking` (a turn runs, nothing said yet),
 * `synthesizing` (her line is at TTS), `song_prepare` (the song worker makes a song), `singing`.
 */
export const StageLinkActivityKindSchema = z
  .enum(["thinking", "synthesizing", "song_prepare", "singing"])
  .meta({ id: "StageLinkActivityKind" });
export type ActivityKind = z.output<typeof StageLinkActivityKindSchema>;

/** A request id: a message with one is answered with the same. */
const requestId = z.number().int().nonnegative().max(0xffff_ffff).nullish();

// ---------------------------------------------------------------------------------------------
// Stage node to Core
// ---------------------------------------------------------------------------------------------

/** What the Stage node reports in `status`. */
export const StageLinkStageStatusSchema = z
  .object({
    /** Connected and authenticated to VTube Studio. */
    vts: z.boolean().default(false),
    /** Connected to OBS. */
    obs: z.boolean().default(false),
    /** Current OBS program scene. */
    scene: z.string().nullable().default(null),
    /** OBS is streaming. */
    streaming: z.boolean().default(false),
    // Added after v1 shipped; older nodes leave them out.
    /** OBS scene names, top of OBS's scene list first. */
    scenes: z.array(z.string()).default([]),
    /** Hotkey names of the model loaded in VTube Studio. */
    hotkeys: z.array(z.string()).default([]),
    /** URL of the node's overlay page (an OBS browser source), if it serves one. */
    overlay_url: z.string().nullable().default(null),
  })
  .meta({ id: "StageLinkStageStatus" });
export type StageStatus = z.output<typeof StageLinkStageStatusSchema>;

export const StageLinkHelloMessageSchema = z
  .object({
    type: z.literal("hello"),
    version: z.number().int().nonnegative(),
    token: z.string(),
    node: z.string().default(""),
    capabilities: z.array(z.string()).default([]),
  })
  .meta({ id: "StageLinkHelloMessage" });

/** Answers a `status_request` (with its `id`), and is sent when the status changes. */
export const StageLinkStatusMessageSchema = StageLinkStageStatusSchema.extend({
  type: z.literal("status"),
  id: requestId,
}).meta({ id: "StageLinkStatusMessage" });

export const StageLinkErrorMessageSchema = z
  .object({ type: z.literal("error"), message: z.string(), id: requestId })
  .meta({ id: "StageLinkErrorMessage" });

/** A highlight was saved (answers `clip`): why, and the file OBS wrote on the streaming PC. */
export const StageLinkClipSavedMessageSchema = z
  .object({
    type: z.literal("clip_saved"),
    reason: z.string().max(CLIP_REASON_MAX),
    path: z.string().max(PATH_MAX),
  })
  .meta({ id: "StageLinkClipSavedMessage" });

export const StageLinkPingMessageSchema = z
  .object({ type: z.literal("ping") })
  .meta({ id: "StageLinkPingMessage" });

export const StageLinkPongMessageSchema = z
  .object({ type: z.literal("pong") })
  .meta({ id: "StageLinkPongMessage" });

/** Text frames sent by the Stage node. `id` answers a Core request. */
export const StageLinkStageMessageSchema = z
  .discriminatedUnion("type", [
    StageLinkHelloMessageSchema,
    StageLinkStatusMessageSchema,
    StageLinkErrorMessageSchema,
    StageLinkClipSavedMessageSchema,
    StageLinkPingMessageSchema,
    StageLinkPongMessageSchema,
  ])
  .meta({ id: "StageLinkStageMessage" });
/** As parsed: defaults applied, a `null` optional field still `null`. */
export type StageMessageWire = z.output<typeof StageLinkStageMessageSchema>;
/** As a stage node may build it. */
export type StageMessageIn = z.input<typeof StageLinkStageMessageSchema>;

// ---------------------------------------------------------------------------------------------
// Core to the Stage node
// ---------------------------------------------------------------------------------------------

export const StageLinkWelcomeMessageSchema = z
  .object({ type: z.literal("welcome"), session: z.string() })
  .meta({ id: "StageLinkWelcomeMessage" });

/**
 * `resting`: not a moment of a line but how she looks while nothing else is shown, until the
 * next `resting` one (`neutral`: nothing stands out). An older node shows it for a moment.
 */
export const StageLinkEmotionMessageSchema = z
  .object({
    type: z.literal("emotion"),
    name: z.string(),
    intensity: z.number(),
    // Added after v1 shipped; older Cores leave it out (older nodes ignore it).
    resting: z.boolean().nullish(),
  })
  .meta({ id: "StageLinkEmotionMessage" });

export const StageLinkSubtitleMessageSchema = z
  .object({ type: z.literal("subtitle"), turn: z.string(), text: z.string(), final: z.boolean() })
  .meta({ id: "StageLinkSubtitleMessage" });

export const StageLinkSpeakingMessageSchema = z
  .object({ type: z.literal("speaking"), state: StageLinkSpeakingStateSchema })
  .meta({ id: "StageLinkSpeakingMessage" });

/**
 * `transition` (an OBS transition name) and `transition_ms` (its duration) are set as OBS's
 * current transition before the switch; left out, OBS uses whatever is current. A blank
 * `transition` counts as left out.
 */
export const StageLinkSceneMessageSchema = z
  .object({
    type: z.literal("scene"),
    name: z.string(),
    // Added after v1 shipped; older Cores leave them out (older nodes ignore them).
    transition: z.string().nullish(),
    transition_ms: z.number().int().min(0).max(TRANSITION_MAX_MS).nullish(),
    id: requestId,
  })
  .meta({ id: "StageLinkSceneMessage" });

export const StageLinkStreamMessageSchema = z
  .object({ type: z.literal("stream"), action: StageLinkStreamActionSchema, id: requestId })
  .meta({ id: "StageLinkStreamMessage" });

export const StageLinkAvatarHotkeyMessageSchema = z
  .object({ type: z.literal("avatar_hotkey"), name: z.string(), id: requestId })
  .meta({ id: "StageLinkAvatarHotkeyMessage" });

export const StageLinkGazeMessageSchema = z
  .object({ type: z.literal("gaze"), target: StageLinkGazeTargetSchema })
  .meta({ id: "StageLinkGazeMessage" });

/**
 * Shows a gift expression for `seconds` (the node maps `expression` to a VTS expression file),
 * then takes it off and restores her own. Answered (with `id`) once it is on.
 */
export const StageLinkAvatarExpressionMessageSchema = z
  .object({
    type: z.literal("avatar_expression"),
    expression: StageLinkGiftExpressionSchema,
    seconds: z.number().min(1).max(GIFT_EXPRESSION_MAX_S),
    id: requestId,
  })
  .meta({ id: "StageLinkAvatarExpressionMessage" });

/** Someone fed her something (`economy.gift`); the overlay merges gifts into one line. */
export const StageLinkGiftMessageSchema = z
  .object({
    type: z.literal("gift"),
    name: z.string().max(GIFT_NAME_MAX),
    item: z.string().max(GIFT_ITEM_MAX),
    count: z.number().int().min(1).max(GIFT_COUNT_MAX),
    label: z.string().max(GIFT_LABEL_MAX),
  })
  .meta({ id: "StageLinkGiftMessage" });

/**
 * A paid message or a song dedication (`economy.screen`). Unlike gifts they are not merged: the
 * overlay queues them and shows one at a time. `song` is the title for a dedication, else null.
 */
export const StageLinkScreenMessageSchema = z
  .object({
    type: z.literal("screen"),
    kind: StageLinkScreenKindSchema,
    name: z.string().max(SCREEN_NAME_MAX),
    text: z.string().max(SCREEN_TEXT_MAX),
    song: z.string().max(SCREEN_SONG_MAX).nullable(),
  })
  .meta({ id: "StageLinkScreenMessage" });

/**
 * A viewer touched the stream on the website (`live.touch`): `x`, `y` 0..1 on the picture
 * (origin top-left), `part` what it landed on. The overlay draws it; she reacts to head, face
 * and body.
 */
export const StageLinkTouchMessageSchema = z
  .object({
    type: z.literal("touch"),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    part: StageLinkTouchPartSchema,
  })
  .meta({ id: "StageLinkTouchMessage" });

/**
 * The song she sings has a video: `play` shows `path` (a file in the song worker's cache on
 * the streaming PC) in the media source, muted, `offset_ms` into the song at the moment the
 * message was sent, in `scene` when the scene director switches to a `sing` scene (else the
 * current one); `stop` stops and clears it. An empty `path` and a blank `scene` count as left out.
 */
export const StageLinkSongVideoMessageSchema = z
  .object({
    type: z.literal("song_video"),
    action: StageLinkSongVideoActionSchema,
    song: z.string().max(SONG_MAX),
    path: z.string().max(PATH_MAX).nullish(),
    offset_ms: z.number().min(0).max(DAY_MS).nullish(),
    scene: z.string().nullish(),
  })
  .meta({ id: "StageLinkSongVideoMessage" });

/**
 * The beat of the song she sings, so she sways and nods with it: `times_ms` (sorted, from the
 * start of the song) with the song `offset_ms` into it at the moment the message was sent.
 * Empty `times_ms` stops it. An older node ignores it.
 */
export const StageLinkBeatMessageSchema = z
  .object({
    type: z.literal("beat"),
    song: z.string().max(SONG_MAX),
    bpm: z.number().min(0).max(BPM_MAX),
    times_ms: z.array(z.number().min(0).max(DAY_MS)).max(BEATS_MAX),
    offset_ms: z.number().min(0).max(DAY_MS),
  })
  .meta({ id: "StageLinkBeatMessage" });

/**
 * Save a highlight: OBS's replay buffer (the last seconds of the stream) as a file, with a
 * note of `reason` next to it. Answered (with `id`) when done; `clip_saved` names the file.
 */
export const StageLinkClipMessageSchema = z
  .object({ type: z.literal("clip"), reason: z.string().max(CLIP_REASON_MAX), id: requestId })
  .meta({ id: "StageLinkClipMessage" });

/** A line of status for the overlay (`""` clears it), e.g. 「準備歌曲中…」. */
export const StageLinkNoticeMessageSchema = z
  .object({ type: z.literal("notice"), text: z.string().max(NOTICE_MAX) })
  .meta({ id: "StageLinkNoticeMessage" });

/**
 * What she is doing now. `kind: null` hides the line (the other fields are then empty / null).
 * `label` is the short zh-TW text, `detail` the song it is about (already escaped and capped),
 * `progress` 0..1 or `null` (indeterminate). A song being sung has `elapsed_ms` (how far into it
 * it was when the message was sent) and `duration_ms`, so its progress runs on the receiver's
 * clock instead.
 */
export const StageLinkActivitySchema = z
  .object({
    kind: StageLinkActivityKindSchema.nullable(),
    label: z.string().max(ACTIVITY_LABEL_MAX).default(""),
    detail: z.string().max(ACTIVITY_DETAIL_MAX).nullable().default(null),
    progress: z.number().min(0).max(1).nullable().default(null),
    elapsed_ms: z.number().min(0).max(DAY_MS).nullable().default(null),
    duration_ms: z.number().positive().max(DAY_MS).nullable().default(null),
  })
  .meta({ id: "StageLinkActivity" });
export type Activity = z.output<typeof StageLinkActivitySchema>;

/** What she is doing now, for the overlay's activity line. */
export const StageLinkActivityMessageSchema = StageLinkActivitySchema.extend({
  type: z.literal("activity"),
}).meta({ id: "StageLinkActivityMessage" });

/** Asks for a `status` (with the same `id`). */
export const StageLinkStatusRequestMessageSchema = z
  .object({ type: z.literal("status_request"), id: requestId })
  .meta({ id: "StageLinkStatusRequestMessage" });

/** Text frames sent by Core. */
export const StageLinkCoreMessageSchema = z
  .discriminatedUnion("type", [
    StageLinkWelcomeMessageSchema,
    StageLinkEmotionMessageSchema,
    StageLinkSubtitleMessageSchema,
    StageLinkSpeakingMessageSchema,
    StageLinkSceneMessageSchema,
    StageLinkStreamMessageSchema,
    StageLinkAvatarHotkeyMessageSchema,
    StageLinkGazeMessageSchema,
    StageLinkAvatarExpressionMessageSchema,
    StageLinkGiftMessageSchema,
    StageLinkScreenMessageSchema,
    StageLinkTouchMessageSchema,
    StageLinkSongVideoMessageSchema,
    StageLinkBeatMessageSchema,
    StageLinkClipMessageSchema,
    StageLinkNoticeMessageSchema,
    StageLinkActivityMessageSchema,
    StageLinkStatusRequestMessageSchema,
    StageLinkPingMessageSchema,
    StageLinkPongMessageSchema,
  ])
  .meta({ id: "StageLinkCoreMessage" });
/** As parsed: defaults applied, a `null` optional field still `null`. */
export type CoreMessageWire = z.output<typeof StageLinkCoreMessageSchema>;
/** As Core may build it. */
export type CoreMessageIn = z.input<typeof StageLinkCoreMessageSchema>;

// ---------------------------------------------------------------------------------------------
// Lip-sync levels
// ---------------------------------------------------------------------------------------------

/**
 * One playback level sample, sent by the voice node to the Stage lip-sync endpoint
 * (`ws://127.0.0.1:7883/levels`) as a JSON text frame. No `type`.
 */
export const StageLinkLevelFrameSchema = z
  .object({
    /**
     * Playback position in milliseconds (start of the window, 0 at the start of each playback).
     * Frames without it are placed by arrival time.
     */
    t: z.number().optional(),
    /** RMS of the audio being played, 0..1. */
    rms: z.number(),
    /** RMS per analysis band, lowest first (vowel shapes); optional. */
    bands: z.array(z.number()).max(LEVEL_BANDS_MAX).optional(),
  })
  .meta({ id: "StageLinkLevelFrame" });
export type LevelFrame = z.output<typeof StageLinkLevelFrameSchema>;
