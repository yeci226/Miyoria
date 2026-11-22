// Who an artifact may be shared with (owner 2026-11-22): never wider than where it was made; only its
// own person widens, and widening opens the link audience only. Also the per-person count the
// daily quota reads, a person deleting their own item, and cleaned copies following their original.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Artifact,
  ArtifactShareError,
  audienceAllowed,
  CLEAN_PLUGIN,
  isSpaceMember,
} from "../src/index.js";
import { DAY, type Fixture, fixture, HOUR, SAMPLES, T0 } from "./artifact-fixtures.js";

let f: Fixture;
let dm: Artifact;
let room: Artifact;
const png = () => SAMPLES["image/png"] as Uint8Array;

beforeEach(async () => {
  f = fixture();
  dm = await f.store.ingest(png(), { source: "imagegen", plugin: "imagegen", place: f.dm });
  room = await f.store.ingest(png(), {
    source: "imagegen",
    plugin: "imagegen",
    place: f.room,
    made_for: f.person,
  });
});
afterEach(() => {
  f.close();
});

const refusal = (run: () => unknown): string | null => {
  try {
    run();
    return null;
  } catch (error) {
    if (!(error instanceof ArtifactShareError)) throw error;
    return error.reason;
  }
};

describe("share policy", () => {
  it("never lets a DM-made artifact reach a space or another person, even widened", () => {
    const shares = f.store.shares;
    const space = f.room.space_id;
    expect(refusal(() => shares.create(dm.id, { audience: "space", space_id: space }))).toBe(
      "dm_to_space",
    );
    expect(
      refusal(() => shares.create(dm.id, { audience: "space", space_id: space, widen: true })),
    ).toBe("dm_to_space");
    expect(
      refusal(() => shares.create(dm.id, { audience: "person", person_id: f.other, widen: true })),
    ).toBe("person_outside");
    // Its own person, and by link only when they widen it themself.
    expect(refusal(() => shares.create(dm.id, { audience: "person", person_id: f.person }))).toBe(
      null,
    );
    expect(refusal(() => shares.create(dm.id, { audience: "link" }))).toBe("link_not_public");
    expect(refusal(() => shares.create(dm.id, { audience: "link", widen: true }))).toBe(null);
  });

  it("keeps a room's artifact in its own space", async () => {
    const shares = f.store.shares;
    const otherSpace = await f.store.ingest(png(), {
      source: "imagegen",
      plugin: "imagegen",
      place: f.room,
      made_for: f.person,
    });
    expect(
      refusal(() => shares.create(otherSpace.id, { audience: "space", space_id: "elsewhere" })),
    ).toBe("space_outside");
    expect(
      refusal(() => shares.create(room.id, { audience: "space", space_id: f.room.space_id })),
    ).toBe(null);
    // A member of the space may get it; someone never seen there may not, widened or not.
    expect(refusal(() => shares.create(room.id, { audience: "person", person_id: f.other }))).toBe(
      null,
    );
    expect(
      refusal(() =>
        shares.create(room.id, { audience: "person", person_id: f.stranger, widen: true }),
      ),
    ).toBe("person_outside");
    expect(refusal(() => shares.create(room.id, { audience: "link" }))).toBe("link_not_public");
    expect(refusal(() => shares.create(room.id, { audience: "link", widen: true }))).toBe(null);
  });

  it("does not widen what was made for nobody, or for her own prompts", async () => {
    const own = await f.store.ingest(png(), { source: "render", plugin: "stage", place: f.home });
    expect(own.scope).toBe("self");
    expect(refusal(() => f.store.shares.create(own.id, { audience: "link", widen: true }))).toBe(
      "not_shareable",
    );
    const nobody = await f.store.ingest(png(), {
      source: "imagegen",
      plugin: "imagegen",
      place: f.room,
    });
    expect(refusal(() => f.store.shares.create(nobody.id, { audience: "link", widen: true }))).toBe(
      "link_not_public",
    );
  });

  it("is a pure rule over a space id and a membership function", () => {
    const made = { scope: "room" as const, made_for: "p1" as never, space_id: "s1" };
    const member = (_p: string, s: string) => s === "s1";
    expect(audienceAllowed(made, { audience: "person", person_id: "p2" as never }, member)).toEqual(
      { ok: true },
    );
    expect(
      audienceAllowed(made, { audience: "person", person_id: "p2" as never }, () => false).ok,
    ).toBe(false);
    expect(
      audienceAllowed({ ...made, scope: "public" }, { audience: "link" }, () => false),
    ).toEqual({ ok: true });
  });

  it("answers membership by space id", () => {
    const space = f.room.space_id as string;
    expect(isSpaceMember(f.t.db, f.person as never, space)).toBe(true);
    expect(isSpaceMember(f.t.db, f.other as never, space)).toBe(true);
    expect(isSpaceMember(f.t.db, f.stranger as never, space)).toBe(false);
    expect(isSpaceMember(f.t.db, f.person as never, "")).toBe(false);
  });
});

