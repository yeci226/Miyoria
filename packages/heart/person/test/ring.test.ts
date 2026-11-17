// The ring on `/me profile` and `/admin person show` (docs/design/v5-heart.md §2.7, §2.11): a PNG
// file block when a renderer is running, the text version without one, and `bondPlace`, the exact
// place of a bond on the ladder and the ring.

import { CommandRegistry, type InvocationData, Permissions } from "@miyoria/commands";
import { SqliteStore } from "@miyoria/store";
import type { AccountRef, Clock } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import {
  type BondRingImageSpec,
  type BondRingImages,
  bondPlace,
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

class FakeImages implements BondRingImages {
  readonly specs: BondRingImageSpec[] = [];
  async png(spec: BondRingImageSpec): Promise<Uint8Array> {
    this.specs.push(spec);
    return PNG;
  }
}

async function world(images: () => BondRingImages | undefined) {
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
  registerCommands(registry, people, async () => null, images);
  const me = (await people.resolve(OWNER, "Owen", T0)) as string;
  const run = (path: string, args: InvocationData["args"] = {}) =>
    registry.dispatch({
      path: path.split(" "),
      args,
      invoker: OWNER,
      invoker_display_name: "Owen",
      context: { platform: "discord", scope: "g1", channel: "c1", kind: "channel" },
      invoker_is_guild_admin: false,
    });
  return { people, me, run };
}

describe("bondPlace", () => {
  it("gives the tier, the next one and the ring exactly", () => {
    expect(bondPlace(742.3)).toMatchObject({ tier: "命運相連", next_tier: "無可取代" });
    expect(bondPlace(742.3).ring.lap).toBe(7);
    expect(bondPlace(742.3).ring.fraction).toBeCloseTo(0.423, 5);
    expect(bondPlace(742.3).tier_progress).toBeCloseTo((742.3 - 640) / 110, 5);
    expect(bondPlace(1000)).toMatchObject({ tier: "永恆羈絆", next_tier: null, tier_progress: 1 });
    expect(bondPlace(1000).ring).toEqual({ lap: 9, fraction: 1, full: true, below: 0 });
    expect(bondPlace(-60)).toMatchObject({ tier: "很討厭", next_tier: "認識", tier_progress: 0 });
    expect(bondPlace(-30).tier).toBe("討厭");
    expect(bondPlace(-60).ring).toMatchObject({ lap: 0, fraction: 0, full: false });
    expect(bondPlace(-60).ring.below).toBeCloseTo(0.6, 5);
  });
});

describe("/me profile", () => {
  it("attaches the ring as a PNG, without a number, with the tier and her line", async () => {
    const images = new FakeImages();
    const w = await world(() => images);
    w.people.heart.adminSet(w.me, "bond", 742.3);
    w.people.heart.adminSet(w.me, "familiarity", 90);
    const reply = await w.run("me profile");
    expect(reply.files).toEqual([{ name: "bond-ring.png", data: PNG, contentType: "image/png" }]);
    expect(reply.card?.blocks[0]).toEqual({ type: "file", name: "bond-ring.png" });
    // The member's ring: coarse (a twentieth), nothing of the bond itself.
    expect(images.specs).toEqual([{ lap: 7, fraction: 0.4, full: false, below: 0 }]);
    expect(JSON.stringify(images.specs)).not.toContain("742");
    expect(reply.text).toContain("命運相連");
    expect(reply.text).not.toContain("742");
  });

  it("is the text version without a renderer, and for someone she has no row for", async () => {
    const none = await world(() => undefined);
    none.people.heart.adminSet(none.me, "bond", 50);
    const text = await none.run("me profile");
    expect(text.files).toBeUndefined();
    expect(text.text).toContain("朋友");

    const images = new FakeImages();
    const fresh = await world(() => images);
    const reply = await fresh.run("me profile");
    expect(reply.files).toBeUndefined();
    expect(images.specs).toEqual([]);
  });

  it("goes on without the picture when drawing fails", async () => {
    const broken: BondRingImages = {
      png: async () => {
        throw new Error("no font");
      },
    };
    const w = await world(() => broken);
    w.people.heart.adminSet(w.me, "bond", 50);
    const reply = await w.run("me profile");
    expect(reply.files).toBeUndefined();
    expect(reply.text).toContain("朋友");
  });
});

describe("/admin person show", () => {
  it("attaches the ring with the number on the heart", async () => {
    const images = new FakeImages();
    const w = await world(() => images);
    w.people.heart.adminSet(w.me, "bond", 742.3);
    const reply = await w.run("admin person show", { user: `discord:${OWNER.id}` });
    expect(reply.files?.[0]?.name).toBe("bond-ring.png");
    expect(images.specs).toHaveLength(1);
    expect(images.specs[0]).toMatchObject({ lap: 7, full: false, below: 0, value: 742.3 });
    expect(images.specs[0]?.fraction).toBeCloseTo(0.423, 5);
  });
});
