// Wire types of the Admin API, field for field as `packages/api/src/types.ts` and
// `packages/types` serialize them. Timestamps are RFC 3339 strings, ids are ULID strings.
// Keep this file in sync when the API changes.

/** A ULID, serialized as a 26-character string. */
export type Ulid = string;
/** RFC 3339 timestamp, e.g. `2026-11-01T08:30:00.123Z`. */
export type Timestamp = string;

// ---------------------------------------------------------------------------
// ids and platform

export type ModuleId = string;
export type ProfileId = string;
export type PlatformId = string;
export type TurnId = Ulid;
export type EventId = Ulid;
export type ActionId = Ulid;
export type PersonId = Ulid;

export interface AccountRef {
  platform: PlatformId;
  id: string;
}

export type ContextKind = "channel" | "thread" | "dm" | "voice";

export interface ContextKey {
  platform: PlatformId;
  /** Guild / server id. `null` for DMs. */
  scope: string | null;
  channel: string;
  kind: ContextKind;
}

export interface MessageRef {
  context: ContextKey;
  id: string;
}

export interface Author {
  account: AccountRef;
  display_name: string;
  is_bot: boolean;
}

export interface Attachment {
  url: string;
  filename: string;
  content_type: string | null;
}

export interface IncomingMessage {
  id: MessageRef;
  author: Author;
  text: string;
  mentions_self: boolean;
  reply_to_self: boolean;
  attachments: Attachment[];
  ts: Timestamp;
}

// ---------------------------------------------------------------------------
// voice

export interface VoiceParticipant {
  account: AccountRef;
  display_name: string;
  is_self: boolean;
  muted: boolean;
  deafened: boolean;
}

export interface VoiceUtterance {
  id: string;
  context: ContextKey;
  speaker: Author;
  text: string;
  language: string | null;
  emotion: string | null;
  audio_events: string[];
  started_at: Timestamp;
  ended_at: Timestamp;
  asr_ms: number;
}

export type PlaybackState = "started" | "finished" | "interrupted" | "failed";

// ---------------------------------------------------------------------------
// events

export type ModuleStateKind =
  | "disabled"
  | "starting"
  | "running"
  | "degraded"
  | "stopping"
  | "stopped"
  | "failed";

export const MODULE_STATES: readonly ModuleStateKind[] = [
  "running",
  "degraded",
  "starting",
  "stopping",
  "failed",
  "stopped",
  "disabled",
];

/** Why the agent did or did not respond. */
export interface DecisionTrace {
  turn: TurnId;
  context: ContextKey;
  respond: boolean;
  score: number;
  reasons: string[];
}

/** `Event`, serialized with `#[serde(tag = "type", content = "data")]`. */
export type BusEvent =
  | { type: "platform_ready"; data: { platform: PlatformId; self_account: AccountRef } }
  | { type: "platform_message_created"; data: IncomingMessage }
  | { type: "platform_typing"; data: { context: ContextKey; account: AccountRef } }
  | { type: "agent_turn_started"; data: { turn: TurnId; context: ContextKey } }
  | { type: "agent_decision"; data: DecisionTrace }
  | { type: "agent_turn_completed"; data: { turn: TurnId; context: ContextKey; text: string } }
  | {
      type: "action_completed";
      data: {
        action: ActionId;
        turn: TurnId | null;
        ok: boolean;
        error: string | null;
        message?: MessageRef | null;
      };
    }
  | { type: "voice_joined"; data: { context: ContextKey; participants: VoiceParticipant[] } }
  | { type: "voice_left"; data: { context: ContextKey; reason: string | null } }
  | { type: "voice_participants"; data: { context: ContextKey; participants: VoiceParticipant[] } }
  | { type: "voice_speaking"; data: { context: ContextKey; account: AccountRef; speaking: boolean } }
  | { type: "voice_utterance"; data: VoiceUtterance }
  | {
      type: "voice_playback";
      data: { context: ContextKey; turn: TurnId | null; state: PlaybackState; text: string };
    }
  | {
      type: "agent_initiative";
      data: { context: ContextKey; reason: string; hint: string; about: AccountRef[] };
    }
  | {
      type: "module_state_changed";
      data: { module: ModuleId; state: ModuleStateKind; reason: string | null };
    }
  | { type: "custom"; data: { topic: string; payload: unknown } };

export type BusEventType = BusEvent["type"];

/** Every event on the bus, as streamed by `GET /api/events`. */
export interface Envelope {
  id: EventId;
  ts: Timestamp;
  source: ModuleId;
  causation: EventId | null;
  correlation: TurnId | null;
  event: BusEvent;
}

// ---------------------------------------------------------------------------
// core routes

/** `GET /api/health` (no token required). */
export interface HealthInfo {
  status: string;
  version: string;
}

/** One module, from `GET /api/modules` and `POST /api/modules/{id}/{action}`. */
export interface ModuleInfo {
  id: ModuleId;
  name: string;
  description: string;
  enabled: boolean;
  state: ModuleStateKind;
  reason: string | null;
  recent_restarts: number;
}

export type ModuleAction = "enable" | "disable" | "restart";

/** Per `provider:model`, from `GET /api/llm/usage`. */
export interface UsageInfo {
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_prompt_tokens: number;
}

export type UsageMap = Record<string, UsageInfo>;

/** `GET /api/persona`. */
export interface PersonaSectionInfo {
  key: string;
  body: string;
}

/** Body of `PUT /api/persona/{key}`. */
export interface SetPersonaRequest {
  body: string;
  /** Defaults to `"api"` on the server. */
  edited_by?: string;
}

/** Response of `PUT /api/persona/{key}`. */
export interface SetPersonaResponse {
  key: string;
  version: number;
}

/** Every error response. */
export interface ErrorBody {
  error: string;
}

// ---------------------------------------------------------------------------
// store records

/** `GET /api/persona/{key}/history` items (`PersonaOverride`). */
export interface PersonaOverride {
  profile: ProfileId;
  key: string;
  version: number;
  body: string;
  edited_by: string;
  edited_at: Timestamp;
}

/** `GET /api/decisions` items, newest first. */
export interface DecisionRecord {
  id: Ulid;
  profile: ProfileId;
  ts: Timestamp;
  trace: DecisionTrace;
}

export interface DecisionsQuery {
  /** Default 50, capped at 1000 by the server. */
  limit?: number;
  context?: ContextKey;
}

// ---------------------------------------------------------------------------
// panel login (`packages/api/src/oauth.ts`)

/** `GET /api/auth/methods` (public). */
export interface AuthMethods {
  token: boolean;
  /** Discord OAuth2 is configured on this Core. */
  discord: boolean;
}

export interface SessionUser {
  /** Discord user id. */
  id: string;
  name: string;
  avatar_url: string | null;
}

/** `GET /api/auth/session`. */
export interface SessionInfo {
  method: "token" | "discord";
  /** `null` for the bearer token. */
  user: SessionUser | null;
  permissions: { write: boolean };
}

// ---------------------------------------------------------------------------
// public side (`/api/public/*`, `/api/member/*`)
// ---------------------------------------------------------------------------

export type PublicState = "singing" | "playing" | "live" | "in_voice" | "idle" | "offline";

/** `GET /api/public/status`. */
export interface PublicStatus {
  state: PublicState;
  live: boolean;
  in_voice: boolean;
  game: string | null;
  today: PublicToday;
  /** The last 14 local days, oldest first, today last. Missing on an older Core. */
  days?: PublicDay[];
}

