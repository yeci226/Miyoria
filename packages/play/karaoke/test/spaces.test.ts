// Rooms per server (phase 6, docs/design/v5-places.md §10): migration 6 gives every room the
// primary Space; a room belongs to the server it was opened in, its list, its voice check, its
// notice and her notes are that server's; a server first seen after the upgrade has no rooms until
// its own comment channel is set; songs and scores stay each person's everywhere.

import { rm } from "node:fs/promises";
import { identitySchema, migrate, SpacePlaces } from "@miyoria/store";
import { openTestDb } from "@miyoria/store/testing";
import type { ContextKey, Places, SpaceRef } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { type KaraokeConfig, KaraokeConfigSchema } from "../src/config.js";
import { karaokeSchema } from "../src/migrations.js";
import { NOT_SET_UP, NOT_THERE, roomPlaces } from "../src/module.js";
import { KaraokeError } from "../src/service.js";
import { ALICE, BOB, CAROL, makeRig, type Rig } from "./room-rig.js";

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    r.raw.close();
    await rm(r.dir, { recursive: true, force: true });
  }
});

const AT = 1_700_000_000_000_000;

describe("karaoke v6", () => {
  const v5 = { ...karaokeSchema, migrations: karaokeSchema.migrations.slice(0, 5) };
  const room = (db: { run(sql: string, p?: object): unknown }, id: string) =>
    db.run(
      `INSERT INTO karaoke_rooms (id, code, opener_person, opener_platform, opener_account,
         opener_name, state, charge, price, created_at)
       VALUES ($id, 'ABCDEF', NULL, 'discord', '1', 'Alice', 'closed', 'free', 0, $at)`,
      { id, at: AT },
    );

  it("gives every room from before the primary Space, and loses no row", () => {
    const t = openTestDb({ identity: true, plugins: [v5] });
    try {
      const identity = t.identity;
      if (!identity) throw new Error("identity");
      const A = identity.seenSpace("discord", "gA", "A");
      identity.seenSpace("discord", "gB", "B");
      room(t.db, "r1");
      room(t.db, "r2");
      expect(migrate(t.db, [identitySchema, karaokeSchema]).map((m) => m.version)).toEqual([6]);
      expect(t.db.all("SELECT id, space_id FROM karaoke_rooms ORDER BY id")).toEqual([
        { id: "r1", space_id: A },
        { id: "r2", space_id: A },
      ]);
      // Running it again does nothing.
      expect(migrate(t.db, [identitySchema, karaokeSchema])).toEqual([]);
    } finally {
      t.close();
    }
  });

  it("keeps no Space on a database that has none yet", () => {
    const t = openTestDb({ identity: true, plugins: [v5] });
    try {
      room(t.db, "r1");
      migrate(t.db, [identitySchema, karaokeSchema]);
      expect(t.db.all("SELECT id, space_id FROM karaoke_rooms")).toEqual([
        { id: "r1", space_id: null },
      ]);
    } finally {
      t.close();
    }
  });
});

/**
 * A rig whose desk knows servers A (primary), B (established) and, with `c`, C (first seen after
 * the upgrade), as identity records them; each has its own comment channel (C only with
 * `cChannel`). `voice`: the servers she is in voice in. `ids`: the Spaces' ids.
 */
