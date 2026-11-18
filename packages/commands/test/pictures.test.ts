// Picture messages in replies (docs/design/v5-play.md §11.5): `pictureParts`, and `/me card`'s dex
// and odds with their pictures over the same text, and the text alone without one.

import { ServiceRegistry } from "@miyoria/runtime/kernel";
import {
  type Keepsakes,
  KeepsakesKey,
  type MemberPictureKind,
  type PictureFile,
  type Pictures,
  PicturesKey,
  type PictureWho,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  CommandRegistry,
  cardText,
  Invocation,
  Permissions,
  pictureParts,
  registerKeepsakes,
  splitPath,
} from "../src/index.js";
import { guildContext } from "./helpers.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const file = (kind: string): PictureFile => ({
  name: `miyoria-${kind}.png`,
  data: PNG,
  contentType: "image/png",
  alt: `${kind} 的一行摘要`,
  artifact_id: null,
});

class FakePictures implements Pictures {
  readonly asked: { who: PictureWho; kind: MemberPictureKind }[] = [];
  constructor(readonly draws: boolean) {}
  async render() {
    return null;
  }
  async forMember(who: PictureWho, kind: MemberPictureKind) {
    this.asked.push({ who, kind });
    return { alt: `${kind} 的一行摘要`, file: this.draws ? file(kind) : null };
  }
}

const KEEPSAKES = {
  cardOdds: async () => ({
    rarities: [{ rarity: "N", shown: "100.00" }],
    pity_after: null,
    price: 30,
    per_day: 3,
    slots: [],
  }),
  cardBook: async () => ({
    ok: true as const,
    value: {
      series: [],
      parts: { owned: 1, total: 2 },
      titles: [],
      legacy: [],
      pity: { since: 0, pity: 10, until: 10 },
      wishlist: [],
    },
    charged: 0,
    balance: null,
  }),
} as unknown as Keepsakes;

function setup(pictures: Pictures | null) {
  const services = new ServiceRegistry();
  services.provide("test", KeepsakesKey, KEEPSAKES);
  if (pictures) services.provide("test", PicturesKey, pictures);
  const registry = new CommandRegistry(Permissions.fromStrings(["discord:1"])).withServices(
    services,
  );
  registerKeepsakes(registry, services);
  return (action: string) =>
    registry.dispatch(
      new Invocation({
        path: splitPath("me card"),
        args: { action },
        invoker: { platform: "discord", id: "1" },
        invoker_display_name: "小魚乾",
        context: guildContext,
        invoker_is_guild_admin: false,
      }),
    );
}

describe("pictureParts", () => {
  it("is the image block with its alt and the file, or nothing", () => {
    expect(pictureParts(file("wallet"))).toEqual({
      blocks: [{ type: "image", name: "miyoria-wallet.png", alt: "wallet 的一行摘要" }],
      files: [{ name: "miyoria-wallet.png", data: PNG, contentType: "image/png" }],
    });
    expect(pictureParts(null)).toEqual({ blocks: [], files: [] });
    // A picture adds nothing to the text a text platform reads.
    const blocks = pictureParts(file("x")).blocks;
    expect(cardText({ accent: "neutral", title: null, blocks })).toBe("");
  });
});

describe("/me card's dex and odds pictures", () => {
  it("put the picture over the same text", async () => {
    const pictures = new FakePictures(true);
    const run = setup(pictures);
    const dex = await run("圖鑑");
    expect(dex.card?.blocks[0]).toEqual({
      type: "image",
      name: "miyoria-dex.png",
      alt: "dex 的一行摘要",
    });
    expect(dex.files?.[0]?.name).toBe("miyoria-dex.png");
    expect(dex.text).toContain("收集到 1 / 2 種部件。");
    const odds = await run("機率");
    expect(odds.card?.blocks[0]).toMatchObject({ type: "image", name: "miyoria-odds.png" });
    expect(pictures.asked.map((a) => a.kind)).toEqual(["dex", "odds"]);
    expect(pictures.asked[0]?.who.name).toBe("小魚乾");
  });

  it("are the text alone without a picture", async () => {
    for (const pictures of [null, new FakePictures(false)]) {
      const run = setup(pictures);
      const dex = await run("圖鑑");
      expect(dex.files).toBeUndefined();
      expect(dex.card?.blocks[0]?.type).toBe("text");
      expect((await run("機率")).files).toBeUndefined();
    }
  });
});
