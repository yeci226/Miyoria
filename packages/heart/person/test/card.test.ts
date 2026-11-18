// The heart module's card on the panel: the people she has a row for, and the ones whose numbers
// changed on her local day, counted from the log.

import { CARD_MAX_FACTS, Supervisor } from "@miyoria/runtime/kernel";
import { SqliteStore, StoreKey } from "@miyoria/store";
import { afterEach, describe, expect, it } from "vitest";
import { HeartModule, heartTables } from "../src/index.js";

/** 2026-11-17 10:00 in her time zone (UTC+8). */
const T0 = Date.UTC(2026, 10, 17, 2, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const clock = { now: () => T0 };

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

async function start() {
  const store = await SqliteStore.open(":memory:", { plugins: [heartTables], clock });
  cleanup.push(() => store.close());
  const sup = new Supervisor();
  cleanup.push(() => sup.stopAll());
  sup.services.provide("app", StoreKey, store);
  const module = new HeartModule("p", { clock });
  await sup.register(module, null, true);
  await sup.startAll();
  return { module, people: store.plugin(heartTables).people };
}

describe("heart card", () => {
  it("counts the people, and those changed since her midnight, each once", async () => {
    const { module, people } = await start();
    for (const p of ["amy", "bob", "cat"]) people.edit(p, {}, { now: T0 - 30 * HOUR });
    // Before her midnight (16:00 UTC the day before): not today.
    people.adminSet("amy", "bond", 30, { now: T0 - 11 * HOUR });
    // Today, twice for the same person.
    people.adminSet("bob", "bond", 20, { now: T0 - HOUR });
    people.adminSet("bob", "trust", 40, { now: T0 });
    const card = await module.card();
    expect(card.facts.length).toBeLessThanOrEqual(CARD_MAX_FACTS);
    expect(card).toEqual({
      facts: [
        { label: "認識的人", value: 3, unit: "人" },
        { label: "今天有變動", value: 1, unit: "人" },
      ],
    });
  });

  it("leaves the daily pass out of the day's changes", async () => {
    const { module, people } = await start();
    people.edit("amy", {}, { now: T0 - 40 * DAY });
    people.adminSet("amy", "bond", 300, { now: T0 - 40 * DAY });
    expect(people.applyDecay("amy", { now: T0 })?.changes.length).toBeGreaterThan(0);
    expect((await module.card()).facts).toEqual([
      { label: "認識的人", value: 1, unit: "人" },
      { label: "今天有變動", value: 0, unit: "人" },
    ]);
  });

  it("has nothing to show before it runs, or without a store", async () => {
    expect(await new HeartModule("p", { clock }).card()).toEqual({ facts: [] });
    const sup = new Supervisor();
    cleanup.push(() => sup.stopAll());
    const module = new HeartModule("p", { clock });
    await sup.register(module, null, true);
    await sup.startAll();
    expect(await module.card()).toEqual({ facts: [] });
  });
});
