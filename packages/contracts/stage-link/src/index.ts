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
import { WorkersKaraokeLyricsV2Schema } from "../../workers/src/karaoke.js";

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

/** Longest payer name / message a screen card takes (code units). */
export const SCREEN_NAME_MAX = 32;
export const SCREEN_TEXT_MAX = 200;

/** Longest danmaku id / sender name / text (code units). */
export const DANMAKU_ID_MAX = 64;
export const DANMAKU_NAME_MAX = 32;
export const DANMAKU_TEXT_MAX = 100;
/** Most danmaku lines on the screen at once, waiting in the queue, and the longest wait (ms). */
export const DANMAKU_ON_SCREEN_MAX = 50;
export const DANMAKU_QUEUE_MAX = 200;
export const DANMAKU_WAIT_MAX_MS = 600_000;

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

/** What a viewer's touch landed on. */
export const StageLinkTouchPartSchema = z
  .enum(["head", "face", "body", "screen"])
  .meta({ id: "StageLinkTouchPart" });
export type TouchPart = z.output<typeof StageLinkTouchPartSchema>;

/**
 * What she is doing, for the overlay's activity line: `thinking` (a turn runs, nothing said yet),
 * `synthesizing` (her line is at TTS), `tool` (a tool of hers runs), `game` (she plays one),
 * `song_prepare` (the song worker makes a song), `singing`.
 */
export const StageLinkActivityKindSchema = z
  .enum(["thinking", "synthesizing", "tool", "game", "song_prepare", "singing"])
  .meta({ id: "StageLinkActivityKind" });
export type ActivityKind = z.output<typeof StageLinkActivityKindSchema>;

/**
 * How a danmaku line ended on the stage: `shown` (it entered the screen), `no_overlay` (no overlay
 * page was open), `queue_full` (the overlay's queue was full), `too_late` (it waited longer than
 * `max_wait_ms`), `cleared` (the layer was cleared before it showed), `lost` (the overlay went away,
 * or never answered, before it showed). Every outcome but `shown` means it was not seen.
 */
export const StageLinkDanmakuOutcomeSchema = z
  .enum(["shown", "no_overlay", "queue_full", "too_late", "cleared", "lost"])
  .meta({ id: "StageLinkDanmakuOutcome" });
export type DanmakuOutcome = z.output<typeof StageLinkDanmakuOutcomeSchema>;

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
    /** OBS's current scene collection, as the node last read it. */
    obs_collection: z.string().nullable().default(null),
    /**
     * Something about OBS the owner should fix, for the panel and `stream status` (OBS is not on
     * the scene collection of `[stage.obs] collection`: the node creates nothing in it).
     */
    obs_warning: z.string().nullable().default(null),
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

/**
 * How a danmaku line (`danmaku`, by its `id`) ended on the overlay; sent once per line. A node that
 * cannot reach Core keeps these and sends them when it is connected again.
 */
export const StageLinkDanmakuDoneMessageSchema = z
  .object({
    type: z.literal("danmaku_done"),
    id: z.string().min(1).max(DANMAKU_ID_MAX),
    outcome: StageLinkDanmakuOutcomeSchema,
  })
  .meta({ id: "StageLinkDanmakuDoneMessage" });

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
    StageLinkDanmakuDoneMessageSchema,
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
 * A paid message (`economy.screen`). Unlike gifts they are not merged: the overlay queues them
 * and shows one at a time.
 */
export const StageLinkScreenMessageSchema = z
  .object({
    type: z.literal("screen"),
    name: z.string().max(SCREEN_NAME_MAX),
    text: z.string().max(SCREEN_TEXT_MAX),
  })
  .meta({ id: "StageLinkScreenMessage" });

/**
 * A paid danmaku line (`economy.danmaku`): it crosses the overlay from right to left in a lane.
 * `name` is the sender's display name, `null` when names are hidden. The limits are the owner's
 * settings, sent with every line: at most `max_on_screen` lines on the screen, `queue_max` waiting,
 * and a line that waited `max_wait_ms` is dropped. The node answers each line once with
 * `danmaku_done` (an older node ignores the message, and Core gives up on it).
 */
