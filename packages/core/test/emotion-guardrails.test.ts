// §12, the other way round: emotions change how she speaks and what she wants, never the rules.
// The code that decides what she may do does not read how she feels, so no feeling can get past it.
// The behaviour is tested where the rules live (packages/arbiter/test/floor.test.ts); this keeps a
// way around them from appearing. A new reader in a rule fails here until someone says why.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.ts$/.test(entry.name) ? [path] : [];
  });
}

/** How a feeling would be read, whichever service it came through. */
const FEELING = /AffectStateKey|SelfStateKey|MoodSignalsKey|EMOTION_OUTPUTS|\.biases\b|\.shown\b/;

const readers = (paths: string[]) =>
  paths
    .filter((p) => FEELING.test(readFileSync(p, "utf8")))
    .map((p) => relative(ROOT, p).replaceAll("\\", "/"));

const inside = (dir: string) => sources(join(ROOT, dir));
const file = (path: string) => [join(ROOT, path)];

describe("no rule reads how she feels", () => {
  it("Directive", () => {
    expect(readers(inside("packages/directive/src"))).toEqual([]);
  });

  it("the claim gate and the main line's checks", () => {
    expect(
      readers([
        ...file("packages/agent/src/claims.ts"),
        ...file("packages/agent/src/mainline/gate.ts"),
        ...file("packages/agent/src/mainline/commitments.ts"),
      ]),
    ).toEqual([]);
  });

  it("the action gate", () => {
    expect(
      readers([
        ...file("packages/actions/src/capability.ts"),
        ...file("packages/actions/src/gated.ts"),
        ...file("packages/actions/src/registry.ts"),
      ]),
    ).toEqual([]);
  });

  it("the scheduler", () => {
    expect(readers(inside("packages/scheduler/src"))).toEqual([]);
  });

  it("the Floor: one number comes in through its budget, and nothing else", () => {
    const path = join(ROOT, "packages/arbiter/src/floor.ts");
    expect(readers([path])).toEqual([]);
    const code = readFileSync(path, "utf8");
    // `#ownLines` is the only reader, and only `budget` calls it.
    expect(code.match(/env\.feeling/g)).toHaveLength(1);
    expect(code.match(/#ownLines\(/g)).toHaveLength(2);
    const interrupt = code.slice(code.indexOf("interruptLevel("), code.indexOf("// ---- budget"));
    expect(interrupt).not.toMatch(/talk|feeling|budget/);
  });
});
