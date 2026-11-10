// Wire types shared by the server and the client (Rust `miyoria_api::types`). Field names and
// nullability mirror the serde JSON exactly; `apps/panel/src/api/*types.ts` mirror these.

import type { PendingApproval } from "@miyoria/actions";
import type { WalletExport } from "@miyoria/economy";
import type { ModuleStatus } from "@miyoria/kernel";

import type { CostReport, ModelUsage, PeriodReport } from "@miyoria/llm";
import type { ItemState } from "@miyoria/queue";
import type { StreamAction } from "@miyoria/stage";
import type {
  AuthScope,
  MemoryKind,
  MemoryScope,
  Person,
  Relationship,
  RelationshipDelta,
} from "@miyoria/store";
import type {
  AccountRef,
  ArbiterDecision,
  ChannelActivity,
  ContextKey,
  ConversationState,
  EmergencyReport,
  FeedbackTally,
  Feeling,
  Goal,
  KnowledgeDoc,
  Lesson,
  MindStats,
  ModuleId,
  ModuleStateKind,
  PersonId,
  PlatformId,
  ProfileId,
  ReasoningLevel,
  ReflectionRun,
  ReflectionStats,
  SelfSnapshot,
  Thought,
  Timestamp,
  TurnId,
  TurnOutcome,
  VoiceParticipant,
  WorldSnapshot,
} from "@miyoria/types";

/** `GET /api/health`. */
export interface HealthInfo {
  status: string;
  version: string;
}

/** `GET /api/auth/methods`: which panel logins this Core offers. */
export interface AuthMethods {
  /** The static bearer token always works. */
  token: boolean;
  /** Discord OAuth2 (`[modules.api.discord_oauth]` is configured). */
  discord: boolean;
}

export interface SessionUser {
  /** Discord user id. */
  id: string;
  name: string;
  avatar_url: string | null;
}

export interface SessionPermissions {
  /** May use mutating routes (`admin.panel.write`; always for the token). */
  write: boolean;
}

/** `GET /api/auth/session`: who the caller is. */
export interface SessionInfo {
  /** `"token"` or `"discord"`. */
  method: string;
  /** The Discord user; `null` for the bearer token. */
  user: SessionUser | null;
  permissions: SessionPermissions;
}

/** What she is doing, as the public page says it. `offline`: the modules that know are stopped. */
export type PublicState = "singing" | "playing" | "live" | "in_voice" | "idle" | "offline";

/** Today's aggregate numbers: nothing in them points at a person. */
export interface PublicToday {
  songs_sung: number;
  hours_live: number;
  hours_in_voice: number;
}

/** One local day of `PublicToday`, `date` as `YYYY-MM-DD`. */
export interface PublicDay extends PublicToday {
  date: string;
}

/** `GET /api/public/status`. */
export interface PublicStatus {
  state: PublicState;
  live: boolean;
  in_voice: boolean;
  /** The game id while she plays one. */
  game: string | null;
  today: PublicToday;
  /** The last `PUBLIC_DAYS` local days, oldest first, today last. */
  days: PublicDay[];
}

/** A song on the public page. `title` is `null` until the worker found it, or if it was screened. */
export interface PublicSong {
  title: string | null;
  artist: string | null;
  duration_s: number | null;
}

/** `GET /api/public/songs`. */
export interface PublicSongs {
  playing: PublicSong | null;
  /** Still to come, in order. */
  upcoming: (PublicSong & { ready: boolean })[];
  /** What she sang last, newest first. */
  recent: PublicSong[];
}

/** `GET /api/member/session`. */
export interface MemberSession {
  name: string;
  avatar_url: string | null;
}

/** 她眼中的你, in words. All `null` for someone she does not know. */
export interface MemberCard {
  call_name: string | null;
  relationship: string | null;
  affinity: string | null;
  trust: string | null;
  familiarity: string | null;
  public_feeling: string | null;
}

