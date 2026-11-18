// The kept pictures under a cap: the ones used longest ago go first (used = read or written, kept
// as the file's modified time, never the access time), never one being read or written, the cap
// checked after each write, and a write that never finished cleaned up.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { cardsConfig } from "../src/config.js";
import { Live2dPortrait, STUDIO_ENTRY, type StudioModule } from "../src/live2d.js";
import { PortraitCache } from "../src/portrait-cache.js";

function scratch(): string {
  const root = join(process.env.TMP ?? tmpdir(), "portrait-cache-test");
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, "c-"));
}

const log = () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn() });
const KB = 1024;
const T0 = Date.UTC(2026, 10, 17, 2, 0, 0);

/** A picture of `kb` kilobytes last used `ago` ms before T0. */
function picture(dir: string, name: string, kb: number, ago: number): string {
  const file = join(dir, name);
  writeFileSync(file, new Uint8Array(kb * KB));
  const at = new Date(T0 - ago);
  utimesSync(file, at, at);
  return file;
}

const names = (dir: string) => readdirSync(dir).sort();

describe("the kept pictures", () => {
  it("is on with a cap of 2048 MB by default", () => {
    expect(cardsConfig().portrait_cache_max_mb).toBe(2048);
  });

  it("deletes the pictures used longest ago until under the cap, and nothing under it", async () => {
    const dir = scratch();
    picture(dir, "a.png", 4, 40_000);
    picture(dir, "b.png", 4, 30_000);
    picture(dir, "c.png", 4, 20_000);
    picture(dir, "d.png", 4, 10_000);
    writeFileSync(join(dir, "notes.txt"), "not a picture");
    const cache = new PortraitCache({ dir, maxBytes: 9 * KB, log: log(), now: () => T0 });
    expect(await cache.sweep()).toEqual({ deleted: 2, bytes: 8 * KB });
    expect(names(dir)).toEqual(["c.png", "d.png", "notes.txt"]);
    expect(await cache.sweep()).toEqual({ deleted: 0, bytes: 8 * KB });
  });

  it("counts a read as a use: the picture read last stays", async () => {
    const dir = scratch();
    const a = picture(dir, "a.png", 4, 40_000);
    picture(dir, "b.png", 4, 30_000);
    picture(dir, "c.png", 4, 20_000);
    const cache = new PortraitCache({ dir, maxBytes: 8 * KB, log: log(), now: () => T0 });
    expect((await cache.read(a))?.length).toBe(4 * KB);
    expect(await cache.read(join(dir, "gone.png"))).toBeNull();
    await cache.sweep();
    expect(names(dir)).toEqual(["a.png", "c.png"]);
  });

  it("checks the cap after each picture it keeps", async () => {
    const dir = scratch();
    picture(dir, "old.png", 4, 40_000);
    const cache = new PortraitCache({ dir, maxBytes: 6 * KB, log: log(), now: () => T0 });
    await cache.keep(join(dir, "new.png"), new Uint8Array(4 * KB));
    await vi.waitFor(() => expect(names(dir)).toEqual(["new.png"]));
  });

  it("never deletes a picture being read, and leaves a write that never finished for an hour", async () => {
    const dir = scratch();
    const a = picture(dir, "a.png", 4, 40_000);
    picture(dir, "b.png", 4, 30_000);
    picture(dir, "x.png.1.abc.tmp", 1, 2 * 60 * 60_000);
    picture(dir, "y.png.1.def.tmp", 1, 60_000);
    const cache = new PortraitCache({ dir, maxBytes: 4 * KB, log: log(), now: () => T0 });
    // `a` is being read (or served) while the sweep looks.
    const release = cache.hold(a);
    await cache.sweep();
    release();
    // `a` was held: `b` went instead, though it was used later. The old temporary file went.
    expect(names(dir)).toEqual(["a.png", "y.png.1.def.tmp"]);
    // Let go, it is the oldest again.
    picture(dir, "c.png", 4, 0);
    await cache.sweep();
    expect(names(dir)).toEqual(["c.png", "y.png.1.def.tmp"]);
  });

  it("is what the Live2D portrait reads and writes, under its cap", async () => {
    const dir = scratch();
    const studioDir = join(dir, "studio");
    mkdirSync(join(studioDir, "dist", "node"), { recursive: true });
    writeFileSync(join(studioDir, STUDIO_ENTRY), "");
    const model = join(dir, "her.model3.json");
    writeFileSync(model, "{}");
    const cacheDir = join(dir, "cache");
    let n = 0;
    const mod: StudioModule = {
      CardStudio: class {
        async render() {
          n += 1;
          return new Uint8Array(3 * KB).fill(n);
        }
        async stop() {}
      },
      missingFiles: () => null,
    };
    const portrait = new Live2dPortrait({
      studioDir,
      model,
      cacheDir,
      cacheMaxBytes: 5 * KB,
      timeoutMs: 1_000,
      log: log(),
      loadStudio: async () => mod,
    });
    const card = (seed: number) => ({
      parts: [],
      expression: { id: "calm", name: "平靜" } as never,
      seed,
    });
    expect(await portrait.render(card(1))).not.toBeNull();
    expect(await portrait.render(card(2))).not.toBeNull();
    // Two pictures of 3 KB are over 5 KB: the one used longest ago went.
    await vi.waitFor(() => expect(readdirSync(cacheDir)).toHaveLength(1));
    // Rendered again when asked for: a picture can always be made again from its card.
    expect(await portrait.render(card(1))).not.toBeNull();
    expect(n).toBe(3);
    expect(existsSync(cacheDir)).toBe(true);
    await portrait.close();
  });
});
