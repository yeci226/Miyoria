// Live operation: extensions, MCP servers, the request queue, the stage (VTube Studio and OBS) and
// the voice monitor. Scene, stream and say go through the actuator gate as the panel.

import { z } from "zod";
import {
  AccountRefSchema,
  ContextKeySchema,
  TimestampSchema,
  VoiceParticipantSchema,
} from "../../wire/src/index.js";
import { ModuleStateKindSchema } from "./core.js";
import { route } from "./route.js";
import { SpaceQuery } from "./shared.js";

// ---- extensions -------------------------------------------------------------------------

/** One extension. */
export const ExtensionInfoSchema = z
  .object({
    id: z.string(),
    /** Supervisor module running it (`ext.<id>`). */
    module: z.string(),
    name: z.string(),
    version: z.string(),
    description: z.string(),
    /** Extension directory. */
    source: z.string(),
    enabled: z.boolean(),
    state: ModuleStateKindSchema,
    /** Why it is not running, when it is not. */
    reason: z.string().nullable(),
    /** Granted permissions: `tools`, `commands`, `events:<topic>`, `network:<host>`, `input:<kind>`. */
    permissions: z.array(z.string()),
  })
  .meta({ id: "ApiExtensionInfo" });
export type ExtensionInfo = z.output<typeof ExtensionInfoSchema>;

// ---- MCP --------------------------------------------------------------------------------

export const McpStateSchema = z
  .enum(["connecting", "ready", "failed", "disabled"])
  .meta({ id: "ApiMcpState" });
export type McpState = z.output<typeof McpStateSchema>;

/** A tool an MCP server offers. */
export const McpToolInfoSchema = z
  .object({
    /** Registry name (`mcp_<server>_<tool>`). */
    name: z.string(),
    description: z.string(),
  })
  .meta({ id: "ApiMcpToolInfo" });
export type McpToolInfo = z.output<typeof McpToolInfoSchema>;

/** One configured MCP server. */
export const McpServerInfoSchema = z
  .object({
    name: z.string(),
    /** `stdio` or `http`. */
    transport: z.string(),
    /** Command line (`stdio`) or URL without credentials (`http`); `null` while not reported. */
    target: z.string().nullable(),
    /** `false` when it is disabled in the configuration file; only `restart` works at runtime. */
    enabled: z.boolean(),
    state: McpStateSchema,
    error: z.string().nullable(),
    tools: z.array(McpToolInfoSchema),
    /** Tools the server offers before allow and deny filtering. */
    remote_tool_count: z.number(),
    /** Permission node required to use the tools. */
    permission: z.string().nullable(),
    reconnects: z.number(),
  })
  .meta({ id: "ApiMcpServerInfo" });
export type McpServerInfo = z.output<typeof McpServerInfoSchema>;

// ---- request queue ----------------------------------------------------------------------

/** Who asked. */
export const QueueAuthorSchema = z
  .object({ account: AccountRefSchema, display_name: z.string() })
  .meta({ id: "ApiQueueAuthor" });
export type QueueAuthor = z.output<typeof QueueAuthorSchema>;

/** One queued request. */
export const QueueItemInfoSchema = z
  .object({
    /** The queue's numeric item id, as a string (`"3"`). */
    id: z.string(),
    /** Free-form, e.g. `chat`, `song`, `game_goal`. */
    kind: z.string(),
    /** Where the request was made; `null` for requests from the API or a game. */
    context: ContextKeySchema.nullable(),
    author: QueueAuthorSchema.nullable(),
    text: z.string(),
    priority: z.number(),
    enqueued_at: TimestampSchema,
    /** `active` items come first, then `pending` ones. */
    state: z.enum(["pending", "active", "done", "skipped", "removed"]),
    votes: z.number(),
  })
  .meta({ id: "ApiQueueItemInfo" });
export type QueueItemInfo = z.output<typeof QueueItemInfoSchema>;

/** The queue, and the answer of every queue change. */
export const QueueStateSchema = z
  .object({
    paused: z.boolean(),
    /** In processing order. */
    items: z.array(QueueItemInfoSchema),
  })
  .meta({ id: "ApiQueueState" });
export type QueueState = z.output<typeof QueueStateSchema>;

