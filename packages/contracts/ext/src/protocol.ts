// What the extension protocol carries that is not a message shape: the version, the JSON-RPC
// error codes, the method that cancels a request, and the bounds both sides hold each other to
// (docs/protocols/extension-rpc.md).

/**
 * The protocol version: the host sends it in `initialize`, the extension answers with its own.
 * Each side refuses the other when the two differ; there is no fallback to an older version.
 * Version 2 carries the bus envelope in `event` and a registered type in `events.publish`.
 */
export const EXT_PROTOCOL_VERSION = 2;

/**
 * Notification `{ id }` a caller sends when it stops waiting for a request (it timed out or was
 * aborted); the other side may stop the work. LSP's name for the same thing.
 */
export const EXT_CANCEL_METHOD = "$/cancelRequest";

/**
 * JSON-RPC error codes. The first five are the standard ones; `Cancelled` is LSP's. The rest are
 * the protocol's own. `Timeout` and `Closed` are made by the caller and never sent.
 */
export const EXT_ERROR_CODE = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** The extension lacks the permission for this call. */
  PermissionDenied: -32001,
  /** A request timed out. */
  Timeout: -32002,
  /** The name is already taken by someone else. */
  Conflict: -32003,
  /** A host service (tool registry, storage, ...) is not available. */
  Unavailable: -32004,
  /** The connection is closed. */
  Closed: -32005,
  /** The caller cancelled the request (`$/cancelRequest`). */
  Cancelled: -32800,
} as const;

/** Bounds of the protocol. */
export const EXT_LIMITS = {
  /** Largest accepted frame body, in bytes. A larger `Content-Length` ends the connection. */
  MAX_FRAME_BYTES: 16 * 1024 * 1024,
  /** Longest header block of a frame, in bytes, before its blank line. */
  MAX_HEADER_BYTES: 8192,
  /**
   * Bytes queued for writing beyond which a sender drops what it may drop (the host's `event`
   * notifications) instead of queueing more.
   */
  MAX_QUEUED_BYTES: 8 * 1024 * 1024,
  /** A tool's wire name: 1 to 64 ASCII letters, digits, `_`, `-` and `.`. */
  TOOL_NAME: /^[A-Za-z0-9_.-]{1,64}$/,
  /** A task goal's name: 1 to 40 of `a-z`, `0-9`, `_`, `-`. */
  GOAL_NAME: /^[a-z0-9_-]{1,40}$/,
  /** Task ids, steer ids and the task named by a steer: 1 to this many characters. */
  TASK_ID_MAX_LENGTH: 64,
  /** Largest `budget_s` of a task: one day. */
  TASK_BUDGET_MAX_S: 86_400,
  /** An executor's display name: 1 to this many characters. */
  EXECUTOR_NAME_MAX_LENGTH: 64,
  /** An executor declares at most this many goals. */
  EXECUTOR_GOALS_MAX: 64,
  /** A goal's description, at most this many characters. */
  GOAL_DESCRIPTION_MAX_LENGTH: 2000,
  /** An executor's guide, at most this many characters. */
  EXECUTOR_GUIDE_MAX_LENGTH: 8000,
  /** `TaskSteer.why`, at most this many characters. */
  STEER_WHY_MAX_LENGTH: 400,
  /** `TaskSteer.cause`, at most this many characters. */
  STEER_CAUSE_MAX_LENGTH: 64,
} as const;
