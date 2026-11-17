import type { MemoryScope } from "@miyoria/store";
import { openTestDb } from "@miyoria/store/testing";
import type { ContextKey, PersonId } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  episodeText,
  identityResolver,
  type MemoryWriter,
  memoryEpisodeSink,
  type NoteScope,
  placeScope,
  replacementScope,
  toMemoryScope,
  toNoteScope,
  visibleTo,
} from "../src/index.js";
import {
  CHANNEL,
  DM_CHANNEL,
  DM_ROOM,
  fakeResolver,
  IN_DM,
  IN_SERVER,
  OWEN,
  OWEN_ACCOUNT,
  ROOM,
  SESSION,
  SPACE,
} from "./helpers.js";

describe("scopes in the two vocabularies", () => {
  const resolver = fakeResolver();
  const pairs: Array<[NoteScope, MemoryScope]> = [
    [{ type: "public" }, { type: "global" }],
    [
      { type: "space", space: SPACE },
      { type: "guild", platform: "discord", guild: "g1" },
    ],
    [
      { type: "room", room: ROOM },
      { type: "channel", context: CHANNEL },
    ],
    [
      { type: "room", room: DM_ROOM },
      { type: "channel", context: DM_CHANNEL },
    ],
    [
      { type: "dm", person: OWEN },
      { type: "dm", account: OWEN_ACCOUNT },
    ],
    [
      { type: "person", person: OWEN },
      { type: "person", person: OWEN },
    ],
  ];

  it.each(pairs)("maps %j to %j and back", (note, memory) => {
    expect(toMemoryScope(note, resolver)).toEqual(memory);
    expect(toNoteScope(memory, resolver)).toEqual(note);
  });

  it("maps her own scope to global, and global back to self only when told it is hers", () => {
    expect(toMemoryScope({ type: "self" }, resolver)).toEqual({ type: "global" });
    expect(toNoteScope({ type: "global" }, resolver, true)).toEqual({ type: "self" });
    expect(toNoteScope({ type: "global" }, resolver)).toEqual({ type: "public" });
  });

  it("never widens what the resolver does not know", () => {
    const stranger = "01HSTRANGER000000000000000" as PersonId;
    expect(toMemoryScope({ type: "space", space: "nope" }, resolver)).toBeNull();
    expect(toMemoryScope({ type: "room", room: "nope" }, resolver)).toBeNull();
    expect(toMemoryScope({ type: "dm", person: stranger }, resolver)).toBeNull();
    expect(toNoteScope({ type: "guild", platform: "discord", guild: "g9" }, resolver)).toBeNull();
    const elsewhere: ContextKey = { ...CHANNEL, channel: "c9" };
    expect(toNoteScope({ type: "channel", context: elsewhere }, resolver)).toBeNull();
    expect(
      toNoteScope({ type: "dm", account: { platform: "discord", id: "u9" } }, resolver),
    ).toBeNull();
  });

  it("reads identity's tables", () => {
    const t = openTestDb({ identity: true });
    try {
      const identity = t.identity;
      if (identity === null) throw new Error("no identity");
      const owen = identity.see(OWEN_ACCOUNT, "Owen");
      const room = identity.ensureRoom("discord", "g1", "c1", "text");
      const real = identityResolver(t.db);
      expect(real.spaceOf("discord", "g1")).toBe(room.space_id);
      expect(real.roomOf(CHANNEL)).toBe(room.id);
      expect(real.contextOf(room.id)).toEqual(CHANNEL);
      expect(real.personOf(OWEN_ACCOUNT)).toBe(owen.id);
      expect(real.accountOf(owen.id as PersonId)).toEqual(OWEN_ACCOUNT);
      const space = { type: "space" as const, space: room.space_id as string };
      expect(toNoteScope(toMemoryScope(space, real) as MemoryScope, real)).toEqual(space);
    } finally {
      t.close();
    }
  });
});

