import {
  type ArgValue,
  type CardBlock,
  CommandRegistry,
  CommandRegistryKey,
  type CommandReply,
  CommandsModule,
  type ComponentInvocationData,
  Invocation,
  Permissions,
  parseAccount,
  replyEphemeral,
  splitPath,
} from "@miyoria/commands";
import { Supervisor } from "@miyoria/kernel";
import { MemorySettingsStore, SettingsStoreKey } from "@miyoria/store";
import type { ContextKey } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  QueueConfigSchema,
  QueueModule,
  RequestQueue,
  RequestQueueKey,
  registerCommands,
  tallies,
} from "../src/index.js";

const context: ContextKey = { platform: "discord", scope: "1", channel: "2", kind: "channel" };

function inv(path: string, who: string, args: Record<string, ArgValue> = {}): Invocation {
  return new Invocation({
    path: splitPath(path),
    args,
    invoker: parseAccount(`discord:${who}`),
    invoker_display_name: `user${who}`,
    context,
    invoker_is_guild_admin: false,
  });
}

function click(id: string, who: string): ComponentInvocationData {
  return {
    custom_id: id,
    invoker: parseAccount(`discord:${who}`),
    invoker_display_name: `user${who}`,
    context,
    invoker_is_guild_admin: false,
  };
}

function setup(overrides: Record<string, unknown> = {}): [RequestQueue, CommandRegistry] {
  const registry = new CommandRegistry(Permissions.fromStrings(["discord:1"]));
  const queue = new RequestQueue(QueueConfigSchema.parse(overrides));
  registerCommands(registry, queue);
  return [queue, registry];
}

function run(
  reg: CommandRegistry,
  path: string,
  who: string,
  args: Record<string, ArgValue> = {},
): Promise<CommandReply> {
  return reg.dispatch(inv(path, who, args));
}

/** Whether the reply is shown to the invoker only, by the central rule. */
function ephemeral(reg: CommandRegistry, path: string, reply: CommandReply): boolean {
  return replyEphemeral(reg.get(splitPath(path))?.ephemeral ?? true, reply);
}

function buttonIds(blocks: readonly CardBlock[] | undefined): string[] {
  return (blocks ?? []).flatMap((b) => (b.type === "buttons" ? b.buttons.map((x) => x.id) : []));
}

