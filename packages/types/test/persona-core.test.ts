import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CORE_CHARS, characterCore } from "../src/index.js";

const PROFILE = join(import.meta.dirname, "../../../profiles/deepseek-chan/persona");

describe("characterCore", () => {
  it("keeps the title, the opening and her personality, not the style or the rules", () => {
    const persona = [
      readFileSync(join(PROFILE, "identity.md"), "utf8"),
      readFileSync(join(PROFILE, "style.md"), "utf8"),
    ].join("\n\n");
    const core = characterCore(persona);
    const lines = core.split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.length).toBeLessThanOrEqual(5);
    expect(lines[0]).toBe("你是 DeepSeek-chan");
    expect([...core].length).toBeLessThanOrEqual(CORE_CHARS + 1);
    expect(core).not.toMatch(/silence|<emo|^#/m);
  });

  it("is empty for an empty persona and cuts one long sentence", () => {
    expect(characterCore("")).toBe("");
    const long = "她".repeat(1000);
    expect([...characterCore(long)].length).toBe(CORE_CHARS + 1);
  });
});
