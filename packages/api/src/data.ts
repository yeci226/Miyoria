// `/api/data/*`: every kind of data she has (the store's data categories, plus her tools
// workspace on disk), with export, delete and a factory reset. Owner only (`owner.data.manage`;
// the bearer token may do everything); the inventory itself is visible to every panel user.
//
// * `GET /api/data` → `DataInventoryView` (on the route table)
// * `GET /api/data/export?categories=a,b` → a JSON backup (all exportable categories without
//   `categories`), as an attachment (a plain route: it is a download)
// * `POST /api/data/wipe` `{ categories, confirm? }` → `DataWipeResult`; categories marked
//   `typed` need `confirm` = the profile id (on the route table)
// * `POST /api/data/backup` → the full backup as an attachment, with the one-time
//   `x-miyoria-backup-token` header a reset needs (a plain route: it is a download)
// * `POST /api/data/reset` `{ confirm, backup_token }` → `DataWipeResult` (on the route table)
//
// A delete stops the modules caching the data (`Supervisor.pause`), deletes in one transaction,
// starts them again, and clears what lives only in memory (the agent's channel overrides, the
// auth cache). The audit log is never deleted; every delete and reset is audited.

import { createHash, randomBytes } from "node:crypto";
import { AuthServiceKey, builtinRoles } from "@miyoria/auth";
import { AgentHandleKey } from "@miyoria/brain/agent";
import type { DataInventoryView, DataNote, DataWipeResult } from "@miyoria/contracts/api";
import { errorMessage, getLogger, SupervisorKey } from "@miyoria/runtime/kernel";
import {
  categoryModules,
  DATA_CATEGORIES,
  type DataCategoryId,
  type DataExport,
  dataCategory,
  isDataCategoryId,
  ProfileDataStoreKey,
  RESET_CATEGORIES,
  resolveCategories,
  SettingsStoreKey,
  type WipeCounts,
} from "@miyoria/store";
import {
  AuthorizerKey,
  type ContextKey,
  type JsonObject,
  type ProfileId,
  toTimestamp,
} from "@miyoria/types";
import { SandboxKey, type ScriptInfo } from "@miyoria/workspace/sandbox";
import { os } from "./contract.js";
import { ApiError } from "./errors.js";
import type { Route } from "./route.js";
import { type ApiContext, type ApiState, actorOf } from "./state.js";

const log = getLogger("api.data");

/** Lets a panel user export and delete her data (owners have it through `*`). */
export const NODE_DATA_MANAGE = "owner.data.manage";
/** Response header carrying the token a reset needs (`POST /api/data/backup`). */
export const BACKUP_TOKEN_HEADER = "x-miyoria-backup-token";
/** How long a backup token stays valid. */
export const BACKUP_TOKEN_TTL_MS = 15 * 60_000;

/** The tools workspace on disk (module `sandbox`), next to the store's categories. */
export const TOOLS_WORKSPACE = "tools_workspace";

export type DataViewId = DataCategoryId | typeof TOOLS_WORKSPACE;

interface BackupToken {
  profile: ProfileId;
  actor: string;
  expires: number;
  sha256: string;
}

/** Issued backup tokens, per running API (hash of the token → token). */
const TOKENS = new WeakMap<ApiState, Map<string, BackupToken>>();

