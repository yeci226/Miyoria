// `/me auction` and `/me lottery` and the controls of the notices: 出價 opens a modal and its
// submission redraws the lot's card, the lottery's buy buttons answer only the buyer, and nothing
// works without the market.

import {
  CommandRegistry,
  type ComponentOutcome,
  componentId,
  Permissions,
} from "@miyoria/commands";
import type { AccountRef, ContextKey } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { registerCommands, unregisterCommands } from "../src/commands.js";
import { ROUTES } from "../src/notices.js";
import type { MarketService } from "../src/service.js";
import { ALICE, BOB, OPENS, rig } from "./rig.js";

const ctx: ContextKey = { platform: "discord", scope: "g", channel: "100", kind: "channel" };

function registryWith(service: MarketService | null): CommandRegistry {
  const registry = new CommandRegistry(Permissions.fromStrings(["discord:1"]));
  registerCommands(registry, () => service);
  return registry;
}

const who = (account: AccountRef) => ({
  invoker: account,
  invoker_display_name: account.id === "1" ? "Alice" : "Bob",
  context: ctx,
  invoker_is_guild_admin: false,
});

function press(
  registry: CommandRegistry,
  account: AccountRef,
  id: string,
  fields?: Record<string, string>,
): Promise<ComponentOutcome | null> {
  return registry.dispatchComponent({
    custom_id: id,
    ...who(account),
    message_id: "m1",
    ...(fields ? { fields } : {}),
  });
}

describe("/me auction", () => {
  it("bids through the button's modal and redraws the lot", async () => {
    const r = await rig({ lottery: false });
    await r.service.plan("frame");
    r.clock.at = OPENS;
    await r.service.tick();
    r.wallet.fund(ALICE, 500);
    const registry = registryWith(r.service);
    const modal = await press(registry, ALICE, componentId(ROUTES.bid));
    expect(modal?.result).toMatchObject({
      type: "modal",
      modal: { fields: [expect.objectContaining({ id: "amount", value: "50" })] },
    });
    const bid = await press(registry, ALICE, componentId(ROUTES.bidForm), { amount: "120" });
    expect(bid?.result.type).toBe("update");
    if (bid?.result.type === "update") expect(bid.result.reply.text).toContain("Alice 120 魚幣");
    const low = await press(registry, BOB, componentId(ROUTES.bidForm), { amount: "100" });
    expect(low).toMatchObject({ ephemeral: true, result: { type: "reply" } });
    if (low?.result.type === "reply") expect(low.result.reply.text).toContain("至少要 125");
    const bob = { path: ["me", "auction"], args: { bid: 130 }, ...who(BOB) };
    const typed = await registry.dispatch(bob);
    expect(typed.text).toContain("魚幣不夠");
    r.wallet.fund(BOB, 500);
    const ok = await registry.dispatch(bob);
    expect(ok.text).toContain("Bob 出價 130");
  });

  it("says so when the market is not there", async () => {
    const registry = registryWith(null);
    const reply = await registry.dispatch({ path: ["me", "auction"], args: {}, ...who(ALICE) });
    expect(reply.text).toContain("沒有開");
    unregisterCommands(registry);
    const gone = await registry.dispatch({ path: ["me", "auction"], args: {}, ...who(ALICE) });
    expect(gone.text).toContain("找不到指令");
  });
});

describe("/me lottery", () => {
  it("buys from the notice's button, answering only the buyer", async () => {
    const r = await rig({ auction: false });
    r.wallet.fund(BOB, 100);
    const registry = registryWith(r.service);
    const bought = await press(registry, BOB, componentId(ROUTES.buy, 5));
    expect(bought?.ephemeral).toBe(true);
    if (bought?.result.type === "reply") expect(bought.result.reply.text).toContain("買了 5 張");
    expect(await press(registry, BOB, componentId(ROUTES.buy, 3))).toMatchObject({
      result: { type: "reply" },
    });
    const view = await registry.dispatch({ path: ["me", "lottery"], args: {}, ...who(BOB) });
    expect(view.text).toContain("你有 5 張");
    const two = { path: ["me", "lottery"], args: { count: 2 }, ...who(BOB) };
    const typed = await registry.dispatch(two);
    expect(typed.text).toContain("這週你一共 7 張");
  });
});

describe("/game lottery", () => {
  it("shows the week's pot to everyone, without anyone's own tickets", async () => {
    const r = await rig({ auction: false });
    r.wallet.fund(BOB, 100);
    const registry = registryWith(r.service);
    await registry.dispatch({ path: ["me", "lottery"], args: { count: 4 }, ...who(BOB) });
    const shown = await registry.dispatch({ path: ["game", "lottery"], args: {}, ...who(BOB) });
    expect(shown.ephemeral ?? false).toBe(false);
    expect(shown.text).not.toContain("你有");
    expect(shown.text).toContain("1 人買了 4 張,獎池 28");
  });
});
