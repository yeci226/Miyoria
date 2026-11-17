import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "@miyoria/runtime/kernel";
import { describe, expect, it } from "vitest";
import {
  install,
  isGitSource,
  isValid,
  list,
  MANIFEST_FILE,
  newExtension,
  validate,
} from "../src/index.js";

function temp(): string {
  return mkdtempSync(join(tmpdir(), "miyoria-cli-"));
}

describe("cli", () => {
  it("scaffold_validate_install_list", () => {
    const root = temp();
    try {
      const dir = newExtension(join(root, "src"), "my-ext");
      const v = validate(dir);
      expect(v.errors).toEqual([]);
      expect(isValid(v)).toBe(true);
      expect(v.manifest?.id).toBe("my-ext");
      // dist is not built yet.
      expect(v.warnings).toHaveLength(1);
      expect(() => newExtension(join(root, "src"), "my-ext")).toThrow(/already exists/);
      expect(() => newExtension(root, "Bad")).toThrow(/must be 1-32 chars/);

      mkdirSync(join(dir, "node_modules/x"), { recursive: true });
      const config = Config.fromToml(
        `[modules.extensions]\ndirs = [${JSON.stringify(join(root, "installed"))}]\n[extensions."my-ext"]\nenabled = false`,
      );
      const installed = install(config, root, dir);
      expect(installed.dir).toBe(join(root, "installed", "my-ext"));
      expect(statSync(join(installed.dir, "src/index.ts")).isFile()).toBe(true);
      expect(existsSync(join(installed.dir, "node_modules"))).toBe(false);
      expect(() => install(config, root, dir)).toThrow(/already exists/);
      expect(() => install(config, root, "nope-not-a-dir")).toThrow(/neither a directory/);

      const listed = list(config, root);
      expect(listed).toHaveLength(1);
      expect(listed[0]?.enabled).toBe(false);
      expect(listed[0]?.runs_on_core).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("git_sources", () => {
    expect(isGitSource("https://github.com/a/b")).toBe(true);
    expect(isGitSource("git@github.com:a/b.git")).toBe(true);
    expect(isGitSource("git+file:///tmp/x")).toBe(true);
    expect(isGitSource("./extensions/x")).toBe(false);
  });

  it("validate_reports_missing_manifest_and_schema", () => {
    const dir = temp();
    try {
      expect(isValid(validate(dir))).toBe(false);
      writeFileSync(
        join(dir, MANIFEST_FILE),
        'id = "v"\nversion = "1"\nkind = "tools"\nruntime = "node"\nentry = "i.js"\n[config]\nschema = "missing.json"',
      );
      const v = validate(dir);
      expect(v.errors).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
