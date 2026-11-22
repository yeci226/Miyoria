import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CharacterSectionSchema, Config, currencyOf } from "@miyoria/runtime/kernel";
import { DEFAULT_CHARACTER, DEFAULT_CURRENCY } from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  databaseDir,
  listProfileFolders,
  PROFILE_ENV,
  ProfileSelectError,
  peekConfig,
  resolveProfile,
} from "../src/profiles.js";
import { loadProfile } from "../src/settings.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "miyoria-profiles-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(path: string, text: string): string {
  const file = join(root, path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
  return file;
}

function persona(id: string, name = id): void {
  write(`profiles/${id}/profile.toml`, `id = "${id}"\ndisplay_name = "${name}"\n`);
  write(`profiles/${id}/persona/identity.md`, `# 你是 ${name}`);
  write(`profiles/${id}/persona/style.md`, "短。");
}

const noEnv = () => undefined;

function resolveAt(text: string | null, env: (name: string) => string | undefined = noEnv) {
  const install = text === null ? join(root, "miyoria.toml") : write("miyoria.toml", text);
  return resolveProfile(install, peekConfig(install, env), env);
}

describe("resolveProfile", () => {
  it("with no profile configured runs the install's config and data, as before profiles", () => {
    persona("deepseek-chan");
    const p = resolveAt('[core]\ndatabase_url = "sqlite:data/miyoria.db"\n');
    expect(p).toMatchObject({
      id: "deepseek-chan",
      own: false,
      source: "default",
      configPath: join(root, "miyoria.toml"),
      baseDir: root,
      installPath: join(root, "miyoria.toml"),
      dir: join(root, "profiles", "deepseek-chan"),
    });
    expect(databaseDir("sqlite:data/miyoria.db", p.baseDir)).toBe(join(root, "data"));
  });

  it("a missing install config resolves to the same defaults", () => {
    expect(resolveAt(null)).toMatchObject({ id: "deepseek-chan", own: false, baseDir: root });
  });

  it("core.profile naming a persona without its own config keeps the install's data", () => {
    persona("other");
    const p = resolveAt('[core]\nprofile = "other"\n');
    expect(p).toMatchObject({ id: "other", own: false, source: "config", baseDir: root });
  });

  it("a profile with its own miyoria.toml runs on it, its folder holding its data", () => {
    persona("kuro");
    write("profiles/kuro/miyoria.toml", '[core]\nprofile = "kuro"\nprofiles_dir = ".."\n');
    const p = resolveAt('[core]\nprofile = "kuro"\n');
    const dir = join(root, "profiles", "kuro");
    expect(p).toMatchObject({
      id: "kuro",
      own: true,
      configPath: join(dir, "miyoria.toml"),
      baseDir: dir,
      installPath: join(root, "miyoria.toml"),
    });
    expect(databaseDir("sqlite:data/miyoria.db", p.baseDir)).toBe(join(dir, "data"));
  });

  it("MIYORIA_PROFILE wins over core.profile", () => {
    persona("deepseek-chan");
    persona("kuro");
    write("profiles/kuro/miyoria.toml", '[core]\nprofile = "kuro"\nprofiles_dir = ".."\n');
    const env = (name: string) => (name === PROFILE_ENV ? "kuro" : undefined);
    expect(resolveAt('[core]\nprofile = "deepseek-chan"\n', env)).toMatchObject({
      id: "kuro",
      own: true,
      source: "env",
    });
  });

  it("refuses MIYORIA_PROFILE naming a folder without its own config, or a path", () => {
    persona("other");
    const env = (value: string) => (name: string) => (name === PROFILE_ENV ? value : undefined);
    expect(() => resolveAt("", env("other"))).toThrow(ProfileSelectError);
    expect(() => resolveAt("", env("../x"))).toThrow(/不是資料夾名稱/);
    // Naming the one the install runs anyway is fine.
    expect(resolveAt("", env("deepseek-chan")).own).toBe(false);
  });

  it("refuses a profile config that names another persona or profiles directory", () => {
    persona("kuro");
    write("profiles/kuro/miyoria.toml", '[core]\nprofile = "miyo"\nprofiles_dir = ".."\n');
    expect(() => resolveAt('[core]\nprofile = "kuro"\n')).toThrow(/core.profile/);
    write("profiles/kuro/miyoria.toml", '[core]\nprofile = "kuro"\n');
    expect(() => resolveAt('[core]\nprofile = "kuro"\n')).toThrow(/profiles_dir/);
  });

  it("reads core.profile through env references, without failing on a missing variable", () => {
    persona("kuro");
    write("profiles/kuro/miyoria.toml", '[core]\nprofile = "kuro"\nprofiles_dir = ".."\n');
    write(".env", "WHO=kuro\n");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${VAR} references in the file
    const p = resolveAt('[core]\nprofile = "${WHO}"\nlog = "${UNSET_VARIABLE}"\n');
    expect(p).toMatchObject({ id: "kuro", own: true });
  });

  it("lists the profiles and which have their own config", () => {
    persona("b");
    persona("a");
    write("profiles/a/miyoria.toml", "");
    mkdirSync(join(root, "profiles", "not-a-profile"));
    expect(listProfileFolders(join(root, "profiles"))).toEqual([
      { id: "a", own: true },
      { id: "b", own: false },
    ]);
  });
});

describe("[character]", () => {
  it("defaults to Miyoria's values", () => {
    expect(CharacterSectionSchema.parse({})).toEqual(DEFAULT_CHARACTER);
  });

  it("reads the coins' name from [modules.economy], as the economy does", () => {
    expect(currencyOf(undefined)).toBe(DEFAULT_CURRENCY);
    expect(currencyOf({})).toBe("魚幣");
    expect(currencyOf({ currency: "  貝殼 " })).toBe("貝殼");
    expect(currencyOf({ currency: "" })).toBe(DEFAULT_CURRENCY);
    expect(currencyOf({ currency: 3 })).toBe(DEFAULT_CURRENCY);
  });

  it("loads with the profile, and a broken section stops the load", async () => {
    persona("kuro", "Kuro");
    const at = (toml: string) =>
      loadProfile(Config.fromToml(`[core]\nprofile = "kuro"\n${toml}`), root);
    expect((await at("")).character).toEqual(DEFAULT_CHARACTER);
    const kuro = await at('[character]\nname = "Kuro"\nshort_name = "Ku"\nother_names = []\n');
    expect(kuro.character.name).toBe("Kuro");
    expect(kuro.names()).toEqual(["Kuro", "Kuro", "Ku"]);
    await expect(at('[character]\nname = ""\n')).rejects.toThrow(/character/);
  });
});