export interface MemberMemory {
  text: string;
  kind: string;
  /** `YYYY-MM-DD`. */
  date: string;
}

export interface MemberSong {
  title: string;
  artist: string | null;
  state: string;
  requested_at: string;
}

/** `GET /api/member/me`. */
/** How much someone talked to her on one local day: their own lines, counted. */
export interface MemberDay {
  date: string;
  /** Lines written in text channels, threads and DMs. */
  text: number;
  /** Lines said in voice. */
  voice: number;
}

export interface MemberView {
  card: MemberCard;
  memories: MemberMemory[];
  songs: MemberSong[];
  /** The last `MEMBER_DAYS` local days, oldest first, today last. */
  activity: MemberDay[];
  can_request_song: boolean;
  /** What forgetting takes and leaves, in the words `/me memory forget` uses. */
  forget: { removes: string; keeps: string };
}

/** A field she added to a card herself: its name and what she wrote. */
export interface CardField {
  label: string;
  text: string;
}

/** A card she gave someone: what she thought of them then, kept so its code can be checked. */
export interface IssuedCard {
  /** `MYR-XXXX-XXXX-XXXX`, Crockford base32 (no I L O U), 60 random bits from crypto. */
  serial: string;
  /** ISO 8601 UTC. */
  issued_at: string;
  /** Their display name when it was issued (from the session record). */
  name: string;
  /** Their avatar URL when it was issued, or null. */
  avatar_url: string | null;
  /** The nth card this person has been given, from 1. */
  number: number;
  call_name: string | null;
  relationship: string | null;
  affinity: string | null;
  trust: string | null;
  familiarity: string | null;
  public_feeling: string | null;
  /** What she wrote for them as she issued it; null on older cards or when she could not. */
  line: string | null;
  /** The stamp she put on it, or null. */
  stamp: string | null;
  /** Fields she chose to add (at most three); empty on older cards. */
  fields: CardField[];
  /** Which picture of her is on it: a key from CARD_POSES (she picks within the band). */
  pose: string;
  /** The card frame they had chosen then (`[modules.economy] frames`), null for none. */
  frame: string | null;
  /** Bought foil finish (`card_foil`); false on older cards. */
  foil: boolean;
  /** When a reroll replaced it, or null: a voided card is shown as 已作廢, never as valid. */
  voided_at: string | null;
}

/** One picture of her they may choose for a card. */
export interface CardPoseChoice {
  id: string;
  /** zh label. */
  label: string;
}

/** What the card extras cost them now; a price is null when it is off sale or there is no wallet. */
export interface CardPrices {
  pose: number | null;
  foil: number | null;
  reroll: number | null;
}

/** `GET /api/member/card`. */
export interface MemberCards {
  /** Their newest card that is not voided. */
  latest: IssuedCard | null;
  /** Cards issued to them in the current local day (utc offset as public stats use); rerolls and voided cards not counted. */
  today: number;
  /** Most cards a person may be issued per local day. */
  per_day: number;
  /** Pictures their affinity band allows, for `card_pose`. */
  poses: CardPoseChoice[];
  prices: CardPrices;
  /** Rerolls of today's newest card they may still buy today (0 when none is possible). */
  rerolls_left: number;
}

/** `GET /api/member/export` (a file). */
export interface MemberExport {
  exported_at: string;
  card: MemberCard;
  memories: (MemberMemory & { derived_from_you: boolean })[];
  /** Memories left out because they hold someone else's name or words, or her own notes. */
  withheld: number;
  songs: MemberSong[];
  /** The cards she gave them, newest first. */
  cards: IssuedCard[];
  /** Their coins: the balance and every line of the ledger, newest first. */
  wallet: WalletExport;
  /** The fortune slips she wrote for them, newest first. */
  fortunes: IssuedFortune[];
}

/** A field on a fortune slip: its name (戀愛, 學業, ...) and what she wrote. */
export interface FortuneField {
  label: string;
  text: string;
}

