// No `"discord"` default in domain code (docs/design/v5-architecture.md §6): a platform comes from
// the context, the requester or the account, never from a fallback. The Discord module itself
// (`packages/discord`) is the platform and is not looked at; the generated `dist` neither.
//
// What counts as a default: `?? "discord"`, `|| "discord"`, `.default("discord")`, a parameter
// defaulting to it, an object built with `platform: "discord"`, a `discord:${...}` key, and
// `"discord"` passed as a call's last argument (`typedCommand(path, "discord")`). Comments are
// skipped. A comparison (`=== "discord"`, a Discord-only rule) is not a default.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const PACKAGES = join(import.meta.dirname, "..", "..");

const DEFAULT = new RegExp(
  [
    String.raw`(\?\?|\|\|)\s*"discord"`,
    String.raw`\.default\(\s*"discord"\s*\)`,
    String.raw`\b[A-Za-z_]\w*\s*(:\s*[A-Za-z_][\w.<>|\s]*)?=\s*"discord"\s*[,)]`,
    String.raw`\bplatform:\s*"discord"\s*[,}]`,
    "`discord:\\$\\{",
    String.raw`,\s*"discord"\s*\)`,
  ].join("|"),
);

/**
 * Files allowed to have one, by path under `packages/`, with why. The first group is for good:
 * those places are Discord's own. The second waits on the packages that own the files (phase 6,
 * .tmp-test/space-plan.md): remove an entry when its file is fixed.
 */
const ALLOWED: Readonly<Record<string, string>> = {
  // Discord's own: logging in with Discord, and the v4 data, which was all Discord.
  "api/src/oauth.ts": "Discord OAuth: the account is a Discord account",
  "store/src/cutover/v4-fixture.ts": "the v4 fixture: v4 ran on Discord only",

  // Waiting on P4 (money and boards): remove when fixed.
  "economy/src/commands-v2.ts": 'P4: typedCommand(path, "discord")',
  "economy/src/v2-tools.ts": 'P4: typedCommand(path, "discord")',
  "economy/src/commands.ts": "P4: idempotency keys",
  "economy/src/gift-commands.ts": "P4: idempotency keys",
  "play/exchange/src/commands.ts": "P4: idempotency keys",
  "api/src/wallet.ts": "P4: the recipient of a transfer",
};

/** Every `.ts` file under a `src` directory of a package, Discord's and `dist` left out. */
function sources(dir: string, inSrc = false, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!inSrc && relative(PACKAGES, path) === "discord") continue;
      sources(path, inSrc || name === "src", out);
    } else if (inSrc && name.endsWith(".ts") && !name.endsWith(".d.ts")) {
      out.push(path);
    }
  }
  return out;
}

/** `path:line` of each default in `text`, comments skipped. */
function defaults(path: string, text: string): string[] {
  const out: string[] = [];
  text.split("\n").forEach((line, i) => {
    const code = line.trim();
    if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return;
    if (DEFAULT.test(code)) out.push(`${path}:${i + 1}`);
  });
  return out;
}

describe("no platform default", () => {
  it("finds the defaults it looks for", () => {
    const found = [
      'const p = ctx.platform ?? "discord";',
      'const p = a || "discord";',
      'platform: z.string().default("discord"),',
      'function f(platform = "discord") {}',
      'function f(platform: string = "discord", x) {}',
      'const ref = { platform: "discord", id };',
      ["const key = `discord:$", "{newId()}`;"].join(""),
      'typedCommand("me bet", "discord")',
    ].map((line) => defaults("x.ts", line).length);
    expect(found).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    const not = [
      'if (platform === "discord") return;',
      '// a comment ?? "discord"',
      ' * platform: "discord"',
      'export const PLATFORM = "discord";',
      'z.enum(["token", "discord"])',
    ].map((line) => defaults("x.ts", line).length);
    expect(not).toEqual([0, 0, 0, 0, 0]);
  });

  it("has none in domain code outside the allow-list", () => {
    const files = sources(PACKAGES);
    expect(files.length).toBeGreaterThan(100);
    const offending = files.flatMap((file) => {
      const path = relative(PACKAGES, file).split(sep).join("/");
      if (Object.hasOwn(ALLOWED, path)) return [];
      return defaults(path, readFileSync(file, "utf8"));
    });
    expect(offending).toEqual([]);
  });
});
