// `/admin memory wipe`: scope select, red confirm, typed profile id, backup first, one
// transaction, audit entry, cache restarts.

import {
  CommandRegistryKey,
  type CommandReply,
  CommandsModule,
  type ComponentInvocationData,
} from "@miyoria/commands";
import {
  defineManifest,
  type Module,
  type ModuleContext,
  ServiceRegistry,
  Supervisor,
  SupervisorKey,
} from "@miyoria/kernel";
import { type LlmRouter, LlmRouterKey, MockProvider } from "@miyoria/llm";
import {
  AuditLogKey,
  dataCategory,
  MemoryRecordStoreKey,
  MessageLogKey,
  PeopleStoreKey,
  ProfileDataStoreKey,
  SettingsStoreKey,
  SqliteStore,
} from "@miyoria/store";
import { newId, toTimestamp } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import {
  embeddingConfig,
  MAINTENANCE_KEY,
  MemoryEngineKey,
  MemoryModule,
  WATERMARK_PREFIX,
  type WipeScope,
  wipeModules,
  wipePlan,
} from "../src/index.js";
import { acct, guildCtx, profile, router } from "./helpers.js";

class LlmStub implements Module {
  readonly manifest = defineManifest("llm", "LLM stub");
  constructor(readonly router: LlmRouter) {}

  async start(ctx: ModuleContext): Promise<void> {
    ctx.provide(LlmRouterKey, this.router);
  }
}

/**
 * Stands in for a module whose caches a wipe must drop; counts its starts. Like the real mood
 * module, `mood` saves its cached state on stop.
 */
class Counting implements Module {
  readonly manifest;
  starts = 0;
  #ctx: ModuleContext | null = null;

  constructor(id: string) {
    this.manifest = defineManifest(id, id);
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.starts++;
    this.#ctx = ctx;
  }

