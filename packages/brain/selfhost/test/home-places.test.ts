// Her home and the other places (phase 6, docs/design/v5-places.md §9): a run at her home sees
// one merged line per other Space that has something waiting (its name and a count by kind,
// never the words), at most four and the rest as "and N more"; `look(place)` reads one of them as
// far as memory's place rule allows from the run's place; a run inside a Space sees nothing of
// another one.

import { transcriptTables } from "@miyoria/memory/transcript";
import { SqliteStore } from "@miyoria/store";
import { type ContextKey, PlacesKey } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { initiativeSettings } from "../src/initiative-config.js";
import { initiativeTables } from "../src/initiative-store.js";
import { calls, dm, mention, Rig, says, stopRigs, textOf, until } from "./harness.js";

const stores: SqliteStore[] = [];
afterEach(async () => {
  await stopRigs();
  for (const s of stores.splice(0)) await s.close();
});

const ctx = (scope: string, channel: string): ContextKey => ({
  platform: "test",
  scope,
  channel,
  kind: "channel",
});
const H1 = ctx("gH", "h1");
const A1 = ctx("gA", "a1");
const B1 = ctx("gB", "b1");
const B2 = ctx("gB", "b2");
const D1 = dm("d1");

const AT = Date.parse("2026-11-22T00:00:00Z");

/**
 * A store with her home's server H, A, and five more: B (two items that wake her, one of Amy's,
 * one of Bob's), C (a result only: the least pressing), D, E, F (one each).
 */
async function world() {
  const db = await SqliteStore.open(":memory:", { plugins: [transcriptTables, initiativeTables] });
  stores.push(db);
  const author = { account: { platform: "test", id: "x" }, display_name: "x" };
  const space = (c: ContextKey, name: string) =>
    db.persons.resolve(c, author, { space_name: name }).space_id as string;
  space(H1, "家");
  space(A1, "伺服器A");
  const B = space(B1, "伺服器B");
  space(B2, "伺服器B");
  const more = ["C", "D", "E", "F"].map((n) =>
    space(ctx(`g${n}`, `${n.toLowerCase()}1`), `伺服器${n}`),
  );
  const tables = db.plugin(initiativeTables);
  let n = 0;
  const add = (
    c: ContextKey | null,
    space_id: string,
    kind: "world" | "timer" | "result",
    text: string,
    person: string | null = null,
  ) =>
    tables.addItem({
      key: `k${n++}`,
      kind,
      session: c === null ? null : `test:${c.scope}:${c.channel}`,
      context: c,
      text,
      person,
      at: AT + n * 1000,
      space_id,
    });
  add(B1, B, "world", "B 的秘密:amy 說了一件事", "amy");
  add(null, B, "timer", "B 的提醒:bob 的事", "bob");
  add(null, more[0] as string, "result", "C 的結果");
  add(null, more[1] as string, "world", "D 的事");
  add(null, more[2] as string, "world", "E 的事");
  add(null, more[3] as string, "world", "F 的事");
  return db;
}

async function rigAt(db: SqliteStore, home: string): Promise<Rig> {
  return Rig.create({
    store: db,
    provide: (sup) => sup.services.provide("app", PlacesKey, db.places),
    host: { initiative: { settings: initiativeSettings({ home }) } },
  });
}

/** The tool result of the request after a `look` call. */
function lookResult(rig: Rig, request: number): string {
  const m = rig.model.requests[request]?.messages.findLast((x) => x.role === "tool");
  return String(m?.content ?? "");
}

const SECRETS = ["B 的秘密", "B 的提醒", "C 的結果", "D 的事", "E 的事", "F 的事"];

