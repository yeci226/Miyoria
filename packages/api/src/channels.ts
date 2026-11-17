// The owner's per-channel levels (docs/design/autonomy.md §21): `GET /api/channels/levels` (the
// levels and the text channels she has seen recently or that have their own level) and `PUT
// /api/channels/level` (set or reset one, like `/channel mode`). Changing needs the same node as
// the command, `admin.channel.mode` (the bearer token has every right).

import {
  AgentHandleKey,
  CHANNEL_MODES,
  type ChannelMode,
  modeDescription,
  modeLabel,
  parseChannelMode,
} from "@miyoria/brain/agent";
import type {
  ChannelLevelsView,
  ChannelLevelView,
  SetChannelLevelRequest,
} from "@miyoria/contracts/api";
import { type ContextKey, contextKeyString, PlatformSinksKey, WorldStateKey } from "@miyoria/types";
import { os } from "./contract.js";
import { parseContextKeyString } from "./data.js";
import { ApiError } from "./errors.js";
import type { ApiContext, ApiState } from "./state.js";

const isText = (c: ContextKey) => c.kind === "channel" || c.kind === "thread";

function handleOf(state: ApiState) {
  return state.service(AgentHandleKey, "agent module");
}

async function levelView(state: ApiState, context: ContextKey): Promise<ChannelLevelView> {
  const handle = handleOf(state);
  let label: string | null = null;
  try {
    label = await state.labels.label(state.optional(PlatformSinksKey), context);
  } catch {
    label = null;
  }
  return {
    context,
    label,
    mode: handle.channelMode(context),
    custom: handle.channelModeOverride(context) !== null,
    default: handle.configuredChannelMode(context),
  };
}

async function levels(state: ApiState): Promise<ChannelLevelsView> {
  const handle = handleOf(state);
  const contexts = new Map<string, ContextKey>();
  for (const c of state.optional(WorldStateKey)?.snapshot().channels ?? []) {
    if (isText(c.context)) contexts.set(contextKeyString(c.context), c.context);
  }
  for (const [key] of handle.channelModeOverrides()) {
    const context = parseContextKeyString(key);
    if (context !== null && isText(context) && !contexts.has(key)) contexts.set(key, context);
  }
  return {
    levels: CHANNEL_MODES.map((mode) => ({
      mode,
      label: modeLabel(mode),
      description: modeDescription(mode),
    })),
    channels: await Promise.all([...contexts.values()].map((c) => levelView(state, c))),
  };
}

/** Needs `admin.channel.mode` (the route's permission). */
async function setLevel(
  state: ApiState,
  c: ApiContext,
  request: SetChannelLevelRequest,
): Promise<ChannelLevelView> {
  const context = { ...request.context, scope: request.context.scope ?? null } as ContextKey;
  if (!isText(context)) throw ApiError.badRequest("levels are for text channels");
  let mode: ChannelMode | null = null;
  if (request.mode !== null) {
    try {
      mode = parseChannelMode(request.mode);
    } catch (error) {
      throw ApiError.badRequest(error instanceof Error ? error.message : String(error));
    }
  }
  let failure: unknown = null;
  try {
    await handleOf(state).setChannelMode(context, mode);
  } catch (error) {
    // Applied in memory; only persisting failed.
    failure = error;
  }
  const target = contextKeyString(context);
  await state.audit(c, "channel.level", target, { mode }, failure === null);
  if (failure !== null) throw ApiError.badGateway(failure);
  return levelView(state, context);
}

/** The channel routes on the route table (`@miyoria/contracts/api`). */
export const channelRpc = {
  levels: os.channels.levels.handler(({ context }) => levels(context.state)),
  setLevel: os.channels.setLevel.handler(({ input, context }) =>
    setLevel(context.state, context.c, input.body),
  ),
};
