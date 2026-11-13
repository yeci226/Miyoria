// The commented `[modules.imagegen]` example in both config templates is valid config.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Config } from "@miyoria/kernel";
import { describe, expect, it } from "vitest";
import { ImageGenConfigSchema } from "../src/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

/** The `# [modules.imagegen]` block, uncommented. */
function example(text: string): string {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const start = lines.indexOf("# [modules.imagegen]");
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
    it(`imagegen_example_in_${file}`, () => {
      const config = Config.fromToml(
        example(readFileSync(join(ROOT, file), "utf8")),
        () => undefined,
      );
      const section = config.module("imagegen");
      expect(section.enabled).toBe(true);
      const imagegen = ImageGenConfigSchema.parse(section.config ?? {});
      expect(imagegen.batch_hours).toBe("02:00-08:00");
      expect(imagegen.models.krea2?.variants.raw?.files?.diffusion_model).toBe(
        "krea2_raw_fp8_scaled.safetensors",
      );
    });
  }
});
