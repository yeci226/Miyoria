// `/me card` and `/me fortune`: neutral answers over the Keepsakes service, and the hub page.

import { ServiceRegistry } from "@miyoria/kernel";
import {
  type KeepsakeCard,
  type KeepsakeCardOrder,
  type KeepsakeCards,
  type KeepsakeFortune,
  type KeepsakeResult,
  type Keepsakes,
  KeepsakesKey,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  CommandRegistry,
  Invocation,
  Permissions,
  panelDefs,
  registerKeepsakes,
  splitPath,
} from "../src/index.js";
import { guildContext } from "./helpers.js";

const card = (number: number): KeepsakeCard => ({
  serial: `MYR-TEST-0000-000${number}`,
  number,
  issued_at: "2026-11-10T00:00:00.000Z",
  relationship: "好朋友",
  line: "今天也辛苦了",
  stamp: null,
  fields: [{ label: "願望", text: "會實現" }],
  foil: false,
});

const SLIP: KeepsakeFortune = {
  id: "f1",
  date: "2026-11-10",
  rank: "大吉",
  title: "春風得意",
  poem: ["月落烏啼", "江楓漁火", "姑蘇城外", "夜半鐘聲"],
  fields: [],
  line: "今天也辛苦了",
};

class Fake implements Keepsakes {
  issued: KeepsakeCard[] = [];
  keys: string[] = [];
  slip: KeepsakeFortune | null = null;
  refuse: { status: number; message: string } | null = null;

  async fortuneToday() {
    return { fortune: this.slip, price: 10 };
  }

  async drawFortune(_who: unknown, key: string): Promise<KeepsakeResult<KeepsakeFortune>> {
    this.keys.push(key);
    if (this.refuse) return { ok: false, ...this.refuse };
    const first = this.slip === null;
    this.slip = SLIP;
    return { ok: true, value: SLIP, charged: first ? 10 : 0, balance: 20 };
  }

  rerolled = 0;

  async cardsToday(): Promise<KeepsakeCards> {
    return {
      latest: this.issued.at(-1) ?? null,
      today: this.issued.length,
      per_day: 5,
      prices: { foil: 30, reroll: 15 },
      rerolls_left: 2 - this.rerolled,
    };
  }

  async issueCard(
    _who: unknown,
    key: string,
    order: KeepsakeCardOrder = {},
  ): Promise<KeepsakeResult<KeepsakeCard>> {
    this.keys.push(key);
    if (this.refuse) return { ok: false, ...this.refuse };
    const made = { ...card(this.issued.length + 1), foil: order.foil === true };
    this.issued.push(made);
    return { ok: true, value: made, charged: made.foil ? 30 : 0, balance: made.foil ? 70 : null };
  }

  async rerollCard(_who: unknown, key: string): Promise<KeepsakeResult<KeepsakeCard>> {
    this.keys.push(key);
    const last = this.issued.at(-1);
    if (!last) return { ok: false, status: 409, message: "今天沒有可以重抽的卡" };
    this.rerolled += 1;
    const made = { ...last, serial: `${last.serial}-R`, line: "重寫的一句" };
    this.issued[this.issued.length - 1] = made;
    return { ok: true, value: made, charged: 15, balance: 55 };
  }
}

function setup(withService = true) {
  const services = new ServiceRegistry();
  const fake = new Fake();
  if (withService) services.provide("test", KeepsakesKey, fake);
  const registry = new CommandRegistry(Permissions.fromStrings(["discord:1"])).withServices(
    services,
  );
  registerKeepsakes(registry, services);
  const run = (path: string, args: Record<string, string | boolean> = {}) =>
    registry.dispatch(
      new Invocation({
        path: splitPath(path),
        args,
        invoker: { platform: "discord", id: "1" },
        invoker_display_name: "Owen",
        context: guildContext,
        invoker_is_guild_admin: false,
      }),
    );
  return { registry, fake, run };
}

