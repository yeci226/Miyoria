// Live controls the panel runs through the actuator gate (principal `panel`), like the `/voice`,
// `/queue song` and `/game` commands do from Discord: her voice channel and Go Live, the song set
// list, and the game director. Every change is audited; the gate decides, nothing bypasses it.

import { z } from "zod";
import { TimestampSchema } from "../../wire/src/index.js";
import { route } from "./route.js";
import { ContextKeyInSchema } from "./shared.js";

/** What a control route's capability said it did. */
export const ControlResultSchema = z.object({ text: z.string() }).meta({ id: "ApiControlResult" });
export type ControlResult = z.output<typeof ControlResultSchema>;

/** One song of her set list. */
export const SongViewSchema = z
  .object({
    no: z.number(),
    /** What was asked for (a name or a link). Untrusted. */
    query: z.string(),
    title: z.string().nullable(),
    artist: z.string().nullable(),
    duration_s: z.number().nullable(),
    /** Transposition in semitones. */
    key: z.number(),
    requester_name: z.string(),
    state: z.enum(["preparing", "ready", "playing", "done", "failed", "cancelled"]),
    /** Worker stage while preparing (`download`, `separate`, `convert`, ...). */
    stage: z.string(),
    /** 0..1 while preparing. */
    progress: z.number(),
    error: z.string().nullable(),
    /** Sung as soon as she is free once ready. */
    forced: z.boolean(),
    created_at: TimestampSchema,
    ready_at: TimestampSchema.nullable(),
  })
  .meta({ id: "ApiSongView" });
export type SongView = z.output<typeof SongViewSchema>;

/** The set list. */
export const SongsStateSchema = z
  .object({
    /** Number of the song she is singing. */
    playing: z.number().nullable(),
    /** Why speech is paused (a song job has the GPU), else `null`. */
    paused: z.string().nullable(),
    songs: z.array(SongViewSchema),
  })
  .meta({ id: "ApiSongsState" });
export type SongsState = z.output<typeof SongsStateSchema>;

/** The answer of a song route: what the capability said, and the set list afterwards. */
export const SongsAnswerSchema = z
  .object({
    text: z.string(),
    playing: z.number().nullable(),
    paused: z.string().nullable(),
    songs: z.array(SongViewSchema),
  })
  .meta({ id: "ApiSongsAnswer" });
export type SongsAnswer = z.output<typeof SongsAnswerSchema>;

/** Body of `POST /api/voice/join`: no channel means the busiest one. */
export const JoinVoiceRequestSchema = z
  .object({ guild: z.string().min(1).max(64), channel: z.string().min(1).max(64).nullish() })
  .meta({ id: "ApiJoinVoiceRequest" });
export type JoinVoiceRequest = z.input<typeof JoinVoiceRequestSchema>;

/** Body of `POST /api/voice/leave`: no guild means the one she is in voice in. */
export const LeaveVoiceRequestSchema = z
  .object({ guild: z.string().min(1).max(64).nullish() })
  .meta({ id: "ApiLeaveVoiceRequest" });
export type LeaveVoiceRequest = z.input<typeof LeaveVoiceRequestSchema>;

/** Body of `POST /api/voice/golive`. */
export const GoLiveRequestSchema = z
  .object({ action: z.enum(["start", "stop"]), guild: z.string().min(1).max(64).nullish() })
  .meta({ id: "ApiGoLiveRequest" });
export type GoLiveRequest = z.input<typeof GoLiveRequestSchema>;

/** Body of `POST /api/songs`. */
export const AddSongRequestSchema = z
  .object({
    query: z.string().min(1).max(300),
    /** Transposition in semitones. */
    key: z.number().int().min(-6).max(6).nullish(),
  })
  .meta({ id: "ApiAddSongRequest" });
export type AddSongRequest = z.input<typeof AddSongRequestSchema>;

/** Body of `POST /api/songs/play`: no song means the next one. */
export const PlaySongRequestSchema = z
  .object({ song: z.number().int().positive().nullish() })
  .meta({ id: "ApiPlaySongRequest" });
export type PlaySongRequest = z.input<typeof PlaySongRequestSchema>;

/** Body of `POST /api/songs/stop`: `all` also clears the set list. */
export const StopSongRequestSchema = z
  .object({ all: z.boolean().nullish() })
  .meta({ id: "ApiStopSongRequest" });
export type StopSongRequest = z.input<typeof StopSongRequestSchema>;

/** Body of `POST /api/game/start`. */
export const GameStartRequestSchema = z
  .object({
    game: z.string().min(1).max(64).nullish(),
    goal: z.string().min(1).max(200).nullish(),
    stream: z.boolean().nullish(),
    /** Where to play; the voice channel she is in when left out. */
    context: ContextKeyInSchema.nullish(),
  })
  .meta({ id: "ApiGameStartRequest" });
export type GameStartRequest = z.input<typeof GameStartRequestSchema>;

/** Body of `POST /api/game/goal`. */
export const GameGoalRequestSchema = z
  .object({ text: z.string().min(1).max(200) })
  .meta({ id: "ApiGameGoalRequest" });
export type GameGoalRequest = z.input<typeof GameGoalRequestSchema>;

// ---- the routes -------------------------------------------------------------------------

/**
 * The controls of `voice` (its monitor is in `ops.ts`). A name or a text is trimmed by the server
 * after validation; one that is empty afterwards is a `422` like an empty one.
 */
export const voiceControl = {
  /** `409`, `400` or `503` when the gate refuses or the capability is not there; `502` when the voice module fails. */
  join: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "POST", path: "/api/voice/join" })
    .input(z.object({ body: JoinVoiceRequestSchema }))
    .output(ControlResultSchema),
  /** `400` without a guild while she is not in voice. */
  leave: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "POST", path: "/api/voice/leave" })
    .input(z.object({ body: LeaveVoiceRequestSchema }))
    .output(ControlResultSchema),
  /** `400` without a guild while she is not in voice. */
  goLive: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "POST", path: "/api/voice/golive" })
    .input(z.object({ body: GoLiveRequestSchema }))
    .output(ControlResultSchema),
};

export const songs = {
  list: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/songs" })
    .output(SongsStateSchema),
  request: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "POST", path: "/api/songs" })
    .input(z.object({ body: AddSongRequestSchema }))
    .output(SongsAnswerSchema),
  play: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "POST", path: "/api/songs/play" })
    .input(z.object({ body: PlaySongRequestSchema }))
    .output(SongsAnswerSchema),
  stop: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "POST", path: "/api/songs/stop" })
    .input(z.object({ body: StopSongRequestSchema }))
    .output(SongsAnswerSchema),
};

export const game = {
  /** `409` without a place to play: she is not in a voice channel and no `context` is given. */
  start: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "POST", path: "/api/game/start" })
    .input(z.object({ body: GameStartRequestSchema }))
    .output(ControlResultSchema),
  /** No body. */
  stop: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "POST", path: "/api/game/stop" })
    .output(ControlResultSchema),
  goal: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "POST", path: "/api/game/goal" })
    .input(z.object({ body: GameGoalRequestSchema }))
    .output(ControlResultSchema),
};
