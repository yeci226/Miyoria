// `/api/data/*` against a real in-memory SQLite store: inventory, export, deletes with their
// confirmations and module pauses, the backup-before-reset rule and the factory reset.

import { ACTIVENESS_PREFIX, AgentHandleKey, MODE_PREFIX } from "@miyoria/agent";
import * as arbiter from "@miyoria/arbiter";
import { AuthService, AuthServiceKey } from "@miyoria/auth";
import {
  defineManifest,
  type Module,
  type ModuleContext,
  Supervisor,
  SupervisorKey,
} from "@miyoria/kernel";
import { USAGE_KEY_PREFIX, USAGE_PROFILE } from "@miyoria/llm";
import { MAINTENANCE_KEY, WATERMARK_PREFIX } from "@miyoria/memory";
import * as queue from "@miyoria/queue";
import { SandboxKey, type ScriptInfo, TOOL_KEY_PREFIX } from "@miyoria/sandbox";
import * as self from "@miyoria/self";
import { SETTINGS_KEY as MOOD_KEY } from "@miyoria/social";
import {
  AuditLogKey,
  AuthStoreKey,
  DATA_CATEGORIES,
  dataCategory,
  GLOBAL_SETTINGS_PROFILE,
  MessageLogKey,
  ProfileDataStoreKey,
  SettingsStoreKey,
  SqliteStore,
} from "@miyoria/store";
import {
  type ContextKey,
  contextKeyString,
  newId,
  PRIVACY_PREFIX,
  PRIVACY_PROFILE,
  toTimestamp,
} from "@miyoria/types";
import { CONSENT_PROFILE, consentKey } from "@miyoria/voice";
import { afterEach, describe, expect, it } from "vitest";
import {
  ActiveProfileKey,
  ApiModule,
  BACKUP_TOKEN_HEADER,
  type DataInventoryView,
  type DataWipeResult,
  parseContextKeyString,
  SESSION_STORE_PREFIX,
  SESSION_STORE_PROFILE,
} from "../src/index.js";
import { raw } from "./support/http.js";

const TOKEN = "test-token";
const P = "deepseek-chan";
const OWNER = { platform: "discord", id: "1" };
const ctx: ContextKey = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" };

/** Like the real mood module: saves what it cached on stop. */
class SavingMood implements Module {
  readonly manifest = defineManifest("mood", "mood stand-in");
  starts = 0;
  #ctx: ModuleContext | null = null;

  async start(ctx: ModuleContext): Promise<void> {
    this.starts++;
    this.#ctx = ctx;
  }

  async stop(): Promise<void> {
    await this.#ctx?.services.get(SettingsStoreKey)?.set(P, "mood:last", { valence: 0.9 });
  }
}

/** The tools workspace of a sandbox, in memory. */
function fakeSandbox() {
  const files = new Map<string, string>([["hello", "print('hi')"]]);
  const info = (name: string): ScriptInfo => ({
    name,
    language: "python",
    file: `${name}.py`,
    size: files.get(name)?.length ?? 0,
  });
  return {
    files,
    sandbox: {
      run: async () => {
        throw new Error("no runs here");
      },
      health: async () => ({ available: false }),
      tools: {
        list: async () => [...files.keys()].map(info),
        read: async (name: string) =>
          files.has(name) ? { info: info(name), code: files.get(name) ?? "" } : null,
        save: async () => {
          throw new Error("read-only");
        },
        remove: async (name: string) => files.delete(name),
      },
    },
  };
}

const sups: Supervisor[] = [];
const stores: SqliteStore[] = [];
afterEach(async () => {
  for (const s of sups.splice(0)) await s.stopAll();
  for (const s of stores.splice(0)) await s.close();
});

