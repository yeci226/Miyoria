// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the tests use literal ${VAR} references
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EnvFile } from "../src/env-file.js";
import {
  display,
  envRefs,
  expand,
  isSecret,
  mask,
  maskUrl,
  type Source,
  singleRef,
} from "../src/refs.js";
import { parseKey, parseValue } from "../src/toml-patch.js";
import * as v from "../src/validate.js";
import { renderChange, Workspace } from "../src/workspace.js";
import { SAMPLE } from "./fixtures.js";
import { tempDir } from "./scripted.js";

describe(".env editor", () => {
  it("env_file_edits_preserve_lines", () => {
    const text = "# comment\nA=1\n\nexport B=\"two words\" \nC='x$y' # c\nD=plain # note\n";
    const env = EnvFile.parse(text);
    expect(env.get("A")).toBe("1");
    expect(env.get("B")).toBe("two words");
    expect(env.get("C")).toBe("x$y");
    expect(env.get("D")).toBe("plain");
    expect(env.get("E")).toBeUndefined();
    env.set("A", "2");
    env.set("B", "has $dollar");
    env.set("E", "a\"b'c");
    expect(env.render()).toBe(
      "# comment\nA=2\n\nexport B='has $dollar'\nC='x$y' # c\nD=plain # note\nE=\"a\\\"b'c\"\n",
    );
    expect(EnvFile.parse(env.render()).get("E")).toBe("a\"b'c");
    expect(env.unset("C")).toBe(true);
    expect(env.unset("C")).toBe(false);
    expect(env.render()).not.toContain("C=");
    expect(EnvFile.parse("A=1\r\nB=2\r\n").render()).toBe("A=1\r\nB=2\r\n");
  });

  it("first_definition_wins_and_empty_files_stay_empty", () => {
    const env = EnvFile.parse("X=1\nX=2\n");
    expect(env.get("X")).toBe("1");
    expect(env.entries()).toEqual([["X", "1"]]);
    const empty = EnvFile.parse("");
    expect(empty.render()).toBe("");
    empty.set("NEW", "v");
    expect(empty.render()).toBe("NEW=v\n");
  });
});

describe("references and masking", () => {
  it("references_and_expansion", () => {
    expect(singleRef("${A:-x}")).toEqual({ name: "A", default: "x" });
    expect(singleRef("discord:${A}")).toBeNull();
    expect(envRefs("discord:${OWNER:-0}")[0]?.name).toBe("OWNER");
    const lookup = (n: string): [string, Source] | undefined =>
      n === "SET" ? ["v", "dotenv"] : n === "EMPTY" ? ["", "dotenv"] : undefined;
    const [value, used] = expand("a-${SET}-${EMPTY:-d}-${NONE:-}", lookup);
    expect(value).toBe("a-v-d-");
    expect(used).toEqual([
      ["SET", "dotenv"],
      ["EMPTY", "default"],
      ["NONE", "default"],
    ]);
    expect(expand("${NONE}", lookup)[1][0]?.[1]).toBe("unset");
  });

  it("masks_secrets", () => {
    expect(isSecret("DISCORD_BOT_TOKEN")).toBe(true);
    expect(isSecret("api_key")).toBe(true);
    expect(isSecret("client_secret")).toBe(true);
    expect(isSecret("bind")).toBe(false);
    expect(mask("")).toBe("(空)");
    expect(mask("short")).toBe("••••");
    expect(mask("sk-1234567890abcd")).toBe("••••abcd");
    expect(maskUrl("postgres://miyoria:hunter2@127.0.0.1:5432/miyoria")).toBe(
      "postgres://miyoria:****@127.0.0.1:5432/miyoria",
    );
    expect(maskUrl("sqlite:data/miyoria.db")).toBe("sqlite:data/miyoria.db");
    expect(display("LLM_API_KEY", "sk-1234567890abcd", false)).toBe("••••abcd");
    expect(display("LLM_API_KEY", "sk-1234567890abcd", true)).toBe("sk-1234567890abcd");
  });
});

