// Each module's settings and card (docs/design/v5-settings.md §3, §6), on the route table:
//
// * `GET /api/modules` adds each module's icon, section, whether it has settings, its card and a
//   save waiting for a guard (the card is asked of the running module with a 500 ms deadline and
//   kept 10 s)
// * `GET /api/modules/{id}`: one module with its card and what it depends on
// * `GET|PUT /api/modules/{id}/settings`, `GET .../settings/history`, `POST .../settings/revert`:
//   through Core's `ModuleSettingsKey`, the only validator; a save or revert needs
//   `admin.settings.<id>` besides write access, and is audited
// * `POST /api/modules/{id}/actions/{action}`: a card's quick action, through the actuator gate as
//   the panel when it names a capability, else the module's own `act`
// * `GET /api/places/rooms`: the channel picker's rooms (`PlaceDirectoryKey`)

import type {
  ModuleActionResult,
  ModuleCard,
  ModuleDetail,
  ModuleInfo,
  ModuleSettings,
  PlaceRooms,
  SaveSettingsRequest,
  SaveSettingsResult,
  SettingsHistory,
} from "@miyoria/contracts/api";
import { Economy2Key } from "@miyoria/economy";
import {
  CARD_MAX_ACTIONS,
  CARD_MAX_FACTS,
  errorMessage,
  getLogger,
  type ModuleCard as KernelCard,
  ModuleSettingsKey,
  type ModuleSettingsService,
  SettingsError,
  SupervisorKey,
  withTimeout,
} from "@miyoria/runtime/kernel";
import {
  type AccountRef,
  AuthorizerKey,
  type JsonValue,
  type ModuleId,
  PlaceDirectoryKey,
  type PlaceRoomKind,
  Principals,
} from "@miyoria/types";
import { os } from "./contract.js";
import { findModule } from "./core.js";
import { ApiError } from "./errors.js";
import { actAs } from "./ops.js";
import { type ApiContext, type ApiState, actorOf, toJson } from "./state.js";

const log = getLogger("api.settings");

/** How long a module's `card()` may take before the page goes without it. */
export const CARD_DEADLINE_MS = 500;
/** How long a card is kept. */
export const CARD_TTL_MS = 10_000;

/** The node that lets a session change one module's settings. */
export const settingsNode = (id: ModuleId) => `admin.settings.${id}`;

interface CachedCard {
  at: number;
  card: ModuleCard | null;
}

const cardCaches = new WeakMap<ApiState, Map<ModuleId, CachedCard>>();
/** Modules whose card failed, logged once each. */
const cardFailures = new Set<ModuleId>();

function settingsService(state: ApiState): ModuleSettingsService {
  return state.service(ModuleSettingsKey, "settings");
}

/** At most four facts and two actions, whatever a module returned. */
function trimCard(card: KernelCard): ModuleCard {
  return {
    facts: card.facts.slice(0, CARD_MAX_FACTS),
    ...(card.next ? { next: card.next } : {}),
    ...(card.last_error ? { last_error: card.last_error } : {}),
    ...(card.actions ? { actions: card.actions.slice(0, CARD_MAX_ACTIONS) } : {}),
  };
}

/** A running module's card, `null` when it has none, is not running or did not answer in time. */
async function cardOf(state: ApiState, id: ModuleId, fresh = false): Promise<ModuleCard | null> {
  const sup = state.service(SupervisorKey, "supervisor");
  const module = sup.module(id);
  const status = sup.list().find((m) => m.id === id);
  if (module?.card === undefined || status?.state !== "running") return null;
  let cache = cardCaches.get(state);
  if (cache === undefined) {
    cache = new Map();
    cardCaches.set(state, cache);
  }
  const kept = cache.get(id);
  if (!fresh && kept !== undefined && state.now() - kept.at < CARD_TTL_MS) return kept.card;
  let card: ModuleCard | null = null;
  try {
    const answer = await withTimeout(module.card(), CARD_DEADLINE_MS);
    if (answer === undefined) throw new Error(`no answer within ${CARD_DEADLINE_MS} ms`);
    card = trimCard(answer);
    cardFailures.delete(id);
  } catch (error) {
    if (!cardFailures.has(id)) {
      cardFailures.add(id);
      log.warn({ module: id, err: errorMessage(error) }, "a module's card failed");
    }
  }
  cache.set(id, { at: state.now(), card });
  return card;
}