/** A fortune slip she wrote for them, one per local day (`GET`/`POST /api/member/fortune`). */
export interface IssuedFortune {
  id: string;
  /** The local day it is for, `YYYY-MM-DD`. */
  date: string;
  issued_at: string;
  rank: "大吉" | "吉" | "中吉" | "小吉" | "末吉" | "凶";
  /** At most 8 characters. */
  title: string;
  /** Four lines of at most 7 characters. */
  poem: string[];
  /** At most three. */
  fields: FortuneField[];
  /** A personal line, at most 30 characters. */
  line: string | null;
}

/** `POST /api/member/forget`. */
export interface MemberForgetResult {
  deleted: number;
  about: number;
  derived: number;
  /** Memories whose evidence is gone, so nothing ties them to the person; they stay. */
  unverified: number;
}

/** One module as reported by `GET /api/modules` (the supervisor's `ModuleStatus`). */
export type ModuleInfo = ModuleStatus;

/** Token usage of one `provider:model`, from `GET /api/llm/usage`. */
export interface UsageInfo {
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_prompt_tokens: number;
}

/** One persona section, from `GET /api/persona`. */
export interface PersonaSectionInfo {
  key: string;
  body: string;
}

/** Body of `PUT /api/persona/{key}`. */
export interface SetPersonaRequest {
  body: string;
  /** Defaults to the caller (`"api"` for the token). */
  edited_by?: string;
}

/** Response of `PUT /api/persona/{key}`. */
export interface SetPersonaResponse {
  key: string;
  version: number;
}

/** Every error response: `{ "error": "..." }`. */
export interface ErrorBody {
  error: string;
}

/** A page of results. `next_cursor` is opaque; `null` on the last page. */
export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

// ---- LLM cost ---------------------------------------------------------------------------

/** Totals of one day (`YYYY-MM-DD`) or month (`YYYY-MM`). */
export type PeriodInfo = PeriodReport;
/** `GET /api/llm/cost`: the router's `CostReport` as-is. */
export type CostInfo = CostReport;
export type { ModelUsage };

// ---- people -----------------------------------------------------------------------------

/** `GET /api/people` items: every known person, with or without a relationship. */
export interface PersonSummary {
  person: Person;
  /** `null` before the first interaction. */
  relationship: Relationship | null;
  /** Short attitude label, e.g. `"朋友"`; `"陌生人"` (a neutral relationship's) without one. */
  label: string | null;
  blocked: boolean;
}

/** `GET /api/people/{id}` (the summary's fields flattened in). */
export interface PersonDetail extends PersonSummary {
  /** Oldest first; values are the resulting absolute levels. */
  history: RelationshipDelta[];
  memory_count: number;
}

/** Body of `PATCH /api/people/{id}`; omitted fields are unchanged. */
export interface UpdatePersonRequest {
  /** Replaces every tag except `blocked` (use `blocked`). */
  tags?: string[];
  notes?: string;
  /** `null` clears it. */
  call_name?: string | null;
  blocked?: boolean;
}

/** `GET /api/people/{id}/wallet`: their coins and newest rows (newest first). */
export interface PersonWalletView {
  balance: number;
  ledger: { ts: string; delta: number; label: string }[];
}

/** Body of `POST /api/people/{id}/wallet/adjust`; a negative `amount` takes coins. */
export interface WalletAdjustRequest {
  amount: number;
  /** 1 to 100 characters. */
  note: string;
  /** One per confirmed submit; the same key twice answers the first. */
  key: string;
}

export interface WalletAdjustResult {
  balance: number;
  entry_id: string;
  duplicate: boolean;
}

/** Body of `POST /api/people/{id}/adjust`. */
export interface AdjustPersonRequest {
  /** Added to the affinity directly, ignoring the daily caps. */
  affinity: number;
}

// ---- memory -----------------------------------------------------------------------------

