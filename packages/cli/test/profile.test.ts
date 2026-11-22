import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProfile, peekConfig, resolveProfile } from "@miyoria/core/light";
import { Config } from "@miyoria/runtime/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enterProfile, isCharacterCommand, parseArgs } from "../src/cli.js";
import { create, ProfileCommandError, use } from "../src/commands/profile.js";
import { loadProfileEnv, selectProfile } from "../src/profile.js";
import { type Output, setOutput } from "../src/ui.js";

const TMP = join(dirname(fileURLToPath(import.meta.url)), "..", ".tmp-test");
const REPO_PROFILES = fileURLToPath(new URL("../../../profiles", import.meta.url));

let root: string;
let install: string;
let restore: () => void;

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
  root = mkdtempSync(join(TMP, "profile-"));
  install = join(root, "miyoria.toml");
  const quiet: Output = { out: () => {}, err: () => {} };
  restore = setOutput(quiet);
});

afterEach(() => {
  restore();
  rmSync(root, { recursive: true, force: true });
});

function write(path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function persona(id: string): void {
  write(`profiles/${id}/profile.toml`, `id = "${id}"\ndisplay_name = "${id}"\n`);
  write(`profiles/${id}/persona/identity.md`, "x");
  write(`profiles/${id}/persona/style.md`, "y");
}

describe("which commands follow the profile", () => {
  it("are the ones about her; the machine's keep the install's files", () => {
    const of = (...argv: string[]) => isCharacterCommand(parseArgs(argv).path);
    for (const c of [["core"], ["chat"], ["config", "list"], ["doctor"], ["db", "doctor"]]) {
      expect(of(...c)).toBe(true);
    }
    expect(of("profile", "validate")).toBe(true);
    for (const c of [["init"], ["hostd"], ["up"], ["add"], ["host", "show"], ["update"]]) {
      expect(of(...c)).toBe(false);
    }
    for (const c of [
      ["profile", "use", "x"],
      ["profile", "new", "x"],
      ["host", "migrate"],
    ]) {
      expect(of(...c)).toBe(false);
    }
  });
});

describe("enterProfile", () => {
  it("with no profile configured, loads the install's .env and keeps every path as today", () => {
    write("miyoria.toml", '[core]\nlog = "info"\n');
    write(".env", "LLM_API_KEY=install\nREAL=dotenv\n");
    const env: Record<string, string | undefined> = { REAL: "shell" };
    const parsed = parseArgs(["core", "-c", install]);
    enterProfile(parsed, env);
    expect(parsed.ctx.config).toBe(install);
    expect(parsed.ctx.install).toBe(install);
    expect(parsed.ctx.options["host-config"]).toBeUndefined();
    expect(parsed.ctx.profile).toMatchObject({ id: "deepseek-chan", own: false, baseDir: root });
    // Exactly `loadDotenv`: unset ones are filled, set ones win.
    expect(env).toEqual({ REAL: "shell", LLM_API_KEY: "install" });
  });

  it("a profile of its own swaps in its config and .env; host.toml stays the install's", () => {
    persona("kuro");
    write("profiles/kuro/miyoria.toml", '[core]\nprofile = "kuro"\nprofiles_dir = ".."\n');
    write("profiles/kuro/.env", "DISCORD_BOT_TOKEN=kuro-token\n");
    write("miyoria.toml", '[core]\nprofile = "kuro"\n');
    write(".env", "DISCORD_BOT_TOKEN=miyoria-token\nLLM_API_KEY=miyoria-key\n");
    // hostd loaded the install's .env and passes its environment on.
    const env: Record<string, string | undefined> = {
      DISCORD_BOT_TOKEN: "miyoria-token",
      LLM_API_KEY: "miyoria-key",
      PATH: "/bin",
    };
    const parsed = parseArgs(["core", "-c", install]);
    enterProfile(parsed, env);
    expect(parsed.ctx.config).toBe(join(root, "profiles", "kuro", "miyoria.toml"));
    expect(parsed.ctx.install).toBe(install);
    expect(parsed.ctx.options["host-config"]).toBe(join(root, "host.toml"));
    // None of the other character's secrets reach her.
    expect(env).toEqual({ DISCORD_BOT_TOKEN: "kuro-token", PATH: "/bin" });
  });

  it("a machine command loads the install's .env even when a profile of its own runs", () => {
    persona("kuro");
    write("profiles/kuro/miyoria.toml", '[core]\nprofile = "kuro"\nprofiles_dir = ".."\n');
    write("miyoria.toml", '[core]\nprofile = "kuro"\n');
    write(".env", "A=install\n");
    const env: Record<string, string | undefined> = {};
    const parsed = parseArgs(["hostd", "-c", install]);
    enterProfile(parsed, env);
    expect(parsed.ctx.config).toBe(install);
    expect(parsed.ctx.profile).toBeUndefined();
    expect(env).toEqual({ A: "install" });
  });

  it("a value set for real (not the install's) wins over the profile's .env", () => {
    persona("kuro");
    write("profiles/kuro/miyoria.toml", '[core]\nprofile = "kuro"\nprofiles_dir = ".."\n');
    write("profiles/kuro/.env", "LOG=kuro\n");
    write("miyoria.toml", '[core]\nprofile = "kuro"\n');
    const env: Record<string, string | undefined> = { LOG: "shell" };
    loadProfileEnv(selectProfile(install, env), env);
    expect(env.LOG).toBe("shell");
  });
});

describe("miyoria profile new / use", () => {
  it("creates a profile that resolves as its own, named as asked", async () => {
    write("miyoria.toml", '[core]\nprofile = "deepseek-chan"   # Miyoria\n');
    await create(install, "kuro", { name: "Kuro" });
    const dir = join(root, "profiles", "kuro");
    for (const f of ["profile.toml", "persona/identity.md", "persona/style.md", ".env"]) {
      expect(existsSync(join(dir, f))).toBe(true);
    }
    expect(existsSync(join(dir, "data"))).toBe(true);
    // The install still runs Miyoria until `use`.
    expect(selectProfile(install, {}).own).toBe(false);
    await use(install, "kuro");
    expect(readFileSync(install, "utf8")).toBe('[core]\nprofile = "kuro"   # Miyoria\n');
    const p = selectProfile(install, {});
    expect(p).toMatchObject({ id: "kuro", own: true, baseDir: dir });
    // Its config loads: her name, her own data folder, extensions from the install.
    const config = await Config.load(p.configPath, () => "");
    expect(config.section("character.name")).toBe("Kuro");
    expect(config.section("core.database_url")).toBe("sqlite:data/miyoria.db");
    expect(config.section("modules.extensions.dirs")).toEqual(["../../extensions"]);
    const profile = await loadProfile(config, p.baseDir);
    expect(profile.displayName).toBe("Kuro");
    expect(profile.ownIdentity()).toBe(
      "你的本名是 Kuro,有人叫 Kuro 都是在叫你。問你叫什麼,你知道自己叫 Kuro。",
    );
  });

  it("never writes into a folder that is there, and refuses names that are not folders", async () => {
    persona("deepseek-chan");
    write("miyoria.toml", "");
    await expect(create(install, "deepseek-chan")).rejects.toThrow(ProfileCommandError);
    expect(existsSync(join(root, "profiles", "deepseek-chan", "miyoria.toml"))).toBe(false);
    await expect(create(install, "../x")).rejects.toThrow(/不能當 profile 名稱/);
    await expect(use(install, "nope")).rejects.toThrow(/不是 profile/);
  });

  it("back to the first character: a persona without its own config runs the install's", async () => {
    persona("deepseek-chan");
    persona("kuro");
    write("profiles/kuro/miyoria.toml", '[core]\nprofile = "kuro"\nprofiles_dir = ".."\n');
    write("miyoria.toml", '[core]\nprofile = "kuro"\n');
    await use(install, "deepseek-chan");
    expect(
      resolveProfile(
        install,
        peekConfig(install, () => undefined),
        () => undefined,
      ),
    ).toMatchObject({ id: "deepseek-chan", own: false, configPath: install, baseDir: root });
  });

  it("the bundled persona still loads beside a scaffolded profile", async () => {
    const config = Config.fromToml(`[core]\nprofiles_dir = ${JSON.stringify(REPO_PROFILES)}\n`);
    expect((await loadProfile(config, root)).character.name).toBe("Miyoria");
  });
});
