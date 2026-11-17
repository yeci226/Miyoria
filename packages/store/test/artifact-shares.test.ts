// Share tokens: random, stored as a hash, looked up in constant time; expiry, use limits and
// revocation; audiences no wider than where the artifact was made; song covers only stream.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Artifact, ArtifactShareError, shareTokenHash } from "../src/index.js";
import { DAY, type Fixture, fixture, HOUR, SAMPLES, T0 } from "./artifact-fixtures.js";

let f: Fixture;
let room: Artifact;
beforeEach(async () => {
  f = fixture();
  room = await f.store.ingest(SAMPLES["image/png"] as Uint8Array, {
    source: "imagegen",
    plugin: "imagegen",
    place: f.room,
    made_for: f.person,
  });
});
afterEach(() => {
  f.close();
});

describe("share tokens", () => {
  it("are random, returned once and stored only as a hash, with one share.created event", () => {
    const one = f.store.shares.create(room.id, {
      audience: "person",
      person_id: f.person,
      requested_by: f.person,
      turn: "turn7",
    });
    const two = f.store.shares.create(room.id, { audience: "person", person_id: f.person });
    expect(one.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(one.token).not.toBe(two.token);
    expect(one.share.token_hash).toBe(shareTokenHash(one.token));
    const stored = JSON.stringify(f.t.db.all("SELECT * FROM artifact_shares"));
    expect(stored).not.toContain(one.token);
    const events = f.t.events.query({ types: ["share.created"] });
    expect(events).toHaveLength(2);
    const mine = events.find((e) => e.envelope.id === one.share.event_id)?.envelope;
    expect(mine).toMatchObject({
      scope: "owner",
      tier: "long",
      person_id: f.person,
      turn: "turn7",
    });
    expect(JSON.stringify(events)).not.toContain(one.token);
  });

  it("look up what they open, and refuse anything else", () => {
    const { token, share } = f.store.shares.create(room.id, {
      audience: "person",
      person_id: f.person,
    });
    expect(f.store.shares.lookup(token)).toMatchObject({ ok: true, share: { id: share.id } });
    for (const bad of [
      "",
      "x",
      `${token}x`,
      token.slice(0, -1),
      share.token_hash,
      "../../etc/passwd",
      "A".repeat(43),
    ]) {
      expect(f.store.shares.lookup(bad)).toEqual({ ok: false, reason: "unknown" });
    }
  });

  it("expire, by default after 7 days and never after their artifact", () => {
    const { token, share } = f.store.shares.create(room.id, {
      audience: "person",
      person_id: f.person,
      ttlMs: 30 * DAY,
    });
    expect(share.expires_at).toBe(room.expires_at);
    const short = f.store.shares.create(room.id, {
      audience: "person",
      person_id: f.person,
      ttlMs: HOUR,
    });
    expect(short.share.expires_at).toBe(new Date(T0 + HOUR).toISOString());
    const plain = f.store.shares.create(room.id, { audience: "person", person_id: f.person });
    expect(plain.share.expires_at).toBe(new Date(T0 + 7 * DAY).toISOString());
    f.clock.advance(HOUR);
    expect(f.store.shares.use(short.token)).toEqual({ ok: false, reason: "expired" });
    expect(f.store.shares.use(token).ok).toBe(true);
    f.clock.advance(7 * DAY);
    expect(f.store.shares.lookup(token)).toEqual({ ok: false, reason: "expired" });
  });

  it("count uses up to their limit, the first one as share.opened", () => {
    const { token, share } = f.store.shares.create(room.id, {
      audience: "person",
      person_id: f.person,
      maxUses: 2,
    });
    expect(f.store.shares.lookup(token)).toMatchObject({ ok: true, share: { uses: 0 } });
    expect(f.store.shares.use(token)).toMatchObject({ ok: true, share: { uses: 1 } });
    f.clock.advance(1000);
    expect(f.store.shares.use(token)).toMatchObject({
      ok: true,
      share: { uses: 2, last_used_at: new Date(T0 + 1000).toISOString() },
    });
    expect(f.store.shares.use(token)).toEqual({ ok: false, reason: "used_up" });
    expect(f.store.shares.get(share.id)?.uses).toBe(2);
    const opened = f.t.events.query({ types: ["share.opened"] });
    expect(opened).toHaveLength(1);
    expect(opened[0]?.envelope.data).toEqual({ share_id: share.id, artifact_id: room.id });
  });

  it("are revoked once, with one share.revoked event", () => {
    const { token, share } = f.store.shares.create(room.id, {
      audience: "person",
      person_id: f.person,
    });
    expect(f.store.shares.revoke(share.id, "asked to", f.person)).toBe(true);
    expect(f.store.shares.revoke(share.id, "again")).toBe(false);
    expect(f.store.shares.use(token)).toEqual({ ok: false, reason: "revoked" });
    expect(f.t.events.query({ types: ["share.revoked"] })).toHaveLength(1);
  });

  it("stop opening when the artifact is taken down or expires", async () => {
    const a = f.store.shares.create(room.id, { audience: "person", person_id: f.person });
    expect(f.store.takeDown(room.id, "owner", "reported")).toBe(true);
    expect(f.store.shares.lookup(a.token)).toEqual({ ok: false, reason: "revoked" });
    const other = await f.store.ingest(SAMPLES["image/gif"] as Uint8Array, {
      source: "imagegen",
      plugin: "imagegen",
      place: f.room,
    });
    const b = f.store.shares.create(other.id, { audience: "space", space_id: f.room.space_id });
    f.t.db.run("UPDATE artifact_shares SET expires_at = NULL WHERE id = $id", { id: b.share.id });
    f.clock.advance(7 * DAY);
    expect(f.store.shares.lookup(b.token)).toEqual({ ok: false, reason: "gone" });
    expect(() =>
      f.store.shares.create(other.id, { audience: "space", space_id: f.room.space_id }),
    ).toThrow(ArtifactShareError);
  });

  it("keep their audience inside where the artifact was made", async () => {
    const png = SAMPLES["image/webp"] as Uint8Array;
    const dm = await f.store.ingest(png, { source: "imagegen", plugin: "imagegen", place: f.dm });
    const shares = f.store.shares;
    expect(shares.create(dm.id, { audience: "person", person_id: f.person }).share.audience).toBe(
      "person",
    );
    expect(() => shares.create(dm.id, { audience: "person", person_id: f.other })).toThrow(
      ArtifactShareError,
    );
    expect(() => shares.create(dm.id, { audience: "space", space_id: f.room.space_id })).toThrow(
      ArtifactShareError,
    );
    expect(() => shares.create(dm.id, { audience: "link" })).toThrow(ArtifactShareError);
    // Its person asked to make it public: the caller says so.
    expect(shares.create(dm.id, { audience: "link", widen: true }).share.audience).toBe("link");

    // A room's: its space, its members; not a stranger, not by link.
    expect(
      shares.create(room.id, { audience: "space", space_id: f.room.space_id }).share.mode,
    ).toBe("download");
    expect(shares.create(room.id, { audience: "person", person_id: f.other }).share.person_id).toBe(
      f.other,
    );
    expect(() => shares.create(room.id, { audience: "person", person_id: f.stranger })).toThrow(
      ArtifactShareError,
    );
    expect(() => shares.create(room.id, { audience: "link" })).toThrow(ArtifactShareError);

    const open = await f.store.ingest(png, {
      source: "cards",
      plugin: "cards",
      place: f.room,
      scope: "public",
    });
    expect(shares.create(open.id, { audience: "link" }).share.audience).toBe("link");
    expect(() => shares.create(open.id, { audience: "person" })).toThrow(ArtifactShareError);
    expect(() => shares.create(open.id, { audience: "space" })).toThrow(ArtifactShareError);
    expect(() => shares.create(open.id, { audience: "link", maxUses: 0 })).toThrow(
      ArtifactShareError,
    );
  });

  it("of a song cover only stream", async () => {
    const cover = await f.store.ingest(SAMPLES["audio/mpeg"] as Uint8Array, {
      source: "sing",
      plugin: "sing",
      place: f.room,
    });
    const { share } = f.store.shares.create(cover.id, {
      audience: "space",
      space_id: f.room.space_id,
    });
    expect(share.mode).toBe("stream");
    expect(() =>
      f.store.shares.create(cover.id, {
        audience: "space",
        space_id: f.room.space_id,
        mode: "download",
      }),
    ).toThrow(/never downloadable/);
    expect(
      f.store.shares.create(room.id, { audience: "person", person_id: f.person, mode: "stream" })
        .share.mode,
    ).toBe("stream");
  });
});