function tokens(state: ApiState): Map<string, BackupToken> {
  let map = TOKENS.get(state);
  if (!map) {
    map = new Map();
    TOKENS.set(state, map);
  }
  return map;
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

// ---- permission -----------------------------------------------------------------------------

function canManage(state: ApiState, c: ApiContext): boolean {
  const principal = c.get("principal");
  if (!principal || principal.kind === "token") return true;
  const authorizer = state.optional(AuthorizerKey);
  return authorizer?.allows(principal.record.account, NODE_DATA_MANAGE) ?? false;
}

function requireManage(state: ApiState, c: ApiContext): void {
  if (!canManage(state, c)) {
    throw new ApiError(403, `managing her data needs \`${NODE_DATA_MANAGE}\``);
  }
}

// ---- inventory ------------------------------------------------------------------------------

async function scripts(state: ApiState): Promise<ScriptInfo[] | null> {
  const sandbox = state.optional(SandboxKey);
  if (!sandbox) return null;
  try {
    return await sandbox.tools.list();
  } catch (error) {
    log.warn({ error: errorMessage(error) }, "cannot list the tools workspace");
    return null;
  }
}

async function inventory(state: ApiState, c: ApiContext): Promise<DataInventoryView> {
  const store = state.service(ProfileDataStoreKey, "profile data store");
  const profile = state.profile();
  const found = await store.inventory(profile);
  const categories: DataInventoryView["categories"] = found.categories.map((inv) => {
    const c = dataCategory(inv.id);
    return {
      ...inv,
      shared: c.shared,
      kept: c.kept,
      exportable: c.exportable,
      confirm: c.confirm,
      requires: [...c.requires],
    };
  });
  const files = await scripts(state);
  if (files !== null) {
    // Before the kept categories, which close the list.
    const at = categories.findIndex((x) => x.kept);
    const count = files.length;
    categories.splice(at < 0 ? categories.length : at, 0, {
      id: TOOLS_WORKSPACE,
      count,
      updated_at: null,
      parts: [{ id: TOOLS_WORKSPACE, count, updated_at: null }],
      breakdown: null,
      shared: false,
      kept: false,
      exportable: true,
      confirm: "typed",
      requires: [],
    });
  }
  return { profile, at: found.at, can_manage: canManage(state, c), categories };
}

// ---- export ---------------------------------------------------------------------------------

function parseIds(raw: readonly string[]): DataViewId[] {
  const out: DataViewId[] = [];
  for (const id of raw) {
    const trimmed = id.trim();
    if (trimmed === "") continue;
    if (trimmed !== TOOLS_WORKSPACE && !isDataCategoryId(trimmed)) {
      throw ApiError.badRequest(`unknown data category \`${trimmed}\``);
    }
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

const storeIds = (ids: readonly DataViewId[]) =>
  ids.filter((id): id is DataCategoryId => id !== TOOLS_WORKSPACE);

/** The backup of `ids`: the store's rows plus, when asked, the tools workspace files. */
async function buildExport(state: ApiState, ids: readonly DataViewId[]): Promise<DataExport> {
  const store = state.service(ProfileDataStoreKey, "profile data store");
  const out = await store.export(state.profile(), storeIds(ids));
  if (ids.includes(TOOLS_WORKSPACE)) {
    const sandbox = state.optional(SandboxKey);
    const rows: JsonObject[] = [];
    for (const info of (await scripts(state)) ?? []) {
      const file = await sandbox?.tools.read(info.name);
      if (file) rows.push({ ...file.info, code: file.code });
    }
    out.parts[TOOLS_WORKSPACE] = rows;
    (out.categories as string[]).push(TOOLS_WORKSPACE);
  }
  return out;
}

function fileName(profile: ProfileId, what: string, at: number): string {
  const stamp = toTimestamp(at).slice(0, 19).replaceAll(":", "");
  return `${profile}-${what}-${stamp}.json`;
}

function attachment(text: string, name: string, extra: Record<string, string> = {}): Response {
  return new Response(text, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${name}"`,
      "cache-control": "no-store",
      ...extra,
    },
  });
}

/** Every exportable category (kept ones included) and the workspace, when there is one. */
async function allExportable(state: ApiState): Promise<DataViewId[]> {
  const ids: DataViewId[] = DATA_CATEGORIES.filter((c) => c.exportable).map((c) => c.id);
  if ((await scripts(state)) !== null) ids.push(TOOLS_WORKSPACE);
  return ids;
}

async function exportData(state: ApiState, c: ApiContext): Promise<Response> {
  requireManage(state, c);
  const raw = c.req.query("categories");
  const ids = raw === undefined ? await allExportable(state) : parseIds(raw.split(","));
  if (ids.length === 0) throw ApiError.badRequest("no categories to export");
  for (const id of storeIds(ids)) {
    if (!dataCategory(id).exportable) throw ApiError.badRequest(`\`${id}\` is not exportable`);
  }
  const backup = await buildExport(state, ids);
  const what = raw === undefined ? "all" : ids.length === 1 ? (ids[0] as string) : "data";
  await state.audit(c, "data.export", state.profile(), { categories: [...ids] }, true);
  return attachment(
    `${JSON.stringify(backup, null, 2)}\n`,
    fileName(backup.profile, what, state.now()),
  );
}

// ---- delete ---------------------------------------------------------------------------------

/** `platform:scope|dm:[voice:]channel` (`contextKeyString`) back into a context. */
export function parseContextKeyString(text: string): ContextKey | null {
  const parts = text.split(":");
  if (parts.length < 3) return null;
  const [platform, scope, ...rest] = parts as [string, string, ...string[]];
  const voice = rest[0] === "voice" && rest.length > 1;
  const channel = (voice ? rest.slice(1) : rest).join(":");
  if (platform === "" || scope === "" || channel === "") return null;
  if (scope === "dm") return { platform, scope: null, channel, kind: voice ? "voice" : "dm" };
  return { platform, scope, channel, kind: voice ? "voice" : "channel" };
}

/** Channel override keys of the profile, read before they are deleted. */
async function channelOverrides(state: ApiState, profile: ProfileId) {
  const store = state.optional(SettingsStoreKey);
  if (!store) return { modes: [], levels: [] };
  const keys = async (prefix: string) =>
    [...(await store.list(profile, prefix)).keys()].map((k) => k.slice(prefix.length));
  return { modes: await keys("channel_mode:"), levels: await keys("activeness:") };
}

/** Drops the in-memory copies of deleted data that no module restart clears. */
async function afterWipe(
  state: ApiState,
  deleted: readonly DataViewId[],
  channels: { modes: string[]; levels: string[] },
): Promise<DataNote[]> {
  const notes: DataNote[] = [];
  if (deleted.includes("channels")) {
    const handle = state.optional(AgentHandleKey);
    for (const [keys, clear] of [
      [channels.modes, (ctx: ContextKey) => handle?.setChannelMode(ctx, null)],
      [channels.levels, (ctx: ContextKey) => handle?.setActiveness(ctx, null)],
    ] as const) {
      for (const key of keys) {
        const ctx = parseContextKeyString(key);
        if (!ctx) continue;
        try {
          await clear(ctx);
        } catch (error) {
          log.warn({ key, error: errorMessage(error) }, "cannot clear a channel override");
        }
      }
    }
  }
  if (deleted.includes("roles")) {
    try {
      await state.optional(AuthServiceKey)?.reload();
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "cannot reload roles after a delete");
    }
  }
  if (deleted.includes("persona") || deleted.includes("module_state")) notes.push("restart_core");
  if (deleted.includes("voice_consent")) notes.push("consent_cache");
  return notes;
}