/** `GET /api/modules`: the supervisor's list with what the system page draws each card with. */
export async function moduleCards(state: ApiState): Promise<ModuleInfo[]> {
  const sup = state.service(SupervisorKey, "supervisor");
  const settings = state.optional(ModuleSettingsKey);
  const list = sup.list();
  return Promise.all(
    list.map(async (m) => {
      const manifest = sup.module(m.id)?.manifest;
      let editable = false;
      try {
        editable = settings?.editable(m.id) ?? false;
      } catch {
        editable = false;
      }
      return {
        ...m,
        icon: manifest?.icon ?? null,
        category: manifest?.category ?? "system",
        settings: editable,
        card: await cardOf(state, m.id),
        pending: settings?.pending(m.id) ?? null,
      };
    }),
  );
}

async function moduleDetail(state: ApiState, id: ModuleId): Promise<ModuleDetail> {
  const sup = state.service(SupervisorKey, "supervisor");
  const status = findModule(sup.list(), id);
  const [info] = (await moduleCards(state)).filter((m) => m.id === id);
  const manifest = sup.module(id)?.manifest;
  return {
    ...status,
    ...info,
    required: sup.isRequired(id),
    requires: [...(manifest?.requires ?? [])],
    optional: [...(manifest?.optional ?? [])],
    dependents: sup.dependentsOf(id),
  };
}

/** The account behind a session request; `null` for the bearer token. */
function sessionAccount(c: ApiContext): AccountRef | null {
  const principal = c.get("principal");
  return principal?.kind === "session" ? principal.record.account : null;
}

/** Whether the request may change module `id`'s settings. */
function mayEdit(state: ApiState, c: ApiContext, id: ModuleId): boolean {
  const principal = c.get("principal");
  if (principal === undefined || principal.kind === "token") return true;
  if (!principal.write) return false;
  return state.optional(AuthorizerKey)?.allows(principal.record.account, settingsNode(id)) ?? false;
}

function requireEdit(state: ApiState, c: ApiContext, id: ModuleId): void {
  if (sessionAccount(c) === null) return;
  if (!mayEdit(state, c, id)) {
    throw new ApiError(403, `changing this module's settings needs \`${settingsNode(id)}\``);
  }
}

/** Who wrote a revision, as the config revisions keep it. */
function authorOf(c: ApiContext): string {
  const account = sessionAccount(c);
  return account === null ? "panel:token" : `panel:${account.platform}:${account.id}`;
}

/** An author in words. */
export function authorLabel(state: ApiState, by: string): string {
  if (by === "panel:token") return "管理 token";
  if (by === "runtime") return "開關";
  if (by === "cli") return "CLI";
  const m = /^panel:([^:]+):(.+)$/.exec(by);
  if (m) {
    const [, platform = "", id = ""] = m;
    return state.auth.sessions.nameOf({ platform, id }) ?? `面板 · ${id}`;
  }
  return by;
}

/** A `SettingsError` as the answer: 404, 400 with `problems`, or 409. */
function settingsFailure(error: unknown): unknown {
  if (!(error instanceof SettingsError)) return error;
  switch (error.kind) {
    case "unknown":
      return ApiError.notFound(error.message);
    case "conflict":
      return new ApiError(
        409,
        "別人剛改過這個模組的設定,重新載入後再改",
        {},
        {
          problems: [],
        },
      );
    default:
      return new ApiError(400, error.message, {}, { problems: error.problems });
  }
}

function moduleOf(state: ApiState, id: ModuleId): void {
  findModule(state.service(SupervisorKey, "supervisor").list(), id);
}

async function readSettings(state: ApiState, c: ApiContext, id: ModuleId): Promise<ModuleSettings> {
  moduleOf(state, id);
  let view: ReturnType<ModuleSettingsService["describe"]>;
  try {
    view = settingsService(state).describe(id);
  } catch (error) {
    throw settingsFailure(error);
  }
  return {
    ...view,
    updated: view.updated && { ...view.updated, by_label: authorLabel(state, view.updated.by) },
    can_edit: mayEdit(state, c, id),
    currency: state.optional(Economy2Key)?.currency ?? "魚幣",
  };
}

async function saveSettings(
  state: ApiState,
  c: ApiContext,
  id: ModuleId,
  body: SaveSettingsRequest,
): Promise<SaveSettingsResult> {
  moduleOf(state, id);
  requireEdit(state, c, id);
  const request = {
    expected: body.expected,
    // The contract checked every value is JSON.
    set: (body.set ?? {}) as Record<string, JsonValue>,
    reset: body.reset ?? [],
    note: body.note ?? null,
  };
  const detail = { set: Object.keys(request.set), reset: request.reset };
  try {
    const result = await settingsService(state).save(id, request, authorOf(c));
    await state.audit(c, "settings.save", id, toJson({ ...detail, ...result }), true);
    return result;
  } catch (error) {
    await state.audit(
      c,
      "settings.save",
      id,
      toJson({ ...detail, error: errorMessage(error) }),
      false,
    );
    throw settingsFailure(error);
  }
}

