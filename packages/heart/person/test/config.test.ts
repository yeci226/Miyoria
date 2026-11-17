// `[modules.heart]`: every key the module reads is in the example config, and the bond's daily
// caps must be listed from the lowest bond up.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HeartConfigSchema } from "../src/index.js";

const EXAMPLE = fileURLToPath(new URL("../../../../miyoria.example.toml", import.meta.url));

/** The lines of `[modules.heart]` and its sub-tables in the example. */
function section(): string {
  const text = readFileSync(EXAMPLE, "utf8");
  const start = text.search(/^\[modules\.heart\]$/mu);
  const rest = text.slice(start + 1);
  const next = rest.search(/^\[modules\.(?!heart[.\]])/mu);
  return next < 0 ? rest : rest.slice(0, next);
}

describe("[modules.heart]", () => {
  it("documents every key in the example config", () => {
    const text = section();
    const defaults = HeartConfigSchema.parse({});
    const missing: string[] = [];
    for (const [key, value] of Object.entries(defaults)) {
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        if (!text.includes(`[modules.heart.${key}]`)) missing.push(`[modules.heart.${key}]`);
        for (const sub of Object.keys(value)) {
          if (!new RegExp(`^# ${sub} = `, "mu").test(text)) missing.push(`${key}.${sub}`);
        }
      } else if (!new RegExp(`^# ${key} = `, "mu").test(text)) {
        missing.push(key);
      }
    }
    expect(missing).toEqual([]);
  });

  it("takes the bond's caps only from the lowest bond up", () => {
    expect(() =>
      HeartConfigSchema.parse({
        bond_gain_caps: [
          [100, 8],
          [0, 12],
        ],
      }),
    ).toThrow(/lowest bonds must go up/);
    expect(() =>
      HeartConfigSchema.parse({
        bond_gain_caps: [
          [0, 12],
          [0, 8],
        ],
      }),
    ).toThrow();
    expect(HeartConfigSchema.parse({ bond_gain_caps: [[0, 40]] }).bond_gain_caps).toEqual([
      [0, 40],
    ]);
  });
});
