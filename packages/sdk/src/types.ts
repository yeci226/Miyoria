// Wire types of the Miyoria extension protocol (JSON form), derived from the schemas in
// `@miyoria/contracts/ext` and `@miyoria/contracts/wire`: there is one description of the
// protocol, and these are its names for extension authors. Where the inferred type would differ
// in a way an author notices from the shape this package always had (a field optional or
// required, `unknown` or JSON), the old shape is kept here and the difference is listed beside it.

import type {
  AnyEventDefinition,
  BusEnvelopeJson,
  DecisionTraceData,
  EventPayload,
  ModuleStateData,
} from "@miyoria/contracts/events";
import type {
  ExtArgKind,
  ExtArgSpec,
  ExtArgValue,
  ExtCommandReply,
  ExtCommandSpec,
  ExtEventNotification,
  ExtGoalDecl,
  ExtInitializeParamsIn,
  ExtInvocation,
  ExtParticipant,
  ExtPermissions,
  ExtPriority,
  ExtPromptRequest,
  ExtPromptSection,
  ExtResolvedUser,
  ExtRpcErrorObject,
  ExtRpcMessage,
  ExtToolCallContext,
  ExtToolDeclIn,
} from "@miyoria/contracts/ext";
import { EXT_ERROR_CODE, EXT_PROTOCOL_VERSION } from "@miyoria/contracts/ext";
import type {
  AccountRef,
  Attachment,
  Author,
  ContextKey,
  ContextKind,
  IncomingMessage,
  MessageRef,
  PlaybackState,
  Timestamp,
  VoiceParticipant,
  VoiceUtterance,
} from "@miyoria/contracts/wire";

// ---- ids and platform -------------------------------------------------------

/** ULID string. */
export type Ulid = string;

export type {
  AccountRef,
  Attachment,
  Author,
  ContextKey,
  ContextKind,
  IncomingMessage,
  MessageRef,
  PlaybackState,
  Timestamp,
  VoiceParticipant,
  VoiceUtterance,
};

export type Priority = ExtPriority;

// ---- events -----------------------------------------------------------------

export type ModuleStateKind = ModuleStateData["state"];
export type DecisionTrace = DecisionTraceData;

/** One version of one event type, as `Events` holds them (from `@miyoria/contracts/events`). */
export type { AnyEventDefinition, EventPayload };

/**
 * A bus event as the `event` notification delivers it (protocol 2): `type` is the dotted topic
 * (`voice.playback`), `data` the payload of that type at `v`, every other key present and `null`
 * when unset. `source` is the module that published it (`agent`, `ext.<id>`, ...).
 */
export type Envelope = BusEnvelopeJson;

/** An envelope of one definition's events: `data` is its payload (`is` narrows to it). */
export type EnvelopeOf<D extends AnyEventDefinition> = Omit<Envelope, "data"> & {
  data: EventPayload<D>;
};

/** Params of the `event` notification. */
export type EventNotification = ExtEventNotification;

/** What `ctx.events.publish` may say about an event besides its type and payload. */
export interface PublishOptions {
  /** The agent turn the event belongs to. */
  turn?: string | null;
  /** The event that caused this one: the `id` of an envelope the extension received. */
  parent?: string | null;
  /** Attention and dedupe key. */
  key?: string | null;
}

// ---- prompts ----------------------------------------------------------------

export type Participant = ExtParticipant;
export type PromptRequest = ExtPromptRequest;
export type PromptSection = ExtPromptSection;

// ---- tools ------------------------------------------------------------------

/** JSON Schema object (loosely typed). */
export type JsonSchema = Record<string, unknown>;

/**
 * `tools.register` params / `contributions.tools` entry. Kept from the old shape: `parameters`
 * is required and loosely typed (the contract gives it a default and types it as JSON).
 */
export type ToolDecl = Omit<ExtToolDeclIn, "parameters"> & { parameters: JsonSchema };

/** `context` of `tools.call`. */
export type ToolCallContext = ExtToolCallContext & {
  /**
   * Aborted when the host stops waiting for this call (`$/cancelRequest`: it timed out or the
   * turn was cancelled). Not on the wire; set by the SDK.
   */
  signal?: AbortSignal;
};

// ---- commands ---------------------------------------------------------------

export type ArgKind = ExtArgKind;
export type ArgSpec = ExtArgSpec;
export type CommandSpec = ExtCommandSpec;
export type ArgValue = ExtArgValue;
export type ResolvedUser = ExtResolvedUser;

/** `commands.invoke` params. */
export type Invocation = ExtInvocation;

/**
 * What a command returns. Kept from the old shape: `ephemeral` is a boolean when given
 * (the host also reads `null` as missing).
 */
export type CommandReply = Omit<ExtCommandReply, "ephemeral"> & {
  /** Defaults to the spec's `ephemeral`. */
  ephemeral?: boolean;
};

// ---- lifecycle --------------------------------------------------------------

export type Permissions = ExtPermissions;

/**
 * `initialize` params (host to extension). Kept from the old shape: `config` is a record of
 * `unknown`, and `extension.game` may be missing (an older host).
 */
export type InitializeParams = Omit<ExtInitializeParamsIn, "config"> & {
  config: Record<string, unknown>;
};

/**
 * `tasks.register` params / `contributions.executor`: what the extension's executor offers.
 * Kept from the old shape: every part is present when the SDK writes it, and a goal's
 * `parameters` is loosely typed.
 */
export type ExecutorDecl = {
  name: string;
  goals: Array<Omit<ExtGoalDecl, "parameters"> & { parameters: JsonSchema | null }>;
  guide: string | null;
  /** The executor implements `steer` (the host answers a steer without it as unsupported). */
  steer?: boolean;
};

export type Contributions = {
  tools: ToolDecl[];
  commands: CommandSpec[];
  prompts: string[];
  subscriptions: string[];
  /** The extension's task executor (`tasks.register`), if it has one. */
  executor?: ExecutorDecl | null;
};

/** `initialize` result (extension to host). */
export interface InitializeResult {
  /** The protocol version the extension speaks (`PROTOCOL_VERSION`). */
  protocol: number;
  contributions: Contributions;
}

// ---- JSON-RPC ---------------------------------------------------------------

export const ErrorCode = EXT_ERROR_CODE;

export type RpcErrorObject = ExtRpcErrorObject;
export type RpcMessage = ExtRpcMessage;

export const PROTOCOL_VERSION = EXT_PROTOCOL_VERSION;