/** Deletes the workspace scripts; returns how many. */
async function wipeWorkspace(state: ApiState): Promise<number> {
  const sandbox = state.optional(SandboxKey);
  if (!sandbox) return 0;
  let n = 0;
  for (const info of await sandbox.tools.list()) {
    if (await sandbox.tools.remove(info.name)) n++;
  }
  return n;
}

/** Stops the caching modules, wipes in one transaction, starts them again, cleans up. */
async function runWipe(state: ApiState, ids: readonly DataViewId[]): Promise<DataWipeResult> {
  const store = state.service(ProfileDataStoreKey, "profile data store");
  const profile = state.profile();
  const categories = resolveCategories(storeIds(ids));
  const channels = categories.includes("channels")
    ? await channelOverrides(state, profile)
    : { modes: [], levels: [] };
  const modules = categoryModules(categories);
  if (ids.includes(TOOLS_WORKSPACE) && !modules.includes("sandbox")) modules.push("sandbox");
  const wipe = async () => {
    const counts = await store.wipe(profile, categories, { seedRoles: builtinRoles() });
    // Files are not part of the transaction: after it, so a failed wipe deletes nothing.
    if (ids.includes(TOOLS_WORKSPACE)) counts[TOOLS_WORKSPACE] = await wipeWorkspace(state);
    return counts;
  };
  const sup = state.optional(SupervisorKey);
  let counts: WipeCounts;
  let failed: string[] = [];
  if (sup) {
    const paused = await sup.pause(modules, wipe);
    counts = paused.value;
    failed = paused.failed;
  } else {
    counts = await wipe();
  }
  const deleted: DataViewId[] = [...categories];
  if (ids.includes(TOOLS_WORKSPACE)) deleted.push(TOOLS_WORKSPACE);
  const notes = await afterWipe(state, deleted, channels);
  return { deleted, counts, failed_modules: failed, notes };
}

function needsTyped(ids: readonly DataViewId[]): boolean {
  if (ids.includes(TOOLS_WORKSPACE)) return true;
  return resolveCategories(storeIds(ids)).some((id) => dataCategory(id).confirm === "typed");
}