async function harness(options: { sandbox?: boolean } = {}) {
  const store = await SqliteStore.open(":memory:");
  stores.push(store);
  const sup = new Supervisor();
  sups.push(sup);
  const s = sup.services;
  const k = "kernel";
  s.provide(k, SupervisorKey, sup);
  s.provide(k, ActiveProfileKey, P);
  s.provide(k, ProfileDataStoreKey, store.profileData);
  s.provide(k, SettingsStoreKey, store.settings);
  s.provide(k, MessageLogKey, store.messages);
  s.provide(k, AuthStoreKey, store.auth);
  s.provide(k, AuditLogKey, store.audit);
  const auth = await AuthService.load(store.auth, store.audit, [OWNER], "user");
  s.provide("auth", AuthServiceKey, auth);
  const cleared: string[] = [];
  s.provide("agent", AgentHandleKey, {
    setChannelMode: async (c: ContextKey, mode: string | null) => {
      if (mode === null) cleared.push(`mode ${contextKeyString(c)}`);
    },
    setActiveness: async (c: ContextKey, level: string | null) => {
      if (level === null) cleared.push(`activeness ${contextKeyString(c)}`);
    },
  } as never);
  const workspace = fakeSandbox();
  if (options.sandbox) s.provide("sandbox", SandboxKey, workspace.sandbox as never);
  const mood = new SavingMood();
  await sup.register(mood, null, true);
  const api = new ApiModule({ env: () => undefined });
  await sup.register(api, { bind: "127.0.0.1:0", token: TOKEN, panel_dir: "" }, true);
  await sup.startAll();
  const base = api.url();
  if (!base) throw new Error("api is not running");

  // Some of everything.
  const now = toTimestamp(Date.UTC(2026, 10, 2));
  const owen = await store.people.upsertAccount({ platform: "discord", id: "2" }, "Owen");
  await store.memories.upsert({
    id: newId(),
    profile: P,
    kind: "fact",
    scope: { type: "global" },
    subjects: [owen],
    content: "Owen 喜歡拉麵",
    tokens: "owen 喜歡 拉麵",
    embedding: null,
    importance: 0.5,
    confidence: 0.8,
    created_at: now,
    updated_at: now,
    last_accessed: null,
    access_count: 0,
    source_context: null,
    source: null,
    due: null,
    done: false,
    superseded_by: null,
  });
  await store.messages.append({
    id: newId(),
    profile: P,
    context: ctx,
    author: { platform: "discord", id: "2" },
    author_name: "Owen",
    text: "嗨",
    is_self: false,
    ts: now,
    turn: null,
  });
  await store.settings.set(P, `${WATERMARK_PREFIX}${contextKeyString(ctx)}`, { id: "x" });
  await store.settings.set(P, "mood:last", { valence: 0.1 });
  await store.settings.set(P, `${MODE_PREFIX}discord:g1:c1`, "always");
  await store.settings.set(P, `${ACTIVENESS_PREFIX}discord:dm:voice:v1`, "high");
  await store.settings.set(GLOBAL_SETTINGS_PROFILE, "queue:state", { items: [] });
  await store.settings.set(GLOBAL_SETTINGS_PROFILE, "llm_usage:2026-11", { usd: 1 });
  await store.auth.upsertRole({ name: "vip", rank: 50, grants: ["x"], denies: [], builtin: false });
  await auth.reload();
  await auth.assign("test", { platform: "discord", id: "2" }, "vip", { type: "global" });
  await store.personaOverrides.set(P, "style", "新的口吻", "test");

  const call = (method: string, path: string, json?: unknown) =>
    raw(base, method, path, { token: TOKEN, ...(json !== undefined && { json }) });
  return { store, sup, base, call, auth, mood, cleared, workspace };
}

const inventoryOf = async (h: Awaited<ReturnType<typeof harness>>) =>
  (await h.call("GET", "/api/data")).body as DataInventoryView;

const countOf = (inv: DataInventoryView, id: string) =>
  inv.categories.find((c) => c.id === id)?.count;

