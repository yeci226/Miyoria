// A profile's front page file: the first character's hand-made page, a page of her own, or the
// plain one; a file that does not read never stops anything and says why.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { LANDING_FILE_MAX_BYTES, loadLanding } from "../src/index.js";

const PROFILES = fileURLToPath(new URL("../../../../profiles", import.meta.url));

const cleanups: string[] = [];
afterEach(async () => {
  for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function profileWith(files: Record<string, string | Buffer>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "myr-front-"));
  cleanups.push(dir);
  await mkdir(join(dir, "landing"));
  for (const [name, body] of Object.entries(files))
    await writeFile(join(dir, "landing", name), body);
  return dir;
}

describe("a profile's front page", () => {
  it("is the hand-made page for the first character, as shipped", async () => {
    expect(await loadLanding(join(PROFILES, "deepseek-chan"))).toEqual({
      landing: { kind: "builtin" },
      problems: [],
    });
  });

  it("is the plain page without a file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "myr-front-"));
    cleanups.push(dir);
    expect(await loadLanding(dir)).toEqual({ landing: { kind: "plain" }, problems: [] });
  });

  it("reads a page of her own, its pictures checked", async () => {
    const dir = await profileWith({
      "landing.json": JSON.stringify({
        line: " 一隻黑貓 ",
        cover: "cover.webp",
        sections: [
          { title: "聊天", text: "標他就好", image: "chat.png" },
          { title: "唱歌", text: "點一首", image: "gone.png" },
        ],
      }),
      "cover.webp": Buffer.from([1]),
      "chat.png": Buffer.from([2]),
    });
    const loaded = await loadLanding(dir);
    expect(loaded.landing).toEqual({
      kind: "own",
      dir: join(dir, "landing"),
      content: {
        line: "一隻黑貓",
        cover: "cover.webp",
        sections: [
          { title: "聊天", text: "標他就好", image: "chat.png" },
          { title: "唱歌", text: "點一首", image: null },
        ],
      },
    });
    expect(loaded.problems).toHaveLength(1);
    expect(loaded.problems[0]).toContain("gone.png");
  });

  it("leaves out a picture over the size limit", async () => {
    const dir = await profileWith({
      "landing.json": JSON.stringify({ cover: "big.png" }),
      "big.png": Buffer.alloc(LANDING_FILE_MAX_BYTES + 1),
    });
    const loaded = await loadLanding(dir);
    expect(loaded.landing.kind).toBe("own");
    if (loaded.landing.kind === "own") expect(loaded.landing.content.cover).toBeNull();
    expect(loaded.problems).toHaveLength(1);
  });

  it("falls back to the plain page, saying why, when the file does not read", async () => {
    for (const body of [
      "{ not json",
      JSON.stringify({ builtin: "someone-else" }),
      JSON.stringify({ cover: "../outside.png" }),
      JSON.stringify({ cover: "a.svg" }),
      JSON.stringify({ sections: [{ title: "", text: "x" }] }),
      JSON.stringify({ script: "<script>" }),
    ]) {
      const loaded = await loadLanding(await profileWith({ "landing.json": body }));
      expect(loaded.landing, body).toEqual({ kind: "plain" });
      expect(loaded.problems, body).toHaveLength(1);
    }
  });
});
