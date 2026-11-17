// What `MessageLog` returns (`recent`, `authoredSince`), pinned on fresh databases so the
// implementation behind it can change: the conversation lines of one character, read back per
// place and counted per author. One profile only: one database belongs to one character
// (v5-data decision D6).

import {
  type AccountRef,
  type ContextKey,
  type ContextKind,
  newId,
  type Timestamp,
  toTimestamp,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { type LogEntry, SqliteStore, type Store } from "../src/index.js";

const P = "deepseek-chan";
const T0 = Date.UTC(2026, 10, 1, 12);
const SECOND = 1000;

const stores: Store[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

async function open(): Promise<Store> {
  const store = await SqliteStore.open(":memory:");
  stores.push(store);
  return store;
}

const account = (id: string): AccountRef => ({ platform: "discord", id });
const place = (scope: string | null, channel: string, kind: ContextKind): ContextKey => ({
  platform: "discord",
  scope,
  channel,
  kind,
});
const at = (secs: number): Timestamp => toTimestamp(T0 + secs * SECOND);

const TEXT = place("g1", "c1", "channel");
const VOICE = place("g1", "c1", "voice");
const OTHER_GUILD = place("g2", "c1", "channel");
const THREAD = place("g1", "t1", "thread");
const DM = place(null, "d1", "dm");
const OWEN = account("100");
const AMY = account("200");
const HER = account("999");

function line(
  context: ContextKey,
  text: string,
  secs: number,
  extra: Partial<Omit<LogEntry, "context" | "text" | "ts">> = {},
): LogEntry {
  return {
    id: newId(),
    profile: P,
    context,
    author: OWEN,
    author_name: "Owen",
    text,
    is_self: false,
    ts: at(secs),
    turn: null,
    ...extra,
  };
}

const herLine = (context: ContextKey, text: string, secs: number): LogEntry =>
  line(context, text, secs, { author: HER, author_name: "Miyori", is_self: true, turn: newId() });

const texts = (entries: readonly LogEntry[]) => entries.map((e) => e.text);

describe("the message log", () => {
  it("reads a place's newest lines, oldest first; equal times keep append order", async () => {
    const log = (await open()).messages;
    for (const [text, secs] of [
      ["b", 2],
      ["a", 1],
      ["c", 3],
      ["d1", 4],
      ["d2", 4],
      ["e", 5],
    ] as const) {
      await log.append(line(TEXT, text, secs));
    }
    expect(texts(await log.recent(P, TEXT, 100))).toEqual(["a", "b", "c", "d1", "d2", "e"]);
    expect(texts(await log.recent(P, TEXT, 3))).toEqual(["d1", "d2", "e"]);
    expect(await log.recent(P, TEXT, 0)).toEqual([]);
  });

  it("gives back each line as it was appended", async () => {
    const log = (await open()).messages;
    const theirs = line(TEXT, "我養了一隻貓", 1);
    const hers = herLine(TEXT, "好可愛", 2);
    const heard = line(VOICE, "聽得到嗎", 3, { author: AMY, author_name: "Amy" });
    const spoken = herLine(VOICE, "聽得到", 4);
    for (const e of [theirs, hers, heard, spoken]) await log.append(e);
    expect(await log.recent(P, TEXT, 10)).toEqual([theirs, hers]);
    expect(await log.recent(P, VOICE, 10)).toEqual([heard, spoken]);
  });

  it("keeps places apart: voice and text of one channel, guilds, threads, DMs", async () => {
    const log = (await open()).messages;
    await log.append(line(TEXT, "text", 1));
    await log.append(line(VOICE, "voice", 2));
    await log.append(line(OTHER_GUILD, "other guild", 3));
    await log.append(line(THREAD, "thread", 4));
    await log.append(line(DM, "dm", 5));
    await log.append(herLine(DM, "dm reply", 6));
    expect(texts(await log.recent(P, TEXT, 10))).toEqual(["text"]);
    expect(texts(await log.recent(P, VOICE, 10))).toEqual(["voice"]);
    expect(texts(await log.recent(P, OTHER_GUILD, 10))).toEqual(["other guild"]);
    expect(texts(await log.recent(P, THREAD, 10))).toEqual(["thread"]);
    expect(texts(await log.recent(P, DM, 10))).toEqual(["dm", "dm reply"]);
    expect(await log.recent(P, place("g1", "nowhere", "channel"), 10)).toEqual([]);
  });

  it("counts what someone wrote since a time, theirs only, with the kind of place", async () => {
    const log = (await open()).messages;
    await log.append(line(TEXT, "old", 0));
    await log.append(line(TEXT, "a", 10));
    await log.append(line(VOICE, "b", 20));
    await log.append(line(TEXT, "other", 30, { author: AMY, author_name: "Amy" }));
    await log.append({ ...line(TEXT, "her", 40), is_self: true });
    await log.append(line(THREAD, "c", 50));
    await log.append(line(DM, "d", 60));
    const got = await log.authoredSince(P, [OWEN], at(5), 10);
    expect(got).toEqual([
      { ts: at(10), kind: "channel" },
      { ts: at(20), kind: "voice" },
      { ts: at(50), kind: "thread" },
      { ts: at(60), kind: "dm" },
    ]);
    // The most recent ones, still oldest first.
    expect(await log.authoredSince(P, [OWEN], at(5), 2)).toEqual([
      { ts: at(50), kind: "thread" },
      { ts: at(60), kind: "dm" },
    ]);
    expect(await log.authoredSince(P, [], at(0), 10)).toEqual([]);
    expect(await log.authoredSince(P, [account("404")], at(0), 10)).toEqual([]);
    expect(await log.authoredSince(P, [OWEN, AMY], at(0), 10)).toHaveLength(6);
  });

  it("keeps microseconds, normalizes to UTC and refuses a bad time", async () => {
    const log = (await open()).messages;
    const precise = { ...line(TEXT, "precise", 0), ts: "2026-03-10T12:00:00.123456789Z" };
    const offset = { ...line(TEXT, "offset", 0), ts: "2026-03-10T20:00:01.5+08:00" };
    const ctx = place("g1", "c9", "channel");
    await log.append({ ...precise, context: ctx });
    await log.append({ ...offset, context: ctx });
    expect((await log.recent(P, ctx, 10)).map((e) => e.ts)).toEqual([
      "2026-03-10T12:00:00.123456Z",
      "2026-03-10T12:00:01.500Z",
    ]);
    await expect(log.append({ ...line(ctx, "bad", 0), ts: "yesterday" })).rejects.toThrow(
      /invalid timestamp/,
    );
  });

  it("refuses an id it already has", async () => {
    const log = (await open()).messages;
    const e = line(TEXT, "once", 1);
    await log.append(e);
    await expect(log.append(e)).rejects.toThrow(/already exists/);
    expect(texts(await log.recent(P, TEXT, 10))).toEqual(["once"]);
  });
});
