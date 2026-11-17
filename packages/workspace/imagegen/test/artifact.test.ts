// A finished picture as an artifact: copied in from the job's own result, by what the bytes are.

import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "@miyoria/store";
import type { ImageJob, ImageOutput } from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ImageArtifactError, ingestImageOutput } from "../src/index.js";

const PNG = Uint8Array.from([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  ...Array(100).fill(9),
]);

let base: string;
let store: SqliteStore;

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "miyoria-imagegen-artifact-"));
  store = await SqliteStore.open(join(base, "a.db"));
});

afterEach(async () => {
  await store.close();
  rmSync(base, { recursive: true, force: true });
});

function job(outputs: ImageOutput[], state: ImageJob["state"] = "done"): ImageJob {
  return { id: "J1", state, outputs } as unknown as ImageJob;
}

describe("ingestImageOutput", () => {
  it("stores the picture the job made as an `imagegen` artifact", async () => {
    const path = join(base, "J1-0.png");
    await writeFile(path, PNG);
    const output: ImageOutput = {
      path,
      file: "2026-11/gacha/J1-0.png",
      index: 0,
      bytes: PNG.length,
    };
    const artifacts = store.artifacts;
    if (!artifacts) throw new Error("no artifact store");
    const a = await ingestImageOutput(artifacts, job([output]), output, { turn: "T1" });
    expect(a).toMatchObject({
      source: "imagegen",
      plugin: "imagegen",
      mime: "image/png",
      kind: "image",
      filename: "J1-0.png",
      turn: "T1",
      scope: "self",
    });
  });

  it("takes only a picture of a finished job's own results", async () => {
    const path = join(base, "other.png");
    await writeFile(path, PNG);
    const output: ImageOutput = { path, file: "other.png", index: 0, bytes: PNG.length };
    const artifacts = store.artifacts;
    if (!artifacts) throw new Error("no artifact store");
    await expect(ingestImageOutput(artifacts, job([]), output)).rejects.toBeInstanceOf(
      ImageArtifactError,
    );
    await expect(
      ingestImageOutput(artifacts, job([output], "running"), output),
    ).rejects.toBeInstanceOf(ImageArtifactError);
    expect(artifacts.list({})).toEqual([]);
  });

  it("does not take a file that is not an image, whatever it is called", async () => {
    const path = join(base, "J2-0.png");
    await writeFile(path, "<html>not a picture</html>");
    const output: ImageOutput = { path, file: "J2-0.png", index: 0, bytes: 26 };
    const artifacts = store.artifacts;
    if (!artifacts) throw new Error("no artifact store");
    await expect(ingestImageOutput(artifacts, job([output]), output)).rejects.toThrow();
  });
});
