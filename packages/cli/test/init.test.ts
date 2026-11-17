// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the tests use literal ${VAR} references
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadProfile } from "@miyoria/core/light";
import { Config } from "@miyoria/runtime/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exampleConfig, PACKAGE_ROOT } from "../src/assets.js";
import { commandPrefix, flow, openForInit, run } from "../src/commands/init.js";
import { CancelledError, DefaultsPrompter } from "../src/prompt.js";
import { DEFAULT_SQLITE_URL, LLM_KINDS } from "../src/settings.js";
import { type Output, setOutput } from "../src/ui.js";
import { Workspace } from "../src/workspace.js";
import { Cancel, Enter, No, Pick, Scripted, Text, tempDir, Yes } from "./scripted.js";

const BUNDLED = join(PACKAGE_ROOT, "..", "..", "profiles");
const NO_ENV = new Map<string, string>();

const ENV = `# my env
LLM_BASE_URL=https://api.deepseek.com
LLM_API_KEY=sk-existing-1234567890
DISCORD_BOT_TOKEN='bot.token.value'
MIYORIA_OWNER_ID=123456789012345678
MIYORIA_API_TOKEN=keepme-api
VOICE_LINK_TOKEN=keepme-voice
STAGE_LINK_TOKEN=keepme-stage
DATABASE_URL=memory://
`;

const PROFILE = `id = "deepseek-chan"

[llm.purposes]
chat       = ["deepseek:deepseek-v4"]   # main
fast       = ["deepseek:deepseek-v4"]
`;

let dir: string;
let restoreOutput: () => void;
const printed: string[] = [];

beforeEach(() => {
  dir = tempDir();
  printed.length = 0;
  const sink: Output = { out: (t) => printed.push(t), err: (t) => printed.push(t) };
  restoreOutput = setOutput(sink);
});

afterEach(() => {
  restoreOutput();
  rmSync(dir, { recursive: true, force: true });
});

/** A configured install: example config, filled .env, one profile. */
function setup(): string {
  const config = join(dir, "miyoria.toml");
  writeFileSync(config, exampleConfig());
  writeFileSync(join(dir, ".env"), ENV);
  mkdirSync(join(dir, "profiles/deepseek-chan"), { recursive: true });
  writeFileSync(join(dir, "profiles/deepseek-chan/profile.toml"), PROFILE);
  return config;
}

const enters = (n: number) => Array.from({ length: n }, () => Enter);
const read = (path: string) => readFileSync(join(dir, path), "utf8");
const token = (env: string) => /^MIYORIA_API_TOKEN=(.*)$/m.exec(env)?.[1] ?? "";