async function serverRig(opts: { c?: boolean; cChannel?: string } = {}) {
  let places: Places | null = null;
  let base: KaraokeConfig = KaraokeConfigSchema.parse({});
  const channels = new Map<string, string>();
  const settings = {
    base: () => base,
    for: ({ space_id }: { space_id: string }) => ({
      ...base,
      comment_channel: channels.get(space_id) ?? "",
    }),
  };
  const voice = new Set<string>();
  const lazy = {
    primary: () => places?.primary() ?? null,
    spaces: () => places?.spaces() ?? [],
    space: (id: string) => places?.space(id) ?? null,
    at: (ctx: ContextKey) => places?.at(ctx) ?? null,
    ofGuild: (platform: string, guild: string) => places?.ofGuild(platform, guild) ?? null,
  } as unknown as Places;
  // Three rooms at once (the cap is the cluster's, over every server: one song worker).
  const rig = await makeRig(
    { room_max: 3 },
    {
      places: roomPlaces(lazy, settings),
      inVoice: (s) => (s === null ? voice.size > 0 : voice.has(s)),
    },
  );
  rigs.push(rig);
  base = rig.config;
  const identity = rig.raw.identity;
  if (identity === null) throw new Error("identity");
  const ids = {
    A: identity.seenSpace("discord", "gA", "A"),
    B: identity.seenSpace("discord", "gB", "B"),
    C: opts.c ? identity.seenSpace("discord", "gC", "C") : "",
  };
  // B was there before the upgrade (identity v4 marks it); C is new.
  rig.raw.db.run("UPDATE spaces SET established = 1 WHERE id = $id", { id: ids.B });
  places = new SpacePlaces(rig.raw.db, identity);
  channels.set(ids.A, "discord:gA:a-comments");
  channels.set(ids.B, "discord:gB:b-comments");
  if (opts.cChannel) channels.set(ids.C, opts.cChannel);
  voice.add(ids.A);
  voice.add(ids.B);
  return { rig, voice, ids };
}

async function refusal(p: Promise<unknown>): Promise<KaraokeError> {
  try {
    await p;
  } catch (error) {
    expect(error).toBeInstanceOf(KaraokeError);
    return error as KaraokeError;
  }
  throw new Error("expected a refusal");
}

describe("rooms per server", () => {
  it("keeps each server's rooms, notice and notes to that server", async () => {
    const { rig, ids } = await serverRig();
    const a = await rig.desk.open(ALICE, "Alice", null, 0, false, ids.A);
    const b = await rig.desk.open(BOB, "Bob", null, 0, false, ids.B);
    // Left out, a room opens in the primary.
    const c = await rig.desk.open(CAROL, "Carol");
    expect(
      rig.desk
        .briefs(ids.A)
        .map((r) => r.code)
        .sort(),
    ).toEqual([a.code, c.code].sort());
    expect(rig.desk.briefs(ids.B).map((r) => r.code)).toEqual([b.code]);
    expect(rig.desk.briefs()).toHaveLength(3);
    await rig.desk.idle();
    // Each notice in its own server's comment channel.
    const where = new Map(rig.notices.map((n) => [n.notice.code, n.channel]));
    expect(where.get(a.code)).toBe("a-comments");
    expect(where.get(b.code)).toBe("b-comments");
    expect(where.get(c.code)).toBe("a-comments");
    // And her notes there too.
    const opened = rig.notes.filter((n) => n.key.endsWith(":open"));
    expect(opened.map((n) => n.context?.scope).sort()).toEqual(["gA", "gA", "gB"]);
    // The rows remember the server.
    const rows = rig.raw.db.all("SELECT code, space_id FROM karaoke_rooms") as {
      code: string;
      space_id: string | null;
    }[];
    expect(Object.fromEntries(rows.map((r) => [r.code, r.space_id]))).toEqual({
      [a.code]: ids.A,
      [b.code]: ids.B,
      [c.code]: ids.A,
    });
  });

  it("looks at her voice in the room's own server", async () => {
    const { rig, voice, ids } = await serverRig();
    voice.delete(ids.B);
    expect((await rig.desk.overview(ALICE, false, ids.A)).available).toBe(true);
    const there = await rig.desk.overview(ALICE, false, ids.B);
    expect(there.available).toBe(false);
    expect(there.reason).toContain("別的伺服器");
    expect((await refusal(rig.desk.open(ALICE, "Alice", null, 0, false, ids.B))).status).toBe(409);
    voice.add(ids.B);
    const a = await rig.desk.open(ALICE, "Alice", null, 0, false, ids.A);
    await rig.desk.open(BOB, "Bob", null, 0, false, ids.B);
    // She leaves B's voice: B's room closes, A's stays.
    voice.delete(ids.B);
    await rig.desk.tick();
    await rig.desk.idle();
    expect(rig.desk.briefs().map((r) => r.code)).toEqual([a.code]);
    expect(rig.wallet.of("p-bob", "karaoke_room_refund")).toEqual([20]);
    expect(rig.desk.view(a.code, ALICE).state).toBe("lobby");
  });

  it("gives a new server no rooms until its own comment channel is set", async () => {
    const off = await serverRig({ c: true });
    off.voice.add(off.ids.C);
    const why = await off.rig.desk.overview(ALICE, false, off.ids.C);
    expect(why).toMatchObject({ available: false, reason: NOT_SET_UP });
    expect(
      (await refusal(off.rig.desk.open(ALICE, "Alice", null, 0, false, off.ids.C))).status,
    ).toBe(409);
    // A server she is not in.
    expect((await off.rig.desk.overview(ALICE, false, "Z")).reason).toBe(NOT_THERE);

    const on = await serverRig({ c: true, cChannel: "discord:gC:c-comments" });
    on.voice.add(on.ids.C);
    expect((await on.rig.desk.overview(ALICE, false, on.ids.C)).available).toBe(true);
    const room = await on.rig.desk.open(ALICE, "Alice", null, 0, false, on.ids.C);
    await on.rig.desk.idle();
    expect(on.rig.notices.find((n) => n.notice.code === room.code)?.channel).toBe("c-comments");
  });

  it("keeps a person in one room whichever server it is in", async () => {
    const { rig, ids } = await serverRig();
    const a = await rig.desk.open(ALICE, "Alice", null, 0, false, ids.A);
    expect((await rig.desk.overview(ALICE, false, ids.B)).mine).toBe(a.code);
    expect((await refusal(rig.desk.open(ALICE, "Alice", null, 0, false, ids.B))).status).toBe(409);
  });
});