export interface PublicToday {
  songs_sung: number;
  hours_live: number;
  hours_in_voice: number;
}

/** One local day, `date` as `YYYY-MM-DD`. */
export interface PublicDay extends PublicToday {
  date: string;
}

export interface PublicSong {
  title: string | null;
  artist: string | null;
  duration_s: number | null;
}

/** `GET /api/public/songs`. */
export interface PublicSongs {
  playing: PublicSong | null;
  upcoming: (PublicSong & { ready: boolean })[];
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

export interface MemberSong {
  title: string;
  artist: string | null;
  state: string;
  requested_at: string;
}

/** `GET /api/member/me`. */
/** Their own lines on one local day. */
export interface MemberDay {
  date: string;
  text: number;
  voice: number;
}

/** A card she gave someone: what she thought of them then, kept so its code can be checked. */
export interface IssuedCard {
  /** `MYR-XXXX-XXXX-XXXX`. */
  serial: string;
  issued_at: string;
  name: string;
  avatar_url: string | null;
  /** The nth card this person has been given, from 1. */
  number: number;
  call_name: string | null;
  relationship: string | null;
  affinity: string | null;
  trust: string | null;
  familiarity: string | null;
  public_feeling: string | null;
  /** What she wrote for them as she issued it. Missing on an older Core, null when she did not. */
  line?: string | null;
  /** The stamp she put on it. Missing on an older Core. */
  stamp?: string | null;
  /** Fields she chose to add, at most three. Missing on an older Core. */
  fields?: { label: string; text: string }[];
  /** Which picture of her is on it (she picks within her feeling's band). */
  pose: string;
  /** The frame they had selected when it was issued; `null` is the plain border. Missing on an older Core. */
  frame?: string | null;
  /** A foil finish they bought. Missing on an older Core. */
  foil?: boolean;
  /** When a reroll replaced it: the card is void, never a valid one. Missing on an older Core. */
  voided_at?: string | null;
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

/** `GET /api/member/fortune`: today's slip or `null`, and the price of one. */
export interface FortuneToday {
  fortune: IssuedFortune | null;
  price: number;
}

/** `POST /api/member/fortune`: the slip (today's own when one existed: nothing charged then). */
export interface FortuneDraw {
  fortune: IssuedFortune;
  charged: number;
  balance: number;
}

// ---------------------------------------------------------------------------
// the coin economy (`/api/member/wallet` and the spends)

export type FeedItem = "rice" | "big_bowl" | "dessert";
export type GiftExpression = "heart" | "blush" | "squint";
export type Hungry = "full" | "ok" | "hungry" | "starving";

/** What earns coins: the first five from the Core's wallet, the others economy 2.0 added. */
export type EarnReason = "checkin" | "talked" | "voice" | "song" | "her_gift" | "quest" | "play" | "achievement";

export interface EarnLine {
  reason: EarnReason;
  label: string;
  amount: number;
  earned_today: number;
  cap: number;
}

export interface ShopItem {
  id: string;
  /** `card`, `song`, `stream` and `fortune` are newer: an older Core never sends them. */
  kind: "feed" | "letter" | "expression" | "frame" | "card" | "song" | "stream" | "fortune";
  label: string;
  price: number;
  available: boolean;
  why: string | null;
}

export interface LedgerLine {
  ts: string;
  delta: number;
  label: string;
}

/** `GET /api/member/wallet`. */
export interface WalletView {
  currency: string;
  balance: number;
  can_earn: boolean;
  today_earned: number;
  checked_in_today: boolean;
  streak: number;
  earn: EarnLine[];
  shop: ShopItem[];
  frames: { owned: string[]; selected: string | null };
  /** Words, never the number; `null` for someone she does not know. */
  hungry: Hungry | null;
  /** Newest first. */
  recent: LedgerLine[];
  /** On the sponsor board. Missing on an older Core. */
  on_board?: boolean;
}

/** `POST /api/member/checkin`. */
export interface CheckinResult {
  gained: number;
  streak: number;
  balance: number;
}

/** `POST /api/member/feed`. Refused (she is full): `accepted` false, nothing charged. */
export interface FeedResult {
  accepted: boolean;
  eaten: number;
  charged: number;
  balance: number;
  message: string;
}

/** `POST /api/member/letter` and `/expression`. */
export interface SpendResult {
  accepted: boolean;
  charged: number;
  balance: number;
  message: string;
}

/** `POST /api/member/transfer`. */
export interface TransferResult {
  sent: number;
  balance: number;
  /** The receiver as their ledger names them. */
  to: string;
}

/** `GET /api/public/board`: only people who chose to be on it. */
export interface BoardView {
  entries: { rank: number; name: string; spent: number }[];
}

/** One of her goals (`GET /api/member/goals`). */
export interface GoalView {
  id: string;
  title: string;
  /** What she will do when it is reached. */
  promise: string;
  target: number;
  raised: number;
  /** What this person put in. */
  my_pledge: number;
  deadline: string;
  status: "open" | "reached" | "expired" | "cancelled";
}

/** `POST /api/member/goals/:id/pledge`. */
export interface PledgeResult {
  pledged: number;
  raised: number;
  target: number;
  reached: boolean;
  balance: number;
  duplicate: boolean;
}

/** One bounty she has open (`GET /api/member/bounties`). */
export interface BountyView {
  id: string;
  task: string;
  reward: number;
  posted_at: string;
  expires_at: string;
}

/** `POST /api/member/frame`. */
export interface FramesResult {
  owned: string[];
  selected: string | null;
  balance: number;
}

/** `GET /api/member/card`. */
export interface MemberCards {
  /** Their newest card that is not voided. */
  latest: IssuedCard | null;
  today: number;
  per_day: number;
  /** Pictures their band allows, for a chosen pose. Missing on an older Core. */
  poses?: { id: string; label: string }[];
  /** Prices of the extras; null is off sale. Missing on an older Core. */
  prices?: { pose: number | null; foil: number | null; reroll: number | null };
  /** Rerolls of today's newest card still to buy today. Missing on an older Core. */
  rerolls_left?: number;
}

export interface MemberView {
  card: MemberCard;
  memories: { text: string; kind: string; date: string }[];
  songs: MemberSong[];
  /** The last 30 local days, oldest first, today last. Missing on an older Core. */
  activity?: MemberDay[];
  can_request_song: boolean;
  forget: { removes: string; keeps: string };
}

/** `POST /api/member/forget`. */
export interface MemberForgetResult {
  deleted: number;
  about: number;
  derived: number;
  unverified: number;
}

// ---------------------------------------------------------------------------
// panel routes

/** A page of results. `next_cursor` is opaque; `null` on the last page. */
export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

// ---------------------------------------------------------------------------
// LLM cost (`CostReport` in miyoria-llm/src/cost.rs)

export type BudgetState = "ok" | "degraded" | "exhausted";

export interface ModelUsage {
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_prompt_tokens: number;
  cost_usd: number;
}

export interface PeriodReport {
  /** `2026-11-01` for a day, `2026-11` for a month. */
  period: string;
  total_usd: number;
  calls: number;
  models: Record<string, ModelUsage>;
}

/** `GET /api/llm/cost`. */
export interface CostReport {
  state: BudgetState;
  daily_usd: number | null;
  monthly_usd: number | null;
  /** Fraction of a budget at which the router degrades, e.g. `0.8`. */
  degrade_at: number;
  today: PeriodReport;
  month: PeriodReport;
}

// ---------------------------------------------------------------------------
// People & relationships (`Person`, `Account`, `Relationship`, `RelationshipDelta`)

export interface Account {
  account: AccountRef;
  display_name: string;
  first_seen: Timestamp;
  last_seen: Timestamp;
}

export interface Person {
  id: PersonId;
  display_name: string;
  created_at: Timestamp;
  accounts: Account[];
}

export interface Relationship {
  profile: ProfileId;
  person: PersonId;
  /** -100..100 */
  affinity: number;
  /** 0..100 */
  trust: number;
  /** 0..100 */
  familiarity: number;
  tags: string[];
  notes: string;
  call_name: string | null;
  interactions: number;
  last_interaction: Timestamp | null;
  updated_at: Timestamp;
}

export interface RelationshipDelta {
  at: Timestamp;
  affinity: number;
  trust: number;
  familiarity: number;
  reason: string;
}

/** `GET /api/people` items. */
export interface PersonSummary {
  person: Person;
  relationship: Relationship | null;
  /** Short attitude label, e.g. `"朋友"`. */
  label: string | null;
  blocked: boolean;
}

/** `GET /api/people/{id}`. */
export interface PersonDetail extends PersonSummary {
  /** Oldest first, for the affinity chart. */
  history: RelationshipDelta[];
  memory_count: number;
}

/** `GET /api/people/{id}/wallet`: their coins and newest rows (newest first). */
export interface PersonWalletView {
  balance: number;
  ledger: { ts: Timestamp; delta: number; label: string }[];
}

/** `POST /api/people/{id}/wallet/adjust`; a negative `amount` takes coins. */
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

/** `POST /api/people/{id}/adjust`: added to the affinity, ignoring daily caps. */
export interface AdjustPersonRequest {
  affinity: number;
}

export interface PeopleQuery {
  q?: string;
  limit?: number;
  cursor?: string;
}

/** `PATCH /api/people/{id}`; every field optional. */
export interface UpdatePersonRequest {
  /** Replaces every tag except `blocked` (set that with `blocked`). */
  tags?: string[];
  notes?: string;
  call_name?: string | null;
  blocked?: boolean;
}

// ---------------------------------------------------------------------------
// Memory (`MemoryRecord`, `MemoryHit`, `MemoryScope`)

export type MemoryKind = "episode" | "fact" | "self_note" | "followup";

export type MemoryScope =
  | { type: "global" }
  | { type: "guild"; platform: PlatformId; guild: string }
  | { type: "channel"; context: ContextKey }
  | { type: "dm"; account: AccountRef }
  | { type: "person"; person: PersonId };

/** A memory record without its embedding vector. */
export interface MemoryRecordView {
  id: Ulid;
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
  superseded_by: Ulid | null;
  has_embedding: boolean;
}

export interface MemoryItem {
  record: MemoryRecordView;
  /** Present when `q` was given: full-text relevance. */
  text_score?: number;
  /** Present when `q` was given and vectors were compared. */
  vector_score?: number | null;
}

export interface MemoryQuery {
  /** Search text; omit to list newest first. */
  q?: string;
  kind?: MemoryKind;
  subject?: PersonId;
  /** Only records created before this time (pagination when listing). */
  before?: Timestamp;
  include_superseded?: boolean;
  limit?: number;
}

/** `PATCH /api/memory/{id}`. */
export interface UpdateMemoryRequest {
  content?: string;
  kind?: MemoryKind;
  importance?: number;
  done?: boolean;
}

// ---------------------------------------------------------------------------
// Roles & permissions (`RoleDefinition`, `RoleAssignment`, `AuthScope`)

export type AuthScope =
  | { type: "global" }
  | { type: "guild"; platform: PlatformId; guild: string }
  | { type: "channel"; context: ContextKey };

export interface RoleDefinition {
  name: string;
  /** Higher outranks lower. */
  rank: number;
  grants: string[];
  denies: string[];
  builtin: boolean;
}

export interface RoleAssignment {
  account: AccountRef;
  role: string;
  scope: AuthScope;
  granted_by: string;
  at: Timestamp;
}

export interface AssignRoleRequest {
  account: AccountRef;
  role: string;
  scope: AuthScope;
}

/** `PUT /api/auth/roles/{name}`. */
export interface UpsertRoleRequest {
  rank: number;
  grants: string[];
  denies: string[];
}

/** Platform role (e.g. a Discord role id) → Miyoria role, per guild. */
export interface RoleMapping {
  platform: PlatformId;
  guild: string;
  platform_role: string;
  role: string;
}

/** `DELETE /api/auth/mappings`. */
export interface RemoveMappingRequest {
  platform: PlatformId;
  guild: string;
  platform_role: string;
}

// ---------------------------------------------------------------------------
// Extensions

export interface ExtensionInfo {
  id: string;
  /** Supervisor module running it, `ext.<id>`. */
  module: string;
  name: string;
  version: string;
  description: string;
  /** Extension directory. */
  source: string;
  enabled: boolean;
  state: ModuleStateKind;
  reason: string | null;
  /** Granted permissions: `"tools"`, `"commands"`, `"events:<topic>"`, `"network:<host>"`, `"input:<kind>"`. */
  permissions: string[];
}

// ---------------------------------------------------------------------------
// MCP servers

export type McpTransport = "stdio" | "http";
export type McpState = "connecting" | "ready" | "failed" | "disabled";

export interface McpToolInfo {
  name: string;
  description: string;
}

export interface McpServerInfo {
  name: string;
  transport: McpTransport;
  /** Command line (`stdio`) or URL without credentials (`http`). */
  target: string | null;
  /** `false` when disabled in `miyoria.toml`; only `restart` works at runtime. */
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

// ---------------------------------------------------------------------------
// Request queue

/** Free-form request kind from the queue, e.g. `"chat"`, `"song"`, `"game_goal"`. */
export type QueueItemKind = string;

export type QueueItemState = "pending" | "active" | "done" | "skipped" | "removed";

export interface QueueItem {
  /** The queue's numeric item id, as a string (e.g. `"3"`). */
  id: string;
  kind: QueueItemKind;
  /** Where the request was made; `null` for requests from the API or a game. */
  context: ContextKey | null;
  author: { account: AccountRef; display_name: string } | null;
  text: string;
  priority: number;
  enqueued_at: Timestamp;
  /** `active` items come first, then `pending` ones. */
  state: QueueItemState;
  votes: number;
}

export interface QueueState {
  paused: boolean;
  /** In processing order. */
  items: QueueItem[];
}

// ---------------------------------------------------------------------------
// Stage / stream control

export interface StageLink {
  connected: boolean;
  error: string | null;
}

export interface StageState {
  vts: StageLink;
  obs: StageLink;
  scene: string | null;
  scenes: string[];
  expression: string | null;
  expressions: string[];
  /** Emotions of the profile's `avatar.toml`, what `POST /api/stage/say` takes. */
  emotions: string[];
  /** The Stage node's overlay page (an OBS browser source); `null` without a node. */
  overlay_url: string | null;
  speaking: boolean;
  /** Name of the connected Stage node; `null` while disconnected. */
  node: string | null;
  /** OBS is streaming. */
  streaming: boolean;
}

export type StreamAction = "start" | "stop";

/** One scene role: which OBS scene the scene director uses for it. */
export interface SceneRoleState {
  role: string;
  /** Label of a built-in role, `null` for the owner's own roles. */
  label: string | null;
  scene: string | null;
  source: "config" | "panel" | "auto" | null;
  /** What the automatic classification picked. */
  auto: string | null;
  /** Set in the config file; the panel cannot change it. */
  locked: boolean;
}

export interface SceneRolesState {
  scenes: string[];
  roles: SceneRoleState[];
  classified_by: "llm" | "heuristic" | null;
  classifying: boolean;
}

export interface SayRequest {
  text: string;
  emotion?: string;
}

// ---------------------------------------------------------------------------
// Voice monitor

export interface LatencyStats {
  p50_ms: number | null;
  p95_ms: number | null;
  samples: number;
}

export interface VoiceSession {
  context: ContextKey;
  /** Guild and channel names when the platform knows them. */
  label: string | null;
  participants: VoiceParticipant[];
  speaking: AccountRef[];
  joined_at: Timestamp;
  latency: {
    asr: LatencyStats;
    llm_first_token: LatencyStats;
    tts_first_audio: LatencyStats;
    /** Speech end to first audio. Absent on a Core older than the six-segment measurement. */
    e2e?: VoiceE2eLatency;
  };
  last_turn: TurnId | null;
}

/** p50 / p90 of one end-to-end series; `null` percentiles without samples. */
export interface E2eStats {
  p50_ms: number | null;
  p90_ms: number | null;
  samples: number;
}

/** The segments of `speech_end → first_audio_played`, in the order a listener hears them. */
export type E2eSegmentName =
  | "endpoint"
  | "asr"
  | "prepare"
  | "llm_first"
  | "tts_queue"
  | "tts_first"
  | "playback";

/** Replies to human speech over the recent window; incomplete ones are only counted, by reason. */
export interface VoiceE2eLatency {
  total: E2eStats;
  segments: Record<E2eSegmentName, E2eStats>;
  complete: number;
  incomplete: number;
  incomplete_by_reason: Record<string, number>;
}

/** The payload of a `voice.latency` bus event with `stage: "e2e"`: one reply, measured. */
export interface E2eRecord {
  context: ContextKey;
  turn: TurnId | null;
  utterance: string;
  complete: boolean;
  reason: string | null;
  total_ms: number | null;
  segments: Record<E2eSegmentName, number | null>;
  unattributed_ms: number | null;
  prefetched: boolean;
  provider: string | null;
}

/** `GET /api/voice`. */
export interface VoiceState {
  sessions: VoiceSession[];
}

// ---------------------------------------------------------------------------
// inner life (`GET /api/self`, `GET /api/world`; `packages/types` self.ts / world.ts)

export type DriveName = "social" | "play" | "attention" | "rest" | "curiosity";

export interface Mood {
  /** -1..1 */
  valence: number;
  /** 0..1 */
  arousal: number;
  /** 0..1 */
  energy: number;
}

export interface Talkativeness {
  level: number;
  until: Timestamp | null;
  why: string;
  set_at: Timestamp;
}

export interface SelfPolicy {
  /** By scope: `*`, `voice`, `text`, `discord:<guild>`, or a context string. */
  talkativeness: Record<string, Talkativeness>;
  initiative: number;
  initiative_why: string;
}

export type AgendaStatus = "open" | "done" | "expired" | "dropped";

export interface AgendaItem {
  id: string;
  text: string;
  why: string;
  person: PersonId | null;
  context: ContextKey | null;
  created_at: Timestamp;
  due: Timestamp | null;
  expires_at: Timestamp | null;
  status: AgendaStatus;
  closed_at: Timestamp | null;
}

export interface FeelingView {
  person: PersonId;
  display_name: string | null;
  text: string;
  updated_at: Timestamp;
  by: string;
}

/** `GET /api/self`. */
export interface SelfView {
  at: Timestamp;
  mood: Mood | null;
  boredom: number;
  drives: Record<DriveName, number>;
  policy: SelfPolicy;
  /** Open items first, then recently closed ones. */
  agenda: AgendaItem[];
  /** Newest first. */
  feelings: FeelingView[];
}

export type PresenceStatus = "online" | "idle" | "dnd" | "offline";

export interface PresenceActivity {
  type: "playing" | "streaming" | "listening" | "watching" | "competing" | "custom";
  name: string;
  details: string | null;
  state: string | null;
  started_at: Timestamp | null;
  url: string | null;
}

export interface VoiceSpot {
  platform: PlatformId;
  guild: string;
  channel: string;
  channel_name: string | null;
}

export interface PersonPresence {
  account: AccountRef;
  person: PersonId | null;
  display_name: string;
  status: PresenceStatus | null;
  activities: PresenceActivity[];
  voice: VoiceSpot | null;
  online_since: Timestamp | null;
  updated_at: Timestamp;
}

export interface VoiceMember {
  account: AccountRef;
  person: PersonId | null;
  display_name: string;
  is_self: boolean;
  muted: boolean;
  deafened: boolean;
  video: boolean;
  streaming: boolean;
  since: Timestamp;
}

export interface VoiceChannelState {
  platform: PlatformId;
  guild: string;
  channel: string;
  name: string | null;
  members: VoiceMember[];
}

export interface ChannelActivity {
  context: ContextKey;
  label: string | null;
  recent_messages: number;
  per_minute: number;
  last_at: Timestamp | null;
  recent_authors: string[];
  topic: string[];
  lively: boolean;
  her_last_at: Timestamp | null;
}

export interface HerStatus {
  voice: ContextKey | null;
  voice_name: string | null;
  golive: string | null;
  streaming: boolean;
  scene: string | null;
  game: string | null;
  /** The song she is singing. Absent on a Core from before the ActivityManager. */
  singing?: string | null;
}

export interface TimeContext {
  local: string;
  weekday: number;
  weekend: boolean;
  part_of_day: string;
  utc_offset_minutes: number;
}

/** `GET /api/world`. */
export interface WorldView {
  at: Timestamp;
  time: TimeContext;
  her: HerStatus;
  people: PersonPresence[];
  voice_channels: VoiceChannelState[];
  channels: ChannelActivity[];
}

/** `off` | `mention-only` | `quiet` | `normal` | `lively` | `always`. */
export type ChannelMode = string;

/** One channel level: a ceiling on how much she talks in a text channel. */
export interface ChannelLevelInfo {
  mode: ChannelMode;
  label: string;
  description: string;
}

export interface ChannelLevelView {
  context: ContextKey;
  label: string | null;
  mode: ChannelMode;
  /** Set with `/channel mode` or here; `false`: from config or the profile. */
  custom: boolean;
  /** What resetting goes back to. */
  default: ChannelMode;
}

/** `GET /api/channels/levels`. */
export interface ChannelLevelsView {
  levels: ChannelLevelInfo[];
  channels: ChannelLevelView[];
}

// --- data (`packages/api/src/data.ts`) ----------------------------------------

export type DataCategoryId =
  | "memories"
  | "relationships"
  | "call_names"
  | "inner"
  | "knowledge"
  | "learning"
  | "conversation"
  | "mood"
  | "messages"
  | "decisions"
  | "initiative"
  | "people"
  | "channels"
  | "voice_consent"
  | "event_log"
  | "directives"
  | "privacy"
  | "queue"
  | "roles"
  | "persona"
  | "proposed_tools"
  | "extensions"
  | "module_state"
  | "other_settings"
  | "tools_workspace"
  | "audit"
  | "llm_usage"
  | "panel_sessions";

export interface DataPartView {
  id: string;
  count: number;
  updated_at: string | null;
}

/** One category of `GET /api/data`. */
export interface DataCategoryView {
  id: DataCategoryId;
  count: number;
  updated_at: string | null;
  parts: DataPartView[];
  /** Memories by kind. */
  breakdown: Record<string, number> | null;
  /** Shared by every profile on this node. */
  shared: boolean;
  /** Never deleted (export only). */
  kept: boolean;
  exportable: boolean;
  /** `typed`: deleting needs the profile id typed. */
  confirm: "typed" | "simple";
  /** Deleted along with this one. */
  requires: DataCategoryId[];
}

export interface DataInventory {
  profile: string;
  at: string;
  /** May export, delete and reset (`owner.data.manage`). */
  can_manage: boolean;
  categories: DataCategoryView[];
}

export type DataNote = "restart_core" | "consent_cache";

export interface DataWipeResult {
  deleted: DataCategoryId[];
  counts: Record<string, number>;
  failed_modules: string[];
  notes: DataNote[];
}

// ---------------------------------------------------------------------------
// mind loop and autonomy (`packages/types/src/mind.ts`, `packages/api/src/mind.ts`)

export interface MindStats {
  calls_last_hour: number;
  max_calls_per_hour: number;
  calls_total: number;
  tokens_total: number;
  last_at: Timestamp | null;
  next_heartbeat_at: Timestamp | null;
  /** Why she is not thinking right now (`paused`, `budget exhausted`, ...). */
  idle_reason: string | null;
}

/** One step of the emergency stop, in the order they ran. */
export interface EmergencyStep {
  step: "pause" | "silence" | "song" | "stream" | "voice" | "game" | "resume";
  ok: boolean;
  detail: string;
}

export interface EmergencyReport {
  paused: boolean;
  by: string;
  at: Timestamp;
  steps: EmergencyStep[];
}

/** `GET /api/mind`, `POST /api/mind/pause|resume`. */
export interface MindView {
  paused: boolean;
  running: boolean;
  accepting: boolean;
  stats: MindStats | null;
  pending_approvals: number;
  /** The last press of the emergency stop; `null`: none since the core started. */
  emergency?: EmergencyReport | null;
}

export type ThoughtTriggerKind = "heartbeat" | "salient" | "suggestion" | "turn" | "voice_quiet" | "manual";

export interface ThoughtTrigger {
  kind: ThoughtTriggerKind;
  detail: string;
  context: ContextKey | null;
  at: Timestamp;
}

export interface ThoughtDecision {
  at: Timestamp;
  capability: string;
  allowed: boolean;
  stage: string;
  reason: string;
}

export type IntentStatus = "pending" | "started" | "done" | "denied" | "dropped" | "failed";

export interface ThoughtIntent {
  id: string;
  capability: string;
  args: unknown;
  why: string;
  opening: string | null;
  context: ContextKey | null;
  about: AccountRef | null;
  expires_at: Timestamp;
  status: IntentStatus;
  detail: string | null;
  turn: TurnId | null;
  decisions: ThoughtDecision[];
  said: string | null;
  /** Every status it went through, oldest first (newer journals only). */
  history?: { at: Timestamp; status: IntentStatus; detail: string | null }[];
}

/** What one thought saw (bounded copies; only the newest thoughts keep it). */
export interface ThoughtInput {
  time: string;
  night: boolean;
  self: {
    mood: Mood | null;
    boredom: number;
    drives: Record<string, number>;
    initiative: number;
  } | null;
  suggestions: MindSuggestion[];
  world: string;
  places: { ref: string; label: string; note: string; here: boolean }[];
  people: { ref: string; name: string; person: string | null; relation: string | null; feeling: string | null; doing: string | null }[];
  agenda: { ref: string; text: string; due: Timestamp | null; blocked: string | null }[];
  memories: string | null;
  documents: string | null;
  lessons: string[];
  recap: string | null;
  digest: string | null;
  unanswered: string[];
  blocked: { capability: string; reason: string }[];
  idle: { thoughts: number; minutes: number } | null;
  capabilities: string[];
  recent: number;
}

/** What one thought changed, item by item. */
export interface ThoughtEffects {
  drives: Record<string, number>;
  talkativeness: { scope: string; level: number; minutes: number; why: string }[];
  initiative: { level: number; why: string } | null;
  feelings: { person: string; name: string; note: string | null; hint: "+" | "-" | null }[];
  agenda_added: { text: string; why: string }[];
  agenda_done: string[];
  agenda_dropped: string[];
  documents: { type: string; title: string | null; ok: boolean; error: string | null }[];
}

/** A reason to think, offered by another module. */
export interface MindSuggestion {
  source: string;
  reason: string;
  context: ContextKey | null;
  hint: string;
  about: AccountRef[];
}

/** `GET /api/mind/thoughts` (newest first, without `input` and `reasoning`) and `GET /api/mind/thoughts/{id}`. */
export interface Thought {
  id: string;
  at: Timestamp;
  triggers: ThoughtTrigger[];
  thought: string;
  changes: string[];
  intents: ThoughtIntent[];
  tokens: number | null;
  error: string | null;
  ms: number;
  suggestions?: MindSuggestion[];
  /** Only from `GET /api/mind/thoughts/{id}`, and only for the newest thoughts. */
  input?: ThoughtInput | null;
  reasoning?: string | null;
  /** In the list: whether the full thought has them. */
  has_input?: boolean;
  has_reasoning?: boolean;
  effects?: ThoughtEffects | null;
  /** Ids of her LLM calls for this thought. */
  calls?: string[];
  cost_usd?: number | null;
  attempts?: number;
  idle?: { thoughts: number; minutes: number } | null;
}

// ---------------------------------------------------------------------------
// LLM call inspector (`packages/llm/src/calls.ts`, `packages/api/src/llmcalls.ts`)

export interface LlmPricing {
  input_per_mtok: number;
  cached_input_per_mtok: number | null;
  output_per_mtok: number;
}

export type LlmCallStatus = "streaming" | "ok" | "error" | "aborted";

export interface LlmCallRecord {
  id: string;
  at: Timestamp;
  purpose: string;
  chain: string;
  model: string | null;
  provider: string | null;
  status: LlmCallStatus;
  fallbacks: { model: string; error: string; kind: string }[];
  retries: string[];
  thinking: boolean;
  json_mode: boolean;
  tools: string[];
  max_tokens: number | null;
  temperature: number | null;
  messages: number;
  images: number;
  usage: { prompt_tokens: number; completion_tokens: number; cached_prompt_tokens: number; reasoning_tokens: number | null } | null;
  first_token_ms: number | null;
  total_ms: number | null;
  cost_usd: number | null;
  pricing: LlmPricing | null;
  finish_reason: string | null;
  error: string | null;
  error_kind: string | null;
  module: string | null;
  turn: string | null;
  thought: string | null;
  label: string | null;
  repair: number | null;
  text_chars: number;
  reasoning_chars: number;
  tool_calls: number;
  has_detail: boolean;
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface LlmCallDetail {
  messages: { role: string; name: string | null; content: string; cut: number; tool_calls: LlmToolCall[]; tool_call_id: string | null }[];
  tools: string[];
  response: { text: string; reasoning: string; tool_calls: LlmToolCall[]; cut: number };
}

export interface LlmCallsQuery {
  purpose?: string;
  model?: string;
  module?: string;
  status?: LlmCallStatus;
  trouble?: boolean;
  thought?: string;
  turn?: string;
  since?: string;
  q?: string;
}

/** `GET /api/llm/calls`. */
export interface LlmCallsPage {
  items: LlmCallRecord[];
  next_cursor: string | null;
  matched: number;
  kept: number;
}

export interface LlmGroupStats {
  key: string;
  calls: number;
  errors: number;
  prompt_tokens: number;
  cached_prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  cost_usd: number;
  p50_ms: number | null;
  p95_ms: number | null;
  total_p50_ms: number | null;
}

/** `GET /api/llm/stats?minutes=`. */
export interface LlmCallStats {
  since: Timestamp | null;
  total: LlmGroupStats;
  by_purpose: LlmGroupStats[];
  by_model: LlmGroupStats[];
  by_module: LlmGroupStats[];
  by_hour: {
    hour: Timestamp;
    calls: number;
    errors: number;
    prompt_tokens: number;
    cached_prompt_tokens: number;
    completion_tokens: number;
    cost_usd: number;
    by_purpose: Record<string, number>;
  }[];
  latency: { le_ms: number; count: number }[];
  errors: { kind: string; count: number }[];
  finish_reasons: { reason: string; count: number }[];
  expensive: LlmCallRecord[];
  slowest: LlmCallRecord[];
  kept: number;
  oldest: Timestamp | null;
  prices: Record<string, LlmPricing>;
}

/** `GET /api/mind/approvals`: high-risk actions waiting for an owner. */
export interface PendingApproval {
  id: string;
  capability: string;
  summary: string;
  principal: string;
  args: unknown;
  why: string | null;
  review: string;
  requested_at: Timestamp;
  expires_at: Timestamp;
}


// ---------------------------------------------------------------------------
// what she organized and learned (phase G)

/** `GET /api/mind/digests`: older thoughts condensed. */
export interface ThoughtDigest {
  id: string;
  from: Timestamp;
  to: Timestamp;
  count: number;
  summary: string;
  intents: Record<string, number>;
  by: "summarizer" | "rule";
}

export type KnowledgeSubject =
  | { type: "person"; person: PersonId }
  | { type: "guild"; platform: PlatformId; guild: string }
  | { type: "self" }
  | { type: "topic"; name: string };

export type SourceKind = "self" | "inferred" | "said" | "panel";

export interface FieldSource {
  kind: SourceKind;
  account: AccountRef | null;
  name: string | null;
  origin: string | null;
  confidence: number;
  at: Timestamp;
}

export interface KnowledgeVersion {
  version: number;
  at: Timestamp;
  by: SourceKind;
  name: string | null;
  why: string;
  ops: string[];
}

/** One of her documents: a fixed envelope around content of whatever shape she chose. */
export interface KnowledgeDoc {
  id: string;
  subject: KnowledgeSubject;
  kind: string;
  title: string;
  content: Record<string, unknown>;
  /** JSON pointer → source. */
  sources: Record<string, FieldSource>;
  created_at: Timestamp;
  updated_at: Timestamp;
  version: number;
  history: KnowledgeVersion[];
  short_id: string;
  subject_label: string;
}

/** `GET /api/knowledge`. */
export interface KnowledgeView {
  documents: KnowledgeDoc[];
}

/** `GET /api/knowledge/conversations`: her running notes on a conversation. */
export interface ConversationNote {
  context: ContextKey;
  updated_at: Timestamp;
  folded_up_to: { id: string; ts: Timestamp } | null;
  folds: number;
  lines: number;
  recap: string;
  notes: Record<string, unknown>;
  label: string | null;
}

export interface Lesson {
  id: string;
  text: string;
  person: PersonId | null;
  scope: string | null;
  talk: number | null;
  created_at: Timestamp;
  expires_at: Timestamp | null;
  source: string;
  display_name: string | null;
}

export interface FeedbackTally {
  subject: string;
  label: string;
  reactions_pos: number;
  reactions_neg: number;
  replies: number;
  started: number;
  answered: number;
  ignored: number;
  positive: number;
  negative: number;
  denied: number;
  examples: string[];
}

export interface ReflectionRun {
  id: string;
  at: Timestamp;
  kind: "daily" | "light";
  context: ContextKey | null;
  summary: string;
  insights: number;
  superseded: number;
  lessons: string[];
  goals: string[];
  documents: string[];
  feelings: string[];
  error: string | null;
  tokens: number | null;
  ms: number;
}

/** `GET /api/reflection?days=7`. */
export interface ReflectionView {
  stats: {
    calls_today: number;
    max_calls_per_day: number;
    last_daily_at: Timestamp | null;
    last_light_at: Timestamp | null;
    idle_reason: string | null;
  };
  runs: ReflectionRun[];
  lessons: Lesson[];
  feedback: FeedbackTally[];
}

// ---------------------------------------------------------------------------
// live controls and telemetry (`packages/api/src/control.ts`, `telemetry.ts`)

/** What a control route's capability said it did. */
export interface ControlResult {
  text: string;
}

export type SongState = "preparing" | "ready" | "playing" | "done" | "failed" | "cancelled";

/** One song of her set list. */
export interface SongView {
  no: number;
  /** What was asked for (a name or a link). */
  query: string;
  title: string | null;
  artist: string | null;
  duration_s: number | null;
  /** Transposition in semitones. */
  key: number;
  requester_name: string;
  state: SongState;
  /** Worker stage while preparing (`download`, `separate`, `convert`, ...). */
  stage: string;
  /** 0..1 while preparing. */
  progress: number;
  error: string | null;
  forced: boolean;
  created_at: Timestamp;
  ready_at: Timestamp | null;
}

/** `GET /api/songs`. */
export interface SongsState {
  playing: number | null;
  /** Why speech is paused (a song job has the GPU). */
  paused: string | null;
  songs: SongView[];
}

export interface TelemetryLlm {
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_prompt_tokens: number;
  cost_usd: number;
  errors: number;
  /** Cumulative counts at each finite upper bound (seconds). */
  first_token: { count: number; sum_s: number; buckets: { le_s: number; count: number }[] };
}

/** One minute's sample. Counters are process totals; `events` count since the previous sample. */
export interface TelemetryPoint {
  at: Timestamp;
  mood: Mood | null;
  boredom: number | null;
  drives: Record<DriveName, number> | null;
  initiative: number | null;
  llm: TelemetryLlm;
  mind: { calls_total: number; tokens_total: number } | null;
  voice_sessions: number;
  speaking: boolean;
  /** `messages`, `turns`, `initiatives`, `utterances`, `actions`. */
  events: Record<string, number>;
}

/** `GET /api/telemetry?minutes=`. */
export interface TelemetryView {
  interval_ms: number;
  points: TelemetryPoint[];
}

export interface GameStartRequest {
  game?: string;
  goal?: string;
  stream?: boolean;
}

// ---------------------------------------------------------------------------
// body, arbiter, affect, plan, prompts (`packages/api/src/{body,affect,plan,prompts}.ts`)

export type TaskId = string;
export type Handle = string;

export type ActivityResource = "presence" | "broadcast" | "activity";
export type ActivityType = "idle" | "chatting" | "singing" | "game" | "browse";
export type ActivityPhase = "starting" | "running" | "stopping" | "failed";

export type HerPresence =
  | { type: "none" }
  | { type: "joining" | "in" | "leaving"; channel: ContextKey; task?: TaskId; since: Timestamp };

export type HerBroadcast =
  | { type: "off" }
  | {
      type: "starting" | "live" | "stopping";
      guild: string;
      golive: boolean;
      obs: boolean;
      task: TaskId | null;
      since: Timestamp;
    };

export interface ActivityFailure {
  code: string;
  detail: string;
  at: Timestamp;
}

export type HerActivity =
  | { type: "idle"; since: Timestamp }
  | {
      type: Exclude<ActivityType, "idle">;
      target: string | null;
      phase: ActivityPhase;
      task: TaskId | null;
      failure: ActivityFailure | null;
      since: Timestamp;
    };

export interface SceneOverride {
  scene: string;
  until: Timestamp;
  by: string;
}

/** `GET /api/activity` (and the payload of `activity.changed`). */
export interface ActivitySnapshot {
  version: number;
  at: Timestamp;
  presence: HerPresence;
  broadcast: HerBroadcast;
  activity: HerActivity;
  override: SceneOverride | null;
  scene: string | null;
}

export type ActivityRequest =
  | { type: "ensure_voice"; platform: string; guild: string; channel: string | null; follow: AccountRef | null }
  | { type: "leave_voice" }
  | { type: "ensure_live"; platform: string; guild: string; source: string | null }
  | { type: "stop_live" }
  | { type: "start"; activity: Exclude<ActivityType, "idle">; target: string | null; goal: string | null }
  | { type: "stop"; activity: Exclude<ActivityType, "idle"> | null }
  | { type: "scene_override"; scene: string; duration_ms: number }
  | { type: "clear_override" };

/** `GET /api/activity/tasks`, newest first. */
export interface ActivityTask {
  id: TaskId;
  resource: ActivityResource;
  request: ActivityRequest;
  by: string;
  turn: TurnId | null;
  context: ContextKey | null;
  status: "queued" | "running" | "done" | "failed";
  created_at: Timestamp;
  ended_at: Timestamp | null;
  failure: ActivityFailure | null;
  detail: string | null;
}

export type LedgerKind = "impulse" | "turn" | "task" | "notice";
export type LedgerOutcome = "pending" | "ok" | "ignored" | "failed" | "denied";

export interface LedgerEntry {
  id: string;
  at: Timestamp;
  kind: LedgerKind;
  source: string;
  self_initiated: boolean;
  context: ContextKey | null;
  person: Handle | null;
  summary: string;
  outcome: LedgerOutcome;
  detail: string | null;
  impulse: string | null;
  turn: TurnId | null;
  task: TaskId | null;
  updated_at: Timestamp;
}

export interface LedgerLimits {
  initiatives_today: number;
  initiative_cap: number | null;
  unanswered_streak: number;
  next_initiative_at: Timestamp | null;
  quiet_hours: { start_hour: number; end_hour: number; active: boolean } | null;
  paused: boolean;
  blocked: { capability: string; reason: string; until: Timestamp | null }[];
}

export interface RaisedTopic {
  /** What she said (her words, short). */
  text: string;
  context: ContextKey | null;
  at: Timestamp;
  status: "waiting" | "engaged" | "ignored";
}

/** `GET /api/arbiter/ledger`. */
export interface LedgerView {
  at: Timestamp;
  entries: LedgerEntry[];
  limits: LedgerLimits;
  unanswered: RaisedTopic[];
}

export type ArbiterVerdict = "accepted" | "merged" | "deferred" | "rejected" | "preempted" | "expired";

export type ArbiterReason =
  | "budget"
  | "rate"
  | "cooldown"
  | "quiet_hours"
  | "consent"
  | "paused"
  | "ceiling"
  | "busy"
  | "unanswered"
  | "superseded"
  | "expired"
  | "denied";

/** One verdict of `GET /api/arbiter/decisions` (`data.decisions`). */
export interface ArbiterDecisionView {
  impulse: string;
  source: string;
  verdict: ArbiterVerdict;
  reason: ArbiterReason | null;
  detail: string;
  retry_at: Timestamp | null;
  merged_into: string | null;
  turn: TurnId | null;
  task: TaskId | null;
  at: Timestamp;
  context: ContextKey | null;
  summary: string | null;
}

export interface ArbiterDecisionsView {
  decisions: ArbiterDecisionView[];
}

export type EmotionName =
  | "joy"
  | "anger"
  | "sorrow"
  | "fear"
  | "surprise"
  | "disgust"
  | "shy"
  | "pride"
  | "jealousy"
  | "lonely"
  | "missing"
  | "gratitude"
  | "guilt"
  | "frustration";

export type AffectDriveName = DriveName | "esteem" | "hunger" | "longing";

export interface EmotionReading {
  name: EmotionName;
  intensity: number;
  cause: string;
  at: Timestamp;
  person: PersonId | null;
}

export interface ShownEmotion {
  from: EmotionName;
  tag: string;
  style: string;
  masked: boolean;
}

export interface AffectBiases {
  talkativeness: number;
  initiative: number;
  wants: { want: string; weight: number; person: Handle | null; why: string }[];
}

/** `GET /api/affect`. */
export interface AffectSnapshot {
  at: Timestamp;
  drives: Partial<Record<AffectDriveName, number>>;
  boredom: number;
  top: EmotionReading[];
  mood: Mood;
  mood_line: string;
  shown: ShownEmotion | null;
  biases: AffectBiases;
}

export type RelationshipLabel = "很討厭" | "討厭" | "陌生人" | "認識" | "朋友" | "好朋友" | "摯友";

/** `GET /api/affect/people`, highest attachment first. */
export interface PersonCard {
  person: PersonId;
  handle: Handle;
  call_name: string | null;
  affinity: number;
  trust: number;
  familiarity: number;
  attachment: number;
  emotions: Partial<Record<"missing" | "jealousy" | "gratitude" | "resentment", number>>;
  feeling: string;
  label: RelationshipLabel;
  owner: boolean;
  blocked: boolean;
  last_seen: Timestamp | null;
  last_together: Timestamp | null;
  updated_at: Timestamp;
}

export type GoalTrigger =
  | { kind: "at"; time: Timestamp }
  | { kind: "when_online"; person: Handle }
  | { kind: "after_activity"; activity: string }
  | { kind: "whenever" };

export type GoalStatus = "pending" | "active" | "done" | "dropped";

export interface Goal {
  id: string;
  what: string;
  why: string;
  trigger: GoalTrigger;
  steps: string[];
  status: GoalStatus;
  expires: Timestamp;
  person: Handle | null;
  context: ContextKey | null;
  source: "plan" | "plan_daily" | "reflect" | "panel";
  created_at: Timestamp;
  updated_at: Timestamp;
  closed_at: Timestamp | null;
  close_reason: string | null;
}

/** `GET /api/mind/goals`. */
export interface GoalsView {
  goals: Goal[];
  closed_included: boolean;
}

/** `GET /api/mind/plan`. */
export interface DayPlanView {
  day_plan: string | null;
}

export type ReasoningLevel = string;

export interface CompiledBlock {
  key: string;
  authority: string;
  source: string;
  chars_in: number;
  chars_out: number;
  budget_chars: number;
  fate: "kept" | "summarized" | "truncated" | "dropped";
}

/** `GET /api/prompts/{turn}`. */
export interface SavedPrompt {
  turn: TurnId;
  context: ContextKey;
  at: Timestamp;
  purpose: string;
  reasoning: ReasoningLevel;
  blocks: CompiledBlock[];
  messages: { role: "system" | "user" | "assistant"; text: string }[];
  prompt_tokens: number | null;
}

/** `GET /api/prompts` items. */
export interface PromptSummary {
  turn: TurnId;
  context: ContextKey;
  at: Timestamp;
  purpose: string;
  reasoning: ReasoningLevel;
  prompt_tokens: number | null;
  blocks: number;
  messages: number;
  chars: number;
}

export type TurnReason = "addressed" | "reply_to_her" | "ambient" | "initiative" | "notice";

export type TurnCancelCause = "input" | "barge_in" | "superseded" | "expired" | "floor" | "shutdown";

export type TurnOutcome =
  | { type: "sent"; parts: number }
  | { type: "silence" }
  | { type: "cancelled"; cause: TurnCancelCause; by: Handle | null }
  | { type: "error"; error: string };

export type TurnOutcomeKind = TurnOutcome["type"];

/** `GET /api/turns/outcomes` items, newest first. */
export interface TurnOutcomeRecord {
  turn: TurnId;
  context: ContextKey;
  reason: TurnReason;
  outcome: TurnOutcome;
  addressed_by: Handle[];
  focus: MessageRef[];
  restarts: number;
  reasoning: ReasoningLevel | null;
  latency_ms: number | null;
  at: Timestamp;
}

// ---------------------------------------------------------------------------
// The fact layer (`GET /api/facts/*`; `packages/types` log-event.ts)

export type LogEventKind =
  | "observation"
  | "thought"
  | "decision"
  | "utterance"
  | "delivered"
  | "action"
  | "result"
  | "steer"
  | "directive"
  | "proposal";

/** One line of the EventLog. */
export interface LogEvent {
  id: Ulid;
  at: Timestamp;
  kind: LogEventKind;
  /** What wrote it: `voice.asr`, `game.minecraft`, `plan`, ... */
  source: string;
  /** The event that caused this one. */
  cause: Ulid | null;
  context: ContextKey | null;
  person: string | null;
  body: unknown;
}

/** `body` of a `steer` line: the request (`phase: "request"`) or how it went (`"outcome"`). */
export type SteerBody = SteerRequestBody | SteerOutcomeBody;

export interface SteerRequestBody {
  phase: "request";
  /** The executor's topic prefix. */
  owner: string;
  task: Ulid;
  /** The goal arguments to change. */
  patch: Record<string, unknown>;
  /** Why she steers, in her words. */
  why: string;
  /** The kind of principal that asked (`self`: the main line). */
  by: string;
}

export type SteerOutcome = "applied" | "rejected" | "too_late";

export interface SteerOutcomeBody {
  phase: "outcome";
  task: Ulid;
  steer: Ulid;
  outcome: SteerOutcome;
  detail: string;
}

/** `body` of a `thought` line from the mind (source `mind`). */
export interface MindThoughtBody {
  thought: string;
  changes: string[];
  intents: ThoughtIntent[];
  error: string | null;
}

/** `body` of a `thought` line from the game director (source `game.director`). */
export interface DirectorThoughtBody {
  game: string;
  trigger: string[];
  goal: string | null;
  action: string | null;
  verdict: string | null;
  commentary: string | null;
  busy: boolean | null;
  /** What she saw when she decided (an older Core does not write it). */
  observation?: string;
  /** The goal's success condition: she holds at least `count` of `item`. */
  want?: { item: string; count: number } | null;
  /** Methods and goals on hold at the time, one line each: the ones that failed the same way twice. */
  held?: string[];
}

export type ThoughtBody = MindThoughtBody | DirectorThoughtBody;

/** `GET /api/facts/events` query. */
export interface FactEventsQuery {
  kind?: LogEventKind[];
  /** Comma list on the wire. */
  source?: string[];
  /** One turn's lines and what they caused (a Core before this ignores it). */
  turn?: string;
  since?: Timestamp;
  until?: Timestamp;
  /** Events older than this id (paging newest first). */
  before?: Ulid;
  order?: "asc" | "desc";
  limit?: number;
}

/** `GET /api/facts/events/:id/chain`: the causes, oldest first, the event asked for last. */
export interface CauseChain {
  events: LogEvent[];
  /** False when an ancestor is gone or the walk hit its limit. */
  complete: boolean;
}

// ---------------------------------------------------------------------------
// the owner's rules (`GET /api/directives`; `packages/types` directive.ts)

export type DirectiveEffect = "deny" | "require_approval" | "prefer" | "avoid";

export type DirectiveAuthority = "owner" | "moderator" | "system" | "viewer";

export interface DirectiveScope {
  /** A capability or tool name, or a pattern (`game.*`, `*`). */
  capability?: string;
  /** A word of what is being done: the game (`minecraft`), a goal, a target. */
  activity?: string;
  context?: ContextKey;
  person?: Handle;
}

/** A stored rule and how it ended, if someone ended it. */
export interface DirectiveRecord {
  id: string;
  issuer: AccountRef;
  authority: DirectiveAuthority;
  scope: DirectiveScope;
  effect: DirectiveEffect;
  text: string;
  /** `until_revoked` never expires. */
  expires: Timestamp | "until_revoked";
  /** An EventLog id, `msg:<id>`, `command:<path>` or `panel:<actor>`. */
  source_event: string;
  created_at: Timestamp;
  revoked_at: Timestamp | null;
  revoked_by: string | null;
}

/** `GET /api/directives`: `healthy` is false while the store cannot be read (everything fails closed). */
export interface DirectivesView {
  healthy: boolean;
  directives: DirectiveRecord[];
}

/** `POST /api/directives`. `minutes` left out: until revoked (a moderator has to say). */
export interface AddDirectiveRequest {
  text: string;
  effect: DirectiveEffect;
  scope?: { capability?: string; activity?: string };
  minutes?: number | null;
}

/** The answer of a change: a `question` means nothing happened and the Core needs more. */
export type DirectiveChange =
  | { status: "added"; directive: DirectiveRecord; note: string | null }
  | { status: "removed"; directive: DirectiveRecord }
  | { status: "question"; question: string };

/** One delivered line (`GET /api/facts/deliveries`), newest first; `answered_by` is who answered in the window. */
export interface Delivery {
  attention_key: string;
  revision: number;
  channel: "voice" | "text";
  context: ContextKey;
  said: string;
  delivered_at: Timestamp;
  audience: Handle[];
  answered_by: Handle[];
  /** Its `utterance` event. */
  line: Ulid;
}

// ---- turn metrics (`GET /api/turns/metrics`, mirrors packages/api/src/metrics-turns.ts) -------

/** `sent / total`; `rate` is `null` with no samples, never 0. */
export interface MetricRatio {
  sent: number;
  total: number;
  rate: number | null;
}

export interface FollowupStopReasons {
  anti_spam: number;
  low_score: number;
  lost_roll: number;
  floor: number;
  passed_silent: number;
  other: number;
}

export interface TurnMetricsBucket {
  turns: number;
  followup: MetricRatio;
  ambient: MetricRatio;
  addressed: MetricRatio;
  voice_latency: { p50_ms: number | null; p90_ms: number | null; samples: number };
  voice_origin: { self_started: number; answering: number };
  outcomes: { sent: number; silence: number; cancelled: number; error: number };
  followup_stopped: FollowupStopReasons;
}

export interface TurnMetricsDay extends TurnMetricsBucket {
  /** Local date, `YYYY-MM-DD`. */
  day: string;
}

export interface TurnMetrics {
  days: number;
  from: string;
  /** The read cap was hit inside the window: its oldest day may be partial. */
  truncated: boolean;
  overall: TurnMetricsBucket;
  daily: TurnMetricsDay[];
}
