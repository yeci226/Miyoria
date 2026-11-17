// The `artifacts` data category: counted with its bytes, exported without token hashes, wiped
// with the people who own artifacts, and the bytes left to the sweep.

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dataCategory, RESET_CATEGORIES, resolveCategories, SqliteStore } from "../src/index.js";
import { DAY, SAMPLES, T0 } from "./artifact-fixtures.js";

let root: string;
let store: SqliteStore;
let now = T0;

beforeEach(async () => {
  now = T0;
  root = mkdtempSync(join(tmpdir(), "miyoria-artifact-data-"));
  store = await SqliteStore.open(":memory:", {
    artifactRoot: join(root, "artifacts"),
    clock: { now: () => now },
  });
});
afterEach(async () => {
  await store.close();
  rmSync(root, { recursive: true, force: true });
});

function blobFiles(): string[] {
  const dir = join(root, "artifacts", "blobs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name);
}

describe("the artifacts category", () => {
  it("is wiped by a reset and with the people its rows point at", () => {
    expect(dataCategory("artifacts")).toMatchObject({ kept: false, shared: false });
    expect(RESET_CATEGORIES).toContain("artifacts");
    const order = resolveCategories(["people"]);
    expect(order).toContain("artifacts");
    expect(order.indexOf("artifacts")).toBeLessThan(order.indexOf("people"));
  });

  it("counts artifacts by kind and the bytes stored, exports them, and wipes them", async () => {
    const artifacts = store.artifacts;
    if (artifacts === null) throw new Error("a root was given");
    const ctx = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" } as const;
    const place = store.persons.resolve(ctx, {
      account: { platform: "discord", id: "100" },
      display_name: "Owen",
    });
    const png = SAMPLES["image/png"] as Uint8Array;
    const text = SAMPLES["text/plain"] as Uint8Array;
    const a = await artifacts.ingest(png, {
      source: "imagegen",
      plugin: "imagegen",
      place,
      made_for: place.person_id,
    });
    await artifacts.ingest(png, { source: "imagegen", plugin: "imagegen", place });
    await artifacts.ingest(text, { source: "doc", plugin: "notebook", place });
    const { token } = artifacts.shares.create(a.id, {
      audience: "space",
      space_id: place.space_id,
    });

    const inventory = await store.profileData.inventory("deepseek-chan");
    const category = inventory.categories.find((c) => c.id === "artifacts");
    expect(category?.parts.map((p) => [p.id, p.count])).toEqual([
      ["artifact_shares", 1],
      ["artifacts", 3],
      ["artifact_blobs", 2],
    ]);
    expect(category?.breakdown).toEqual({
      image: 2,
      text: 1,
      bytes: png.length + text.length,
    });

    const backup = await store.profileData.export("deepseek-chan", ["artifacts"]);
    expect(backup.parts.artifacts).toHaveLength(3);
    expect(backup.parts.artifacts?.[0]).toMatchObject({ id: a.id, downloadable: true });
    expect(JSON.stringify(backup)).not.toContain(token);
    expect(JSON.stringify(backup)).not.toContain("token_hash");

    // Deleting people deletes the artifacts first (they point at persons and places).
    const counts = await store.profileData.wipe("deepseek-chan", ["people"]);
    expect(counts).toMatchObject({ artifact_shares: 1, artifacts: 3, artifact_blobs: 2 });
    expect(artifacts.get(a.id)).toBeNull();
    expect(blobFiles()).toHaveLength(2);
    // The bytes go with the sweep, once older than its grace.
    now = Math.max(T0, Date.now()) + 2 * DAY;
    expect(await artifacts.sweep()).toMatchObject({ orphan_files_removed: 2 });
    expect(blobFiles()).toEqual([]);
  });

  it("has no artifact store without a root on an in-memory database", async () => {
    const bare = await SqliteStore.open(":memory:");
    try {
      expect(bare.artifacts).toBeNull();
      const inventory = await bare.profileData.inventory("deepseek-chan");
      expect(inventory.categories.find((c) => c.id === "artifacts")?.count).toBe(0);
    } finally {
      await bare.close();
    }
  });
});
