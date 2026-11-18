// `/me wallet` with the picture of this week's coins (docs/design/v5-play.md §11.5): the picture
// over the same text and buttons, `picture:false` (the panel's status line) for the words alone,
// and the words alone whenever there is no picture.

import { CommandRegistry, Permissions } from "@miyoria/commands";
import { ServiceRegistry } from "@miyoria/runtime/kernel";
import {
  type AccountRef,
  type ContextKey,
  type MemberPictureKind,
  type PictureFile,
  type Pictures,
  PicturesKey,
  type PictureWho,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { EconomyCommands } from "../src/commands.js";
import { type Economy, EconomyKey, type WalletView } from "../src/types.js";

const ctx: ContextKey = { platform: "discord", scope: "g", channel: "9", kind: "channel" };
const BOB: AccountRef = { platform: "discord", id: "5" };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

const VIEW: WalletView = {
  currency: "魚幣",
  balance: 1280,
  can_earn: true,
  today_earned: 30,
  checked_in_today: false,
  streak: 6,
  earn: [],
  shop: [],
  frames: { owned: [], selected: null },
  hungry: null,
  recent: [],
  on_board: false,
  transfer_fee: 0.05,
};

class FakePictures implements Pictures {
  readonly asked: { who: PictureWho; kind: MemberPictureKind }[] = [];
  constructor(readonly file: PictureFile | null) {}
  async render() {
    return null;
  }
  async forMember(who: PictureWho, kind: MemberPictureKind) {
    this.asked.push({ who, kind });
    return { alt: "小魚乾的錢包：餘額 1,280 魚幣", file: this.file };
  }
}

const FILE: PictureFile = {
  name: "miyoria-wallet.png",
  data: PNG,
  contentType: "image/png",
  alt: "小魚乾的錢包：餘額 1,280 魚幣",
  artifact_id: null,
};

function setup(pictures: Pictures | null) {
  const registry = new CommandRegistry(Permissions.fromStrings(["discord:1"]));
  const services = new ServiceRegistry();
  services.provide("test", EconomyKey, { wallet: async () => VIEW } as unknown as Economy);
  if (pictures) services.provide("test", PicturesKey, pictures);
  new EconomyCommands().install(registry, services);
  const run = (args: Record<string, boolean> = {}) =>
    registry.dispatch({
      path: ["me", "wallet"],
      args,
      invoker: BOB,
      invoker_display_name: "小魚乾",
      context: ctx,
      invoker_is_guild_admin: false,
    });
  return run;
}

describe("/me wallet picture", () => {
  it("puts the week's picture over the text, its summary as the alt text", async () => {
    const pictures = new FakePictures(FILE);
    const reply = await setup(pictures)();
    expect(pictures.asked).toEqual([{ who: { account: BOB, name: "小魚乾" }, kind: "wallet" }]);
    expect(reply.card?.blocks[0]).toEqual({
      type: "image",
      name: "miyoria-wallet.png",
      alt: "小魚乾的錢包：餘額 1,280 魚幣",
    });
    expect(reply.files).toEqual([
      { name: "miyoria-wallet.png", data: PNG, contentType: "image/png" },
    ]);
    expect(reply.text).toContain("1280 魚幣");
  });

  it("is the words alone with picture:false, without the renderer, or when drawing fails", async () => {
    const asked = new FakePictures(FILE);
    const off = await setup(asked)({ picture: false });
    expect(asked.asked).toEqual([]);
    expect(off.files).toBeUndefined();
    for (const pictures of [null, new FakePictures(null)]) {
      const reply = await setup(pictures)();
      expect(reply.files).toBeUndefined();
      expect(reply.card?.blocks[0]?.type).toBe("text");
      expect(reply.text).toContain("1280 魚幣");
    }
  });
});