async function revertSettings(
  state: ApiState,
  c: ApiContext,
  id: ModuleId,
  version: number,
  expected: number,
): Promise<SaveSettingsResult> {
  moduleOf(state, id);
  requireEdit(state, c, id);
  try {
    const result = await settingsService(state).revert(id, version, expected, authorOf(c));
    await state.audit(c, "settings.revert", id, toJson({ version, ...result }), true);
    return result;
  } catch (error) {
    await state.audit(
      c,
      "settings.revert",
      id,
      toJson({ version, error: errorMessage(error) }),
      false,
    );
    throw settingsFailure(error);
  }
}

function history(
  state: ApiState,
  id: ModuleId,
  q: { limit?: string | undefined; before?: string | undefined },
): SettingsHistory {
  moduleOf(state, id);
  const limit = q.limit === undefined ? undefined : Number.parseInt(q.limit, 10);
  const before = q.before === undefined ? undefined : Number.parseInt(q.before, 10);
  const page = settingsService(state).history(id, {
    ...(limit === undefined ? {} : { limit }),
    ...(before === undefined ? {} : { before }),
  });
  return {
    items: page.items.map((item) => ({ ...item, by_label: authorLabel(state, item.by) })),
    next_before: page.next_before,
  };
}

async function cardAction(
  state: ApiState,
  c: ApiContext,
  id: ModuleId,
  actionId: string,
): Promise<ModuleActionResult> {
  const sup = state.service(SupervisorKey, "supervisor");
  findModule(sup.list(), id);
  const card = await cardOf(state, id, true);
  const action = card?.actions?.find((a) => a.id === actionId);
  if (action === undefined) throw ApiError.notFound(`\`${id}\` has no action \`${actionId}\` now`);
  if (action.capability !== undefined) {
    const outcome = await actAs(state, c, action.capability, action.args ?? {});
    await state.audit(
      c,
      "module.card_action",
      `${id}.${actionId}`,
      toJson({ error: outcome.error?.message }),
      outcome.error === null,
    );
    if (outcome.error) throw outcome.error;
    cardCaches.get(state)?.delete(id);
    return { text: outcome.text };
  }
  const module = sup.module(id);
  if (module?.act === undefined) throw ApiError.notFound(`\`${id}\` has no action \`${actionId}\``);
  try {
    await module.act(actionId, Principals.panel(actorOf(c), null));
  } catch (error) {
    await state.audit(
      c,
      "module.card_action",
      `${id}.${actionId}`,
      { error: errorMessage(error) },
      false,
    );
    throw ApiError.internal(error);
  }
  await state.audit(c, "module.card_action", `${id}.${actionId}`, {}, true);
  cardCaches.get(state)?.delete(id);
  return { text: action.label };
}

function rooms(
  state: ApiState,
  q: { kind?: PlaceRoomKind | undefined; space?: string | undefined },
): PlaceRooms {
  const directory = state.optional(PlaceDirectoryKey);
  if (directory === undefined || !directory.ready()) return { ready: false, rooms: [] };
  return {
    ready: true,
    rooms: directory.rooms({
      ...(q.kind === undefined ? {} : { kind: q.kind }),
      ...(q.space === undefined ? {} : { space: q.space }),
    }),
  };
}

/** The settings, card and place routes on the route table. */
export const settingsRpc = {
  get: os.modules.get.handler(({ input, context }) => moduleDetail(context.state, input.params.id)),
  settings: os.modules.settings.handler(({ input, context }) =>
    readSettings(context.state, context.c, input.params.id),
  ),
  saveSettings: os.modules.saveSettings.handler(({ input, context }) =>
    saveSettings(context.state, context.c, input.params.id, input.body),
  ),
  settingsHistory: os.modules.settingsHistory.handler(({ input, context }) =>
    history(context.state, input.params.id, input.query),
  ),
  revertSettings: os.modules.revertSettings.handler(({ input, context }) =>
    revertSettings(
      context.state,
      context.c,
      input.params.id,
      input.body.version,
      input.body.expected,
    ),
  ),
  cardAction: os.modules.cardAction.handler(({ input, context }) =>
    cardAction(context.state, context.c, input.params.id, input.params.action),
  ),
};

export const placesRpc = {
  rooms: os.places.rooms.handler(({ input, context }) => rooms(context.state, input.query)),
};