/** Body of `POST /api/queue/{id}/move`: a 0-based index of the queue's items. */
export const MoveQueueItemRequestSchema = z
  .object({ position: z.number().int().min(0) })
  .meta({ id: "ApiMoveQueueItemRequest" });
export type MoveQueueItemRequest = z.input<typeof MoveQueueItemRequestSchema>;

// ---- stage ------------------------------------------------------------------------------

/** One part of the stage node (VTube Studio or OBS). */
export const StageLinkStateSchema = z
  .object({ connected: z.boolean(), error: z.string().nullable() })
  .meta({ id: "ApiStageLinkState" });
export type StageLinkState = z.output<typeof StageLinkStateSchema>;

/** The stage, and the answer of the stage changes. */
export const StageStateSchema = z
  .object({
    vts: StageLinkStateSchema,
    obs: StageLinkStateSchema,
    scene: z.string().nullable(),
    /** OBS scene names, top of OBS's list first; empty while OBS is not connected. */
    scenes: z.array(z.string()),
    /** The last expression (a VTube Studio hotkey) triggered through the API. */
    expression: z.string().nullable(),
    /** VTube Studio hotkey names of the loaded model (what the expression route takes). */
    expressions: z.array(z.string()),
    /** Emotions of the profile's `avatar.toml` (what the say route takes), sorted. */
    emotions: z.array(z.string()),
    /** The stage node's overlay page (an OBS browser source); `null` without a node. */
    overlay_url: z.string().nullable(),
    /** Her speech is playing. */
    speaking: z.boolean(),
    /** Name of the connected stage node; `null` while disconnected. */
    node: z.string().nullable(),
    /** OBS is streaming. */
    streaming: z.boolean(),
    /**
     * Something about OBS the owner should fix, from the stage node (OBS is not on Miyoria's
     * scene collection); `null` when all is well or no node is connected.
     */
    obs_warning: z.string().nullable(),
  })
  .meta({ id: "ApiStageState" });
export type StageState = z.output<typeof StageStateSchema>;

export const StreamActionSchema = z.enum(["start", "stop"]).meta({ id: "ApiStreamAction" });
export type StreamAction = z.output<typeof StreamActionSchema>;

/** One scene role: which OBS scene the scene director uses for it. */
export const SceneRoleStateSchema = z
  .object({
    /** `chat`, `game`, `brb`, `starting`, `ending` or one of the owner's roles. */
    role: z.string(),
    /** Label of a built-in role, `null` for the owner's own roles. */
    label: z.string().nullable(),
    /** The OBS scene it switches to, `null`: none. */
    scene: z.string().nullable(),
    /** Where that came from: the configuration file, the panel or the automatic classification. */
    source: z.enum(["config", "panel", "auto"]).nullable(),
    /** What the classification picked. */
    auto: z.string().nullable(),
    /** Set in the configuration file; the panel cannot change it. */
    locked: z.boolean(),
  })
  .meta({ id: "ApiSceneRoleState" });
export type SceneRoleState = z.output<typeof SceneRoleStateSchema>;

/** The scene roles, and the answer of their changes. */
export const SceneRolesStateSchema = z
  .object({
    /** OBS scene names the stage node reports. */
    scenes: z.array(z.string()),
    roles: z.array(SceneRoleStateSchema),
    /** `llm`, `heuristic` (keywords) or `null` (not classified yet). */
    classified_by: z.enum(["llm", "heuristic"]).nullable(),
    classifying: z.boolean(),
  })
  .meta({ id: "ApiSceneRolesState" });
export type SceneRolesState = z.output<typeof SceneRolesStateSchema>;

/** Body of `POST /api/stage/scene`. */
export const StageSceneRequestSchema = z
  .object({ scene: z.string() })
  .meta({ id: "ApiStageSceneRequest" });
export type StageSceneRequest = z.input<typeof StageSceneRequestSchema>;

/** Body of `POST /api/stage/expression`. */
export const StageExpressionRequestSchema = z
  .object({ expression: z.string() })
  .meta({ id: "ApiStageExpressionRequest" });
export type StageExpressionRequest = z.input<typeof StageExpressionRequestSchema>;

/** Body of `POST /api/stage/stream`. */
export const StageStreamRequestSchema = z
  .object({ action: StreamActionSchema })
  .meta({ id: "ApiStageStreamRequest" });
