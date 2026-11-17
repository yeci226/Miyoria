import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { findExtensionDirs, MANIFEST_FILE } from "../src/index.js";

const root = mkdtempSync(join(tmpdir(), "miyoria-ext-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function manifest(...parts: string[]): string {
  const dir = join(root, ...parts);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, MANIFEST_FILE), 'id = "x"\n');
  return dir;
}

describe("extension discovery", () => {
  it("skips_the_examples_folder_unless_it_is_listed_itself", () => {
    const real = manifest("minecraft");
    const hello = manifest("examples", "hello");
    expect(findExtensionDirs(root)).toEqual([real]);
    expect(findExtensionDirs(join(root, "examples"))).toEqual([hello]);
  });
});
