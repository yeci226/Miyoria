// `@miyoria/contracts` is published next to `@miyoria/sdk`, and the SDK depends on it. A published
// package must not point at source files it does not ship, so `publishConfig.exports` replaces
// `exports` at pack time with the built files only; this keeps the two lists in step, so a new
// part is never left out of the tarball.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface Manifest {
  exports: Record<string, Record<string, string>>;
  publishConfig: { access: string; exports: Record<string, Record<string, string>> };
  files: string[];
  scripts: Record<string, string>;
}

const manifest = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as Manifest;

describe("what is published", () => {
  it("has an entry in publishConfig.exports for every part, pointing at built files", () => {
    expect(Object.keys(manifest.publishConfig.exports).sort()).toEqual(
      Object.keys(manifest.exports).sort(),
    );
    for (const [part, conditions] of Object.entries(manifest.publishConfig.exports)) {
      const source = manifest.exports[part];
      expect(Object.keys(conditions).sort(), part).toEqual(["default", "types"]);
      expect(conditions.types, part).toBe(source?.types);
      expect(conditions.default, part).toBe(source?.default);
    }
  });

  it("is public, ships the build and the JSON Schema, and builds before it is packed", () => {
    expect(manifest.publishConfig.access).toBe("public");
    expect(manifest.files).toEqual(["dist", "schema"]);
    expect(manifest.scripts.prepack).toBe("pnpm build");
  });
});
