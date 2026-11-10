// The commented `[modules.economy]` example in both config templates is valid config and is
// exactly the defaults.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Config } from "@miyoria/kernel";
import { describe, expect, it } from "vitest";
import { EconomyConfigSchema } from "../src/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

/** The `# [modules.economy]` block, uncommented. */
function example(text: string): string {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const start = lines.indexOf("# [modules.economy]");
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
    it(`economy_example_in_${file}`, () => {
      const config = Config.fromToml(
        example(readFileSync(join(ROOT, file), "utf8")),
        () => undefined,
      );
      const section = config.module("economy");
      expect(section.enabled).toBe(true);
      const economy = EconomyConfigSchema.strict().parse(section.config ?? {});
      expect(economy).toEqual(EconomyConfigSchema.parse({}));
    });
  }
});
