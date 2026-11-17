// Her words and tags on the heart's row (phase 4 step 4): call name, impression, the member
// page's line, tags, and the owner's reset. None of them is a number, so none records a change,
// except the reset, whose numbers go back with cause `admin`.

import { openTestDb, type TestDb } from "@miyoria/store/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HeartStore, heartPersonConfig, heartSchema } from "../src/index.js";

const NOW = Date.UTC(2026, 10, 17, 2, 0, 0);
const clock = { now: () => NOW };

let t: TestDb;
let store: HeartStore;

beforeEach(() => {
  t = openTestDb({ identity: true, plugins: [heartSchema], clock });
  store = new HeartStore(t.db, t.events, { rules: heartPersonConfig(), clock });
});

afterEach(() => t.close());

const changes = () => t.events.query({ types: ["heart.changed"], limit: 100 });

describe("edits", () => {
  it("writes call name, impression and the page's line, making a row for someone new", () => {
    store.edit("amy", { call_name: "阿咪", impression: "愛聊貓" });
    expect(store.get("amy")).toMatchObject({ call_name: "阿咪", impression: "愛聊貓", bond: 0 });
    store.edit("amy", { public_feeling: "哼,還不錯啦。" });
    store.edit("amy", { public_feeling: null, call_name: null });
    expect(store.get("amy")).toMatchObject({ call_name: null, public_feeling: null });
    expect(changes()).toEqual([]);
  });

  it("adds and removes tags, saying whether anything changed", () => {
    expect(store.setTag("amy", "blocked", true)).toBe(true);
    expect(store.setTag("amy", "blocked", true)).toBe(false);
    expect(store.setTag("amy", "friend", true)).toBe(true);
    expect(store.get("amy")?.tags).toEqual(["blocked", "friend"]);
    expect(store.setTag("amy", "blocked", false)).toBe(true);
    expect(store.get("amy")?.tags).toEqual(["friend"]);
  });

  it("resets numbers with cause admin and clears her words; tags, floor and anchors stay", () => {
    store.adminSet("amy", "bond", 130);
    store.setAnchor("amy", { tier: 120, note_ref: null, quote: "", at: "", by: "admin" });
    store.edit("amy", { call_name: "阿咪", impression: "愛聊貓", tags: ["friend"] });
    const before = changes().length;
    const row = store.reset("amy", { quote: "reset by owner" });
    expect(row).toMatchObject({
      bond: 0,
      trust: 10,
      call_name: null,
      impression: "",
      tags: ["friend"],
    });
    expect(row.tier_floor).toBe(120);
    expect(row.anchors).toHaveLength(1);
    const after = changes().slice(0, changes().length - before);
    expect(after.every((e) => (e.envelope.data as { cause: string }).cause === "admin")).toBe(true);
  });
});