export const StageLinkDanmakuMessageSchema = z
  .object({
    type: z.literal("danmaku"),
    id: z.string().min(1).max(DANMAKU_ID_MAX),
    name: z.string().max(DANMAKU_NAME_MAX).nullable(),
    text: z.string().min(1).max(DANMAKU_TEXT_MAX),
    max_on_screen: z.number().int().min(1).max(DANMAKU_ON_SCREEN_MAX),
    queue_max: z.number().int().min(0).max(DANMAKU_QUEUE_MAX),
    max_wait_ms: z.number().int().min(0).max(DANMAKU_WAIT_MAX_MS),
  })
  .meta({ id: "StageLinkDanmakuMessage" });

/** Takes every danmaku line off the overlay; the ones still waiting end as `cleared`. */
export const StageLinkDanmakuClearMessageSchema = z
  .object({ type: z.literal("danmaku_clear") })
  .meta({ id: "StageLinkDanmakuClearMessage" });

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
/**
 * What happens beside the main line: a song being prepared while she does something else. Its own
 * label and song title, one overall `progress` (`null`: waiting, no bar).
 */
export const StageLinkActivitySideSchema = z
  .object({
    label: z.string().max(ACTIVITY_LABEL_MAX),
    detail: z.string().max(ACTIVITY_DETAIL_MAX).nullable().default(null),
    progress: z.number().min(0).max(1).nullable().default(null),
  })
  .meta({ id: "StageLinkActivitySide" });
export type ActivitySide = z.output<typeof StageLinkActivitySideSchema>;

export const StageLinkActivitySchema = z
  .object({
    kind: StageLinkActivityKindSchema.nullable(),
    label: z.string().max(ACTIVITY_LABEL_MAX).default(""),
    detail: z.string().max(ACTIVITY_DETAIL_MAX).nullable().default(null),
    progress: z.number().min(0).max(1).nullable().default(null),
    elapsed_ms: z.number().min(0).max(DAY_MS).nullable().default(null),
    duration_ms: z.number().positive().max(DAY_MS).nullable().default(null),
    /** Left out (or `null`) when nothing happens beside the main line; an older node never reads it. */
    secondary: StageLinkActivitySideSchema.nullable().optional(),
  })
  .meta({ id: "StageLinkActivity" });
export type Activity = z.output<typeof StageLinkActivitySchema>;

/** What she is doing now, for the overlay's activity line. */
export const StageLinkActivityMessageSchema = StageLinkActivitySchema.extend({
  type: z.literal("activity"),
}).meta({ id: "StageLinkActivityMessage" });

// ---- karaoke rooms on the stream (docs/design/karaoke.md 「做了什麼第五步」) ---------------------

/** Longest room code, member name, song title / artist and note the karaoke messages carry. */
export const KARAOKE_CODE_MAX = 12;
export const KARAOKE_NAME_MAX = 60;
export const KARAOKE_TITLE_MAX = 200;
export const KARAOKE_NOTE_MAX = 200;
/** Most of a singer's recent pitch one board line carries (base64 of 50 Hz frames). */
export const KARAOKE_PITCH_MAX_CHARS = 2_000;
/** Most reference notes a round's words carry for the scene's pitch lanes. */
export const KARAOKE_NOTES_MAX = 8_000;
/** Most people a karaoke room lists, and singers on its board. */
export const KARAOKE_MEMBERS_MAX = 64;
export const KARAOKE_BOARD_MAX = 16;
/** Most queue entries the stream shows (the next few). */
export const KARAOKE_QUEUE_MAX = 5;
/** Longest join link the stream's QR code carries. */
export const KARAOKE_JOIN_URL_MAX = 200;
/** Most recent cheers one scene carries. */
export const KARAOKE_CHEERS_MAX = 12;

/**
 * A cheer someone watching sent a singer (`kind`: 「加油」「好聽」「太強了」「安可」), for the scene to
 * show beside that singer's lane: `to` names the singer as the board does (name and colour), `by`
 * who sent it. `id` is unique within the room: a scene sent again carries the same cheers, and
 * each is shown once. Names are untrusted (shown as text).
 */
export const StageLinkKaraokeCheerSchema = z
  .object({
    id: z.string().max(32),
    kind: z.enum(["cheer", "nice", "wow", "encore"]),
    to: z.object({ name: z.string().max(KARAOKE_NAME_MAX), color: z.number().int().min(0).max(7) }),
    by: z.object({ name: z.string().max(KARAOKE_NAME_MAX), color: z.number().int().min(0).max(7) }),
  })
  .meta({ id: "StageLinkKaraokeCheer" });