  async stop(): Promise<void> {
    const settings = this.#ctx?.services.get(SettingsStoreKey);
    if (this.manifest.id === "mood" && settings && this.starts === 1) {
      await settings.set(profile(), "mood:last", { valence: 0.2 });
    }
  }
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

async function setup() {
  const store = await SqliteStore.open(":memory:");
  const services = new ServiceRegistry();
  const sup = new Supervisor({ services });
  cleanup.push(async () => {
    await sup.stopAll();
    await store.close();
  });
  services.provide("app", SupervisorKey, sup);
  services.provide("app", MemoryRecordStoreKey, store.memories);
  services.provide("app", MessageLogKey, store.messages);
  services.provide("app", PeopleStoreKey, store.people);
  services.provide("app", SettingsStoreKey, store.settings);
  services.provide("app", ProfileDataStoreKey, store.profileData);
  services.provide("app", AuditLogKey, store.audit);
  const counting = ["social", "mood", "agent", "arbiter"].map((id) => new Counting(id));
  await sup.register(new LlmStub(router(new MockProvider("sum").reply("{}"))), null, true);
  await sup.register(new CommandsModule(), { owners: ["discord:1"] }, true);
  await sup.register(new MemoryModule(profile(), embeddingConfig()), {}, true);
  for (const m of counting) await sup.register(m, null, true);
  await sup.startAll();

  // Data of this profile and of another one.
  const owen = await store.people.upsertAccount(acct("2"), "Owen");
  const ctx = guildCtx("g1", "c1");
  const now = toTimestamp(Date.now());
  for (const p of [profile(), "other"]) {
    await store.memories.upsert({
      id: newId(),
      profile: p,
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
      profile: p,
      context: ctx,
      author: acct("2"),
      author_name: "Owen",
      text: "我喜歡拉麵",
      is_self: false,
      ts: now,
      turn: null,
    });
    await store.settings.set(p, `${WATERMARK_PREFIX}x`, { at: now });
    await store.settings.set(p, "mood:last", { valence: 0.2 });
    await store.settings.set(p, "channel_mode:x", "always");
  }
  return { store, sup, counting, registry: services.require(CommandRegistryKey), services };
}

function invoke(who: string) {
  return {
    path: ["admin", "memory", "wipe"],
    args: {},
    invoker: acct(who),
    invoker_display_name: who,
    context: guildCtx("g1", "c1"),
    invoker_is_guild_admin: true,
  };
}

function click(who: string, id: string, extra: Partial<ComponentInvocationData> = {}) {
  const { path: _p, args: _a, ...rest } = invoke(who);
  return {
    ...rest,
    custom_id: id,
    message_id: "panel",
    ...extra,
  } satisfies ComponentInvocationData;
}

describe("memory wipe", () => {
  it("plans_never_clear_watermarks_without_the_log", () => {
    const settingsOf = (scope: WipeScope) =>
      wipePlan(scope).flatMap((id) =>
        dataCategory(id).parts.flatMap((p) =>
          p.kind === "settings" ? [...p.keys, ...p.prefixes] : [],
        ),
      );
    for (const scope of ["memories", "relationships", "history", "everything"] as WipeScope[]) {
      const plan = wipePlan(scope);
      expect(settingsOf(scope).includes(WATERMARK_PREFIX), scope).toBe(plan.includes("messages"));
      expect(plan, scope).toContain("memories");
      expect(settingsOf(scope)).toContain(MAINTENANCE_KEY);
    }
    expect(wipePlan("memories")).toEqual(["memories", "knowledge"]);
    expect(wipePlan("relationships")).toEqual([
      "memories",
      "relationships",
      "inner",
      "knowledge",
      "learning",
      "mood",
    ]);
    expect(wipePlan("history")).toContain("conversation");
    expect(settingsOf("relationships")).toEqual(
      expect.arrayContaining(["mood:last", "self:state", "self:feeling:"]),
    );
    expect(settingsOf("memories")).not.toContain("self:feeling:");
    expect(settingsOf("relationships")).toContain("mind:thought:");
    expect(settingsOf("everything")).toEqual(
      expect.arrayContaining(["arbiter:state", "initiative:state"]),
    );
    expect(wipeModules("history")).toEqual([
      "memory",
      "arbiter",
      "social",
      "agent",
      "self",
      "mind",
      "knowledge",
      "reflect",
      "conversation",
      "mood",
      "facts",
    ]);
    expect(wipeModules("memories")).toEqual(["memory", "arbiter", "knowledge"]);
  });

  it("is_owner_only_and_walks_through_select_confirm_and_modal", async () => {
    const { store, registry, counting, sup } = await setup();
    const engineBefore = sup.services.require(MemoryEngineKey);

    // A guild admin is not enough.
    const denied = await registry.dispatch(invoke("5"));
    expect(denied.text).toContain("owner.memory.wipe");
    expect(registry.get(["admin", "memory", "wipe"])?.ephemeral).toBe(true);

    const start = await registry.dispatch(invoke("1"));
    expect(start.card?.accent).toBe("danger");
    expect(start.card?.blocks.some((b) => b.type === "select")).toBe(true);

    const picked = await registry.dispatchComponent(
      click("1", "mi:admin:memory:wipe:scope", { values: ["history"] }),
    );
    expect(picked?.result.type).toBe("update");
    const confirmCard = picked?.result.type === "update" ? picked.result.reply : null;
    expect(confirmCard?.card?.accent).toBe("danger");
    expect(confirmCard?.text).toContain("記憶 1 筆");
    expect(confirmCard?.text).toContain("聊天紀錄 1 則");

    const modal = await registry.dispatchComponent(click("1", "mi:admin:memory:wipe:ask:history"));
    expect(modal?.result.type).toBe("modal");
    if (modal?.result.type === "modal") {
      expect(modal.result.modal.id).toBe("mi:admin:memory:wipe:go:history");
    }

    // A wrong profile id deletes nothing.
    const wrong = await registry.dispatchComponent(
      click("1", "mi:admin:memory:wipe:go:history", { fields: { profile: "nope" } }),
    );
    expect(wrong?.result.type === "reply" && wrong.result.reply.text).toContain("不正確");
    // Without a way to send the backup, nothing is deleted either.
    const noBackup = await registry.dispatchComponent(
      click("1", "mi:admin:memory:wipe:go:history", { fields: { profile: profile() } }),
    );
    expect(noBackup?.result.type === "reply" && noBackup.result.reply.tone).toBe("error");
    const ctx = guildCtx("g1", "c1");
    expect(await store.messages.recent(profile(), ctx, 9)).toHaveLength(1);

    // The real thing: the backup goes out while the data still exists.
    const sent: CommandReply[] = [];
    let messagesAtBackup = -1;
    const done = await registry.dispatchComponent(
      click("1", "mi:admin:memory:wipe:go:history", { fields: { profile: ` ${profile()} ` } }),
      {
        followUp: async (reply) => {
          sent.push(reply);
          messagesAtBackup = (await store.messages.recent(profile(), ctx, 9)).length;
        },
      },
    );
    expect(done?.result.type).toBe("update");
    expect(messagesAtBackup).toBe(1);
    expect(sent).toHaveLength(1);
    const file = sent[0]?.files?.[0];
    expect(file?.name).toMatch(new RegExp(`^${profile()}-history-.*\\.json$`));
    const backup = JSON.parse(String(file?.data));
    expect(backup.format).toBe("miyoria.data");
    expect(backup.parts.memory_records).toHaveLength(1);
    expect(backup.parts.message_log[0].text).toBe("我喜歡拉麵");
    expect(backup.parts.memory_watermarks[0].key).toBe(`${WATERMARK_PREFIX}x`);

    // Gone for this profile, kept for the other and for settings outside the plan.
    const filter = {
      subject: null,
      scope: null,
      kind: null,
      before: null,
      include_superseded: true,
      limit: 9,
    };
    expect(await store.memories.list(profile(), filter)).toEqual([]);
    expect(await store.messages.recent(profile(), ctx, 9)).toEqual([]);
    expect([...(await store.settings.list(profile(), "")).keys()]).toEqual(["channel_mode:x"]);
    expect(await store.memories.list("other", filter)).toHaveLength(1);
    expect(await store.messages.recent("other", ctx, 9)).toHaveLength(1);

    // Audited, and the caching modules were restarted (fresh engine).
    const audit = await store.audit.recent(10, "discord:1");
    expect(audit.some((e) => e.action === "memory.wipe" && e.ok)).toBe(true);
    for (const m of counting) expect(m.starts, m.manifest.id).toBe(2);
    expect(sup.services.require(MemoryEngineKey)).not.toBe(engineBefore);
  });
});