describe("the per-person count", () => {
  it("counts the shares of what was made for them within the window, revoked ones too", () => {
    const shares = f.store.shares;
    const one = shares.create(room.id, { audience: "person", person_id: f.person });
    shares.create(dm.id, { audience: "person", person_id: f.person });
    shares.revoke(one.share.id, "test");
    const since = new Date(T0 - DAY).toISOString() as never;
    expect(shares.countFor(f.person as never, since)).toBe(2);
    expect(shares.countFor(f.other as never, since)).toBe(0);
    f.clock.advance(2 * DAY);
    const later = new Date(f.clock.now() - DAY).toISOString() as never;
    expect(shares.countFor(f.person as never, later)).toBe(0);
  });
});

describe("a person deleting their own item", () => {
  it("removes it and its copy for everyone, revokes their shares, and is one event", async () => {
    const copy = await f.store.ingest(png(), {
      source: "imagegen",
      plugin: CLEAN_PLUGIN,
      place: f.room,
      made_for: f.person,
      derived_from: room.id,
    });
    const link = f.store.shares.create(copy.id, { audience: "person", person_id: f.person });
    expect(f.store.deleteFor(room.id, f.other as never)).toBe(false);
    expect(f.store.deleteFor(room.id, f.person as never)).toBe(true);
    expect(f.store.deleteFor(room.id, f.person as never)).toBe(false);
    expect(f.store.get(room.id)?.deleted_at).not.toBeNull();
    expect(f.store.get(copy.id)?.deleted_at).not.toBeNull();
    expect(f.store.shares.lookup(link.token)).toEqual({ ok: false, reason: "revoked" });
    const events = f.t.events.query({ types: ["artifact.deleted"] });
    expect(events).toHaveLength(1);
    expect(events[0]?.envelope.data).toMatchObject({ artifact_id: room.id, shares_revoked: 1 });
  });

  it("keeps, releases and takes down a cleaned copy with its original", async () => {
    const copy = await f.store.ingest(png(), {
      source: "imagegen",
      plugin: CLEAN_PLUGIN,
      place: f.room,
      made_for: f.person,
      derived_from: room.id,
    });
    expect(f.store.list({ derived_from: room.id }).map((a) => a.id)).toEqual([copy.id]);
    f.store.keep(room.id, "person");
    expect(f.store.get(copy.id)?.kept_by).toBe("person");
    f.store.release(room.id);
    expect(f.store.get(copy.id)?.expires_at).not.toBeNull();
    const link = f.store.shares.create(copy.id, { audience: "person", person_id: f.person });
    f.clock.advance(HOUR);
    expect(f.store.takeDown(room.id, "owner", "test")).toBe(true);
    expect(f.store.get(copy.id)?.review).toBe("taken_down");
    expect(f.store.shares.lookup(link.token).ok).toBe(false);
  });
});