export type KaraokeStageCheer = z.output<typeof StageLinkKaraokeCheerSchema>;

/** One person in the room on the stream. Names are untrusted (shown as text). */
export const StageLinkKaraokeMemberSchema = z
  .object({
    name: z.string().max(KARAOKE_NAME_MAX),
    /** 0..7: their colour (the panel's category colours; 5–7 repeat 0–2 dashed). */
    color: z.number().int().min(0).max(7),
    role: z.enum(["singer", "spectator"]),
    ready: z.boolean(),
    opener: z.boolean(),
  })
  .meta({ id: "StageLinkKaraokeMember" });
export type KaraokeStageMember = z.output<typeof StageLinkKaraokeMemberSchema>;

/**
 * One singer on the stream's board: the live ranking while a round is sung (`total` the running
 * score, `move` since the last board), the final one after it (`winner`, `coins`, `finished`).
 * `source`: `voice` the official score, `estimate` the browser's (預估); `null` no score yet.
 */
export const StageLinkKaraokeLineSchema = z
  .object({
    name: z.string().max(KARAOKE_NAME_MAX),
    color: z.number().int().min(0).max(7),
    rank: z.number().int().min(1).nullable(),
    total: z.number().min(0).max(110).nullable(),
    source: z.enum(["voice", "estimate"]).nullable(),
    move: z.enum(["up", "down", "same"]),
    winner: z.boolean(),
    coins: z.number().int().min(0),
    finished: z.boolean(),
    /** Their voice is the one the stream plays now (`karaoke_voice`). */
    on_air: z.boolean(),
    /** With the results: the four parts of their official score (`null` without a result). */
    parts: z
      .object({
        pitch: z.number().nullable(),
        stability: z.number().nullable(),
        rhythm: z.number().nullable(),
        expression: z.number().nullable(),
      })
      .nullable()
      .default(null),
    /**
     * Their pitch lately, for the scene's pitch lanes (§7.1): frames from `from` at 50 Hz in song
     * time with their device's latency taken off (where it lands on the reference), one byte a
     * frame (`encodeTrack`), base64; `null` without any (and after the round). It is their
     * browser's own detection, so it is there whether or not the song worker keeps up.
     */
    pitch: z
      .object({ from: z.number().int().min(0), track: z.string().max(KARAOKE_PITCH_MAX_CHARS) })
      .nullable()
      .default(null),
    /** Cheers they got this round from the people watching. Left out by an older Core: none. */
    cheers: z.number().int().min(0).default(0),
  })
  .meta({ id: "StageLinkKaraokeLine" });
export type KaraokeStageLine = z.output<typeof StageLinkKaraokeLineSchema>;

/** The song of the room on the stream. Title and artist are untrusted (the song's source). */
export const StageLinkKaraokeSongSchema = z
  .object({
    id: z.string().max(SONG_MAX),
    title: z.string().max(KARAOKE_TITLE_MAX),
    artist: z.string().max(KARAOKE_TITLE_MAX).nullable(),
    duration_ms: z.number().positive().max(DAY_MS).nullable(),
  })
  .meta({ id: "StageLinkKaraokeSong" });
export type KaraokeStageSong = z.output<typeof StageLinkKaraokeSongSchema>;

/**
 * One song waiting in the room's queue, on the stream: the next few, in order. `by` is the name of
 * who added it (untrusted, shown as text); `state` its preparation (`failed` ones are skipped).
 */
export const StageLinkKaraokeQueueEntrySchema = z
  .object({
    title: z.string().max(KARAOKE_TITLE_MAX),
    artist: z.string().max(KARAOKE_TITLE_MAX).nullable(),
    by: z.string().max(KARAOKE_NAME_MAX),
    state: z.enum(["ready", "preparing", "failed"]),
  })
  .meta({ id: "StageLinkKaraokeQueueEntry" });
export type KaraokeStageQueueEntry = z.output<typeof StageLinkKaraokeQueueEntrySchema>;

