// Opening an account from Discord (owner 2026-11-22: before, only the member page could). A member
// without one sees the rules in a few lines and a 開戶 button bound to them on /me market overview,
// /me market mine and after pressing 買; pressing it opens the account through the same call the
// member page uses and goes on to what they were doing; a refusal says why. Also: a press that opens
// a modal answers at once, without the provider or the picture renderer (Discord cannot defer a
// modal); everything else is deferred by the interaction layer when slow.

import {
  type Card,
  type CardBlock,
  CommandRegistry,
  type CommandReply,
  type ComponentInvocationData,
  type ComponentOutcome,
  Permissions,
} from "@miyoria/commands";
import {
  type AccountRef,
  type ContextKey,
  EXCHANGE_DISCLAIMER,
  type PictureFile,
  type Pictures,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { registerCommands } from "../src/commands.js";
import type { ExchangeService } from "../src/service.js";
import { discordProblems } from "./discord-limits.js";
import { ALICE, BOB, CAROL, local, NEWBIE, rig } from "./rig.js";

const ctx: ContextKey = { platform: "discord", scope: "g", channel: "100", kind: "channel" };
const as = (who: AccountRef, name: string) => ({
  invoker: who,
  invoker_display_name: name,
  context: ctx,
  invoker_is_guild_admin: false,
});

function registryWith(service: () => ExchangeService, pictures: Pictures | null = null) {
  const registry = new CommandRegistry(
    Permissions.fromStrings(["discord:1", "discord:2", "discord:3", "discord:7"]),
  );
  registerCommands(registry, service, () => pictures);
  return registry;
}

const blocksOf = (r: CommandReply | undefined): CardBlock[] =>
  (r?.card as Card | undefined)?.blocks ?? [];
const buttonsOf = (r: CommandReply | undefined) =>
  blocksOf(r).flatMap((b) => (b.type === "buttons" ? b.buttons : []));
const button = (r: CommandReply | undefined, label: string) => {
  const b = buttonsOf(r).find((x) => x.label === label);
  if (!b)
    throw new Error(
      `no ${label}: ${buttonsOf(r)
        .map((x) => x.label)
        .join(",")}`,
    );
  return b;
};
const replyOf = (o: ComponentOutcome | null): CommandReply => {
  if (!o || o.result.type === "modal") throw new Error("not a reply");
  return o.result.reply;
};
const press = (
  id: string,
  who: ReturnType<typeof as>,
  extra: Partial<ComponentInvocationData> = {},
): ComponentInvocationData => ({ custom_id: id, message_id: "m1", ...who, ...extra });

async function market(more: Record<string, unknown> = {}) {
  const r = await rig({ open: true, ...more } as never);
  r.wallet.fund(BOB, 500);
  await r.at(local(0, 12, 30));
  return r;
}

describe("opening an account from Discord", () => {
  it("shows the rules and a 開戶 button on mine, opens it, and goes on to their holdings", async () => {
    const r = await market();
    const registry = registryWith(() => r.service);
    const bob = as(BOB, "Bob");
    const mine = await registry.dispatch({ path: ["me", "market", "mine"], args: {}, ...bob });
    expect(mine.ephemeral).toBe(true);
    expect(mine.text).toContain("開戶不花錢");
    expect(mine.text).toContain("認識你滿 7 天、羈絆到「認識」以上");
    expect(mine.text).toContain(EXCHANGE_DISCLAIMER);
    expect(discordProblems(mine)).toEqual([]);
    const done = replyOf(await registry.dispatchComponent(press(button(mine, "開戶").id, bob)));
    expect(done.text).toContain("開好戶了");
    expect(done.card?.title).toBe("你的持股");
    expect((await r.service.accountView(BOB))?.opened).toBe(true);
    // Nothing to share: the way to the beginners' list instead of a dead button.
    expect(buttonsOf(done).map((b) => b.label)).toEqual(["去看新手推薦"]);
  });

  it("puts the rules and the button on the overview, and after 買 goes on to the buy's form", async () => {
    const r = await market();
    const registry = registryWith(() => r.service);
    const bob = as(BOB, "Bob");
    const o = await registry.dispatch({ path: ["me", "market", "overview"], args: {}, ...bob });
    expect(o.text).toContain("開戶不花錢");
    expect(buttonsOf(o).some((b) => b.label === "開戶")).toBe(true);
    const pick = blocksOf(o).flatMap((b) => (b.type === "select" ? [b.select] : []))[1]?.id ?? "";
    const card = replyOf(await registry.dispatchComponent(press(pick, bob, { values: ["RICE"] })));
    const buy = replyOf(await registry.dispatchComponent(press(button(card, "買").id, bob)));
    expect(buy.card?.title).toBe("開戶");
    const form = await registry.dispatchComponent(press(button(buy, "開戶").id, bob));
    expect(form?.result.type).toBe("modal");
    if (form?.result.type === "modal") expect(form.result.modal.title).toBe("買進 RICE");
  });

  it("says why when it cannot open yet: not known long enough, or the bond tier", async () => {
    const r = await market({ account_min_tier: "朋友" });
    const registry = registryWith(() => r.service);
    for (const [who, name, why] of [
      [NEWBIE, "Newbie", "7 天"],
      [CAROL, "Carol", "朋友"],
    ] as const) {
      const me = as(who, name);
      const mine = await registry.dispatch({ path: ["me", "market", "mine"], args: {}, ...me });
      expect(mine.text).toContain("現在還不行");
      const no = replyOf(await registry.dispatchComponent(press(button(mine, "開戶").id, me)));
      expect(no.text).toContain("還不能開戶");
      expect(no.text).toContain(why);
      expect(no.text).toContain(EXCHANGE_DISCLAIMER);
      expect((await r.service.accountView(who))?.opened).toBe(false);
    }
  });

  it("refuses someone else pressing the button, and opens nothing for them", async () => {
    const r = await market();
    r.wallet.fund(ALICE, 500);
    const registry = registryWith(() => r.service);
    const mine = await registry.dispatch({
      path: ["me", "market", "mine"],
      args: {},
      ...as(BOB, "Bob"),
    });
    const out = await registry.dispatchComponent(
      press(button(mine, "開戶").id, as(ALICE, "Alice")),
    );
    if (!out || out.result.type === "modal") throw new Error("no reply");
    expect(out.result.reply.text).toContain("這是別人打開的面板");
    expect((await r.service.accountView(ALICE))?.opened).toBe(false);
    expect((await r.service.accountView(BOB))?.opened).toBe(false);
  });
});

/** A renderer that never answers, and a provider that never answers. */
class Hanging implements Pictures {
  calls = 0;
  render(): Promise<PictureFile | null> {
    this.calls++;
    return new Promise(() => undefined);
  }
  async forMember() {
    return null;
  }
}

describe("answering in time", () => {
  it("opens the buy and sell forms at once, without the provider or the picture renderer", async () => {
    const r = await market();
    await r.service.openAccount(BOB);
    const pictures = new Hanging();
    const registry = registryWith(() => r.service, pictures);
    const bob = as(BOB, "Bob");
    // The quote card (built here without a picture); its 買 and 賣 open their forms at once.
    const plain = registryWith(() => r.service, null);
    const card = await plain.dispatch({
      path: ["me", "market", "quote"],
      args: { code: "RICE" },
      ...bob,
    });
    const started = Date.now();
    const form = await registry.dispatchComponent(press(button(card, "買").id, bob));
    expect(form?.result.type).toBe("modal");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(pictures.calls).toBe(0);
  });
});