export type StageStreamRequest = z.input<typeof StageStreamRequestSchema>;

/** Body of `PUT /api/stage/scenes`: the panel's scene for a role; `null` goes back to the classification. */
export const SetSceneRoleRequestSchema = z
  .object({ role: z.string(), scene: z.string().nullable() })
  .meta({ id: "ApiSetSceneRoleRequest" });
export type SetSceneRoleRequest = z.input<typeof SetSceneRoleRequestSchema>;

/** Body of `POST /api/stage/say`. */
export const SayRequestSchema = z
  .object({ text: z.string(), emotion: z.string().nullish() })
  .meta({ id: "ApiSayRequest" });
export type SayRequest = z.input<typeof SayRequestSchema>;

/** Answer of `POST /api/stage/say`: the turn id correlates the `voice.playback` events. */
export const SayResponseSchema = z
  .object({ turn: z.string().nullable() })
  .meta({ id: "ApiSayResponse" });
export type SayResponse = z.output<typeof SayResponseSchema>;

// ---- voice ------------------------------------------------------------------------------

/** Latency over the recent window; `null` percentiles without samples. */
export const LatencyStatsSchema = z
  .object({
    p50_ms: z.number().nullable(),
    p95_ms: z.number().nullable(),
    samples: z.number(),
  })
  .meta({ id: "ApiLatencyStats" });
export type LatencyStats = z.output<typeof LatencyStatsSchema>;

/** p50 and p90 of one end-to-end series; `null` percentiles without samples. */
export const E2eStatsSchema = z
  .object({
    p50_ms: z.number().nullable(),
    p90_ms: z.number().nullable(),
    samples: z.number(),
  })
  .meta({ id: "ApiE2eStats" });
export type E2eStats = z.output<typeof E2eStatsSchema>;

/** The segments of `speech_end` to `first_audio_played`, in the order a listener hears them. */
export const E2eSegmentNameSchema = z
  .enum(["endpoint", "asr", "prepare", "llm_first", "tts_queue", "tts_first", "playback"])
  .meta({ id: "ApiE2eSegmentName" });
export type E2eSegmentName = z.output<typeof E2eSegmentNameSchema>;

/**
 * End-to-end voice latency over the recent window: replies to human speech only. `total` and the
 * segments count complete measurements; incomplete ones (cancelled, barged in on, failed) are
 * only counted, by reason.
 */
export const VoiceE2eLatencySchema = z
  .object({
    total: E2eStatsSchema,
    segments: z.object({
      endpoint: E2eStatsSchema,
      asr: E2eStatsSchema,
      prepare: E2eStatsSchema,
      llm_first: E2eStatsSchema,
      tts_queue: E2eStatsSchema,
      tts_first: E2eStatsSchema,
      playback: E2eStatsSchema,
    }),
    complete: z.number(),
    incomplete: z.number(),
    incomplete_by_reason: z.record(z.string(), z.number()),
  })
  .meta({ id: "ApiVoiceE2eLatency" });
export type VoiceE2eLatency = z.output<typeof VoiceE2eLatencySchema>;

export const VoiceLatencySchema = z
  .object({
    asr: LatencyStatsSchema,
    llm_first_token: LatencyStatsSchema,
    tts_first_audio: LatencyStatsSchema,
    /** Speech end to first audio. */
    e2e: VoiceE2eLatencySchema,
  })
  .meta({ id: "ApiVoiceLatency" });
export type VoiceLatency = z.output<typeof VoiceLatencySchema>;

/** One voice channel she is in. */
export const VoiceSessionSchema = z
  .object({
    context: ContextKeySchema,
    /** Guild and channel names when the platform knows them. */
    label: z.string().nullable(),
    participants: z.array(VoiceParticipantSchema),
    /** Accounts currently speaking. */
    speaking: z.array(AccountRefSchema),
    joined_at: TimestampSchema,
    latency: VoiceLatencySchema,
    last_turn: z.string().nullable(),
  })
  .meta({ id: "ApiVoiceSession" });
export type VoiceSession = z.output<typeof VoiceSessionSchema>;