describe("validation", () => {
  it("urls", () => {
    expect(v.httpUrl("http://127.0.0.1:8001")).toBeNull();
    expect(v.httpUrl("https://opencode.ai/inference/go/v1")).toBeNull();
    expect(v.httpUrl("${ASR_URL:-http://x}")).toBeNull();
    expect(v.httpUrl("127.0.0.1:8001")).not.toBeNull();
    expect(v.httpUrl("ftp://x")).not.toBeNull();
    expect(v.httpUrl("")).not.toBeNull();
    expect(v.wsUrl("ws://127.0.0.1:7882/stage-link")).toBeNull();
    expect(v.wsUrl("tcp://x")).not.toBeNull();
    expect(v.databaseUrl("memory://")).toBeNull();
    expect(v.databaseUrl("sqlite:data/miyoria.db")).toBeNull();
    expect(v.databaseUrl("sqlite:")).not.toBeNull();
    expect(v.databaseUrl("postgres://u:p@127.0.0.1:5432/db")).toMatch(/不支援 PostgreSQL/);
    expect(v.databaseUrl("mysql://x")).not.toBeNull();
  });

  it("numbers_and_ids", () => {
    expect(v.port("4455")).toBeNull();
    expect(v.port("0")).not.toBeNull();
    expect(v.port("70000")).not.toBeNull();
    expect(v.port("abc")).not.toBeNull();
    expect(v.bind("127.0.0.1:7878")).toBeNull();
    expect(v.bind("[::1]:7878")).toBeNull();
    expect(v.bind("7878")).not.toBeNull();
    expect(v.bind(":7878")).not.toBeNull();
    expect(v.discordId("123456789012345678")).toBeNull();
    expect(v.discordId("12345")).not.toBeNull();
    expect(v.discordId("12345678901234567a")).not.toBeNull();
    expect(v.optionalDiscordId("")).toBeNull();
    expect(v.discordIds("123456789012345678, 223456789012345678")).toBeNull();
    expect(v.discordIds("123456789012345678,x")).not.toBeNull();
    expect(v.modelId("deepseek-chat")).toBeNull();
    expect(v.modelId("qwen2.5:7b")).toBeNull();
    expect(v.modelId("")).not.toBeNull();
    expect(v.modelId("a b")).not.toBeNull();
    expect(v.envName("LLM_API_KEY")).toBeNull();
    expect(v.envName("1X")).not.toBeNull();
  });

  it("values_by_key", () => {
    const check = (k: string, value: string) => v.valueForKey(parseKey(k), parseValue(value));
    expect(check("stage.obs.port", "4455")).toBeNull();
    expect(check("stage.obs.port", '"4455"')).not.toBeNull();
    expect(check("modules.agent.enabled", "false")).toBeNull();
    expect(check("modules.agent.enabled", "nope")).not.toBeNull();
    expect(check("modules.api.bind", "127.0.0.1:1")).toBeNull();
    expect(check("modules.api.bind", "nope")).not.toBeNull();
    expect(check("speech.asr.local.url", "http://x:1")).toBeNull();
    expect(check("speech.asr.local.url", "x")).not.toBeNull();
    expect(check("speech.asr.local.url", "${ASR_URL}")).toBeNull();
    expect(check("modules.api.discord_oauth.redirect_uri", "https://a/b")).toBeNull();
    expect(check("core.database_url", "memory://")).toBeNull();
    expect(check("stage.core_url", "ws://a:1/b")).toBeNull();
    expect(
      check('modules."platform.discord.bot".command_guilds', '["123456789012345678"]'),
    ).toBeNull();
    expect(check('modules."platform.discord.bot".command_guilds', "[1]")).not.toBeNull();
    expect(check("core.log", "debug")).toBeNull();
  });
});

describe("workspace", () => {
  it("changes_are_masked", () => {
    const dir = tempDir();
    try {
      const path = join(dir, "miyoria.toml");
      writeFileSync(path, SAMPLE);
      writeFileSync(join(dir, ".env"), "LLM_API_KEY=sk-old-0000000000\n");
      const ws = Workspace.open(path, { processEnv: new Map() });
      ws.setEnv("LLM_API_KEY", "sk-new-1111111111");
      ws.set("modules.api.token", "literal-secret-value");
      ws.set("core.profile", "other");
      const all = ws.changes().map(renderChange).join("\n");
      expect(all).not.toMatch(/sk-new|sk-old|literal-secret/);
      expect(all).toContain("~ LLM_API_KEY: ••••0000 → ••••1111");
      expect(all).toContain('~ core.profile: "deepseek-chan" → "other"');
      ws.save();
      expect(ws.changes()).toEqual([]);
      expect(Workspace.open(path).doc.toString()).toMatch(
        /^# top comment\n\[core\]\nprofile = "other" {10}# profiles\/<id>\//,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("process_env_wins_over_dotenv", () => {
    const dir = tempDir();
    try {
      const path = join(dir, "miyoria.toml");
      writeFileSync(path, SAMPLE);
      writeFileSync(join(dir, ".env"), "DATABASE_URL=postgres://a@b/c\n");
      expect(Workspace.open(path, { processEnv: new Map() }).effective("core.database_url")).toBe(
        "postgres://a@b/c",
      );
      const ws = Workspace.open(path, { processEnv: new Map([["DATABASE_URL", "memory://"]]) });
      expect(ws.effective("core.database_url")).toBe("memory://");
      ws.setEnv("DATABASE_URL", "postgres://x@y/z");
      expect(ws.warnings).toHaveLength(1);
      expect(ws.references("DATABASE_URL")).toEqual(["core.database_url"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("missing_config_points_to_init", () => {
    const dir = tempDir();
    try {
      expect(() => Workspace.open(join(dir, "miyoria.toml"))).toThrow(/miyoria init/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
