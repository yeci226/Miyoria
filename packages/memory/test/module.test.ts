// The module under a supervisor: services, registrations, commands and event-driven
// consolidation (Rust `tests/module.rs`).

import {
  type ArgValue,
  CommandRegistryKey,
  CommandsModule,
  type InvocationData,
  replyEphemeral,
} from "@miyoria/commands";
import {
  defineManifest,
  type Module,
  type ModuleContext,
  ServiceRegistry,
  Supervisor,
} from "@miyoria/kernel";
import { type LlmRouter, LlmRouterKey, MockProvider } from "@miyoria/llm";
import {
  logEntryFromIncoming,
  type MemoryKind,
  MemoryRecordStoreKey,
  type MemoryScope,
  MessageLogKey,
  PeopleStoreKey,
  SettingsStoreKey,
} from "@miyoria/store";
import { ToolRegistry, ToolRegistryKey } from "@miyoria/tools";
import {
  type ContextKey,
  EventLogKey,
  FollowupSourceKey,
  type IncomingMessage,
  type JsonValue,
  MemoryRetrievalKey,
  type PersonId,
  PinnedMemoryKey,
  PromptContributors,
  PromptContributorsKey,
  toTimestamp,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import {
  embeddingConfig,
  MemoryEngine,
  MemoryEngineKey,
  MemoryModule,
  memoryFilter,
  PATHS,
} from "../src/index.js";
import {
  type Areas,
  acct,
  closeAll,
  dmCtx,
  guildCtx,
  openAreas,
  profile,
  router,
} from "./helpers.js";

class LlmStub implements Module {
  readonly manifest = defineManifest("llm", "LLM stub");
  constructor(readonly router: LlmRouter) {}

  async start(ctx: ModuleContext): Promise<void> {
    ctx.provide(LlmRouterKey, this.router);
  }
}

interface Harness {
  sup: Supervisor;
  store: Areas;
  contributors: PromptContributors;
  tools: ToolRegistry;
}

const sups: Supervisor[] = [];

async function harness(llm: MockProvider, config: JsonValue): Promise<Harness> {
  const services = new ServiceRegistry();
  const sup = new Supervisor({ services });
  sups.push(sup);
  const store = await openAreas("fake");
  services.provide("app", MemoryRecordStoreKey, store.memories);
  services.provide("app", MessageLogKey, store.messages);
  services.provide("app", PeopleStoreKey, store.people);
  services.provide("app", SettingsStoreKey, store.settings);
  const contributors = new PromptContributors();
  services.provide("app", PromptContributorsKey, contributors);
  const tools = new ToolRegistry();
  services.provide("app", ToolRegistryKey, tools);

  await sup.register(new LlmStub(router(llm)), null, true);
  await sup.register(new CommandsModule(), { owners: ["discord:1"] }, true);
  await sup.register(new MemoryModule(profile(), embeddingConfig()), config, true);
  await sup.startAll();
  return { sup, store, contributors, tools };
}

function inv(
  path: string,
  invoker: string,
  context: ContextKey,
  args: [string, string][] = [],
): InvocationData {
  return {
    path: path.split(" "),
    args: Object.fromEntries(args) as Record<string, ArgValue>,
    invoker: acct(invoker),
    invoker_display_name: invoker,
    context,
    invoker_is_guild_admin: false,
  };
}

function engine(h: Harness): MemoryEngine {
  return h.sup.services.require(MemoryEngineKey);
}

async function run(h: Harness, invocation: InvocationData): Promise<string> {
  const reg = h.sup.services.require(CommandRegistryKey);
  const reply = await reg.dispatch(invocation);
  expect(replyEphemeral(reg.get(invocation.path)?.ephemeral ?? false, reply)).toBe(true);
  return reply.text;
}

async function add(
  h: Harness,
  kind: MemoryKind,
  scope: MemoryScope,
  subjects: PersonId[],
  content: string,
): Promise<void> {
  await engine(h).store(
    {
      kind,
      scope,
      subjects,
      content,
      importance: 0.5,
      confidence: 0.8,
      source_context: null,
      source: null,
      origin: "experienced",
      source_events: kind === "fact" ? ["01TESTEVIDENCE0000000000"] : [],
      due: null,
    },
    toTimestamp(Date.now()),
  );
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(async () => {
  for (const sup of sups.splice(0)) await sup.stopAll();
  await closeAll();
});

describe("module", () => {
  it("registers_services_and_unregisters_on_stop", async () => {
    const h = await harness(new MockProvider("sum").reply("{}"), { tick_secs: 1 });
    expect(h.sup.services.get(FollowupSourceKey)).toBeDefined();
    expect(h.sup.services.get(MemoryEngineKey)).toBeInstanceOf(MemoryEngine);
    // The memory contributor, and the v4 §5 ones (just now, elsewhere, her notebook's index).
    expect(h.contributors.all().map((c) => c.key)).toEqual([
      "elsewhere",
      "just_now",
      "memory",
      "notebook",
    ]);
    expect(h.tools.names()).toEqual([
      "forget_date",
      "notebook_delete",
      "notebook_read",
      "notebook_write",
      "recall",
      "remember",
      "remember_date",
    ]);
    const reg = h.sup.services.require(CommandRegistryKey);
    for (const path of PATHS) {
      const spec = reg.get(path.split(" "));
      if (!spec) throw new Error(`${path} not registered`);
      expect(
        spec.permission.startsWith("memory.self.") || spec.permission === "owner.memory.wipe",
      ).toBe(true);
      expect(spec.ephemeral).toBe(true);
    }
    const memoryStatus = h.sup.list().find((m) => m.id === "memory");
    expect(memoryStatus?.state).toBe("running");

    await h.sup.disable("memory");
    expect(h.contributors.all()).toEqual([]);
    expect(h.tools.isEmpty).toBe(true);
    expect(reg.get(["me", "memory", "show"])).toBeUndefined();
    expect(h.sup.services.get(FollowupSourceKey)).toBeUndefined();

    // After a restart of the commands module the commands are (still) there.
    await h.sup.enable("memory");
    await h.sup.restart("commands");
    const after = h.sup.services.require(CommandRegistryKey);
    expect(after).toBe(reg);
    const deadline = Date.now() + 5000;
    while (after.get(["me", "memory", "show"]) === undefined) {
      expect(Date.now() < deadline, "not re-registered").toBe(true);
      await pause(50);
    }
  });

  it("provides the V3 readers and picks up the EventLog when it appears", async () => {
    const h = await harness(new MockProvider("sum").reply("{}"), {});
    expect(h.sup.services.get(PinnedMemoryKey)).toBeDefined();
    expect(h.sup.services.get(MemoryRetrievalKey)).toBeDefined();
    // No EventLog in this harness yet.
    const e = engine(h);
    expect(e.events).toBeNull();
    e.attach({
      get: ((key: unknown) =>
        key === EventLogKey
          ? { query: async () => [], get: async () => null }
          : undefined) as never,
      has: () => false,
      require: (() => {
        throw new Error("none");
      }) as never,
    });
    expect(e.events).not.toBeNull();
  });

  it("memory_commands_show_forget_export", async () => {
    const h = await harness(new MockProvider("sum").reply("{}"), {});
    const owenAcct = acct("2");
    const owen = await h.store.people.upsertAccount(owenAcct, "Owen");
    const amy = await h.store.people.upsertAccount(acct("3"), "Amy");
    const g1: MemoryScope = { type: "guild", platform: "discord", guild: "g1" };
    const dmScope: MemoryScope = { type: "dm", account: owenAcct };
    await add(h, "fact", g1, [owen], "Owen 喜歡拉麵");
    await add(h, "fact", dmScope, [owen], "Owen 下週要看牙醫");
    await add(h, "fact", { type: "person", person: owen }, [owen], "Owen 希望被叫歐文");
    await add(h, "fact", g1, [amy], "Amy 養貓");

    const guild = guildCtx("g1", "c1");
    const dm = dmCtx("d-owen");

    let shown = await run(h, inv("me memory show", "2", guild));
    expect(shown).toContain("拉麵");
    expect(shown).toContain("歐文");
    expect(shown, "DM memory shown in a guild").not.toContain("牙醫");
    expect(shown).not.toContain("Amy");
    shown = await run(h, inv("me memory show", "2", dm));
    expect(shown).toContain("牙醫");
    expect(shown, "guild memory shown in a DM").not.toContain("拉麵");
    const otherGuild = await run(h, inv("me memory show", "2", guildCtx("g2", "c1")));
    expect(otherGuild).toContain("歐文");
    expect(otherGuild).not.toContain("拉麵");
    // There is no way to look at someone else's memories here.
    const reg = h.sup.services.require(CommandRegistryKey);
    expect(reg.get(["me", "memory", "show"])?.args).toEqual([]);

    // The export is a file, not a code block.
    const exported = await reg.dispatch(inv("me memory export", "2", guild));
    const file = exported.files?.[0];
    expect(file?.name).toMatch(/^memories-\d{4}-\d{2}-\d{2}\.json$/);
    const items = JSON.parse(String(file?.data)) as { kind: string; created_at: string }[];
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.kind === "fact")).toBe(true);
    expect(items[0]?.created_at).toMatch(/\+00:00$/);
    expect(exported.text).toContain("已匯出 2 筆記憶");

    // Forgetting asks first; the confirm button does it (the keyword rides in the session).
    const ask = await reg.dispatch(inv("me memory forget", "2", guild, [["target", "牙醫"]]));
    expect(ask.card?.accent).toBe("danger");
    expect(ask.session?.data).toEqual({ keyword: "牙醫" });
    const click = (id: string, data: JsonValue | null) =>
      reg.dispatchComponent({
        ...inv("x", "2", guild),
        custom_id: id,
        message_id: "m",
        session: data === null ? null : { initiator: acct("2"), initiator_only: true, data },
      });
    const expired = await click("mi:me:memory:forget:keyword", null);
    expect(expired?.result.type).toBe("reply");
    const forgot = await click("mi:me:memory:forget:keyword", { keyword: "牙醫" });
    expect(forgot?.result.type === "update" && forgot.result.reply.text).toContain("1 件事");
    const none = await click("mi:me:memory:forget:keyword", { keyword: "火星" });
    expect(none?.result.type === "update" && none.result.reply.text).toContain("沒有記得");
    const all = await click("mi:me:memory:forget:all", null);
    expect(all?.result.type === "update" && all.result.reply.text).toContain("已讓她忘記");
    const e = engine(h);
    expect(await e.memoriesOf(owen, owenAcct, true)).toEqual([]);
    expect(await e.memoriesOf(amy, acct("3"), false), "Amy's memories untouched").toHaveLength(1);
    const empty = await run(h, inv("me memory show", "2", guild));
    expect(empty).toContain("還沒有記得");
  });

  it("consolidates_after_enough_messages", async () => {
    const reply = `{"facts": [{"subject_name": "Owen", "statement": "Owen 養了一隻叫麻糬的貓", "importance": 0.7, "confidence": 0.9, "global": false}]}`;
    const llm = new MockProvider("sum").reply(reply);
    const h = await harness(llm, {
      tick_secs: 1,
      consolidate_every_messages: 2,
      consolidate_idle_secs: 3600,
    });
    const owen = acct("2");
    await h.store.people.upsertAccount(owen, "Owen");
    const ctx = guildCtx("g1", "c1");
    for (const [i, text] of ["我家有貓", "牠叫麻糬"].entries()) {
      const msg: IncomingMessage = {
        id: { context: ctx, id: `m${i}` },
        author: { account: owen, display_name: "Owen", is_bot: false },
        text,
        mentions_self: false,
        reply_to_self: false,
        attachments: [],
        ts: toTimestamp(Date.now() + i),
      };
      // The recorder would append it; do it here.
      await h.store.messages.append(logEntryFromIncoming(profile(), msg, false));
      h.sup.bus.publish("test", { type: "platform_message_created", data: msg });
    }
    const deadline = Date.now() + 10_000;
    for (;;) {
      const records = await engine(h).memoriesOf(null, owen, false);
      const all = await h.store.memories.list(profile(), memoryFilter(10));
      const first = all[0];
      if (first) {
        expect(first.content).toContain("麻糬");
        expect(first.scope).toEqual({ type: "guild", platform: "discord", guild: "g1" });
        expect(records, "no DM-scoped records").toEqual([]);
        break;
      }
      expect(Date.now() < deadline, "not consolidated").toBe(true);
      await pause(100);
    }
    expect(llm.requests()).toHaveLength(1);
    const user = llm.requests()[0]?.messages[1]?.content ?? "";
    expect(user).toContain("我家有貓");
    expect(user).toContain("牠叫麻糬");
  });

  it("consolidates right after a conversation fold, before the thresholds", async () => {
    const reply = `{"facts": [{"subject_name": "Owen", "statement": "Owen 下週要搬家", "importance": 0.7, "confidence": 0.9, "global": false}]}`;
    const llm = new MockProvider("sum").reply(reply);
    const h = await harness(llm, {
      tick_secs: 1,
      consolidate_every_messages: 100,
      consolidate_idle_secs: 3600,
    });
    const owen = acct("2");
    const ctx = guildCtx("g1", "c1");
    const msg: IncomingMessage = {
      id: { context: ctx, id: "m1" },
      author: { account: owen, display_name: "Owen", is_bot: false },
      text: "我下週要搬家",
      mentions_self: false,
      reply_to_self: false,
      attachments: [],
      ts: toTimestamp(Date.now()),
    };
    await h.store.messages.append(logEntryFromIncoming(profile(), msg, false));
    h.sup.bus.publish("test", { type: "platform_message_created", data: msg });
    await pause(1500);
    expect(llm.requests()).toHaveLength(0);
    h.sup.bus.publish("conversation", {
      type: "custom",
      data: {
        topic: "conversation.folded",
        payload: {
          context: { ...ctx },
          folded_up_to: { id: "x", ts: msg.ts },
          lines: 1,
          session_lines: 1,
        },
      },
    });
    const deadline = Date.now() + 10_000;
    while (llm.requests().length === 0) {
      expect(Date.now() < deadline, "not consolidated").toBe(true);
      await pause(100);
    }
    expect(llm.requests()[0]?.messages[1]?.content).toContain("我下週要搬家");
  });

  it("is degraded without a message log and fails without a record store", async () => {
    const services = new ServiceRegistry();
    const sup = new Supervisor({ services });
    sups.push(sup);
    const store = await openAreas("fake");
    services.provide("app", MemoryRecordStoreKey, store.memories);
    await sup.register(new LlmStub(router(new MockProvider("sum").reply("{}"))), null, true);
    const module = new MemoryModule(profile());
    await sup.register(module, { forgetting: { enabled: false } }, true);
    await sup.startAll();
    expect(await module.health()).toEqual({
      status: "degraded",
      reason: "no message log: consolidation is off",
    });

    const bare = new Supervisor();
    sups.push(bare);
    await bare.register(new LlmStub(router(new MockProvider("sum").reply("{}"))), null, true);
    await bare.register(new MemoryModule(profile()), null, true);
    await bare.startAll();
    const status = bare.list().find((m) => m.id === "memory");
    expect(status?.state).not.toBe("running");
  });
});
