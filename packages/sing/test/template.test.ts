// The commented `[modules.sing]` example in both config templates is valid config.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Config } from "@miyoria/runtime/kernel";
import { describe, expect, it } from "vitest";
import { SingConfigSchema } from "../src/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

/** The `# [modules.sing]` block, uncommented. */
function example(text: string): string {
  const lines = text.split("\n");
  const start = lines.indexOf("# [modules.sing]");
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
    it(`sing_example_in_${file}`, () => {
      const config = Config.fromToml(
        example(readFileSync(join(ROOT, file), "utf8")),
        () => undefined,
      );
      const sing = SingConfigSchema.strict().parse(config.module("sing").config ?? {});
      expect(sing.url).toBe("http://127.0.0.1:8005");
      expect(sing.start).toBe("decide");
      expect(sing.video_source).toBe("worker");
      expect(sing.ytdlp_path).toBe("yt-dlp");
    });
  }
});