describe("init flow", () => {
  it("rerun_with_enter_keeps_everything", async () => {
    const ws = Workspace.open(setup(), { processEnv: NO_ENV });
    // profile, kind, base URL, API key, model, bot token, owner, db, OAuth?
    const p = new Scripted([...enters(8), No]);
    const generated = await flow(p, ws);
    expect(p.done).toBe(true);
    expect(generated).toEqual([]); // tokens must not be regenerated
    expect(ws.changes()).toEqual([]);
    expect(
      p.asked.some((q) => q.startsWith("LLM API key") && q.includes("已設定(按 Enter 保留)")),
    ).toBe(true);
    expect(p.asked.some((q) => q.includes("Discord bot token") && q.includes("已設定"))).toBe(true);
  });

  it("changes_only_what_was_typed", async () => {
    const config = setup();
    const ws = Workspace.open(config, { processEnv: NO_ENV });
    const p = new Scripted([
      Enter,
      Enter,
      Enter,
      Text("sk-new-key-0987654321"),
      Text("deepseek-v5"),
      Enter,
      Enter,
      Enter,
      No,
    ]);
    await flow(p, ws);
    expect(ws.changes().map((c) => c.key)).toEqual([
      "LLM_API_KEY",
      "llm.purposes.chat",
      "llm.purposes.fast",
    ]);
    ws.save();
    const env = read(".env");
    expect(env.startsWith("# my env\n")).toBe(true);
    expect(env).toContain("LLM_API_KEY=sk-new-key-0987654321\n");
    expect(env).toContain("DISCORD_BOT_TOKEN='bot.token.value'\n");
    expect(env).toContain("MIYORIA_API_TOKEN=keepme-api\n");
    const profile = read("profiles/deepseek-chan/profile.toml");
    expect(profile).toContain('chat       = ["deepseek:deepseek-v5"]   # main');
    expect(profile).toContain('fast       = ["deepseek:deepseek-v5"]');
    // The config file keeps its references.
    expect(read("miyoria.toml")).toBe(exampleConfig());
  });

  it("opencode_and_oauth_are_added", async () => {
    const config = setup();
    const ws = Workspace.open(config, { processEnv: NO_ENV });
    const opencode = LLM_KINDS.indexOf("opencode");
    const p = new Scripted([
      Enter, // profile
      Pick(opencode), // kind
      Enter, // base URL: opencode default
      Text("oc-key-1234567890"),
      Text("kimi-k2"),
      Enter,
      Enter,
      Enter,
      Yes, // OAuth
      Text("223456789012345678"),
      Text("oauth-secret-1234567890"),
      Enter, // redirect default
    ]);
    await flow(p, ws);
    expect(p.done).toBe(true);
    ws.save();
    const toml = read("miyoria.toml");
    expect(toml).toContain(
      '[llm.providers.opencode]\nkind = "opencode"\nbase_url = "https://opencode.ai/inference/go/v1"\napi_key = "${OPENCODE_API_KEY:-}"\n',
    );
    expect(toml).toContain(
      '[modules.api.discord_oauth]\nclient_id = "${DISCORD_CLIENT_ID:-}"\nclient_secret = "${DISCORD_CLIENT_SECRET:-}"\nredirect_uri = "http://127.0.0.1:7878/api/auth/oauth/callback"\n',
    );
    // The old provider and its comment stay.
    expect(toml).toContain(
      '[llm.providers.deepseek]\nkind = "deepseek"                  # deepseek',
    );
    const env = read(".env");
    expect(env).toContain("OPENCODE_API_KEY=oc-key-1234567890\n");
    expect(env).toContain("DISCORD_CLIENT_ID=223456789012345678\n");
    expect(env).toContain("DISCORD_CLIENT_SECRET=oauth-secret-1234567890\n");
    expect(env).toContain("LLM_API_KEY=sk-existing-1234567890\n");
    expect(read("profiles/deepseek-chan/profile.toml")).toContain(
      'chat       = ["opencode:kimi-k2"]',
    );
    expect(p.printed.some((l) => l.includes("Redirects 要加上 http://127.0.0.1:7878"))).toBe(true);

    // Running again with Enter everywhere keeps the new setup.
    const again = Workspace.open(config, { processEnv: NO_ENV });
    const p2 = new Scripted(enters(12));
    await flow(p2, again);
    expect(p2.done).toBe(true);
    expect(again.changes()).toEqual([]);
  });

  it("fresh_directory_starts_from_the_templates_and_bundled_profile", async () => {
    const config = join(dir, "miyoria.toml");
    const ws = openForInit(config, { bundledProfiles: BUNDLED, processEnv: NO_ENV });
    expect(ws.planScaffold()).toEqual(["deepseek-chan"]);
    // profile (bundled, select), kind, base URL, key, model, token, owner, db (SQLite), OAuth?
    const p = new Scripted([Enter, Enter, Enter, Text("sk-fresh-1234567890"), ...enters(4), No]);
    const generated = await flow(p, ws);
    expect(p.done).toBe(true);
    expect(generated).toHaveLength(3);
    expect(ws.missingFiles()).toHaveLength(4); // miyoria.toml, .env, profile, data/
    ws.save();
    const env = read(".env");
    expect(env).toContain("LLM_API_KEY=sk-fresh-1234567890\n");
    expect(env).toContain(`DATABASE_URL=${DEFAULT_SQLITE_URL}\n`);
    const first = token(env);
    expect(first).toHaveLength(52);
    expect(existsSync(join(dir, "profiles/deepseek-chan/persona/identity.md"))).toBe(true);
    expect(existsSync(join(dir, "data"))).toBe(true);

    // A second run keeps the generated token.
    const again = Workspace.open(config, { processEnv: NO_ENV });
    const p2 = new Scripted([...enters(8), No]);
    expect(await flow(p2, again)).toEqual([]);
    expect(again.changes()).toEqual([]);
    again.save();
    expect(token(read(".env"))).toBe(first);
  });
});

