// The config template `miyoria init` writes (`templates/`) is a copy of the repository's
// `miyoria.example.toml`: when they differ, a new install is missing keys the docs talk about.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Config } from "@miyoria/runtime/kernel";
import { describe, expect, it } from "vitest";
import { exampleConfig } from "../src/assets.js";

const ROOT_EXAMPLE = fileURLToPath(new URL("../../../miyoria.example.toml", import.meta.url));

const lf = (text: string) => text.replaceAll("\r\n", "\n");

describe("config template", () => {
  it("is_the_same_file_as_the_repository_example", () => {
    const root = lf(readFileSync(ROOT_EXAMPLE, "utf8"));
    // On a difference: `cp miyoria.example.toml packages/cli/templates/miyoria.example.toml`.
    expect(lf(exampleConfig())).toBe(root);
  });

  it("parses_and_keeps_its_commented_sections_for_the_v3_modules", () => {
    const text = exampleConfig();
    expect(() => Config.fromToml(text, () => undefined)).not.toThrow();
    for (const section of ["[modules.facts]", "[modules.moderation]", "[modules.memory.pinned]"]) {
      expect(text).toContain(section);
    }
  });

  it("names_no_worker_address_and_no_old_launcher_section", () => {
    const text = exampleConfig();
    expect(text).not.toMatch(/ASR_URL|TTS_URL/);
    expect(text).not.toMatch(/^\s*#?\s*\[(stack|machine)[\].]/m);
    expect(text).not.toContain("miyoria start");
    expect(text).not.toContain("miyoria install");
    const toml = Config.fromToml(text, () => undefined).section("speech") as {
      asr: { local: Record<string, unknown> };
      tts: { local: Record<string, unknown> };
    };
    expect(toml.asr.local).toEqual({ kind: "http-worker" });
    expect(toml.tts.local).toMatchObject({ kind: "http-worker" });
    expect(toml.tts.local.url).toBeUndefined();
    // The one way to pin a worker is shown as a comment.
    expect(text).toMatch(/^# url = "http:\/\/127\.0\.0\.1:8003"$/m);
  });
});
