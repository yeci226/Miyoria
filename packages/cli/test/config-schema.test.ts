// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the tests use literal ${VAR} references
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Config, configJsonSchema } from "@miyoria/runtime/kernel";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import * as settings from "../src/settings.js";
import { parseKey, parseTomlText, parseValue } from "../src/toml-patch.js";
import * as v from "../src/validate.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const EXAMPLE = readFileSync(join(ROOT, "miyoria.example.toml"), "utf8");

async function context(text = EXAMPLE): Promise<v.SchemaContext> {
  const ctx = await v.schemaContext(parseTomlText(text));
  if (ctx === null) throw new Error("the root schema did not load");
  return ctx;
}

// The root schema loads every module package on first use.
beforeAll(async () => {
  await v.configSchema();
}, 120_000);

describe("the JSON Schema of the whole file", () => {
  it("accepts the example files as Core loads them", async () => {
    const schema = await v.configSchema();
    if (schema === null) throw new Error("the root schema did not load");
    const json = configJsonSchema(schema);
    const back = z.fromJSONSchema(json as Parameters<typeof z.fromJSONSchema>[0]);
    for (const name of ["miyoria.example.toml", "deploy/miyoria.docker.toml"]) {
      const doc = Config.fromToml(readFileSync(join(ROOT, name), "utf8"), () => "x").raw;
      const result = back.safeParse(doc);
      expect(result.success ? null : z.prettifyError(result.error), name).toBeNull();
    }
    // The CLI's own sections are in it.
    const properties = (json as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(properties)).toEqual(
      expect.arrayContaining(["stack", "machine", "modules"]),
    );
  });
});

describe("config set with the root schema", () => {
  it("checks a key the schema describes by the schema, in the CLI's words", async () => {
    const ctx = await context();
    const check = (k: string, value: string) => v.valueForKey(parseKey(k), parseValue(value), ctx);
    // `[stage.obs] port` is 0–65535 in the stage's schema (the CLI used to say 1–65535).
    expect(check("stage.obs.port", "0")).toBeNull();
    expect(check("stage.obs.port", "70000")).toBe("不能大於 65535");
    expect(check("stage.obs.port", '"4455"')).toBe("要是數字");
    expect(check("modules.agent.enabled", "nope")).toBe("要是 true 或 false");
    expect(check("modules.voice.barge_in", '"selective"')).toBeNull();
    expect(check("modules.voice.barge_in", '"nope"')).toBe(
      '要是 "selective"、"stop"、"ignore" 其中之一',
    );
    // The Discord module takes digit strings and safe integers.
    const guilds = 'modules."platform.discord.bot".command_guilds';
    expect(check(guilds, '["123456789012345678"]')).toBeNull();
    expect(check(guilds, "[1]")).toBeNull();
    expect(check(guilds, '["abc"]')).toBe("[0] `abc` is not a Discord id");
    expect(check("stack.workers.asr.port", "0")).toBe("不能小於 1");
    expect(check("stack.nope", "1")).toBe("`nope` 不是這個表格認得的鍵");
    expect(check("llm.budget.daily_usd", '"${BUDGET}"')).toBeNull();
  });

  it("keeps the formats the schema does not say, and the rules of keys it does not describe", async () => {
    const ctx = await context();
    const check = (k: string, value: string) => v.valueForKey(parseKey(k), parseValue(value), ctx);
    expect(check("modules.api.bind", "nope")).not.toBeNull();
    expect(check("modules.api.bind", "127.0.0.1:1")).toBeNull();
    expect(check("core.database_url", "postgres://x")).not.toBeNull();
    expect(check("stage.core_url", "nope")).not.toBeNull();
    expect(check("speech.asr.local.url", "x")).not.toBeNull();
    // Not in any schema: the CLI's own rule.
    expect(check("stage.vts.port", "0")).toBe("port 要是 1–65535 的整數");
    expect(check("somewhere.enabled", "1")).toBe("`enabled` 要是 true 或 false");
  });

  it("only blames the value, not what is wrong elsewhere in the file", async () => {
    const ctx = await context(`${EXAMPLE}\n[modules.queue]\nmax_pending = "many"\n`);
    expect(v.valueForKey(parseKey("modules.queue.max_pending"), parseValue("3"), ctx)).toBeNull();
    expect(v.valueForKey(parseKey("stage.obs.port"), parseValue("4455"), ctx)).toBeNull();
  });
});

describe("prompts with the root schema", () => {
  it("check a field by the schema where it describes the key", async () => {
    const ctx = await context();
    const port = settings.STAGE.find((f) => f.key === "stage.obs.port");
    if (port === undefined) throw new Error("no OBS port field");
    const portCheck = settings.checkOf(port, ctx);
    expect(portCheck?.("0")).toBeNull();
    expect(portCheck?.("x")).toBe("port 要是整數");
    expect(portCheck?.("70000")).toBe("不能大於 65535");
    const guilds = settings.checkOf(settings.DISCORD_GUILDS, ctx);
    expect(guilds?.("123, 456")).toBeNull();
    expect(guilds?.("abc")).not.toBeNull();
    const api = settings.checkOf(settings.API_BIND, ctx);
    expect(api?.("nope")).not.toBeNull();
    // Without the schema, the CLI's own rules.
    expect(settings.checkOf(port, null)?.("0")).toBe("port 要是 1–65535 的整數");
  });

  it("offer the module's own barge-in modes", () => {
    const field = settings.VOICE.find((f) => f.key === "modules.voice.barge_in");
    expect(field?.kind).toEqual({ type: "choice", options: ["selective", "stop", "ignore"] });
    expect(field?.default).toBe("selective");
  });

  it("suggest the ports the asr and tts services run on", () => {
    for (const name of ["asr", "tts"]) {
      const toml = readFileSync(join(ROOT, "workers", name, "service.toml"), "utf8");
      const port = /^port = (\d+)$/m.exec(toml)?.[1];
      const field = settings.VOICE.find((f) => f.key === `speech.${name}.local.url`);
      expect(port).toBeDefined();
      expect(field?.default).toBe(`http://127.0.0.1:${port}`);
    }
  });
});