/**
 * What the stream's scene plays during the round (her own voice channel carries none of it: she is
 * not the one singing). `backing`: the scene plays the round's backing (`karaoke_lyrics.backing`).
 * `relay`: the name of the singer whose voice the scene plays now (`karaoke_voice`; one at a time:
 * the round's one singer who asked for it, or the room's leader), `null` for nobody. `delay_ms`:
 * how far the stream runs behind the singers (the room's fixed delay; `position_ms` already has
 * it). The gains (0..1) are the owner's: the backing, the voice, and both while she speaks
 * (`speaking`), so her hosting lines in the voice channel stay clear.
 */
export const StageLinkKaraokeAirSchema = z
  .object({
    backing: z.boolean(),
    relay: z.string().max(KARAOKE_NAME_MAX).nullable(),
    delay_ms: z.number().int().min(0).max(60_000),
    backing_gain: z.number().min(0).max(1),
    voice_gain: z.number().min(0).max(4),
    duck_gain: z.number().min(0).max(1),
  })
  .meta({ id: "StageLinkKaraokeAir" });
export type KaraokeStageAir = z.output<typeof StageLinkKaraokeAirSchema>;

/**
 * The karaoke room the stream shows (one at a time: a round being sung first, then the latest
 * results, then a lobby). `room: null` ends the scene (no room, rooms off); the other fields are
 * then empty. `position_ms`: during the countdown and the round, where the song is *on the stream*
 * at the moment the message was sent (negative while it counts down): the singers' start plus the
 * stream's delay (`stream_delay_ms`), so the voice channel's backing and the overlay agree;
 * `null` otherwise. Sent on every change, once a second while a round is sung (the board), and
 * a few times a second when the singers' pitch moves on.
 */
export const StageLinkKaraokeSceneSchema = z
  .object({
    room: z.string().max(KARAOKE_CODE_MAX).nullable(),
    state: z.enum(["lobby", "countdown", "singing", "results"]).nullable(),
    /** The round now, 1-based (0 before the first), and how many the room may still start. */
    round: z.number().int().min(0),
    rounds_left: z.number().int().min(0),
    /** The round's song while one is on; in the lobby and after a round, the next one to sing. */
    song: StageLinkKaraokeSongSchema.nullable(),
    /** Semitones the backing is moved by (one key for everyone). */
    shift: z.number().int().min(-12).max(12),
    /**
     * The songs waiting after `song` (the next few; `song` itself is not repeated here). Left out
     * by a Core from before the queue: none.
     */
    queue: z.array(StageLinkKaraokeQueueEntrySchema).max(KARAOKE_QUEUE_MAX).default([]),
    /**
     * The room's join link (`<member site>/karaoke/room/<code>`) for the scene's QR code, sent only
     * when the member site's address is set and `stream_qr` is on; `null`: no QR, the code stays.
     * Anyone who sees the stream may open it; the room's own rules decide who gets in.
     */
    join_url: z.string().max(KARAOKE_JOIN_URL_MAX).nullable().default(null),
    /** The QR code stays (small) while a round is sung too (`stream_qr_while_singing`). */
    qr_while_singing: z.boolean().default(false),
    members: z.array(StageLinkKaraokeMemberSchema).max(KARAOKE_MEMBERS_MAX),
    position_ms: z.number().min(-DAY_MS).max(DAY_MS).nullable(),
    /** The live board while sung, the final ranking with the results; empty otherwise. */
    board: z.array(StageLinkKaraokeLineSchema).max(KARAOKE_BOARD_MAX),
    /** Why the round paid no prize, with the results (`null`: nothing to say). */
    note: z.string().max(KARAOKE_NOTE_MAX).nullable(),
    currency: z.string().max(16),
    air: StageLinkKaraokeAirSchema,
    /**
     * The song is over and the round is being settled (結算中): the names of the singers whose
     * result is still waited for (maybe none: it is about to settle). `null` otherwise.
     */
    settling: z
      .object({ waiting: z.array(z.string().max(KARAOKE_NAME_MAX)).max(KARAOKE_BOARD_MAX) })
      .nullable()
      .default(null),
    /** The latest cheers of the round (the last few seconds' worth), oldest first. */
    cheers: z.array(StageLinkKaraokeCheerSchema).max(KARAOKE_CHEERS_MAX).default([]),
  })
  .meta({ id: "StageLinkKaraokeScene" });
export type KaraokeStageScene = z.output<typeof StageLinkKaraokeSceneSchema>;

export const StageLinkKaraokeMessageSchema = StageLinkKaraokeSceneSchema.extend({
  type: z.literal("karaoke"),
}).meta({ id: "StageLinkKaraokeMessage" });

