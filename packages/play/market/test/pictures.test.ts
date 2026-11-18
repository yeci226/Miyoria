// The market's pictures (docs/design/v5-play.md §11.5): the auction's notice (opening, redrawn
// after a bid on it, closing) and the lottery's (the week, the draw or the refund) carry the
// `auction` / `lottery` picture above their text with its summary as the alt text; `/me auction`
// and `/me lottery` show the member's own bid and tickets on it. Without a renderer, when it
// answers nothing, throws or is too slow, or when the channel takes no upload, the text card goes
// alone. A bid or a purchase never waits for a picture.

import {
  type CardBlock,
  CommandRegistry,
  type CommandReply,
  componentId,
  Permissions,
} from "@miyoria/commands";
import type {
  AccountRef,
  AuctionPictureData,
  ContextKey,
  LotteryPictureData,
  Pictures,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { registerCommands } from "../src/commands.js";
import { ROUTES } from "../src/notices.js";
import { drawPicture } from "../src/pictures.js";
import { ALICE, BOB, CAROL, DAY, DRAW, FakePictures, OPENS, type RigOptions, rig } from "./rig.js";

const ctx: ContextKey = { platform: "discord", scope: "g", channel: "100", kind: "channel" };

const image = (reply: CommandReply | undefined): CardBlock | undefined =>
  reply?.card?.blocks[0]?.type === "image" ? reply.card.blocks[0] : undefined;

/** A rig with the frame lot open and three funded bidders. */
async function openLot(options: RigOptions = {}) {
  const r = await rig({ lottery: false }, options);
  r.clock.at = OPENS;
  await r.service.tick();
  for (const a of [ALICE, BOB, CAROL]) r.wallet.fund(a, 1000);
  return r;
}

describe("the auction's pictures", () => {
  it("go above the opening and the closing notice, with the summary as the alt text", async () => {
    const pictures = new FakePictures();
    const r = await openLot({ pictures });
    const opening = r.posted[0]?.reply;
    expect(image(opening)).toEqual({
      type: "image",
      name: "miyoria-auction.png",
      alt: "auction 的摘要",
    });
    expect(opening?.files?.map((f) => f.name)).toEqual(["miyoria-auction.png"]);
    // The text card is still all there under it.
    expect(opening?.text).toContain("起標 50");
    expect(pictures.drawn[0]?.data).toMatchObject({
      state: "open",
      item: { name: "只此一件的卡框", detail: expect.any(String) },
      start_bid: 50,
      step: 5,
      top: null,
      mine: null,
      utc_offset_minutes: 480,
      ends_at: new Date(OPENS + DAY).toISOString(),
    } satisfies Partial<AuctionPictureData>);

    await r.service.bid(ALICE, 50);
    await r.service.bid(BOB, 80);
    r.clock.at = OPENS + DAY;
    await r.service.tick();
    const closing = r.posted.at(-1)?.reply;
    expect(closing?.text).toContain("Bob 以 80 魚幣得標");
    expect(image(closing)).toMatchObject({ type: "image", alt: "auction 的摘要" });
    expect(pictures.drawn.at(-1)?.data).toMatchObject({
      state: "closed",
      top: { amount: 80, name: "Bob" },
      bids: 2,
      bidders: 2,
      mine: null,
      history: [
        { amount: 80, name: "Bob" },
        { amount: 50, name: "Alice" },
      ],
    });
  });

  it("fall back to the text card without a renderer, a null, a throw or a channel without uploads", async () => {
    const bare = await openLot();
    expect(image(bare.posted[0]?.reply)).toBeUndefined();
    expect(bare.posted[0]?.reply.files).toBeUndefined();
    for (const mode of ["null", "throw"] as const) {
      const pictures = new FakePictures();
      pictures.mode = mode;
      const r = await openLot({ pictures });
      expect(pictures.drawn).toHaveLength(1);
      expect(image(r.posted[0]?.reply)).toBeUndefined();
      expect(r.posted[0]?.reply.text).toContain("起標 50");
    }
    // The post with the picture does not go: the same notice goes as text.
    const noUploads = await openLot({ pictures: new FakePictures(), noUploads: true });
    expect(noUploads.posted).toHaveLength(1);
    expect(image(noUploads.posted[0]?.reply)).toBeUndefined();
    expect(noUploads.store.lotsIn(["open"])[0]?.message_id).toBe("m1");
  });

  it("never stand in the way of a bid", async () => {
    const pictures = new FakePictures();
    const r = await openLot({ pictures });
    const before = pictures.drawn.length;
    pictures.mode = "hang";
    expect(await r.service.bid(ALICE, 60)).toMatchObject({ ok: true, amount: 60 });
    // The bid itself draws nothing; the hold is in.
    expect(pictures.drawn).toHaveLength(before);
    expect(r.wallet.balanceOf("p-alice")).toBe(940);
  });

  it("give up on a renderer that is too slow", async () => {
    const pictures: Pictures = {
      render: () => new Promise(() => undefined),
      forMember: async () => null,
    };
    expect(await drawPicture(pictures, "auction", {} as AuctionPictureData, 20)).toBeNull();
    expect(await drawPicture(null, "auction", {} as AuctionPictureData)).toBeNull();
  });
});

describe("the commands' pictures", () => {
  const who = (account: AccountRef, name: string) => ({
    invoker: account,
    invoker_display_name: name,
    context: ctx,
    invoker_is_guild_admin: false,
  });

  it("show the member's own bid on /me auction, and nobody's on the edited notice", async () => {
    const pictures = new FakePictures();
    const r = await openLot({ pictures });
    const registry = new CommandRegistry(Permissions.fromStrings(["discord:1", "discord:2"]));
    registerCommands(registry, () => r.service);
    // A bid through the notice's modal: the bid stands, the notice is redrawn for everyone.
    const pressed = await registry.dispatchComponent({
      custom_id: componentId(ROUTES.bidForm),
      ...who(ALICE, "Alice"),
      message_id: "m1",
      fields: { amount: "70" },
    });
    expect(pressed?.result.type).toBe("update");
    if (pressed?.result.type === "update") expect(image(pressed.result.reply)).toBeDefined();
    expect(pictures.drawn.at(-1)?.data).toMatchObject({ mine: null, top: { amount: 70 } });
    const mine = await registry.dispatch({ path: ["me", "auction"], args: {}, ...who(BOB, "Bob") });
    expect(image(mine)).toBeDefined();
    expect(pictures.drawn.at(-1)?.data).toMatchObject({ mine: null });
    await registry.dispatch({ path: ["me", "auction"], args: { bid: 90 }, ...who(BOB, "Bob") });
    expect(pictures.drawn.at(-1)?.data).toMatchObject({ mine: { amount: 90, leading: true } });
    // A renderer that answers nothing leaves the card as it was.
    pictures.mode = "null";
    const plain = await registry.dispatch({
      path: ["me", "auction"],
      args: {},
      ...who(BOB, "Bob"),
    });
    expect(image(plain)).toBeUndefined();
    expect(plain.text).toContain("Bob 90 魚幣");
  });

  it("show the member's own tickets on /me lottery and after a purchase that went through", async () => {
    const pictures = new FakePictures();
    const r = await rig({ auction: false }, { pictures });
    r.wallet.fund(BOB, 100);
    const registry = new CommandRegistry(Permissions.fromStrings(["discord:2"]));
    registerCommands(registry, () => r.service);
    pictures.mode = "throw";
    const bought = await registry.dispatch({
      path: ["me", "lottery"],
      args: { count: 3 },
      ...who(BOB, "Bob"),
    });
    // Paid, whatever the picture did.
    expect(bought.text).toContain("買了 3 張");
    expect(r.wallet.balanceOf("p-bob")).toBe(70);
    expect(image(bought)).toBeUndefined();
    pictures.mode = "ok";
    const view = await registry.dispatch({ path: ["me", "lottery"], args: {}, ...who(BOB, "Bob") });
    expect(image(view)).toMatchObject({ alt: "lottery 的摘要" });
    expect(view.text).toContain("你有 3 張");
    expect(pictures.drawn.at(-1)?.data).toMatchObject({
      state: "open",
      mine: { tickets: 3 },
      tickets: 3,
      players: 1,
      pot: 30,
    } satisfies Partial<LotteryPictureData>);
  });
});

describe("the lottery's pictures", () => {
  it("go above the week's notice and the draw, and say when it was refunded", async () => {
    const pictures = new FakePictures();
    const r = await rig({ auction: false }, { pictures });
    await r.service.tick();
    const week = r.posted[0]?.reply;
    expect(week?.card?.title).toBe("每週樂透");
    expect(image(week)).toMatchObject({ alt: "lottery 的摘要" });
    expect(pictures.drawn[0]?.data).toMatchObject({
      state: "open",
      mine: null,
      ticket_price: 10,
      per_person: 20,
      min_players: 3,
      prize_share: 0.7,
      draw_at: new Date(DRAW).toISOString(),
    });
    for (const a of [ALICE, BOB, CAROL]) {
      r.wallet.fund(a, 100);
      await r.service.buyTickets(a, 2, `k${a.id}`);
    }
    r.dice.push(3);
    r.clock.at = DRAW;
    await r.service.tick();
    const drawn = r.posted.find((p) => p.reply.text.includes("開獎了"))?.reply;
    expect(image(drawn)).toBeDefined();
    const data = pictures.drawn.find((d) => (d.data as LotteryPictureData).state === "drawn");
    expect(data?.data).toMatchObject({
      state: "drawn",
      tickets: 6,
      players: 3,
      pot: 60,
      prize_share: 0.7,
      winners: [{ name: "Bob", prize: 42 }],
    });

    const few = await rig({ auction: false }, { pictures: new FakePictures() });
    few.wallet.fund(ALICE, 100);
    await few.service.buyTickets(ALICE, 1, "k");
    few.clock.at = DRAW;
    await few.service.tick();
    const refunded = few.posted.find((p) => p.reply.text.includes("不開獎"))?.reply;
    expect(image(refunded)).toBeDefined();
  });
});
