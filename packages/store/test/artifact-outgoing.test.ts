// Outgoing attachments and the daily sweep's schedule: what an attachment source checks at send
// time (the artifact is live, may be downloaded, is visible at the destination, fits, is the
// recorded bytes), how a context becomes a place and a viewer, and when the sweep runs.

import { writeFileSync } from "node:fs";
import type { AccountRef, ContextKey } from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Artifact,
  ArtifactAttachments,
  type ArtifactInput,
  ArtifactSweepSchedule,
  type SweepResult,
} from "../src/index.js";
import { DAY, type Fixture, fixture, HOUR, SAMPLES, T0 } from "./artifact-fixtures.js";

let f: Fixture;
beforeEach(() => {
  f = fixture();
});
afterEach(() => {
  f.close();
});

const OWEN: AccountRef = { platform: "discord", id: "100" };
const MIA: AccountRef = { platform: "discord", id: "200" };
const ROOM: ContextKey = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" };
const OTHER_ROOM: ContextKey = { platform: "discord", scope: "g1", channel: "c2", kind: "channel" };
const THREAD: ContextKey = { platform: "discord", scope: "g1", channel: "t1", kind: "thread" };
const DM: ContextKey = { platform: "discord", scope: null, channel: "d1", kind: "dm" };
const UNKNOWN: ContextKey = { platform: "discord", scope: "g9", channel: "zz", kind: "channel" };
const text = (s: string) => new TextEncoder().encode(s);

async function make(
  data: Uint8Array,
  where: ContextKey,
  as: AccountRef,
  extra: Partial<ArtifactInput> = {},
): Promise<Artifact> {
  const site = f.store.places.at(where, as);
  if (site === null) throw new Error("no site");
  return f.store.ingest(data, {
    source: "sandbox",
    plugin: "sandbox",
    place: site.place,
    made_for: site.person_id,
    ...extra,
  });
}

describe("places", () => {
  it("knows rooms, threads and DMs from identity, and nothing else", () => {
    const room = f.store.places.at(ROOM, OWEN);
    expect(room?.dm).toBe(false);
    expect(room?.place).toEqual(f.room);
    expect(room?.person_id).toBe(f.person);
    expect(room?.viewer).toMatchObject({ person_id: f.person, room_id: f.room.room_id });
    expect(f.store.places.at(THREAD, OWEN)?.viewer.parent_room_id).toBe(f.room.room_id);
    expect(f.store.places.at(UNKNOWN, OWEN)).toBeNull();
  });

  it("a DM is its person's alone", () => {
    const dm = f.store.places.at(DM, OWEN);
    expect(dm).toMatchObject({ dm: true, person_id: f.person });
    expect(dm?.viewer.space_id).toBeNull();
    // Another account asking about that DM has no site there.
    expect(f.store.places.at(DM, MIA)).toBeNull();
    // Without an account: the DM's person.
    expect(f.store.places.at(DM)?.viewer.person_id).toBe(f.person);
  });

  it("records a guild room it has not seen yet only when asked to", () => {
    const fresh: ContextKey = { platform: "discord", scope: "g1", channel: "c7", kind: "channel" };
    expect(f.store.places.at(fresh, OWEN)).toBeNull();
    expect(f.store.places.at(fresh, OWEN, { create: true })?.place.room_id).toEqual(
      expect.any(String),
    );
    expect(f.store.places.at(fresh, OWEN)).not.toBeNull();
    // A DM is never created this way.
    const newDm: ContextKey = { platform: "discord", scope: null, channel: "d9", kind: "dm" };
    expect(f.store.places.at(newDm, OWEN, { create: true })).toBeNull();
  });
});