describe("data routes", () => {
  it("list every category with counts, behind the token", async () => {
    const h = await harness();
    expect((await raw(h.base, "GET", "/api/data")).status).toBe(401);
    const inv = await inventoryOf(h);
    expect(inv.profile).toBe(P);
    expect(inv.can_manage).toBe(true);
    expect(inv.categories.map((c) => c.id)).toEqual(DATA_CATEGORIES.map((c) => c.id));
    expect(countOf(inv, "memories")).toBe(1);
    expect(countOf(inv, "messages")).toBe(2);
    expect(countOf(inv, "people")).toBe(2); // one person, one account
    expect(countOf(inv, "audit")).toBeGreaterThan(0);
    const people = inv.categories.find((c) => c.id === "people");
    expect(people).toMatchObject({ shared: true, confirm: "typed", kept: false });
    expect(people?.requires).toEqual([
      "relationships",
      "call_names",
      "inner",
      "knowledge",
      "learning",
    ]);
    expect(inv.categories.find((c) => c.id === "audit")?.kept).toBe(true);
    // Without a sandbox there is no tools workspace.
    expect(inv.categories.some((c) => c.id === "tools_workspace")).toBe(false);
  });

  it("export categories as an attachment", async () => {
    const h = await harness({ sandbox: true });
    const r = await h.call("GET", "/api/data/export?categories=memories,tools_workspace");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-disposition")).toMatch(/^attachment; filename="deepseek-chan-/);
    const body = r.body as {
      format: string;
      categories: string[];
      parts: Record<string, unknown[]>;
    };
    expect(body.format).toBe("miyoria.data");
    expect(body.categories).toEqual(["memories", "tools_workspace"]);
    expect(body.parts.memory_records).toHaveLength(1);
    expect(body.parts.tools_workspace).toEqual([
      { name: "hello", language: "python", file: "hello.py", size: 11, code: "print('hi')" },
    ]);
    expect((await h.call("GET", "/api/data/export?categories=nope")).status).toBe(400);
    expect((await h.call("GET", "/api/data/export?categories=panel_sessions")).status).toBe(400);
    const all = await h.call("GET", "/api/data/export");
    expect((all.body as { categories: string[] }).categories).toContain("audit");
    const audit = await h.store.audit.recent(10, "api");
    expect(audit.some((e) => e.action === "data.export" && e.ok)).toBe(true);
  });

  it("deletes need the typed profile id for anything that matters", async () => {
    const h = await harness();
    let r = await h.call("POST", "/api/data/wipe", { categories: ["messages"] });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toContain("profile id");
    r = await h.call("POST", "/api/data/wipe", { categories: ["messages"], confirm: "wrong" });
    expect(r.status).toBe(400);
    expect((await h.call("POST", "/api/data/wipe", { categories: ["audit"] })).status).toBe(400);
    expect((await h.call("POST", "/api/data/wipe", { categories: ["x"] })).status).toBe(400);
    expect(countOf(await inventoryOf(h), "messages")).toBe(2);

    // The log and its watermarks go together.
    r = await h.call("POST", "/api/data/wipe", { categories: ["messages"], confirm: ` ${P} ` });
    expect(r.status).toBe(200);
    const result = r.body as DataWipeResult;
    expect(result.deleted).toEqual(["conversation", "messages", "event_log"]);
    expect(result.counts).toEqual({
      message_log: 1,
      memory_watermarks: 1,
      conversation_states: 0,
      log_events: 0,
      log_event_rollups: 0,
    });
    expect((await h.store.settings.list(P, WATERMARK_PREFIX)).size).toBe(0);
    expect(countOf(await inventoryOf(h), "memories")).toBe(1);
    const audit = await h.store.audit.recent(10, "api");
    expect(audit.find((e) => e.action === "data.delete")).toMatchObject({ ok: true, target: P });
  });

  it("stops caching modules around a delete and clears live channel overrides", async () => {
    const h = await harness();
    // Simple categories need no typed id. `mood` saves on stop: paused first, it cannot write
    // the deleted state back.
    const r = await h.call("POST", "/api/data/wipe", { categories: ["mood", "channels"] });
    expect(r.status).toBe(200);
    expect(await h.store.settings.get(P, "mood:last")).toBeNull();
    expect(h.mood.starts).toBe(2);
    expect(h.cleared.sort()).toEqual(["activeness discord:dm:voice:v1", "mode discord:g1:c1"]);
  });

  it("resets roles to the built-ins and keeps the config owner", async () => {
    const h = await harness();
    const r = await h.call("POST", "/api/data/wipe", { categories: ["roles"], confirm: P });
    expect(r.status).toBe(200);
    expect((r.body as DataWipeResult).counts.role_assignments).toBe(1);
    expect(h.auth.role("vip")).toBeUndefined();
    expect(h.auth.role("owner")?.builtin).toBe(true);
    expect(h.auth.allows(OWNER, "owner.data.manage")).toBe(true);
    expect(h.auth.allows({ platform: "discord", id: "2" }, "owner.data.manage")).toBe(false);
  });

  it("factory reset only after a backup was downloaded", async () => {
    const h = await harness({ sandbox: true });
    let r = await h.call("POST", "/api/data/reset", { confirm: P, backup_token: "made-up" });
    expect(r.status).toBe(409);
    expect(countOf(await inventoryOf(h), "memories")).toBe(1);

    const backup = await h.call("POST", "/api/data/backup");
    expect(backup.status).toBe(200);
    const token = backup.headers.get(BACKUP_TOKEN_HEADER) ?? "";
    expect(token.length).toBeGreaterThan(40);
    const data = backup.body as { categories: string[]; parts: Record<string, unknown[]> };
    expect(data.categories).toEqual(
      expect.arrayContaining(["memories", "audit", "tools_workspace"]),
    );
    expect(data.parts.message_log).toHaveLength(1);

    // The profile id must still be typed.
    r = await h.call("POST", "/api/data/reset", { confirm: "nope", backup_token: token });
    expect(r.status).toBe(400);
    r = await h.call("POST", "/api/data/reset", { confirm: P, backup_token: token });
    expect(r.status).toBe(200);
    const result = r.body as DataWipeResult;
    expect(result.deleted).toContain("tools_workspace");
    expect(result.notes).toContain("restart_core");
    // One reset per backup.
    r = await h.call("POST", "/api/data/reset", { confirm: P, backup_token: token });
    expect(r.status).toBe(409);

    const inv = await inventoryOf(h);
    for (const c of inv.categories) {
      if (c.id === "audit" || c.id === "llm_usage") expect(c.count, c.id).toBeGreaterThan(0);
      else if (c.id === "roles") expect(c.count).toBe(7);
      else expect(c.count, c.id).toBe(0);
    }
    expect(h.workspace.files.size).toBe(0);
    expect(h.auth.allows(OWNER, "owner.data.manage")).toBe(true);
    const audit = (await h.store.audit.recent(50, "api")).map((e) => e.action);
    expect(audit).toEqual(expect.arrayContaining(["data.backup", "data.reset"]));
  });
});