/**
 * The round's backing as the scene plays it: `path` an absolute file on the streaming PC (Core's
 * karaoke cache), `format` `pcm` (s16le mono at `rate`, decoded by the song worker) or `m4a` (AAC,
 * when the worker had no PCM: the page decodes it).
 */
export const StageLinkKaraokeBackingSchema = z
  .object({
    path: z.string().max(PATH_MAX),
    format: z.enum(["pcm", "m4a"]),
    rate: z.number().int().min(8_000).max(192_000),
  })
  .meta({ id: "StageLinkKaraokeBacking" });
export type KaraokeStageBacking = z.output<typeof StageLinkKaraokeBackingSchema>;

/**
 * The words, picture and backing of a round, once when it starts (and again for a node that
 * connects mid-round): the lyrics as the song's reference has them (untrusted text), `video` the
 * absolute path of the round's background video on the streaming PC (Core's karaoke cache; no
 * sound), `backing` the round's backing in its key; `null` without one. `round` and `song` say
 * which round of `room` they belong to.
 */
export const StageLinkKaraokeLyricsSchema = z
  .object({
    room: z.string().max(KARAOKE_CODE_MAX),
    round: z.number().int().min(1),
    song: z.string().max(SONG_MAX),
    lyrics: WorkersKaraokeLyricsV2Schema.nullable(),
    video: z.string().max(PATH_MAX).nullable(),
    backing: StageLinkKaraokeBackingSchema.nullable(),
    /**
     * The reference notes of the round, in its key (song time in seconds, MIDI), for the scene's
     * pitch lanes. Left out by an older Core: none.
     */
    notes: z
      .array(z.object({ start: z.number().min(0), end: z.number().min(0), midi: z.number() }))
      .max(KARAOKE_NOTES_MAX)
      .default([]),
  })
  .meta({ id: "StageLinkKaraokeLyrics" });
export type KaraokeStageLyrics = z.output<typeof StageLinkKaraokeLyricsSchema>;

export const StageLinkKaraokeLyricsMessageSchema = StageLinkKaraokeLyricsSchema.extend({
  type: z.literal("karaoke_lyrics"),
}).meta({ id: "StageLinkKaraokeLyricsMessage" });

/** Sample rate of `karaoke_voice` audio (the singers' µ-law stream). */
export const KARAOKE_VOICE_RATE = 16_000;
/** Most audio one `karaoke_voice` carries: two seconds of µ-law, base64. */
export const KARAOKE_VOICE_MAX_CHARS = 44_000;

/**
 * A piece of the relayed singer's voice for the scene to play: µ-law at `KARAOKE_VOICE_RATE`,
 * base64, its first sample at song time `at_ms` (already placed on the backing's time by the
 * singer's device latency). Core has already chosen whose voice it is, crossfaded a change of
 * singer and buffered every singer to the room's fixed delay, so pieces follow each other without
 * gaps (silence where nothing arrived in time). Sent about four times a second while a voice is on
 * the stream; never kept anywhere.
 */
export const StageLinkKaraokeVoiceSchema = z
  .object({
    room: z.string().max(KARAOKE_CODE_MAX),
    round: z.number().int().min(1),
    at_ms: z.number().min(-DAY_MS).max(DAY_MS),
    audio: z.string().max(KARAOKE_VOICE_MAX_CHARS),
  })
  .meta({ id: "StageLinkKaraokeVoice" });
export type KaraokeStageVoice = z.output<typeof StageLinkKaraokeVoiceSchema>;

export const StageLinkKaraokeVoiceMessageSchema = StageLinkKaraokeVoiceSchema.extend({
  type: z.literal("karaoke_voice"),
}).meta({ id: "StageLinkKaraokeVoiceMessage" });

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
    StageLinkDanmakuMessageSchema,
    StageLinkDanmakuClearMessageSchema,
    StageLinkTouchMessageSchema,
    StageLinkSongVideoMessageSchema,
    StageLinkBeatMessageSchema,
    StageLinkClipMessageSchema,
    StageLinkNoticeMessageSchema,
    StageLinkActivityMessageSchema,
    StageLinkKaraokeMessageSchema,
    StageLinkKaraokeLyricsMessageSchema,
    StageLinkKaraokeVoiceMessageSchema,
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