/** The voice channels she is in, oldest join first. */
export const VoiceStateSchema = z
  .object({ sessions: z.array(VoiceSessionSchema) })
  .meta({ id: "ApiVoiceState" });
export type VoiceState = z.output<typeof VoiceStateSchema>;

// ---- the routes -------------------------------------------------------------------------

const ExtensionParams = z.object({ id: z.string(), action: z.string() });
const McpParams = z.object({ name: z.string(), action: z.string() });
const ItemParams = z.object({ id: z.string() });

export const extensions = {
  list: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/extensions" })
    .output(z.array(ExtensionInfoSchema)),
  /**
   * `action` is a string and the server checks it (`enable`, `disable` or `restart`; another is a
   * 404), as it does for a module. `409` when the module cannot be stopped.
   */
  action: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "POST", path: "/api/extensions/{id}/{action}" })
    .input(z.object({ params: ExtensionParams }))
    .output(ExtensionInfoSchema),
};

export const mcp = {
  list: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/mcp" })
    .output(z.array(McpServerInfoSchema)),
  /**
   * Only `restart` works at runtime (it restarts the whole `mcp` module): `enable` and `disable`
   * are a `409`, any other action a `404`. Servers are turned on and off in the configuration.
   */
  action: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "POST", path: "/api/mcp/{name}/{action}" })
    .input(z.object({ params: McpParams }))
    .output(McpServerInfoSchema),
};

/**
 * Each server has its own queue (phase 6): `?space=` picks it (`SpaceQuery`; default: the primary).
 * Skipping or moving an item answers with the queue the item is in.
 */
export const queue = {
  list: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/queue" })
    .input(z.object({ query: SpaceQuery }).optional())
    .output(QueueStateSchema),
  pause: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "POST", path: "/api/queue/pause" })
    .input(z.object({ query: SpaceQuery }).optional())
    .output(QueueStateSchema),
  resume: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "POST", path: "/api/queue/resume" })
    .input(z.object({ query: SpaceQuery }).optional())
    .output(QueueStateSchema),
  /** `404` for an item that is not there (or was skipped already). */
  skip: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "POST", path: "/api/queue/{id}/skip" })
    .input(z.object({ params: ItemParams, query: SpaceQuery.optional() }))
    .output(QueueStateSchema),
  /** `404` for an item that is not there, `409` for one that is active. */
  move: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "POST", path: "/api/queue/{id}/move" })
    .input(
      z.object({
        params: ItemParams,
        query: SpaceQuery.optional(),
        body: MoveQueueItemRequestSchema,
      }),
    )
    .output(QueueStateSchema),
};

export const stage = {
  status: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/stage" })
    .output(StageStateSchema),
  /** `409` while OBS is not connected. */
  scene: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "POST", path: "/api/stage/scene" })
    .input(z.object({ body: StageSceneRequestSchema }))
    .output(StageStateSchema),
  scenes: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/stage/scenes" })
    .output(SceneRolesStateSchema),
  /** `400` for a role set in the configuration file or a scene OBS does not have. */
  setSceneRole: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "PUT", path: "/api/stage/scenes" })
    .input(z.object({ body: SetSceneRoleRequestSchema }))
    .output(SceneRolesStateSchema),
  /** Classifies the OBS scenes again. */
  classify: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "POST", path: "/api/stage/scenes/classify" })
    .output(SceneRolesStateSchema),
  /** `409` while VTube Studio is not connected. */
  expression: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "POST", path: "/api/stage/expression" })
    .input(z.object({ body: StageExpressionRequestSchema }))
    .output(StageStateSchema),
  /** `409` while OBS is not connected. */
  stream: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "POST", path: "/api/stage/stream" })
    .input(z.object({ body: StageStreamRequestSchema }))
    .output(StageStateSchema),
  /**
   * Speaks `text` through TTS in the voice channel she is in, without the LLM; answers as soon as
   * speaking started. `409` when she is not in a voice channel, `502` when the voice module fails.
   */
  say: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "POST", path: "/api/stage/say" })
    .input(z.object({ body: SayRequestSchema }))
    .output(SayResponseSchema),
};

/** The voice monitor; the controls that join and leave are in `control.ts`. */
export const voiceMonitor = {
  state: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/voice" })
    .output(VoiceStateSchema),
};