describe("the command shown in the next steps", () => {
  it("names the package manager that started the CLI", () => {
    const pnpm = "pnpm/9.15.0 npm/? node/v24.2.0 win32 x64";
    const npm = "npm/11.3.0 node/v24.2.0 win32 x64 workspaces/false";
    expect(commandPrefix({ npm_command: "exec", npm_config_user_agent: pnpm })).toBe(
      "pnpm exec miyoria",
    );
    expect(commandPrefix({ npm_config_user_agent: pnpm })).toBe("pnpm dlx miyoria");
    expect(commandPrefix({ npm_command: "exec", npm_config_user_agent: npm })).toBe("npx miyoria");
    // A script of the repository (`pnpm dev init`) and a global install: the plain name.
    expect(commandPrefix({ npm_command: "run-script", npm_config_user_agent: pnpm })).toBe(
      "miyoria",
    );
    expect(commandPrefix({})).toBe("miyoria");
  });
});

describe("init command", () => {
  it("scaffolds_a_runnable_install_into_an_empty_folder", async () => {
    const config = join(dir, "miyoria.toml");
    const p = new Scripted([
      Enter, // what this machine is for: text only
      Enter, // profile
      Enter, // kind
      Enter, // base URL
      Text("sk-scaffold-1234567890"),
      ...enters(4), // model, bot token, owner, database
      No, // OAuth
      Yes, // write?
    ]);
    await run(config, p, { bundledProfiles: BUNDLED, processEnv: NO_ENV, command: "miyoria" });
    expect(p.done).toBe(true);
    expect(readdirSync(dir).sort()).toEqual([
      ".env",
      ".gitignore",
      "data",
      "host.toml",
      "miyoria.toml",
      "profiles",
    ]);
    expect(read(".gitignore")).toContain(".env\n");
    const summary = p.printed.find((l) => l.startsWith("box: 將變更")) ?? "";
    expect(summary).toContain("建立");
    expect(summary).not.toContain("sk-scaffold"); // secrets are masked
    expect(summary).toContain("••••7890");
    expect(p.printed.at(-1)).toMatch(/下一步[\s\S]*miyoria doctor/);

    // The result loads like the core would load it.
    const env = new Map(
      read(".env")
        .split("\n")
        .flatMap((l) => (/^[A-Z_]+=/.test(l) ? [l.split("=", 2) as [string, string]] : [])),
    );
    const loaded = await Config.load(config, (n) => env.get(n));
    expect(loaded.section("core.database_url")).toBe(DEFAULT_SQLITE_URL);
    expect(loaded.module("api").config).toMatchObject({ token: env.get("MIYORIA_API_TOKEN") });
    const profile = await loadProfile(loaded, dir);
    expect(profile.displayName).toBe("DeepSeek-chan");
  });

  it("writes_nothing_when_cancelled_or_declined", async () => {
    const config = join(dir, "miyoria.toml");
    const cancel = new Scripted([Enter, Enter, Enter, Enter, Cancel]);
    await expect(
      run(config, cancel, { bundledProfiles: BUNDLED, processEnv: NO_ENV }),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(readdirSync(dir)).toEqual([]);
    const decline = new Scripted([...enters(9), No, No]);
    await run(config, decline, { bundledProfiles: BUNDLED, processEnv: NO_ENV });
    expect(readdirSync(dir)).toEqual([]);
    expect(decline.printed).toContain("warn: 沒有寫入任何檔案");
  });

  it("yes_without_a_terminal_accepts_every_default", async () => {
    const config = join(dir, "sub", "miyoria.toml");
    const quiet = {
      intro() {},
      outro() {},
      section() {},
      note() {},
      ok() {},
      warn() {},
      fail() {},
      box() {},
    };
    await run(config, new DefaultsPrompter(quiet), {
      yes: true,
      bundledProfiles: BUNDLED,
      processEnv: NO_ENV,
    });
    expect(existsSync(join(dir, "sub/profiles/deepseek-chan/profile.toml"))).toBe(true);
    expect(token(read("sub/.env"))).toHaveLength(52);
    // Re-running changes nothing.
    const before = read("sub/.env");
    await run(config, new DefaultsPrompter(quiet), {
      yes: true,
      bundledProfiles: BUNDLED,
      processEnv: NO_ENV,
    });
    expect(read("sub/.env")).toBe(before);
  });
});
