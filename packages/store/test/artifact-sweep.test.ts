// Expiry and collection: what expires and what never does, the grace before rows and blobs go,
// the sweep racing ingests, crashes between the row and the blob in both orders, stray files.

import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ArtifactInput, ArtifactStore } from "../src/index.js";
import {
  bytes,
  DAY,
  deferred,
  type Fixture,
  fixture,
  gatedStream,
  HOUR,
  SAMPLES,
  T0,
} from "./artifact-fixtures.js";

let f: Fixture;
beforeEach(() => {
  f = fixture();
});
afterEach(() => {
  f.close();
});

async function readAll(stream: AsyncIterable<Uint8Array | string>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts);
}

const input = (): ArtifactInput => ({ source: "imagegen", plugin: "imagegen", place: f.room });
const count = (table: string) => Number(f.t.db.all(`SELECT COUNT(*) AS n FROM ${table}`)[0]?.n);

function blobFiles(): string[] {
  const dir = f.store.layout.blobs;
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name);
}

/** A file's times set `ms` before the test clock's start (the sweep compares with its clock). */
function age(path: string, ms: number): void {
  const at = new Date(T0 - ms);
  utimesSync(path, at, at);
}

describe("expiry", () => {
  it("expires after 7 days, revokes the shares, and removes rows and blobs after the grace", async () => {
    const a = await f.store.ingest(SAMPLES["image/png"] as Uint8Array, input());
    const { share } = f.store.shares.create(a.id, { audience: "space", space_id: f.room.space_id });
    age(f.store.layout.blobPath(a.sha256), DAY);

    f.clock.advance(7 * DAY - 1);
    expect(await f.store.sweep()).toMatchObject({ expired: 0, blobs_removed: 0 });

    f.clock.advance(1);
    expect(await f.store.sweep()).toMatchObject({ expired: 1, rows_removed: 0, blobs_removed: 0 });
    expect(f.store.get(a.id)?.deleted_at).toBe(new Date(T0 + 7 * DAY).toISOString());
    expect(f.store.shares.get(share.id)?.revoked_at).not.toBeNull();
    const expired = f.t.events.query({ types: ["artifact.expired"] });
    expect(expired).toHaveLength(1);
    expect(expired[0]?.envelope).toMatchObject({ scope: "owner", tier: "keep" });
    expect(expired[0]?.envelope.data).toMatchObject({ artifact_id: a.id, shares_revoked: 1 });
    expect(existsSync(f.store.layout.blobPath(a.sha256))).toBe(true);

    // Within the grace the row (and so its blob) stays.
    f.clock.advance(DAY - 1);
    expect(await f.store.sweep()).toMatchObject({ expired: 0, rows_removed: 0, blobs_removed: 0 });

    f.clock.advance(1);
    const result = await f.store.sweep();
    expect(result).toMatchObject({ rows_removed: 1, blobs_removed: 1, bytes_freed: a.size });
    expect(f.store.get(a.id)).toBeNull();
    expect(f.store.shares.get(share.id)).toBeNull();
    expect(count("artifact_blobs")).toBe(0);
    expect(blobFiles()).toEqual([]);
    const swept = f.t.events.query({ types: ["artifact.swept"] });
    expect(swept).toHaveLength(1);
    expect(swept[0]?.envelope.data).toMatchObject({ rows_removed: 1, blobs_removed: 1 });

    // Nothing left to do: no new event.
    await f.store.sweep();
    expect(f.t.events.query({ types: ["artifact.swept"] })).toHaveLength(1);
  });

  it("never expires what is in an album or kept, and keeps a blob a live artifact shares", async () => {
    const data = SAMPLES["image/gif"] as Uint8Array;
    const album = await f.store.ingest(data, { ...input(), keep: "album" });
    const loose = await f.store.ingest(data, input());
    const kept = await f.store.ingest(SAMPLES["audio/wav"] as Uint8Array, input());
    expect(f.store.keep(kept.id, "person")).toBe(true);
    f.clock.advance(400 * DAY);
    const result = await f.store.sweep();
    expect(result).toMatchObject({ expired: 1 });
    f.clock.advance(2 * DAY);
    expect(await f.store.sweep()).toMatchObject({ rows_removed: 1, blobs_removed: 0 });
    expect(f.store.get(loose.id)).toBeNull();
    expect(f.store.get(album.id)).toMatchObject({ deleted_at: null, kept_by: "album" });
    expect(f.store.get(kept.id)).toMatchObject({ deleted_at: null, kept_by: "person" });
    expect(existsSync(f.store.layout.blobPath(album.sha256))).toBe(true);
  });

  it("takes per-source lifetimes", async () => {
    const short = fixture({ lifetimes: { sandbox: HOUR } });
    try {
      const a = await short.store.ingest(SAMPLES["text/plain"] as Uint8Array, {
        source: "sandbox",
        plugin: "sandbox",
      });
      const b = await short.store.ingest(SAMPLES["text/plain"] as Uint8Array, {
        source: "doc",
        plugin: "notebook",
      });
      expect(a.expires_at).toBe(new Date(T0 + HOUR).toISOString());
      expect(b.expires_at).toBe(new Date(T0 + 7 * DAY).toISOString());
    } finally {
      short.close();
    }
  });

  it("expires many in batches", { timeout: 60_000 }, async () => {
    for (let i = 0; i < 230; i++) {
      await f.store.ingest(new TextEncoder().encode(`note ${i}`), {
        source: "doc",
        plugin: "notebook",
      });
    }
    f.clock.advance(8 * DAY);
    expect((await f.store.sweep()).expired).toBe(230);
    expect(f.t.events.query({ types: ["artifact.expired"], limit: 1000 })).toHaveLength(230);
  });
});

