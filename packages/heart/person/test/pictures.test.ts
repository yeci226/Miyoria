// Picture messages on `/me profile` and `/admin person show` (docs/design/v5-play.md §11.5): the
// personal card in place of the bare ring, `week:true` for the week's review, the owner's card with
// the numbers, and the ring or the text whenever there is no picture.

import { CommandRegistry, type InvocationData, Permissions } from "@miyoria/commands";
import { SqliteStore } from "@miyoria/store";
import type {
  AccountRef,
  Clock,
  MemberPictureKind,
  PictureDataMap,
  PictureFile,
  PictureKind,
  Pictures,
  PictureWho,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import {
  type BondRingImageSpec,
  type BondRingImages,
  heartTables,
  PeopleDirectory,
  registerCommands,
} from "../src/index.js";

const T0 = Date.UTC(2026, 10, 17, 2, 0, 0);
const clock: Clock = { now: () => T0 };
const OWNER: AccountRef = { platform: "discord", id: "1" };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

const file = (kind: string, alt: string): PictureFile => ({
  name: `miyoria-${kind}.png`,
  data: PNG,
  contentType: "image/png",
  alt,
  artifact_id: null,
});

class FakePictures implements Pictures {
  readonly asked: { who?: PictureWho; kind: string; data?: unknown }[] = [];
  constructor(readonly draws = true) {}
  async render<K extends PictureKind>(
    kind: K,
    data: PictureDataMap[K],
  ): Promise<PictureFile | null> {
    this.asked.push({ kind, data });
    return this.draws ? file(kind, `${kind} summary`) : null;
  }
  async forMember(who: PictureWho, kind: MemberPictureKind, options: { draw?: boolean } = {}) {
    this.asked.push({ who, kind });
    const alt = `${kind}：一行摘要 5 天`;
    return { alt, file: this.draws && options.draw !== false ? file(kind, alt) : null };
  }
}

class FakeImages implements BondRingImages {
  readonly specs: BondRingImageSpec[] = [];
  async png(spec: BondRingImageSpec): Promise<Uint8Array> {
    this.specs.push(spec);
    return PNG;
  }
}

async function world(pictures: () => Pictures | undefined, images = new FakeImages()) {
  const store = await SqliteStore.open(":memory:", { plugins: [heartTables], clock });
  cleanup.push(() => store.close());
  const people = new PeopleDirectory(
    "p",
    "米優",
    [],
    {
      people: store.people,
      identity: store.identity ?? null,
      heart: store.plugin(heartTables).people,
    },
    clock,
  );
  const registry = new CommandRegistry(Permissions.fromStrings([`discord:${OWNER.id}`]));
  const ring = () => images;
  registerCommands(registry, people, async () => null, ring, pictures);
  const me = (await people.resolve(OWNER, "小魚乾", T0)) as string;
  const run = (path: string, args: InvocationData["args"] = {}) =>
    registry.dispatch({
      path: path.split(" "),
      args,
      invoker: OWNER,
      invoker_display_name: "小魚乾",
      context: { platform: "discord", scope: "g1", channel: "c1", kind: "channel" },
      invoker_is_guild_admin: false,
    });
  return { people, me, run, images };
}

describe("/me profile with pictures", () => {
  it("sends the personal card in place of the ring, with its summary as the alt text", async () => {
    const pictures = new FakePictures();
    const w = await world(() => pictures);
    w.people.heart.adminSet(w.me, "bond", 120);
    const reply = await w.run("me profile");
    expect(pictures.asked).toEqual([{ who: { account: OWNER, name: "小魚乾" }, kind: "profile" }]);
    expect(reply.card?.blocks[0]).toEqual({
      type: "image",
      name: "miyoria-profile.png",
      alt: "profile：一行摘要 5 天",
    });
    expect(reply.files).toEqual([
      { name: "miyoria-profile.png", data: PNG, contentType: "image/png" },
    ]);
    expect(w.images.specs).toEqual([]);
    // The text and the buttons stay.
    expect(reply.text).toContain("關係");
    expect(reply.card?.blocks.some((b) => b.type === "buttons")).toBe(true);
  });

  it("picture:false is the words alone (a panel's status line draws nothing)", async () => {
    const pictures = new FakePictures();
    const w = await world(() => pictures);
    w.people.heart.adminSet(w.me, "bond", 120);
    const reply = await w.run("me profile", { picture: false });
    expect(reply.files).toBeUndefined();
    expect(pictures.asked).toEqual([]);
    expect(w.images.specs).toEqual([]);
    expect(reply.text).toContain("關係");
    const week = await w.run("me profile", { week: true, picture: false });
    expect(week.files).toBeUndefined();
    expect(week.text).toContain("week：一行摘要 5 天");
  });

  it("falls back to the ring when the card cannot be drawn", async () => {
    const w = await world(() => new FakePictures(false));
    w.people.heart.adminSet(w.me, "bond", 120);
    const reply = await w.run("me profile");
    expect(reply.files?.[0]?.name).toBe("bond-ring.png");
    expect(w.images.specs).toHaveLength(1);
  });

  it("week:true is the week's picture, and its summary in words without one", async () => {
    const pictures = new FakePictures();
    const w = await world(() => pictures);
    const reply = await w.run("me profile", { week: true });
    expect(pictures.asked.map((a) => a.kind)).toEqual(["week"]);
    expect(reply.card?.blocks).toEqual([
      { type: "image", name: "miyoria-week.png", alt: "week：一行摘要 5 天" },
    ]);
    expect(reply.text).toContain("week：一行摘要 5 天");

    const flat = await world(() => new FakePictures(false));
    const text = await flat.run("me profile", { week: true });
    expect(text.files).toBeUndefined();
    expect(text.text).toContain("week：一行摘要 5 天");

    const none = await world(() => undefined);
    const off = await none.run("me profile", { week: true });
    expect(off.text).toContain("這一週的回顧現在看不到");
  });
});

describe("/admin person show with pictures", () => {
  it("draws the owner's card with the eight numbers", async () => {
    const pictures = new FakePictures();
    const w = await world(() => pictures);
    w.people.heart.adminSet(w.me, "bond", 742.3);
    const reply = await w.run("admin person show", { user: `discord:${OWNER.id}` });
    expect(reply.files?.[0]?.name).toBe("miyoria-profile.png");
    const data = pictures.asked[0]?.data as PictureDataMap["profile"];
    expect(data.variant).toBe("admin");
    if (data.variant !== "admin") return;
    expect(data.bond).toBeCloseTo(742.3, 5);
    const eight = ["ease", "familiarity", "grudge", "longing", "rapport", "respect"];
    expect(Object.keys(data.values).sort()).toEqual([...eight, "trust", "warmth"]);
    expect(w.images.specs).toEqual([]);
    expect(reply.text).toContain("羈絆 742.3");
  });
});