/** A `MemoryRecord` without its search tokens and embedding vector. */
export interface MemoryRecordView {
  id: string;
  profile: ProfileId;
  kind: MemoryKind;
  scope: MemoryScope;
  subjects: PersonId[];
  content: string;
  importance: number;
  confidence: number;
  created_at: Timestamp;
  updated_at: Timestamp;
  last_accessed: Timestamp | null;
  access_count: number;
  source_context: ContextKey | null;
  due: Timestamp | null;
  done: boolean;
  superseded_by: string | null;
  has_embedding: boolean;
}

/** `GET /api/memory` items. The scores are present only for a search (`q`). */
export interface MemoryItem {
  record: MemoryRecordView;
  /** The backend's full-text relevance, 0 when only the vector matched. */
  text_score?: number;
  /** `null` for a search that compared no vectors. */
  vector_score?: number | null;
  /**
   * Hybrid recall score (vector, text, recency, importance), present when the search ran through
   * the memory engine; results are ordered by it.
   */
  score?: number;
}

/** Query of `GET /api/memory`. */
export interface MemoryListQuery {
  /**
   * Search text: hybrid recall (vector, text, recency, importance) through the memory module
   * when it runs, full text otherwise. Omitted lists newest first.
   */
  q?: string;
  kind?: MemoryKind;
  subject?: PersonId;
  /** Only records created before this time (pagination when listing). */
  before?: Timestamp;
  include_superseded?: boolean;
  limit?: number;
}

/** Body of `PATCH /api/memory/{id}`; omitted fields are unchanged. */
export interface UpdateMemoryRequest {
  content?: string;
  kind?: MemoryKind;
  importance?: number;
  done?: boolean;
}

// ---- roles & permissions ----------------------------------------------------------------

/** Body of `POST` / `DELETE /api/auth/assignments`. */
export interface AssignRoleRequest {
  account: AccountRef;
  role: string;
  scope: AuthScope;
}

/** Body of `PUT /api/auth/roles/{name}`. */
export interface UpsertRoleRequest {
  rank: number;
  grants?: string[];
  denies?: string[];
}

/** Body of `DELETE /api/auth/mappings`. */
export interface RemoveMappingRequest {
  platform: PlatformId;
  guild: string;
  platform_role: string;
}

// ---- extensions -------------------------------------------------------------------------

/** One extension, from `GET /api/extensions`. */
export interface ExtensionInfo {
  id: string;
  /** Supervisor module running it (`ext.<id>`). */
  module: ModuleId;
  name: string;
  version: string;
  description: string;
  /** Extension directory. */
  source: string;
  enabled: boolean;
  state: ModuleStateKind;
  reason: string | null;
  /** Granted permissions, e.g. `"tools"`, `"events:game.*"`. */
  permissions: string[];
}

// ---- MCP --------------------------------------------------------------------------------

export type McpState = "connecting" | "ready" | "failed" | "disabled";

export interface McpToolInfo {
  /** Registry name (`mcp_<server>_<tool>`). */
  name: string;
  description: string;
}

/** One configured MCP server, from `GET /api/mcp`. */
export interface McpServerInfo {
  name: string;
  /** `"stdio"` or `"http"`. */
  transport: string;
  /** Command line or URL; `null` while the MCP module does not report it. */
  target: string | null;
  enabled: boolean;
  state: McpState;
  error: string | null;
  tools: McpToolInfo[];
  /** Tools the server offers before allow / deny filtering. */
  remote_tool_count: number;
  /** Permission node required to use the tools. */
  permission: string | null;
  reconnects: number;
}

// ---- request queue ----------------------------------------------------------------------

export interface QueueAuthor {
  account: AccountRef;
  display_name: string;
}

/** One queued request, from `GET /api/queue`. */
export interface QueueItemInfo {
  /** The queue's numeric item id, as a string. */
  id: string;
  /** Free-form, e.g. `"chat"`, `"song"`, `"game_goal"`. */
  kind: string;
  context: ContextKey | null;
  author: QueueAuthor | null;
  text: string;
  priority: number;
  enqueued_at: Timestamp;
  /** `active` items come first, then `pending` ones. */
  state: ItemState;
  votes: number;
}

