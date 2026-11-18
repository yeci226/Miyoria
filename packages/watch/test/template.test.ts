// The commented `[modules.watch]` example in both config templates is valid config and says every
// setting with its default.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Config } from "@miyoria/runtime/kernel";
import { describe, expect, it } from "vitest";
import { WatchConfigSchema } from "../src/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

/** The `# [modules.watch]` block, uncommented. */
function example(text: string): string {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const start = lines.indexOf("# [modules.watch]");
  expect(start).toBeGreaterThan(0);
  const out: string[] = [];
  for (const line of lines.slice(start)) {
    if (!line.startsWith("# ")) break;
    out.push(line.slice(2));
  }
  return out.join("\n");
}

describe("config templates", () => {
  for (const file of ["miyoria.example.toml", "packages/cli/templates/miyoria.example.toml"]) {
    it(`watch_example_in_${file}`, () => {
      const config = Config.fromToml(
        example(readFileSync(join(ROOT, file), "utf8")),
        () => undefined,
      );
      const section = config.module("watch").config ?? {};
      const parsed = WatchConfigSchema.strict().parse(section);
      // Every setting is there, and each one is its default.
      expect(Object.keys(section).sort()).toEqual(Object.keys(WatchConfigSchema.shape).sort());
      expect(parsed).toEqual(WatchConfigSchema.parse({}));
      expect(config.module("watch").enabled).toBe(false);
    });
  }
});
