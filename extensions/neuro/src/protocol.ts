// The Neuro Game SDK wire protocol, as written in API/SPECIFICATION.md of
// https://github.com/VedalAI/neuro-game-sdk (read at commit 0cad33ac, 2026-08-21).
//
// Game (client) -> us (server): startup, context, actions/register, actions/unregister,
// actions/force, action/result. Us -> game: startup (acknowledgement), action, speech_finished.
// The spec says unknown or malformed messages are silently ignored (no error reply, no
// disconnect), so `parseClientMessage` never throws and tells the caller why it gave up.

import { z } from "zod";

/** One JSON text frame is at most this long (the WebSocket server enforces it as `maxPayload`). */
export const MAX_FRAME_BYTES = 512 * 1024;

const GameName = z.string().min(1).max(200);

const Startup = z.object({ command: z.literal("startup"), game: GameName });

const Context = z.object({
  command: z.literal("context"),
  game: GameName,
  data: z.object({ message: z.string(), silent: z.boolean() }),
});

/** Actions are checked one by one (`parseAction`), so one bad action does not drop the others. */
const Register = z.object({
  command: z.literal("actions/register"),
  game: GameName,
  data: z.object({ actions: z.array(z.unknown()) }),
});

const Unregister = z.object({
  command: z.literal("actions/unregister"),
  game: GameName,
  data: z.object({ action_names: z.array(z.string()) }),
});

export const FORCE_PRIORITIES = ["low", "medium", "high", "critical"] as const;
export type ForcePriority = (typeof FORCE_PRIORITIES)[number];

const Force = z.object({
  command: z.literal("actions/force"),
  game: GameName,
  data: z.object({
    state: z.string().optional(),
    query: z.string(),
    ephemeral_context: z.boolean().optional(),
    priority: z.enum(FORCE_PRIORITIES).optional(),
    action_names: z.array(z.string()),
  }),
});

const Result = z.object({
  command: z.literal("action/result"),
  game: GameName,
  data: z.object({ id: z.string(), success: z.boolean(), message: z.string().optional() }),
});

const ClientMessage = z.discriminatedUnion("command", [
  Startup,
  Context,
  Register,
  Unregister,
  Force,
  Result,
]);

export type ClientMessage = z.infer<typeof ClientMessage>;
export type ClientCommand = ClientMessage["command"];

/** An action as the game declares it (`Action` of the spec). `schema` is `undefined` for `{}`. */
export interface GameAction {
  name: string;
  description: string;
  schema: Record<string, unknown> | undefined;
}

const RawAction = z.object({
  name: z.string().min(1).max(128),
  description: z.string(),
  schema: z.record(z.string(), z.unknown()).optional(),
});

/**
 * One `Action`: a name, a description, and a schema that is absent, `{}` or has `type: "object"`.
 * Anything else is not an action we can offer, so it is left out (`null`).
 */
export function parseAction(raw: unknown): GameAction | null {
  const parsed = RawAction.safeParse(raw);
  if (!parsed.success) return null;
  const { name, description, schema } = parsed.data;
  if (schema === undefined || Object.keys(schema).length === 0) {
    return { name, description, schema: undefined };
  }
  if (schema.type !== "object") return null;
  return { name, description, schema };
}

export type ParsedFrame =
  | { ok: true; message: ClientMessage }
  | { ok: false; reason: "binary" | "json" | "shape" | "unknown_command"; command?: string };

/** Never throws: the caller drops what is not ok, as the spec asks. */
export function parseClientMessage(
  raw: string | Buffer | ArrayBuffer | Buffer[],
  isBinary: boolean,
): ParsedFrame {
  // Neuro cannot handle binary frames either; the spec's advice is to never send them.
  if (isBinary) return { ok: false, reason: "binary" };
  let json: unknown;
  try {
    json = JSON.parse(raw.toString());
  } catch {
    return { ok: false, reason: "json" };
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return { ok: false, reason: "shape" };
  }
  const command = (json as { command?: unknown }).command;
  if (typeof command !== "string") return { ok: false, reason: "shape" };
  // `data` may be left out, `undefined` or `{}` for commands without data (only `startup`).
  const candidate =
    command === "startup" && (json as { data?: unknown }).data !== undefined
      ? { command, game: (json as { game?: unknown }).game }
      : json;
  const parsed = ClientMessage.safeParse(candidate);
  if (parsed.success) return { ok: true, message: parsed.data };
  const known = ClientMessage.options.some((o) => o.shape.command.value === command);
  return known
    ? { ok: false, reason: "shape", command }
    : { ok: false, reason: "unknown_command", command };
}

// ---- server -> game ----------------------------------------------------------

export interface StartupSession {
  sessionId: string;
  characterId: string;
  displayName: string;
}

export type ServerMessage =
  | { command: "startup"; data: { session: StartupSession } }
  | { command: "action"; data: { id: string; name: string; data?: string } }
  | {
      command: "speech_finished";
      data: { isFinal: boolean; cancelled?: boolean; reason?: string };
    };

export function startupAck(session: StartupSession): ServerMessage {
  return { command: "startup", data: { session } };
}

/** `data` is the JSON text of the arguments; left out when the action takes none. */
export function actionMessage(id: string, name: string, data?: string): ServerMessage {
  return { command: "action", data: data === undefined ? { id, name } : { id, name, data } };
}

export function speechFinished(
  isFinal: boolean,
  cancelled?: boolean,
  reason?: string,
): ServerMessage {
  const data: { isFinal: boolean; cancelled?: boolean; reason?: string } = { isFinal };
  if (cancelled) data.cancelled = true;
  if (cancelled && reason) data.reason = reason;
  return { command: "speech_finished", data };
}