/** `GET /api/queue` and the response of every queue mutation. */
export interface QueueState {
  paused: boolean;
  /** In processing order. */
  items: QueueItemInfo[];
}

/** Body of `POST /api/queue/{id}/move`. */
export interface MoveRequest {
  /** 0-based target index in `QueueState.items`, clamped. */
  position: number;
}

// ---- stage ------------------------------------------------------------------------------

export interface StageLinkState {
  connected: boolean;
  error: string | null;
}

/** `GET /api/stage` and the response of stage mutations. */
export interface StageState {
  vts: StageLinkState;
  obs: StageLinkState;
  scene: string | null;
  /** OBS scene names, top of OBS's scene list first; empty while OBS is not connected. */
  scenes: string[];
  /** Last expression (VTube Studio hotkey) triggered through the API. */
  expression: string | null;
  /** VTube Studio hotkey names of the loaded model (what `POST /api/stage/expression` takes). */
  expressions: string[];
  /** Emotions of the profile's `avatar.toml` (what `POST /api/stage/say` takes), sorted. */
  emotions: string[];
  /** The Stage node's overlay page (an OBS browser source); `null` without a node. */
  overlay_url: string | null;
  /** Her speech is playing. */
  speaking: boolean;
  /** Name of the connected Stage node, `null` while disconnected. */
  node: string | null;
  /** OBS is streaming. */
  streaming: boolean;
}

/** One scene role in `GET /api/stage/scenes`. */
export interface SceneRoleState {
  /** `chat`, `game`, `brb`, `starting`, `ending` or one of the owner's roles. */
  role: string;
  /** Label of a built-in role, `null` for the owner's own roles. */
  label: string | null;
  /** The OBS scene it switches to, `null` = none. */
  scene: string | null;
  /** Where that came from: the config file, the panel or the automatic classification. */
  source: "config" | "panel" | "auto" | null;
  /** What the classification picked. */
  auto: string | null;
  /** Set in the config file (the panel cannot change it). */
  locked: boolean;
}

/** `GET /api/stage/scenes` and the response of its mutations. */
export interface SceneRolesState {
  /** OBS scene names the stage node reports. */
  scenes: string[];
  roles: SceneRoleState[];
  /** `llm`, `heuristic` (keywords) or `null` (not classified yet). */
  classified_by: "llm" | "heuristic" | null;
  classifying: boolean;
}

/** Body of `PUT /api/stage/scenes`: `scene: null` goes back to the classification. */
export interface SceneRoleRequest {
  role: string;
  scene: string | null;
}

/** Body of `POST /api/stage/scene`. */
export interface SceneRequest {
  scene: string;
}

/** Body of `POST /api/stage/expression`. */
export interface ExpressionRequest {
  expression: string;
}

/** Body of `POST /api/stage/stream`. */
export interface StreamRequest {
  action: StreamAction;
}

/** Body of `POST /api/stage/say`. */
export interface SayRequest {
  text: string;
  emotion?: string;
}

/** Response of `POST /api/stage/say`. */
export interface SayResponse {
  turn: TurnId | null;
}

// ---- voice ------------------------------------------------------------------------------

/** Latency over the recent window; `null` percentiles without samples. */
export interface LatencyStats {
  p50_ms: number | null;
  p95_ms: number | null;
  samples: number;
}

/** p50 / p90 of one end-to-end latency series; `null` percentiles without samples. */
export interface E2eStats {
  p50_ms: number | null;
  p90_ms: number | null;
  samples: number;
}

/**
 * The seven segments of `speech_end → first_audio_played`, in the order a listener hears them.
 * `prepare` (the wait, attention, memory and prompt building before the model call) was part of
 * `llm_first` until 2026-11-10.
 */
