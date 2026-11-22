// `/me feed thing:` and `/me gifts` (gift-commands.ts): the quote only the member sees, 確認 and
// 取消, and the fixed foods named in words, against the real economy and gift tables.

import {
  type CardBlock,
  CommandRegistry,
  type CommandReply,
  Permissions,
  replyEphemeral,
} from "@miyoria/commands";
import { type AccountRef, type ContextKey, SelfStateKey } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { EconomyCommands } from "../src/commands.js";
import { GIFT_ROUTES } from "../src/gift-commands.js";
import { giftTables } from "../src/gift-tables.js";
import { GiftPricerKey } from "../src/gift-words.js";
import { FreeGiftsKey, GiftDesk } from "../src/gifts.js";
import { ALICE, BOB, balance, fund, rig } from "./rig.js";

const ctx: ContextKey = { platform: "discord", scope: "g", channel: "9", kind: "channel" };

async function setup() {
  const r = await rig();
  r.services.provide("test", SelfStateKey, {
    drives: () => ({ hunger: 0.9 }),
    adjust: () => undefined,
  } as never);
  r.services.provide("test", GiftPricerKey, {
    price: async (item: string) => ({
      kind: "big_object" as const,
      twd: item === "一台跑車" ? 2500 : 50,
    }),
  });
  const desk = new GiftDesk(r.economy, () => r.store.plugin(giftTables));
  r.services.provide("test", FreeGiftsKey, desk);
  const registry = new CommandRegistry(Permissions.fromStrings(["discord:1"]));
  new EconomyCommands().install(registry, r.services);
  return { r, desk, registry };
}

function run(registry: CommandRegistry, who: AccountRef, args: Record<string, string>) {
  return registry.dispatch({
    path: ["me", "feed"],
    args,
    invoker: who,
    invoker_display_name: who.id === ALICE.id ? "Alice" : "Bob",
    context: ctx,
    invoker_is_guild_admin: false,
  });
}

function press(registry: CommandRegistry, who: AccountRef, customId: string) {
  return registry.dispatchComponent({
    custom_id: customId,
    invoker: who,
    invoker_display_name: "x",
    context: ctx,
    invoker_is_guild_admin: false,
  });
}

function buttons(reply: CommandReply) {
  return (reply.card?.blocks ?? [])
    .filter((b): b is Extract<CardBlock, { type: "buttons" }> => b.type === "buttons")
    .flatMap((b) => b.buttons);
}

function updated(outcome: Awaited<ReturnType<typeof press>>): CommandReply {
  if (outcome?.result.type !== "update") throw new Error("expected an update");
  return outcome.result.reply;
}

describe("/me feed thing:", () => {
  it("answers with a quote only the member sees, and charges at 確認 once", async () => {
    const { r, registry } = await setup();
    await fund(r, ALICE, 100);
    const reply = await run(registry, ALICE, { thing: "一把電吉他" });
    expect(reply.ephemeral).toBe(true);
    expect(replyEphemeral(false, reply)).toBe(true);
    expect(reply.card?.accent).toBe("neutral");
    expect(reply.text).toContain("一把電吉他");
    expect(reply.text).toContain("約 NT$50 → 50 魚幣");
    expect(reply.text).not.toContain("大禮");
    expect(reply.text).toContain("送出後剩 50");
    expect(reply.session).toBeDefined();
    const [ok, no] = buttons(reply);
    expect([ok?.label, no?.label]).toEqual(["確認", "取消"]);
    expect(ok?.id.startsWith(`mi:${GIFT_ROUTES.ok}:`)).toBe(true);
    expect(await balance(r, ALICE)).toBe(100);
    // Someone else pressing it is refused, nothing charged.
    await fund(r, BOB, 100);
    expect(updated(await press(registry, BOB, ok?.id as string)).text).toContain("不是你要送的");
    expect(await balance(r, BOB)).toBe(100);
    const done = updated(await press(registry, ALICE, ok?.id as string));
    expect(done.text).toContain("送出了「一把電吉他」");
    await press(registry, ALICE, ok?.id as string);
    expect(await balance(r, ALICE)).toBe(50);
  });

  it("says a large gift is one, with the balance after, and asks nothing more", async () => {
    const { r, registry } = await setup();
    await fund(r, ALICE, 3000);
    const reply = await run(registry, ALICE, { thing: "一台跑車" });
    expect(reply.text).toContain("約 NT$2,500 → 2,500 魚幣");
    expect(reply.text).toContain("這是一份大禮:2,500 魚幣,送出後只剩 500");
    expect(buttons(reply).map((b) => b.label)).toEqual(["確認", "取消"]);
  });

  it("取消 costs nothing", async () => {
    const { r, registry } = await setup();
    await fund(r, ALICE, 100);
    const reply = await run(registry, ALICE, { thing: "一把電吉他" });
    const no = buttons(reply)[1];
    expect(updated(await press(registry, ALICE, no?.id as string)).text).toContain("沒有扣錢");
    expect(await balance(r, ALICE)).toBe(100);
  });

  it("feeds a fixed food named in words at once, with no confirmation", async () => {
    const { r, registry } = await setup();
    await fund(r, ALICE, 100);
    const reply = await run(registry, ALICE, { thing: "白飯" });
    expect(buttons(reply)).toEqual([]);
    expect(reply.text).toContain("她吃了一碗白飯");
    expect(await balance(r, ALICE)).toBeGreaterThanOrEqual(90);
  });

  it("still feeds by item exactly as before", async () => {
    const { r, registry } = await setup();
    await fund(r, ALICE, 100);
    const reply = await run(registry, ALICE, { item: "rice" });
    expect(reply.text).toContain("她吃了一碗白飯");
    expect(buttons(reply)).toEqual([]);
  });

  it("says why it cannot be given, privately, nothing charged", async () => {
    const { r, registry } = await setup();
    await fund(r, ALICE, 100);
    const reply = await run(registry, ALICE, { thing: "100 魚幣" });
    expect(reply.ephemeral).toBe(true);
    expect(reply.text).toContain("沒辦法送");
    expect(await balance(r, ALICE)).toBe(100);
  });
});

describe("/me gifts", () => {
  it("lists what they gave her and what she said", async () => {
    const { r, desk, registry } = await setup();
    await fund(r, ALICE, 100);
    const a = await desk.ask(ALICE, "一把電吉他", "k", "discord");
    if (a.status !== "quote") throw new Error("no quote");
    await desk.confirm(ALICE, a.quote.id);
    await desk.answer(a.quote.id, true, "我要練到會彈", true, "her");
    const reply = await registry.dispatch({
      path: ["me", "gifts"],
      args: {},
      invoker: ALICE,
      invoker_display_name: "Alice",
      context: ctx,
      invoker_is_guild_admin: false,
    });
    expect(reply.text).toContain("一把電吉他");
    expect(reply.text).toContain("我要練到會彈");
    expect(reply.text).toContain("她很喜歡");
  });
});
