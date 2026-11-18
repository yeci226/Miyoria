// A member's own pictures are put together from what their member page shows them
// (docs/design/v5-play.md §11.5): words and the ring's coarse place for the profile, never a number
// of the bond; their own coins of this week; nothing for someone she does not know or blocked.

import { layoutPicture } from "@miyoria/card-face/pictures";
import { EconomyKey } from "@miyoria/economy";
import { heartTables } from "@miyoria/heart/person";
import { ServiceRegistry } from "@miyoria/runtime/kernel";
import { PeopleStoreKey, SqliteStore, StoreKey } from "@miyoria/store";
import {
  type AccountRef,
  AuthorizerKey,
  type Clock,
  type PersonId,
  SocialSignalsKey,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { memberPicture } from "../src/picture-data.js";
import type { ApiState } from "../src/state.js";

const NOW = Date.parse("2026-11-17T04:00:00.000Z");
const clock: Clock = { now: () => NOW };
const FISH: AccountRef = { platform: "discord", id: "11" };
const STRANGER: AccountRef = { platform: "discord", id: "99" };

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});

async function fakeState(blocked = false) {
  const db = await SqliteStore.open(":memory:", { plugins: [heartTables], clock });
  cleanup.push(() => db.close());
  const heart = db.plugin(heartTables).people;
  const person = "P-FISH" as PersonId;
  heart.adminSet(person, "bond", 342.5);
  heart.adminSet(person, "trust", 55);
  heart.adminSet(person, "familiarity", 45);
  heart.edit(person, { call_name: "小魚", public_feeling: "今天也謝謝你。" });
  if (blocked) heart.setTag(person, "blocked", true);
  const services = new ServiceRegistry();
  services.provide("store", StoreKey, { plugin: (p: never) => db.plugin(p) } as never);
  services.provide("people", PeopleStoreKey, {
    personByAccount: async (a: AccountRef) =>
      a.id === FISH.id ? { id: person, accounts: [{ account: FISH }] } : null,
  } as never);
  services.provide("social", SocialSignalsKey, { attitude: () => null } as never);
  services.provide("auth", AuthorizerKey, { allows: () => true } as never);
  services.provide("economy", EconomyKey, {
    wallet: async () => ({ currency: "魚幣", balance: 1280, streak: 6 }),
    exportWallet: async () => ({
      balance: 1280,
      ledger: [
        { ts: "2026-11-16T12:00:00.000Z", delta: 30, label: "簽到" },
        { ts: "2026-11-17T01:00:00.000Z", delta: -90, label: "每日卡" },
        { ts: "2026-11-01T01:00:00.000Z", delta: 500, label: "簽到" },
      ],
    }),
  } as never);
  const state = {
    optional: (key: never) => services.get(key),
    now: () => NOW,
    profile: () => "p",
    ctx: {},
    publicSide: {
      config: { utc_offset_minutes: 480 },
      names: async () => [],
      passes: () => true,
    },
  } as unknown as ApiState;
  return state;
}

describe("a member's pictures", () => {
  it("the profile is the ring's place and words, with no number of the bond", async () => {
    const state = await fakeState();
    const p = await memberPicture(state, { account: FISH, name: "小魚乾" }, "profile");
    expect(p?.kind).toBe("profile");
    expect(p?.person).toBe("P-FISH");
    const data = p?.data;
    if (data === undefined || !("variant" in data) || data.variant !== "member") {
      throw new Error("expected a member profile");
    }
    expect(data.call_name).toBe("小魚");
    expect(data.feeling).toBe("今天也謝謝你。");
    expect(data.trust).toBe("信任");
    // The ring's fraction is in twentieths; nothing carries 342.
    expect((data.ring.fraction * 20) % 1).toBe(0);
    expect(JSON.stringify(data)).not.toContain("342");
    expect(layoutPicture("profile", data).alt).not.toMatch(/\d{2}/);
  });

  it("the wallet is this week's own ledger and the balance", async () => {
    const state = await fakeState();
    const p = await memberPicture(state, { account: FISH, name: "小魚乾" }, "wallet");
    const data = p?.data as {
      balance: number;
      income: unknown;
      spending: unknown;
      days: unknown[];
    };
    expect(data.balance).toBe(1280);
    expect(data.days).toHaveLength(7);
    expect(data.income).toEqual([{ label: "簽到", amount: 30 }]);
    expect(data.spending).toEqual([{ label: "每日卡", amount: 90 }]);
  });

  it("is nothing for someone she does not know, or blocked", async () => {
    const state = await fakeState();
    expect(await memberPicture(state, { account: STRANGER, name: "x" }, "profile")).toBeNull();
    expect(await memberPicture(state, { account: STRANGER, name: "x" }, "wallet")).toBeNull();
    const blocked = await fakeState(true);
    expect(await memberPicture(blocked, { account: FISH, name: "小魚乾" }, "profile")).toBeNull();
    expect(await memberPicture(blocked, { account: FISH, name: "小魚乾" }, "week")).toBeNull();
  });
});