describe("data categories", () => {
  it("name the settings keys their owners use", () => {
    const settings = DATA_CATEGORIES.flatMap((c) => c.parts).flatMap((p) =>
      p.kind === "settings" ? [{ profile: p.profile, names: [...p.keys, ...p.prefixes] }] : [],
    );
    const has = (profile: "active" | "global", name: string) =>
      settings.some((s) => s.profile === profile && s.names.includes(name));
    expect(has("active", WATERMARK_PREFIX)).toBe(true);
    expect(has("active", MAINTENANCE_KEY)).toBe(true);
    expect(has("active", MODE_PREFIX)).toBe(true);
    expect(has("active", ACTIVENESS_PREFIX)).toBe(true);
    expect(has("active", self.STATE_KEY)).toBe(true);
    expect(has("active", self.FEELING_PREFIX)).toBe(true);
    expect(has("active", MOOD_KEY)).toBe(true);
    expect(has("active", TOOL_KEY_PREFIX)).toBe(true);
    for (const [profile, name] of [
      [arbiter.STATE_PROFILE, arbiter.STATE_KEY],
      [queue.STATE_PROFILE, queue.STATE_KEY],
      [CONSENT_PROFILE, consentKey({ platform: "x", id: "y" }).replace(/x:y$/, "")],
      [PRIVACY_PROFILE, PRIVACY_PREFIX],
      [USAGE_PROFILE, USAGE_KEY_PREFIX],
      [SESSION_STORE_PROFILE, SESSION_STORE_PREFIX],
    ] as const) {
      expect(profile).toBe(GLOBAL_SETTINGS_PROFILE);
      expect(has("global", name), name).toBe(true);
    }
    expect(dataCategory("panel_sessions")).toMatchObject({ kept: true, exportable: false });
  });

  it("parse channel override keys back into contexts", () => {
    for (const c of [
      ctx,
      { platform: "discord", scope: null, channel: "d1", kind: "dm" },
      { platform: "discord", scope: "g1", channel: "v1", kind: "voice" },
      { platform: "discord", scope: null, channel: "v1", kind: "voice" },
    ] as ContextKey[]) {
      const parsed = parseContextKeyString(contextKeyString(c));
      expect(parsed && contextKeyString(parsed)).toBe(contextKeyString(c));
    }
    expect(parseContextKeyString("bad")).toBeNull();
  });
});