describe("where a line may be shown and written", () => {
  it("scopes what is learned to where it was said", () => {
    expect(placeScope(IN_SERVER)).toEqual({ type: "space", space: SPACE });
    expect(placeScope(IN_DM)).toEqual({ type: "dm", person: OWEN });
    expect(placeScope({ space: null, room: ROOM, dm: null })).toEqual({ type: "room", room: ROOM });
    expect(placeScope({ space: null, room: null, dm: null })).toBeNull();
  });

  it("never gives a replacement a wider scope than its place", () => {
    expect(replacementScope({ type: "person", person: OWEN }, IN_DM)).toEqual({
      type: "dm",
      person: OWEN,
    });
    expect(replacementScope({ type: "public" }, IN_SERVER)).toEqual({
      type: "space",
      space: SPACE,
    });
    expect(replacementScope({ type: "room", room: ROOM }, IN_SERVER)).toEqual({
      type: "room",
      room: ROOM,
    });
    expect(replacementScope({ type: "room", room: "other" }, IN_SERVER)).toEqual({
      type: "space",
      space: SPACE,
    });
  });

  it("shows a line only where its scope allows, everything to the owner", () => {
    const channel = { space: SPACE, room: ROOM, dm: null, present: [OWEN] };
    const dm = { space: null, room: DM_ROOM, dm: OWEN, present: [OWEN] };
    expect(visibleTo({ type: "dm", person: OWEN }, channel)).toBe(false);
    expect(visibleTo({ type: "dm", person: OWEN }, dm)).toBe(true);
    expect(visibleTo({ type: "space", space: SPACE }, dm)).toBe(false);
    expect(visibleTo({ type: "person", person: OWEN }, channel)).toBe(true);
    expect(visibleTo({ type: "room", room: ROOM }, channel)).toBe(true);
    expect(visibleTo({ type: "dm", person: OWEN }, "owner")).toBe(true);
  });
});

describe("memoryEpisodeSink", () => {
  function writer() {
    const stored: Array<Parameters<MemoryWriter["store"]>[0]> = [];
    const w: MemoryWriter = {
      async store(memory) {
        stored.push(memory);
        return { type: "inserted", id: `r${stored.length}` };
      },
    };
    return { w, stored };
  }

  it("stores an episode and a follow-up through the engine's write, in the old scope", async () => {
    const { w, stored } = writer();
    const sink = memoryEpisodeSink(w, { resolver: fakeResolver(), contextOf: () => CHANNEL });
    const id = await sink.episode({
      summary: "跟 Owen 聊拉麵",
      feeling: "開心",
      importance: 0.6,
      people: [OWEN],
      scope: { type: "space", space: SPACE },
      session: SESSION,
      seq_from: 1,
      seq_to: 4,
      message_ids: ["m1", "m2"],
      at: "2026-11-01T12:00:00.000Z" as never,
    });
    expect(id).toBe("r1");
    expect(stored[0]).toMatchObject({
      kind: "episode",
      scope: { type: "guild", platform: "discord", guild: "g1" },
      subjects: [OWEN],
      content: "跟 Owen 聊拉麵(當時我的心情:開心)",
      origin: "experienced",
      source_context: CHANNEL,
      source_events: ["msg:m1", "msg:m2"],
    });
    await sink.followup?.({
      about: "問 Owen 考試",
      person: OWEN,
      due: "2026-11-02T12:00:00.000Z" as never,
      scope: { type: "dm", person: OWEN },
      session: SESSION,
      at: "2026-11-01T12:00:00.000Z" as never,
    });
    expect(stored[1]).toMatchObject({
      kind: "followup",
      scope: { type: "dm", account: OWEN_ACCOUNT },
      due: "2026-11-02T12:00:00.000Z",
    });
  });

  it("does not store what it cannot scope", async () => {
    const { w, stored } = writer();
    const sink = memoryEpisodeSink(w, { resolver: fakeResolver() });
    const id = await sink.episode({
      summary: "x",
      feeling: null,
      importance: 0.5,
      people: [],
      scope: { type: "space", space: "unknown" },
      session: SESSION,
      seq_from: 1,
      seq_to: 1,
      message_ids: [],
      at: "2026-11-01T12:00:00.000Z" as never,
    });
    expect(id).toBeNull();
    expect(stored).toEqual([]);
    expect(episodeText({ summary: "x", feeling: "  " })).toBe("x");
  });
});