/** Needs `owner.data.manage` (the route's permission). */
async function wipeData(
  state: ApiState,
  c: ApiContext,
  request: { categories: string[]; confirm?: string | null | undefined },
): Promise<DataWipeResult> {
  const ids = parseIds(request.categories);
  if (ids.length === 0) throw ApiError.badRequest("no categories to delete");
  for (const id of storeIds(ids)) {
    if (dataCategory(id).kept) throw ApiError.badRequest(`\`${id}\` is kept and cannot be deleted`);
  }
  if (ids.includes(TOOLS_WORKSPACE) && !state.optional(SandboxKey)) {
    throw ApiError.unavailable("sandbox module is not available");
  }
  const profile = state.profile();
  if (needsTyped(ids) && request.confirm?.trim() !== profile) {
    throw ApiError.badRequest("type the profile id in `confirm` to delete this");
  }
  let result: DataWipeResult;
  try {
    result = await runWipe(state, ids);
  } catch (error) {
    await state.audit(
      c,
      "data.delete",
      profile,
      { categories: [...ids], error: errorMessage(error) },
      false,
    );
    throw ApiError.internal(error);
  }
  log.info({ profile, deleted: result.deleted, counts: result.counts }, "data deleted");
  await state.audit(
    c,
    "data.delete",
    profile,
    { categories: [...result.deleted], counts: { ...result.counts } },
    true,
  );
  return result;
}

// ---- factory reset --------------------------------------------------------------------------

/** What a reset deletes: everything but the kept categories. */
async function resetIds(state: ApiState): Promise<DataViewId[]> {
  const ids: DataViewId[] = [...RESET_CATEGORIES];
  if ((await scripts(state)) !== null) ids.push(TOOLS_WORKSPACE);
  return ids;
}

async function backup(state: ApiState, c: ApiContext): Promise<Response> {
  requireManage(state, c);
  const profile = state.profile();
  const ids = (await resetIds(state)).filter(
    (id) => id === TOOLS_WORKSPACE || dataCategory(id).exportable,
  );
  // The audit log too: the backup is everything she had.
  const data = await buildExport(state, [...ids, "audit"]);
  const text = `${JSON.stringify(data, null, 2)}\n`;
  const token = randomBytes(32).toString("base64url");
  const map = tokens(state);
  const now = state.now();
  for (const [hash, t] of map) if (t.expires <= now) map.delete(hash);
  const digest = sha256(text);
  map.set(sha256(token), {
    profile,
    actor: actorOf(c),
    expires: now + BACKUP_TOKEN_TTL_MS,
    sha256: digest,
  });
  await state.audit(
    c,
    "data.backup",
    profile,
    { sha256: digest, bytes: Buffer.byteLength(text) },
    true,
  );
  return attachment(text, fileName(profile, "backup", now), { [BACKUP_TOKEN_HEADER]: token });
}

/** Needs `owner.data.manage` (the route's permission). */
async function reset(
  state: ApiState,
  c: ApiContext,
  request: { confirm: string; backup_token: string },
): Promise<DataWipeResult> {
  const profile = state.profile();
  if (request.confirm.trim() !== profile) {
    throw ApiError.badRequest("type the profile id in `confirm` to reset");
  }
  const map = tokens(state);
  const key = sha256(request.backup_token.trim());
  const issued = map.get(key);
  if (!issued || issued.expires <= state.now()) {
    map.delete(key);
    throw ApiError.conflict("download a backup first (`POST /api/data/backup`)");
  }
  if (issued.profile !== profile || issued.actor !== actorOf(c)) {
    throw ApiError.conflict("this backup was made for another profile or account");
  }
  // One reset per backup.
  map.delete(key);
  const ids = await resetIds(state);
  let result: DataWipeResult;
  try {
    result = await runWipe(state, ids);
  } catch (error) {
    await state.audit(
      c,
      "data.reset",
      profile,
      { backup: issued.sha256, error: errorMessage(error) },
      false,
    );
    throw ApiError.internal(error);
  }
  log.warn({ profile, counts: result.counts }, "factory reset");
  await state.audit(
    c,
    "data.reset",
    profile,
    { backup: issued.sha256, counts: { ...result.counts } },
    true,
  );
  return result;
}

/** The data routes on the route table (`@miyoria/contracts/api`). */
export const dataRpc = {
  inventory: os.data.inventory.handler(({ context }) => inventory(context.state, context.c)),
  wipe: os.data.wipe.handler(({ input, context }) =>
    wipeData(context.state, context.c, input.body),
  ),
  reset: os.data.reset.handler(({ input, context }) => reset(context.state, context.c, input.body)),
};

/** The downloads, which stay plain routes: they answer an attachment, not JSON. */
export function dataRoutes(state: ApiState): Route[] {
  return [
    { method: "GET", path: "/api/data/export", handler: (c) => exportData(state, c) },
    { method: "POST", path: "/api/data/backup", handler: (c) => backup(state, c) },
  ];
}