describe("ArtifactAttachments", () => {
  const open = (id: string, to: ContextKey, maxBytes = 10_000) =>
    new ArtifactAttachments(f.store).open(id, to, { maxBytes });

  it("gives the recorded bytes, the stored name and the sniffed type", async () => {
    const a = await make(SAMPLES["image/png"] as Uint8Array, ROOM, OWEN, { filename: "cat.png" });
    const file = await open(a.id, ROOM);
    expect(file).toMatchObject({
      artifact_id: a.id,
      filename: "cat.png",
      content_type: "image/png",
      size: a.size,
    });
    expect(Buffer.from(file.data)).toEqual(Buffer.from(SAMPLES["image/png"] as Uint8Array));
  });

  it("takes an id and nothing else", async () => {
    await make(SAMPLES["text/plain"] as Uint8Array, ROOM, OWEN);
    for (const id of ["../artifacts", "C:\\Windows\\win.ini", "/etc/passwd", f.root, ""]) {
      await expect(open(id, ROOM), id).rejects.toMatchObject({ code: "not_found" });
    }
  });

  it("refuses a destination that may not see the artifact", async () => {
    const inDm = await make(SAMPLES["text/plain"] as Uint8Array, DM, OWEN);
    await expect(open(inDm.id, ROOM)).rejects.toMatchObject({ code: "not_visible" });
    expect((await open(inDm.id, DM)).artifact_id).toBe(inDm.id);
    const inRoom = await make(SAMPLES["text/plain"] as Uint8Array, ROOM, OWEN);
    await expect(open(inRoom.id, OTHER_ROOM)).rejects.toMatchObject({ code: "not_visible" });
    await expect(open(inRoom.id, DM)).rejects.toMatchObject({ code: "not_visible" });
    await expect(open(inRoom.id, UNKNOWN)).rejects.toMatchObject({ code: "not_visible" });
    // A thread and its parent room see each other's.
    expect((await open(inRoom.id, THREAD)).artifact_id).toBe(inRoom.id);
  });

  it("an artifact that is no longer visible is refused at send time", async () => {
    const a = await make(SAMPLES["text/plain"] as Uint8Array, ROOM, OWEN);
    expect((await open(a.id, ROOM)).artifact_id).toBe(a.id);
    f.store.takeDown(a.id, "owner", "test");
    await expect(open(a.id, ROOM)).rejects.toMatchObject({ code: "not_found" });
    const b = await make(SAMPLES["text/plain"] as Uint8Array, ROOM, OWEN);
    f.clock.advance(8 * DAY);
    await expect(open(b.id, ROOM)).rejects.toMatchObject({ code: "not_found" });
  });

  it("never sends a song cover, and honours the size the platform takes", async () => {
    const cover = await make(SAMPLES["audio/wav"] as Uint8Array, ROOM, OWEN, {
      source: "sing",
      plugin: "sing",
    });
    await expect(open(cover.id, ROOM)).rejects.toMatchObject({ code: "not_shareable" });
    const a = await make(SAMPLES["text/plain"] as Uint8Array, ROOM, OWEN);
    await expect(open(a.id, ROOM, a.size - 1)).rejects.toMatchObject({ code: "too_large" });
    expect((await open(a.id, ROOM, a.size)).size).toBe(a.size);
  });

  it("refuses bytes that are missing or are not the recorded ones", async () => {
    const a = await make(text("original words\n"), ROOM, OWEN);
    writeFileSync(f.store.layout.blobPath(a.sha256), "original wordz\n");
    await expect(open(a.id, ROOM)).rejects.toMatchObject({ code: "damaged" });
    const b = await make(text("another file\n"), ROOM, OWEN);
    writeFileSync(f.store.layout.blobPath(b.sha256), "shorter");
    await expect(open(b.id, ROOM)).rejects.toMatchObject({ code: "damaged" });
  });
});

describe("ArtifactSweepSchedule", () => {
  const result = (): SweepResult => ({
    expired: 0,
    rows_removed: 0,
    blobs_removed: 0,
    orphan_files_removed: 0,
    temp_files_removed: 0,
    missing_blobs: 0,
    bytes_freed: 0,
  });

  function schedule(options: { everyMs?: number; firstMs?: number } = {}) {
    let now = T0;
    const clock = { now: () => now };
    const runs: number[] = [];
    let fail = false;
    const store = {
      async sweep(): Promise<SweepResult> {
        runs.push(now);
        if (fail) throw new Error("disk is full");
        return result();
      },
    };
    const s = new ArtifactSweepSchedule(store, clock, options);
    return {
      s,
      runs,
      advance: (ms: number) => {
        now += ms;
      },
      failing: (v: boolean) => {
        fail = v;
      },
    };
  }

  it("runs once a day: first a minute after the start, then every 24 hours", async () => {
    const t = schedule();
    expect(await t.s.tick()).toBeNull();
    t.advance(59_000);
    expect(await t.s.tick()).toBeNull();
    t.advance(1_000);
    expect(await t.s.tick()).not.toBeNull();
    t.advance(DAY - 1);
    expect(await t.s.tick()).toBeNull();
    t.advance(1);
    expect(await t.s.tick()).not.toBeNull();
    t.advance(DAY);
    expect(await t.s.tick()).not.toBeNull();
    expect(t.runs).toEqual([T0 + 60_000, T0 + 60_000 + DAY, T0 + 60_000 + 2 * DAY]);
  });

  it("calling it often does not run it often", async () => {
    const t = schedule();
    t.advance(HOUR);
    const outcomes = [];
    for (let i = 0; i < 50; i++) {
      outcomes.push(await t.s.tick());
      t.advance(60_000);
    }
    expect(t.runs).toHaveLength(1);
  });

  it("a failed sweep counts as the day's run and the error reaches the caller", async () => {
    const t = schedule();
    t.advance(HOUR);
    t.failing(true);
    await expect(t.s.tick()).rejects.toThrow("disk is full");
    t.failing(false);
    t.advance(HOUR);
    expect(await t.s.tick()).toBeNull();
    t.advance(DAY);
    expect(await t.s.tick()).not.toBeNull();
    expect(t.runs).toHaveLength(2);
  });

  it("takes its interval from the options, never longer than a day by default", () => {
    const t = schedule({ everyMs: 6 * HOUR });
    expect(t.s.everyMs).toBe(6 * HOUR);
    expect(t.s.firstMs).toBe(60_000);
    expect(t.s.checkMs).toBe(60_000);
    expect(schedule().s.everyMs).toBe(DAY);
  });

  it("really sweeps the store: an artifact past its life is marked expired by the run", async () => {
    const a = await make(SAMPLES["text/plain"] as Uint8Array, ROOM, OWEN);
    const s = new ArtifactSweepSchedule(f.store, f.clock);
    f.clock.advance(8 * DAY);
    const swept = await s.tick();
    expect(swept?.expired).toBe(1);
    expect(f.store.get(a.id)?.deleted_at).not.toBeNull();
  });
});