describe("queue commands", () => {
  it("add_list_upvote_and_manage", async () => {
    const [queue, reg] = setup();

    const r = await run(reg, "queue add", "5", { text: "唱一首歌", kind: "song" });
    expect(r.text).toBe("已加入佇列：#1，目前排第 1 位。");
    expect(ephemeral(reg, "queue add", r)).toBe(false);
    const item = queue.get(1);
    expect([item?.kind, item?.requester_name]).toEqual(["song", "user5"]);
    expect(item?.context).not.toBeNull();

    await run(reg, "queue add", "5", { text: "再來一首" });
    const full = await run(reg, "queue add", "5", { text: "第三首" });
    expect(ephemeral(reg, "queue add", full)).toBe(true);
    expect(full.text).toContain("請稍後再試");
    const empty = await run(reg, "queue add", "6", { text: "  " });
    expect(empty.text).toBe("請輸入內容。");

    // The list is public and carries the manage buttons.
    let list = await run(reg, "queue list", "6");
    expect(ephemeral(reg, "queue list", list)).toBe(false);
    expect(list.text).toContain("#1 [song] user5：唱一首歌");
    expect(list.text).toContain("#2 [chat]");
    expect(buttonIds(list.card?.blocks)).toEqual([
      "mi:queue:list:next",
      "mi:queue:list:done",
      "mi:queue:list:skip",
      "mi:queue:list:pause",
      "mi:queue:list:refresh",
    ]);

    // Viewers cannot press Next; moderators (here: the owner) can, and the card updates.
    const viewer = await reg.dispatchComponent(click("mi:queue:list:next", "6"));
    expect(viewer?.result.type).toBe("reply");
    expect(queue.current()).toBeNull();
    const pressed = await reg.dispatchComponent(click("mi:queue:list:next", "1"));
    expect(pressed?.result.type).toBe("update");
    if (pressed?.result.type === "update") {
      expect(pressed.result.reply.text).toContain("**進行中**　#1");
      expect(pressed.result.reply.text).toContain("輪到 #1");
    }

    expect((await run(reg, "queue manage done", "1")).text).toBe("#1 已完成。");
    expect((await run(reg, "queue manage done", "1")).text).toContain("請指定編號");
    const skipped = await run(reg, "queue manage skip", "1", { id: 2 });
    expect(skipped.text).toBe("已跳過 #2。");

    await run(reg, "queue add", "7", { text: "a" });
    await run(reg, "queue add", "8", { text: "b" });
    // Removing asks first.
    const ask = await run(reg, "queue manage remove", "1", { id: 3 });
    expect(ask.card?.accent).toBe("danger");
    expect(queue.get(3)).toBeDefined();
    const [yes] = buttonIds(ask.card?.blocks);
    expect(yes).toBe("mi:queue:remove:yes:3");
    const removed = await reg.dispatchComponent(click(yes as string, "1"));
    expect(removed?.result.type === "update" && removed.result.reply.text).toBe("已移除 #3。");
    const missing = await run(reg, "queue manage remove", "1", { id: 3 });
    expect(missing.text).toBe("#3 目前無法進行這個操作。");

    const pr = await run(reg, "queue manage priority", "1", { id: 4, priority: 9 });
    expect(pr.text).toBe("已將 #4 的優先度設為 9。");
    expect(queue.get(4)?.priority).toBe(9);

    const up = await run(reg, "queue upvote", "9", { id: 4 });
    expect(up.text).toContain("1 票");
    expect(ephemeral(reg, "queue upvote", up)).toBe(false);

    expect((await run(reg, "queue manage pause", "1")).text).toContain("已暫停叫號");
    expect(queue.isPaused()).toBe(true);
    expect((await run(reg, "queue manage next", "1")).text).toBe("叫號已暫停。");
    list = await run(reg, "queue list", "1");
    expect(list.card?.title).toBe("請求佇列（暫停中）");
    expect((await run(reg, "queue manage resume", "1")).text).toBe("已恢復叫號。");
    expect(queue.isPaused()).toBe(false);

    // Clearing asks first too.
    const clear = await run(reg, "queue manage clear", "1");
    expect(clear.card?.accent).toBe("danger");
    expect(queue.list()).toHaveLength(1);
    const cleared = await reg.dispatchComponent(click("mi:queue:clear:yes", "1"));
    expect(cleared?.result.type === "update" && cleared.result.reply.text).toBe(
      "已清空 1 個項目。",
    );
    expect((await run(reg, "queue list", "1")).text).toContain("佇列是空的。");
    expect((await run(reg, "queue manage clear", "1")).text).toBe("沒有排隊中的項目。");
  });

  it("next_on_an_empty_queue_says_so", async () => {
    const [, reg] = setup();
    expect((await run(reg, "queue manage next", "1")).text).toBe("目前沒有人在排隊。");
  });

  it("long_text_is_ellipsized_in_listings", async () => {
    const [, reg] = setup();
    await run(reg, "queue add", "5", { text: "字".repeat(40) });
    const list = await run(reg, "queue list", "5");
    expect(list.text).toContain(`${"字".repeat(30)}…`);
  });

  it("votes_are_buttons_on_a_public_card", async () => {
    const [queue, reg] = setup();

    const started = await run(reg, "queue vote start", "1", { options: "左, 右，上", seconds: 30 });
    expect(ephemeral(reg, "queue vote start", started)).toBe(false);
    expect(started.text).toContain("30 秒");
    expect(started.text).toContain("1. 左　0 票\n2. 右　0 票\n3. 上　0 票");
    expect(started.session).toEqual({ ttlMs: 30_000, initiatorOnly: false });
    expect(buttonIds(started.card?.blocks)).toEqual([
      "mi:queue:vote:cast:0",
      "mi:queue:vote:cast:1",
      "mi:queue:vote:cast:2",
    ]);
    const again = await run(reg, "queue vote start", "1", { options: "a,b", seconds: 30 });
    expect(again.text).toBe("已經有投票正在進行。");

    let list = await run(reg, "queue list", "5");
    expect(list.text).toContain("投票進行中：左 0 票／右 0 票／上 0 票");

    const cast = async (who: string, index: number) =>
      reg.dispatchComponent(click(`mi:queue:vote:cast:${index}`, who));
    const first = await cast("5", 1);
    expect(first?.result.type === "update" && first.result.reply.text).toContain("2. 右　1 票");
    await cast("6", 2);
    await cast("5", 2);
    expect(tallies(queue.voteStatus() as never)).toEqual([0, 0, 2]);
    expect((await cast("5", 7))?.result.type).toBe("reply");

    const end = await run(reg, "queue vote end", "1");
    expect(end.text).toContain("結果：「上」");
    expect(end.text).toContain("上　2 票");
    expect((await cast("5", 0))?.result.type).toBe("reply");
    const bad = await run(reg, "queue vote start", "1", { options: "only", seconds: 30 });
    expect(bad.text).toContain("投票設定有誤");
    const neg = await run(reg, "queue vote start", "1", { options: "a,b", seconds: -3 });
    expect(neg.text).toContain("秒數");

    // The winner is waiting in the queue.
    list = await run(reg, "queue list", "1");
    expect(list.text).toContain("[vote]");
    expect(list.text).toContain("上");
  });

  it("vote_end_without_ballots_says_nobody_voted", async () => {
    const [, reg] = setup();
    await run(reg, "queue vote start", "1", { options: "a、b", seconds: 30 });
    const end = await run(reg, "queue vote end", "1");
    expect(end.text).toBe("投票結束\na　0 票\nb　0 票\n沒有人投票。");
  });

  it("configurable_permissions", async () => {
    const [queue, reg] = setup({ permissions: { manage: "admin.queue.manage" } });
    await run(reg, "queue add", "5", { text: "x" });
    const cases: Array<[string, Record<string, ArgValue>]> = [
      ["queue manage clear", {}],
      ["queue manage pause", {}],
      ["queue manage skip", { id: 1 }],
      ["queue vote start", { options: "a,b", seconds: 9 }],
    ];
    for (const [path, args] of cases) {
      const denied = await run(reg, path, "5", args);
      expect(ephemeral(reg, path, denied), path).toBe(true);
      expect(denied.text, path).toContain("admin.queue.manage");
    }
    expect(queue.isPaused()).toBe(false);
    expect(queue.list()).toHaveLength(1);
    expect(queue.voteStatus()).toBeNull();
    // Viewers may still list; an owner may manage.
    expect((await run(reg, "queue list", "5")).text).toContain("#1");
    expect((await run(reg, "queue manage clear", "1")).card?.accent).toBe("danger");
  });

  it("command_paths_are_valid_and_nonconflicting", () => {
    const [, reg] = setup();
    const names = reg.specs().map((s) => s.path.join(" "));
    expect(names).toEqual([
      "queue add",
      "queue list",
      "queue manage clear",
      "queue manage done",
      "queue manage next",
      "queue manage pause",
      "queue manage priority",
      "queue manage remove",
      "queue manage resume",
      "queue manage skip",
      "queue upvote",
      "queue vote end",
      "queue vote start",
    ]);
    expect(reg.groupDescription("queue")).toBe("請求佇列與投票");
    expect(reg.groupDescription("queue manage")).toContain("管理佇列");
  });
});

