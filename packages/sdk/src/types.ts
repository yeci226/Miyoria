// Wire types of the Miyoria extension protocol, mirroring the Rust types in
// `miyoria-types`, `miyoria-commands` and `miyoria-ext-host` (serde JSON
// form). Hand-written: keep in sync with `docs/protocols/extension-rpc.md`.

// ---- ids and platform -------------------------------------------------------

/** ULID string. */
export type Ulid = string;
/** RFC 3339 timestamp. */
export type Timestamp = string;

export interface AccountRef {
  platform: string;
  id: string;
}

export type ContextKind = "channel" | "thread" | "dm" | "voice";

export interface ContextKey {
  platform: string;
  /** Guild / server id; `null` for DMs. */
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

export type Priority = "system" | "direct" | "request" | "initiative" | "idle";

// ---- events -----------------------------------------------------------------

export type ModuleStateKind =
  | "disabled"
  | "starting"
  | "running"
  | "degraded"
  | "stopping"
  | "stopped"
  | "failed";

export interface DecisionTrace {
  turn: Ulid;
  context: ContextKey;
  respond: boolean;
  score: number;
  reasons: string[];
}

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

/** `miyoria_types::Event` (`{ type, data }`). */
export type Event =
  | { type: "platform_ready"; data: { platform: string; self_account: AccountRef } }
  | { type: "platform_message_created"; data: IncomingMessage }
  | { type: "platform_typing"; data: { context: ContextKey; account: AccountRef } }
  | { type: "agent_turn_started"; data: { turn: Ulid; context: ContextKey } }
  | { type: "agent_decision"; data: DecisionTrace }
  | { type: "agent_turn_completed"; data: { turn: Ulid; context: ContextKey; text: string } }
  | {
      type: "action_completed";
      data: {
        action: Ulid;
        turn: Ulid | null;
        ok: boolean;
        error: string | null;
        message: MessageRef | null;
      };
    }
  | { type: "voice_joined"; data: { context: ContextKey; participants: VoiceParticipant[] } }
  | { type: "voice_left"; data: { context: ContextKey; reason: string | null } }
  | { type: "voice_participants"; data: { context: ContextKey; participants: VoiceParticipant[] } }
  | { type: "voice_speaking"; data: { context: ContextKey; account: AccountRef; speaking: boolean } }
  | { type: "voice_utterance"; data: VoiceUtterance }
  | {
      type: "voice_playback";
      data: {
        context: ContextKey;
        turn: Ulid | null;
        state: PlaybackState;
        text: string;
        emotion?: string | null;
        heard_ms?: number | null;
        total_ms?: number | null;
        blocked?: string | null;
      };
    }
  | {
      type: "agent_initiative";
      data: { context: ContextKey; reason: string; hint: string; about: AccountRef[] };
    }
  | {
      type: "module_state_changed";
      data: { module: string; state: ModuleStateKind; reason: string | null };
    }
  | { type: "custom"; data: { topic: string; payload: unknown } };

/** Params of the `event` notification: the bus envelope plus its topic. */
export interface Envelope {
  /** Dotted topic, e.g. `platform.message.created` or a custom topic. */
  topic: string;
  id: Ulid;
  ts: Timestamp;
  /** Module that published it, e.g. `agent` or `ext.<id>`. */
  source: string;
  causation: Ulid | null;
  correlation: Ulid | null;
  event: Event;
}

// ---- prompts ----------------------------------------------------------------

export interface Participant {
  account: AccountRef;
  display_name: string;
  person: Ulid | null;
}

export interface PromptRequest {
  profile: string;
  turn: Ulid;
  context: ContextKey;
  participants: Participant[];
  speakers: AccountRef[];
  query: string;
  recent: string[];
  voice: boolean;
  now: Timestamp;
}

export interface PromptSection {
  key: string;
  /** Heading shown to the model (Traditional Chinese). */
  title: string;
  body: string;
  /** Lower comes first. */
  order: number;
}

// ---- tools ------------------------------------------------------------------

/** JSON Schema object (loosely typed). */
export type JsonSchema = Record<string, unknown>;

/** `tools.register` params / `contributions.tools` entry. */
export interface ToolDecl {
  /** May contain dots; the host registers it with `_` instead. */
  name: string;
  description: string;
  parameters: JsonSchema;
  permission?: string | null;
}

/** `context` of `tools.call`. */
export interface ToolCallContext {
  turn: Ulid;
  context: ContextKey;
  /** Author of the message that triggered the turn. */
  account: AccountRef;
  message: MessageRef;
  priority: Priority;
  /**
   * Aborted when the host stops waiting for this call (`$/cancelRequest`: it timed out or the
   * turn was cancelled). Not on the wire; set by the SDK.
   */
  signal?: AbortSignal;
}

// ---- commands ---------------------------------------------------------------

export type ArgKind =
  | { type: "string" }
  | { type: "integer" }
  | { type: "boolean" }
  | { type: "choice"; choices: string[] }
  | { type: "user" }
  | { type: "role" };

export interface ArgSpec {
  name: string;
  description: string;
  kind: ArgKind;
  required: boolean;
}

export interface CommandSpec {
  /** One to three lowercase words. */
  path: string[];
  description: string;
  args: ArgSpec[];
  /** Permission node; `""` = everyone. */
  permission: string;
  ephemeral: boolean;
}

export type ArgValue = string | number | boolean;

export interface ResolvedUser {
  display_name: string;
  platform_roles: string[];
  is_guild_admin: boolean;
}

/** `commands.invoke` params. */
export interface Invocation {
  path: string[];
  args: Record<string, ArgValue>;
  invoker: AccountRef;
  invoker_display_name: string;
  context: ContextKey;
  invoker_is_guild_admin: boolean;
  platform_roles?: string[];
  resolved_users?: Record<string, ResolvedUser>;
}

export interface CommandReply {
  text: string;
  /** Defaults to the spec's `ephemeral`. */
  ephemeral?: boolean;
}

// ---- lifecycle --------------------------------------------------------------

export interface Permissions {
  events: string[];
  tools: boolean;
  commands: boolean;
  network: string[];
  input: string[];
}

/** `initialize` params (host → extension). */
export interface InitializeParams {
  protocol: number;
  host: { name: string; version: string };
  /** `game`: the game id a declared game adapter owns (manifest `game`), else null / absent. */
  extension: { id: string; version: string; dir: string; game?: string | null };
  config: Record<string, unknown>;
  /** What the host grants (declared ∩ config override). */
  permissions: Permissions;
}

export interface Contributions {
  tools: ToolDecl[];
  commands: CommandSpec[];
  prompts: string[];
  subscriptions: string[];
  /** The extension's task executor (`tasks.register`), if it has one. */
  executor?: ExecutorDecl | null;
}

/** `tasks.register` params / `contributions.executor`: what the extension's executor offers. */
export interface ExecutorDecl {
  name: string;
  goals: { name: string; description: string; parameters: JsonSchema | null; budget_s: number | null }[];
  guide: string | null;
  /** The executor implements `steer` (the host answers a steer without it as unsupported). */
  steer?: boolean;
}

/** `initialize` result (extension → host). */
export interface InitializeResult {
  contributions: Contributions;
}

// ---- JSON-RPC ---------------------------------------------------------------

export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  PermissionDenied: -32001,
  Timeout: -32002,
  Conflict: -32003,
  Unavailable: -32004,
  Closed: -32005,
  /** The caller cancelled the request (`$/cancelRequest`, LSP's code). */
  Cancelled: -32800,
} as const;

export interface RpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export type RpcMessage =
  | { jsonrpc: "2.0"; id: number | string; method: string; params?: unknown }
  | { jsonrpc: "2.0"; method: string; params?: unknown }
  | { jsonrpc: "2.0"; id: number | string | null; result: unknown }
  | { jsonrpc: "2.0"; id: number | string | null; error: RpcErrorObject };

export const PROTOCOL_VERSION = 1;