function placesOf(spaces: SpaceRef[]): Places {
  return {
    primary: () => spaces.find((x) => x.primary) ?? null,
    spaces: () => spaces,
    space: (id: string) => spaces.find((x) => x.id === id) ?? null,
    at: (ctx: ContextKey) => {
      const found = spaces.find((x) => x.external_id === ctx.scope);
      return found === undefined
        ? null
        : { space_id: found.id, room_id: ctx.channel, parent_room_id: null, session: "" };
    },
    ofGuild: (_p: string, guild: string) => spaces.find((x) => x.external_id === guild) ?? null,
  } as unknown as Places;
}

const space = (id: string, primary: boolean, established = true): SpaceRef => ({
  id,
  platform: "discord",
  external_id: `g${id}`,
  name: `伺服器 ${id}`,
  primary,
  established,
});

describe("roomPlaces", () => {
  const settings = (channels: Record<string, string>) => {
    const base = KaraokeConfigSchema.parse({ comment_channel: "discord:gA:cluster" });
    return {
      base: () => base,
      for: ({ space_id }: { space_id: string }) => ({
        ...base,
        comment_channel: channels[space_id] ?? "",
      }),
    };
  };

  it("finds the primary, a command's server and each server's settings", () => {
    const p = roomPlaces(
      placesOf([space("A", true), space("B", false), space("N", false, false)]),
      settings({ A: "discord:gA:cluster" }),
    );
    expect(p.fallback()).toBe("A");
    expect(p.at({ platform: "discord", scope: "gB", channel: "x", kind: "channel" })).toBe("B");
    expect(p.at({ platform: "discord", scope: null, channel: "d", kind: "dm" })).toBeNull();
    // Established servers have rooms as before, with or without a comment channel.
    expect(p.why("A")).toBeNull();
    expect(p.why("B")).toBeNull();
    expect(p.why("N")).toBe(NOT_SET_UP);
    expect(p.why("gone")).toBe(NOT_THERE);
    expect(p.config(null).comment_channel).toBe("discord:gA:cluster");
    expect(p.config("B").comment_channel).toBe("");
  });
});