describe("collection against ingests", () => {
  it("does not collect a blob placed by an ingest that has not committed", async () => {
    const data = SAMPLES["video/webm"] as Uint8Array;
    // An old orphan of the same bytes (a crash long ago), which the sweep would remove.
    const path = f.store.layout.blobPath(
      (await import("node:crypto")).createHash("sha256").update(data).digest("hex"),
    );
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
    age(path, 30 * DAY);

    const placed = deferred();
    const proceed = deferred();
    const store = new ArtifactStore(f.t.db, f.t.events, {
      root: f.root,
      onPlaced: async () => {
        placed.resolve();
        await proceed.promise;
      },
    });
    const ingest = store.ingest(data, input());
    await placed.promise;
    f.clock.advance(60 * DAY);
    const result = await store.sweep();
    expect(result).toMatchObject({ orphan_files_removed: 0, blobs_removed: 0 });
    expect(existsSync(path)).toBe(true);
    proceed.resolve();
    const a = await ingest;
    const { stream } = await store.openFor(a.id, {
      owner: true,
      person_id: null,
      space_id: null,
      room_id: null,
    });
    expect(await readAll(stream)).toEqual(Buffer.from(data));
  });

  it("does not collect a blob row that an ingest is reusing", async () => {
    const data = SAMPLES["image/jpeg"] as Uint8Array;
    const old = await f.store.ingest(data, input());
    f.clock.advance(8 * DAY);
    await f.store.sweep(); // expired
    f.clock.advance(2 * DAY);
    // The tombstone goes now; the blob row would follow, but an ingest of the same bytes is on it.
    const placed = deferred();
    const proceed = deferred();
    const store = new ArtifactStore(f.t.db, f.t.events, {
      root: f.root,
      onPlaced: async () => {
        placed.resolve();
        await proceed.promise;
      },
    });
    const ingest = store.ingest(data, input());
    await placed.promise;
    expect(await store.sweep()).toMatchObject({ rows_removed: 1, blobs_removed: 0 });
    proceed.resolve();
    const fresh = await ingest;
    expect(fresh.sha256).toBe(old.sha256);
    expect(existsSync(store.layout.blobPath(fresh.sha256))).toBe(true);
    expect(count("artifact_blobs")).toBe(1);
  });

  it("does not remove the temporary file of a stream still being written", async () => {
    const data = SAMPLES["audio/ogg"] as Uint8Array;
    const gate = deferred();
    const ingest = f.store.ingestStream(
      gatedStream([data.subarray(0, 100), data.subarray(100)], gate.promise),
      input(),
    );
    // Let the first chunk reach the disk.
    const written = () =>
      existsSync(f.store.layout.tmp) && readdirSync(f.store.layout.tmp).length > 0;
    for (let i = 0; i < 200 && !written(); i++) await new Promise((r) => setTimeout(r, 5));
    expect(written()).toBe(true);
    f.clock.advance(30 * DAY);
    expect(await f.store.sweep()).toMatchObject({ temp_files_removed: 0 });
    gate.resolve();
    const a = await ingest;
    expect(a.size).toBe(data.length);
  });

  it("joins a sweep already running", async () => {
    const [one, two] = await Promise.all([f.store.sweep(), f.store.sweep()]);
    expect(one).toBe(two);
  });
});