describe("QueueModule", () => {
  it("module_wires_commands_events_and_persistence", async () => {
    const sup = new Supervisor();
    const store = new MemorySettingsStore();
    sup.services.provide("app", SettingsStoreKey, store);
    await sup.register(new CommandsModule(), { owners: ["discord:1"] }, true);
    await sup.register(new QueueModule(), { persist_debounce_ms: 30, tick_ms: 10 }, true);
    const sub = sup.bus.subscribe("queue.*");
    await sup.startAll();

    const registry = sup.services.require(CommandRegistryKey);
    const queue = sup.services.require(RequestQueueKey);
    const reply = await run(registry, "queue add", "5", { text: "挖鑽石", kind: "game_goal" });
    expect(reply.text).toContain("#1");

    const env = await sub.recv();
    expect(env?.source).toBe("queue");
    expect(env?.event.type).toBe("custom");
    if (env?.event.type === "custom") {
      expect(env.event.data.topic).toBe("queue.changed");
      const payload = env.event.data.payload as { items: Array<{ kind: string }> };
      expect(payload.items[0]?.kind).toBe("game_goal");
    }
    queue.next();
    let sawActivation = false;
    for (let i = 0; i < 2; i++) {
      const e = await sub.recv();
      if (e?.event.type === "custom" && e.event.data.topic === "queue.item_activated") {
        sawActivation = true;
      }
    }
    expect(sawActivation).toBe(true);

    // Restarting the module keeps the queue (snapshot restore) and the commands.
    await sup.restart("queue");
    const revived = sup.services.require(RequestQueueKey);
    expect(revived).not.toBe(queue);
    expect(revived.current()?.text).toBe("挖鑽石");
    const registry2 = sup.services.require(CommandRegistryKey);
    expect((await run(registry2, "queue list", "5")).text).toContain("**進行中**　#1");

    // Restarting `commands` keeps the queue commands (same registry).
    await sup.restart("commands");
    expect(sup.services.require(CommandRegistryKey).get(["queue", "add"])).toBeDefined();

    // Disabling it removes the commands again.
    await sup.disable("queue");
    expect(sup.services.get(RequestQueueKey)).toBeUndefined();
    expect(registry2.get(["queue", "add"])).toBeUndefined();
    expect(await store.get("_global", "queue:state")).not.toBeNull();
    await sup.stopAll();
  });

  it("module_starts_without_optional_services", async () => {
    const sup = new Supervisor();
    await sup.register(new QueueModule(), null, true);
    await sup.startAll();
    const queue = sup.services.require(RequestQueueKey);
    expect(queue.list()).toEqual([]);
    expect(sup.list().find((s) => s.id === "queue")?.state).toBe("running");
    await sup.stopAll();
  });

  it("module_manifest", () => {
    const m = new QueueModule().manifest;
    expect(m.id).toBe("queue");
    expect(m.optional).toEqual(["commands", "social"]);
    expect(m.requires).toEqual([]);
  });
});