export type E2eSegmentName =
  | "endpoint"
  | "asr"
  | "prepare"
  | "llm_first"
  | "tts_queue"
  | "tts_first"
  | "playback";

/**
 * End-to-end voice latency over the recent window: replies to human speech only. `total` and the
 * segments count complete measurements (a segment that was not measured is left out of its own
 * stats); incomplete ones (cancelled, barged in on, failed) are only counted, by reason.
 */
export interface VoiceE2eLatency {
  total: E2eStats;
  segments: Record<E2eSegmentName, E2eStats>;
  complete: number;
  incomplete: number;
  incomplete_by_reason: Record<string, number>;
}

export interface VoiceLatency {
  asr: LatencyStats;
  llm_first_token: LatencyStats;
  tts_first_audio: LatencyStats;
  e2e: VoiceE2eLatency;
}

/** One voice channel she is in. */
export interface VoiceSession {
  context: ContextKey;
  label: string | null;
  participants: VoiceParticipant[];
  /** Accounts currently speaking. */
  speaking: AccountRef[];
  joined_at: Timestamp;
  latency: VoiceLatency;
  last_turn: TurnId | null;
}

/** `GET /api/voice`. */
export interface VoiceState {
  sessions: VoiceSession[];
}

/** One of her feelings, with the person's name. */
export interface FeelingView extends Feeling {
  display_name: string | null;
}

/** `GET /api/self`: her inner state and her feelings about people (newest first). */
export interface SelfView extends SelfSnapshot {
  feelings: FeelingView[];
}

/** A text context of the world snapshot, with its human name when the platform knows it. */
export interface ChannelActivityView extends ChannelActivity {
  label: string | null;
}

/** `GET /api/world`: what she perceives right now. */
export interface WorldView extends Omit<WorldSnapshot, "channels"> {
  channels: ChannelActivityView[];
}

/** One channel level (docs/design/autonomy.md §21). */
export interface ChannelLevelInfo {
  /** `off`, `mention-only`, `quiet`, `normal`, `lively` or `always`. */
  mode: string;
  /** In words (`安靜`). */
  label: string;
  description: string;
}

/** The level of one text channel. */
export interface ChannelLevelView {
  context: ContextKey;
  /** The channel's name when the platform knows it. */
  label: string | null;
  mode: string;
  /** Set at runtime (`/channel mode` or the panel); `false`: from config or the profile. */
  custom: boolean;
  /** The mode without the runtime setting (what resetting goes back to). */
  default: string;
}

/**
 * `GET /api/channels/levels`: the levels, and the text channels she has seen recently or that
 * have their own level.
 */
export interface ChannelLevelsView {
  levels: ChannelLevelInfo[];
  channels: ChannelLevelView[];
}

/** `GET /api/mind` (and the answer of `POST /api/mind/pause|resume`). */
export interface MindView {
  /** The emergency stop is on: she does not reply or speak, only commands and the panel act. */
  paused: boolean;
  /** The `mind` module is running. */
  running: boolean;
  /** Her mind takes triggers right now. */
  accepting: boolean;
  stats: MindStats | null;
  /** High-risk actions waiting for an owner. */
  pending_approvals: number;
  /** The last press of the emergency stop, step by step; `null`: none since the core started. */
  emergency: EmergencyReport | null;
}

export type { PendingApproval, Thought };

// ---- what she organized and learned (phase G) -----------------------------------------------

/** One of her documents, with its short id (as her prompts show it) and whom it is about. */
export interface KnowledgeDocView extends KnowledgeDoc {
  short_id: string;
  subject_label: string;
}

/** `GET /api/knowledge`: every document, most recently updated first. */
export interface KnowledgeView {
  documents: KnowledgeDocView[];
}

/** `GET /api/knowledge/conversations`: her notes on a conversation, with the place's name. */
export interface ConversationNoteView extends ConversationState {
  label: string | null;
}

export interface LessonView extends Lesson {
  display_name: string | null;
}