describe("crashes", () => {
  it("removes a blob file whose row never committed, after the grace", async () => {
    const data = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 500);
    const hash = (await import("node:crypto")).createHash("sha256").update(data).digest("hex");
    const path = f.store.layout.blobPath(hash);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
    age(path, -HOUR); // written "now"
    expect(await f.store.sweep()).toMatchObject({ orphan_files_removed: 0 });
    expect(existsSync(path)).toBe(true);
    f.clock.advance(DAY + 2 * HOUR);
    expect(await f.store.sweep()).toMatchObject({ orphan_files_removed: 1 });
    expect(existsSync(path)).toBe(false);
  });

  it("counts a row whose file is gone, and a new ingest of the same bytes brings it back", async () => {
    const data = SAMPLES["application/pdf"] as Uint8Array;
    const a = await f.store.ingest(data, { ...input(), source: "doc" });
    rmSync(f.store.layout.blobPath(a.sha256));
    expect(await f.store.sweep()).toMatchObject({ missing_blobs: 1 });
    await expect(f.store.openContent(a)).rejects.toThrow(/missing/);
    await f.store.ingest(data, { ...input(), source: "doc" });
    expect(await f.store.sweep()).toMatchObject({ missing_blobs: 0 });
    expect(await readAll(await f.store.openContent(a))).toEqual(Buffer.from(data));
  });

  it("finishes a collection a crash cut between the row and the unlink", async () => {
    // The row went, the file stayed: that is an orphan file to the next run.
    const a = await f.store.ingest(SAMPLES["image/png"] as Uint8Array, input());
    f.t.db.run("DELETE FROM artifact_items");
    f.t.db.run("DELETE FROM artifact_blobs");
    age(f.store.layout.blobPath(a.sha256), 2 * DAY);
    expect(await f.store.sweep()).toMatchObject({ orphan_files_removed: 1, blobs_removed: 0 });
    expect(blobFiles()).toEqual([]);
  });

  it("finishes a collection a crash cut between the unlink and the row", async () => {
    // The file went first (another order, or someone removed it): the row goes on the next run.
    const a = await f.store.ingest(SAMPLES["image/png"] as Uint8Array, input());
    f.t.db.run("DELETE FROM artifact_items");
    rmSync(f.store.layout.blobPath(a.sha256));
    f.clock.advance(2 * DAY);
    expect(await f.store.sweep()).toMatchObject({ blobs_removed: 1, missing_blobs: 0 });
    expect(count("artifact_blobs")).toBe(0);
  });

  it("removes stale temporary files and leaves names that are not its own", async () => {
    mkdirSync(f.store.layout.tmp, { recursive: true });
    const stale = f.store.layout.tempPath();
    writeFileSync(stale, "half an image");
    age(stale, 2 * DAY);
    const fresh = f.store.layout.tempPath();
    writeFileSync(fresh, "still going");
    age(fresh, -HOUR);
    const foreign = join(f.store.layout.tmp, "keep-me.txt");
    writeFileSync(foreign, "not the store's");
    age(foreign, 30 * DAY);
    mkdirSync(join(f.store.layout.blobs, "zz"), { recursive: true });
    const odd = join(f.store.layout.blobs, "zz", "notes.txt");
    writeFileSync(odd, "x");
    age(odd, 30 * DAY);
    expect(await f.store.sweep()).toMatchObject({ temp_files_removed: 1, orphan_files_removed: 0 });
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(foreign)).toBe(true);
    expect(existsSync(odd)).toBe(true);
  });

  it("is safe to run again and again", async () => {
    await f.store.ingest(SAMPLES["image/png"] as Uint8Array, input());
    f.clock.advance(10 * DAY);
    const first = await f.store.sweep();
    f.clock.advance(2 * DAY);
    await f.store.sweep();
    const again = await f.store.sweep();
    expect(first.expired).toBe(1);
    expect(again).toMatchObject({ expired: 0, rows_removed: 0, blobs_removed: 0 });
    expect(blobFiles()).toEqual([]);
  });
});
