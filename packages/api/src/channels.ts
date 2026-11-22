// The owner's per-channel levels (docs/design/autonomy.md §21): `GET /api/channels/levels` (the
// levels and the text channels of one Space she has seen recently or that have their own level,
// and that Space's own level), `PUT /api/channels/level` (set or reset one channel, like `/channel
// mode`) and `PUT /api/channels/space-level` (a whole Space, like `/channel mode 範圍:整個伺服器`).
// `?space=` picks the Space (default: the primary, `adminSpace`); without Spaces (a store without
// identity) every channel she knows is listed, as before. Changing needs the same node as the
// command, `admin.channel.mode` (the bearer token has every right).

import {
  type AgentHandle,
  AgentHandleKey,
  CHANNEL_MODES,
  type ChannelMode,
  modeDescription,
  modeLabel,
  parseChannelMode,
  UnknownPlaceError,
} from "@miyoria/brain/agent";
import type {
  ChannelLevelsView,
  ChannelLevelView,
  SetChannelLevelRequest,
  SetSpaceLevelRequest,
  SpaceLevelView,
} from "@miyoria/contracts/api";
import {
  type ContextKey,
  contextKeyString,
  PlacesKey,
  PlatformSinksKey,
  type SpaceRef,
  WorldStateKey,
} from "@miyoria/types";
import { os } from "./contract.js";
import { parseContextKeyString } from "./data.js";
import { ApiError } from "./errors.js";
import { adminSpace } from "./space-param.js";
import { type ApiContext, type ApiState, actorOf } from "./state.js";

const isText = (c: ContextKey) => c.kind === "channel" || c.kind === "thread";

function handleOf(state: ApiState) {
  return state.service(AgentHandleKey, "agent module");
}

/** The Space a request is about: `?space=` or the primary; `null` without Spaces. */
function spaceOf(state: ApiState, requested?: string | null): SpaceRef | null {
  if (state.optional(PlacesKey) === undefined) return null;
  return adminSpace(state, requested);
}

/** A context of the Space, for reading its own level (any channel of it will do). */
function spaceContext(space: SpaceRef): ContextKey {
  return {
    platform: space.platform,
    scope: space.external_id,
    channel: space.external_id,
    kind: "channel",
  };
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

function spaceView(handle: AgentHandle, space: SpaceRef): SpaceLevelView {
  const context = spaceContext(space);
  const own = handle.spaceChannelMode(context);
  const fallback = handle.configuredSpaceMode(context);
  return {
    id: space.id,
    name: space.name,
    mode: own ?? fallback,
    custom: own !== null,
    default: fallback,
  };
}

async function levels(state: ApiState, requested?: string | null): Promise<ChannelLevelsView> {
  const handle = handleOf(state);
  const space = spaceOf(state, requested);
  const inSpace = (c: ContextKey) =>
    space === null || (c.platform === space.platform && c.scope === space.external_id);
  const contexts = new Map<string, ContextKey>();
  for (const c of state.optional(WorldStateKey)?.snapshot().channels ?? []) {
    if (isText(c.context) && inSpace(c.context)) {
      contexts.set(contextKeyString(c.context), c.context);
    }
  }
  for (const [key] of handle.channelModeOverrides(space?.id ?? null)) {
    const context = parseContextKeyString(key);
    if (context !== null && isText(context) && inSpace(context) && !contexts.has(key)) {
      contexts.set(key, context);
    }
  }
  return {
    levels: CHANNEL_MODES.map((mode) => ({
      mode,
      label: modeLabel(mode),
      description: modeDescription(mode),
    })),
    channels: await Promise.all([...contexts.values()].map((c) => levelView(state, c))),
    space: space === null ? null : spaceView(handle, space),
  };
}

function parseMode(raw: string | null): ChannelMode | null {
  if (raw === null) return null;
  try {
    return parseChannelMode(raw);
  } catch (error) {
    throw ApiError.badRequest(error instanceof Error ? error.message : String(error));
  }
}

/** Who changed it, for the place setting's record. */
function byOf(c: ApiContext): string {
  return `panel:${actorOf(c)}`;
}

/** Needs `admin.channel.mode` (the route's permission). */
async function setLevel(
  state: ApiState,
  c: ApiContext,
  request: SetChannelLevelRequest,
): Promise<ChannelLevelView> {
  const context = { ...request.context, scope: request.context.scope ?? null } as ContextKey;
  if (!isText(context)) throw ApiError.badRequest("levels are for text channels");
  const mode = parseMode(request.mode);
  let failure: unknown = null;
  try {
    await handleOf(state).setChannelMode(context, mode, { by: byOf(c) });
  } catch (error) {
    // Applied in memory; only persisting failed.
    failure = error;
  }
  const target = contextKeyString(context);
  await state.audit(c, "channel.level", target, { mode }, failure === null);
  if (failure !== null) throw ApiError.badGateway(failure);
  return levelView(state, context);
}

/** Needs `admin.channel.mode` (the route's permission). */
async function setSpaceLevel(
  state: ApiState,
  c: ApiContext,
  requested: string | undefined,
  request: SetSpaceLevelRequest,
): Promise<SpaceLevelView> {
  const space = spaceOf(state, requested);
  if (space === null) throw ApiError.notFound("她還沒有加入任何伺服器");
  const mode = parseMode(request.mode);
  const handle = handleOf(state);
  let failure: unknown = null;
  try {
    await handle.setChannelMode(spaceContext(space), mode, {
      scope: "space",
      by: byOf(c),
    });
  } catch (error) {
    failure = error;
  }
  await state.audit(c, "channel.level", `space:${space.id}`, { mode }, failure === null);
  if (failure instanceof UnknownPlaceError) throw ApiError.notFound("她還不認得這個伺服器");
  if (failure !== null) throw ApiError.badGateway(failure);
  return spaceView(handle, space);
}

/** The channel routes on the route table (`@miyoria/contracts/api`). */
export const channelRpc = {
  levels: os.channels.levels.handler(({ input, context }) =>
    levels(context.state, input?.query.space),
  ),
  setLevel: os.channels.setLevel.handler(({ input, context }) =>
    setLevel(context.state, context.c, input.body),
  ),
  setSpaceLevel: os.channels.setSpaceLevel.handler(({ input, context }) =>
    setSpaceLevel(context.state, context.c, input.query.space, input.body),
  ),
};