/** `GET /api/reflection?days=7`. */
export interface ReflectionView {
  stats: ReflectionStats;
  runs: ReflectionRun[];
  lessons: LessonView[];
  feedback: FeedbackTally[];
}

// ---- live controls (`control.ts`) and telemetry (`telemetry.ts`) ----------------------------

/** Answer of a control route: what the capability said it did. */
export interface ControlResult {
  text: string;
}

/** One song of her set list (`GET /api/songs`). */
export interface SongView {
  no: number;
  /** What was asked for. Untrusted. */
  query: string;
  title: string | null;
  artist: string | null;
  duration_s: number | null;
  key: number;
  requester_name: string;
  state: "preparing" | "ready" | "playing" | "done" | "failed" | "cancelled";
  /** Worker stage while preparing (`download`, `separate`, `convert`, ...). */
  stage: string;
  /** 0..1 while preparing. */
  progress: number;
  error: string | null;
  /** Sung as soon as she is free once ready. */
  forced: boolean;
  created_at: string;
  ready_at: string | null;
}

/** `GET /api/songs` (and the answers of the song routes, with `text`). */
export interface SongsState {
  /** Number of the song she is singing. */
  playing: number | null;
  /** Why speech is paused (a song job has the GPU), else `null`. */
  paused: string | null;
  songs: SongView[];
}

/** Process-wide LLM counters at a sample, summed over models and purposes. */
export interface TelemetryLlm {
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_prompt_tokens: number;
  cost_usd: number;
  errors: number;
  /** `miyoria_llm_first_token_seconds`: cumulative counts at each finite upper bound. */
  first_token: { count: number; sum_s: number; buckets: { le_s: number; count: number }[] };
}

/** One sample. Counters are totals since the process started; `events` count since the last one. */
export interface TelemetryPoint {
  at: string;
  mood: { valence: number; arousal: number; energy: number } | null;
  boredom: number | null;
  drives: Record<string, number> | null;
  initiative: number | null;
  llm: TelemetryLlm;
  mind: { calls_total: number; tokens_total: number } | null;
  voice_sessions: number;
  speaking: boolean;
  /** `messages`, `turns`, `initiatives`, `utterances`, `actions` since the previous sample. */
  events: Record<string, number>;
}

/** `GET /api/telemetry?minutes=360`: samples, oldest first. */
export interface TelemetryView {
  interval_ms: number;
  points: TelemetryPoint[];
}

// ---- body, arbiter, affect, plan, prompts (docs/design/v2-architecture.md §3) -------------

/** One arbiter decision (`arbiter.decision`) with what the ledger knows about its impulse. */
export interface ArbiterDecisionView extends ArbiterDecision {
  /** Where the impulse was aimed (`null`: unknown or anywhere). */
  context: ContextKey | null;
  /** What it was, short zh-TW, when the ledger still has it. */
  summary: string | null;
}

/** `GET /api/arbiter/decisions`: decisions seen since the `api` module started, newest first. */
export interface ArbiterDecisionsView {
  decisions: ArbiterDecisionView[];
}

/** `GET /api/mind/goals`. */
export interface GoalsView {
  /** Pending and active goals, soonest trigger first, then (with `closed=true`) closed ones. */
  goals: Goal[];
  /** The closed goals were asked for and the agenda can list them. */
  closed_included: boolean;
}

/** `GET /api/mind/plan`: today's plan in her words (`null`: not written yet). */
export interface DayPlanView {
  day_plan: string | null;
}

/** One saved prompt without its blocks and messages (`GET /api/prompts`). */
export interface PromptSummary {
  turn: TurnId;
  context: ContextKey;
  at: Timestamp;
  purpose: string;
  reasoning: ReasoningLevel;
  prompt_tokens: number | null;
  blocks: number;
  messages: number;
  /** Characters of all kept messages. */
  chars: number;
}

/** The outcome kinds of a turn (`TurnOutcome["type"]`). */
export type TurnOutcomeKind = TurnOutcome["type"];