describe("her home and the other places", () => {
  it("merges the other places into one line each at home, capped, without their words", async () => {
    const db = await world();
    const rig = await rigAt(db, "h1");
    rig.model.push(says("嗯"));
    rig.say(mention(H1, "amy", "@她 在家嗎"));
    await until(() => rig.sink.texts().length === 1, 3_000, "her answer at home");
    const prompt = textOf(rig.model.requests[0]);
    expect(prompt).toContain("別的地方在等你的事");
    // The two that would wake her first; C (a result only) is the one left out.
    expect(prompt).toContain("- 伺服器B:2 件(時間到了 1、外面的事 1)");
    for (const n of ["D", "E", "F"]) expect(prompt).toContain(`- 伺服器${n}:1 件(外面的事 1)`);
    expect(prompt).toContain("- 還有 1 個地方也有事");
    expect(prompt).not.toContain("伺服器C");
    expect(prompt).not.toContain("伺服器A");
    for (const s of SECRETS) expect(prompt).not.toContain(s);
  });

  it("shows a run inside a Space nothing of another one", async () => {
    const db = await world();
    const rig = await rigAt(db, "h1");
    rig.model.push(says("嗨"), says("哈囉"));
    rig.say(mention(A1, "amy", "@她 你好"));
    await until(() => rig.sink.texts().length === 1, 3_000, "her answer in A");
    const inA = textOf(rig.model.requests[0]);
    expect(inA).not.toContain("別的地方在等你的事");
    for (const s of [...SECRETS, "伺服器B", "伺服器D"]) expect(inA).not.toContain(s);
    // In B she sees B's own (its home item there), and nothing of the others.
    rig.say(mention(B2, "amy", "@她 你好"));
    await until(() => rig.sink.texts().length === 2, 3_000, "her answer in B");
    const inB = textOf(rig.model.requests[1]);
    expect(inB).toContain("B 的提醒");
    for (const s of ["C 的結果", "D 的事", "E 的事", "F 的事", "別的地方在等你的事"]) {
      expect(inB).not.toContain(s);
    }
  });

  it("look: refused from another server, at a channel home, for a place unknown or left", async () => {
    const db = await world();
    const rig = await rigAt(db, "h1");
    rig.model.push(
      calls("look", { place: "伺服器B" }),
      says("好"),
      calls("look", { place: "伺服器B" }),
      says("好"),
      calls("look", { place: "伺服器Z" }),
      says("好"),
    );
    rig.say(mention(A1, "amy", "@她 B 那邊怎樣"));
    await until(() => rig.sink.texts().length === 1, 3_000, "the look from A");
    const fromA = lookResult(rig, 1);
    expect(fromA).toContain("有 2 件事,但在這裡不能看");
    for (const s of SECRETS) expect(fromA).not.toContain(s);
    // Her home is a channel of server H: its readers would hear it, so B stays B's.
    rig.say(mention(H1, "amy", "@她 B 那邊怎樣"));
    await until(() => rig.sink.texts().length === 2, 3_000, "the look at home");
    const atHome = lookResult(rig, 3);
    expect(atHome).toContain("在這裡不能看");
    for (const s of SECRETS) expect(atHome).not.toContain(s);
    rig.say(mention(A1, "amy", "@她 Z 呢"));
    await until(() => rig.sink.texts().length === 3, 3_000, "an unknown place");
    expect(lookResult(rig, 5)).toContain("找不到「伺服器Z」這個地方,或你已經不在那裡了");
  });

  it("look: a place she has left is refused, and leaves the merged lines", async () => {
    const db = await world();
    db.places.left("test", "gF");
    const rig = await rigAt(db, "h1");
    rig.model.push(calls("look", { place: "伺服器F" }), says("好"));
    rig.say(mention(H1, "amy", "@她 F 呢"));
    await until(() => rig.sink.texts().length === 1, 3_000, "the look at a left place");
    expect(textOf(rig.model.requests[0])).not.toContain("伺服器F");
    // Four places are left: C is listed now, and nothing is "more".
    expect(textOf(rig.model.requests[0])).toContain("- 伺服器C:1 件(回來的結果 1)");
    expect(textOf(rig.model.requests[0])).not.toContain("還有");
    expect(lookResult(rig, 1)).toContain("你已經不在那裡了");
  });

  it("look: allowed in the same server, and from a DM home for what that person took part in", async () => {
    const db = await world();
    const rig = await rigAt(db, "d1");
    // Her home is her DM with Amy: only what Amy took part in.
    rig.model.push(calls("look", { place: "伺服器B" }), says("好"));
    rig.say(mention(D1, "amy", "B 那邊有我的事嗎"));
    await until(() => rig.sink.texts().length === 1, 3_000, "the look from the DM home");
    const home = lookResult(rig, 1);
    expect(home).toContain("〔別的地方的事〕以下是伺服器B的事");
    expect(home).toContain("B 的秘密");
    expect(home).not.toContain("B 的提醒");
    expect(home).toContain("還有 1 件在這裡不能看");
    // Reading marks nothing seen: both still wait for B.
    expect(
      db
        .plugin(initiativeTables)
        .unseen()
        .filter((r) => r.text.startsWith("B ")),
    ).toHaveLength(2);
    // From another channel of B: B's items are this server's.
    rig.model.push(calls("look", { place: "伺服器B" }), says("好"));
    rig.say(mention(B2, "amy", "@她 這裡有什麼"));
    await until(() => rig.sink.texts().length === 2, 3_000, "the look from B");
    const inB = lookResult(rig, 3);
    expect(inB).toContain("B 的秘密");
    expect(inB).toContain("B 的提醒");
  });
});