describe("me card", () => {
  it("issues one when there is none today and shows today's after that", async () => {
    const { run, fake, registry } = setup();
    expect(registry.get(["me", "card"])?.ephemeral).toBe(true);
    const first = await run("me card");
    expect(first.card?.accent).toBe("neutral");
    expect(first.text).toContain("第 1 張");
    expect(first.text).toContain("今天也辛苦了");
    expect(first.text).toContain("MYR-TEST-0000-0001");
    const again = await run("me card");
    expect(again.text).toContain("第 1 張");
    expect(again.text).toContain("今天發了 1 / 5 張");
    expect(fake.issued).toHaveLength(1);
    expect(fake.keys[0]).toMatch(/^discord:/);
  });

  it("issues another one today, as a foil card when asked, and says what it cost", async () => {
    const { run, fake } = setup();
    await run("me card");
    const shown = await run("me card");
    expect(shown.text).toContain("要再一張用 action:再發一張，加 foil 做成閃卡（30）");
    expect(shown.text).toContain("action:重抽（15，今天還能 2 次）");
    const plain = await run("me card", { action: "再發一張" });
    expect(plain.text).toContain("第 2 張");
    expect(plain.text).not.toContain("花了");
    // foil alone means a new card too.
    const foil = await run("me card", { foil: true });
    expect(foil.text).toContain("第 3 張　好朋友　閃卡");
    expect(foil.text).toContain("花了 30，剩 70");
    expect(fake.issued.map((c) => c.foil)).toEqual([false, false, true]);
  });

  it("rerolls today's newest card, and says plainly when there is none", async () => {
    const { run, fake } = setup();
    const none = await run("me card", { action: "重抽" });
    expect(none.text).toBe("今天沒有可以重抽的卡");
    expect(none.tone).toBe("info");
    await run("me card");
    const redone = await run("me card", { action: "重抽" });
    expect(redone.text).toContain("重寫的一句");
    expect(redone.text).toContain("花了 15，剩 55");
    expect(fake.issued).toHaveLength(1);
    // A reroll does not take a foil finish: that is a new card.
    expect((await run("me card", { action: "重抽", foil: true })).text).toContain("再發一張");
    expect(fake.rerolled).toBe(1);
  });

  it("answers a refusal as plain information, and a failure as a warning", async () => {
    const { run, fake } = setup();
    fake.refuse = { status: 429, message: "今天的卡已經發完了,明天再來" };
    const full = await run("me card");
    expect(full.text).toBe("今天的卡已經發完了,明天再來");
    expect(full.tone).toBe("info");
    fake.refuse = { status: 503, message: "這個 Core 還不能發卡" };
    expect((await run("me card")).tone).toBe("warn");
  });

  it("says so plainly when the api is not running", async () => {
    const { run } = setup(false);
    expect((await run("me card")).text).toBe("這個功能現在不能用。");
    expect((await run("me fortune")).text).toBe("這個功能現在不能用。");
  });
});

describe("me fortune", () => {
  it("shows the slip and what it cost, and the same slip for nothing the second time", async () => {
    const { run } = setup();
    const first = await run("me fortune");
    expect(first.card?.accent).toBe("neutral");
    expect(first.text).toContain("大吉　春風得意");
    expect(first.text).toContain("月落烏啼\n江楓漁火");
    expect(first.text).toContain("花了 10，剩 20");
    const again = await run("me fortune");
    expect(again.text).toContain("春風得意");
    expect(again.text).not.toContain("花了");
  });

  it("is refused in plain words for someone she does not know", async () => {
    const { run, fake } = setup();
    fake.refuse = { status: 403, message: "她還不認識你" };
    const reply = await run("me fortune");
    expect(reply.text).toBe("她還不認識你");
    expect(reply.tone).toBe("info");
  });
});

describe("the me panel", () => {
  it("has a page for the card, the slip and a letter, over commands that exist", () => {
    const me = panelDefs().find((d) => d.command === "me");
    const page = me?.pages.find((p) => p.id === "keepsakes");
    expect(page?.actions.map((a) => a.path)).toEqual(["me card", "me fortune", "me letter"]);
    expect(page?.actions.find((a) => a.id === "letter")?.ask?.fields.map((f) => f.arg)).toEqual([
      "text",
    ]);
  });
});
