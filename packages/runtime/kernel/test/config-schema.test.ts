import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ConfigError } from "../src/config.js";
import {
  checkConfig,
  composeConfigSchema,
  configJsonSchema,
  configPath,
  configProblemsError,
  schemaAt,
} from "../src/config-schema.js";

const Talk = z.object({
  level: z.number().int().min(0).max(3).default(1),
  voice: z.object({ name: z.string().default("a") }).prefault({}),
});
const Llm = z.object({ purposes: z.record(z.string(), z.array(z.string())).default({}) });

const root = composeConfigSchema({
  sections: { llm: Llm, memory: { embedding: z.object({ threads: z.number().default(2) }) } },
  modules: new Map([
    ["talk", Talk],
    ["platform.bot", null],
  ]),
});

describe("composeConfigSchema", () => {
  it("accepts a document that leaves everything out, or holds keys nobody names", () => {
    expect(checkConfig(root, {})).toEqual([]);
    expect(
      checkConfig(root, {
        other: 1,
        llm: { extra: 1 },
        memory: { other: 1 },
        modules: { talk: { enabled: false, extra: 1 }, unknown: { x: 1 }, "platform.bot": {} },
      }),
    ).toEqual([]);
  });

  it("names each problem by its path, every one", () => {
    const problems = checkConfig(root, {
      llm: { purposes: { chat: "a:b" } },
      memory: { embedding: { threads: "2" } },
      modules: { talk: { enabled: "yes", level: 9 }, "platform.bot": { enabled: 1 } },
    });
    expect(problems.map((p) => p.path).sort()).toEqual([
      "llm.purposes.chat",
      "memory.embedding.threads",
      'modules."platform.bot".enabled',
      "modules.talk.enabled",
      "modules.talk.level",
    ]);
  });

  it("classifies problems with the policy and can leave env references alone", () => {
    const doc = { modules: { talk: { level: `\${LEVEL}`, voice: { name: 3 } } } };
    const policy = (keys: readonly (string | number)[]) =>
      keys.at(-1) === "name" ? ("warning" as const) : ("error" as const);
    expect(checkConfig(root, doc, { policy }).map((p) => [p.path, p.severity])).toEqual([
      ["modules.talk.level", "error"],
      ["modules.talk.voice.name", "warning"],
    ]);
    expect(checkConfig(root, doc, { policy, skipEnvRefs: true }).map((p) => p.path)).toEqual([
      "modules.talk.voice.name",
    ]);
  });
});

describe("configProblemsError", () => {
  it("reads like parseSection's for one problem and lists several", () => {
    const one = configProblemsError(checkConfig(root, { modules: { talk: { level: 9 } } }));
    expect(one).toBeInstanceOf(ConfigError);
    expect(one.code).toBe("invalid");
    expect(one.path).toBe("modules.talk.level");
    expect(one.message).toBe(
      "invalid config at `modules.talk.level`: Too big: expected number to be <=3",
    );
    const two = configProblemsError(
      checkConfig(root, { modules: { talk: { level: 9, voice: { name: 1 } } } }),
    );
    expect(two.message.split("\n")).toEqual([
      "invalid config (2 problems):",
      "  at `modules.talk.level`: Too big: expected number to be <=3",
      "  at `modules.talk.voice.name`: Invalid input: expected string, received number",
    ]);
  });
});

describe("configPath", () => {
  it("quotes keys that are not bare and indexes arrays", () => {
    expect(configPath(["modules", "platform.discord.bot", "command_guilds", 0])).toBe(
      'modules."platform.discord.bot".command_guilds[0]',
    );
  });
});

describe("schemaAt", () => {
  it("finds the schema of a key through wrappers, records and module sections", () => {
    expect(schemaAt(root, ["modules", "talk", "level"])).toBeInstanceOf(z.ZodDefault);
    expect(schemaAt(root, ["modules", "talk", "enabled"])).not.toBeNull();
    expect(schemaAt(root, ["modules", "talk", "voice", "name"])).not.toBeNull();
    expect(schemaAt(root, ["llm", "purposes", "chat", 0])).toBeInstanceOf(z.ZodString);
    expect(schemaAt(root, ["memory", "embedding", "threads"])).not.toBeNull();
  });

  it("is null where no schema says anything", () => {
    expect(schemaAt(root, ["other"])).toBeNull();
    expect(schemaAt(root, ["modules", "unknown", "x"])).toBeNull();
    expect(schemaAt(root, ["modules", "talk", "extra"])).toBeNull();
  });
});

describe("configJsonSchema", () => {
  it("describes the input: nothing with a default is required, other keys are allowed", () => {
    const schema = configJsonSchema(root) as {
      properties: { modules: { properties: Record<string, { properties: object }> } };
      required?: string[];
    };
    expect(schema.required ?? []).toEqual([]);
    expect(Object.keys(schema.properties.modules.properties)).toEqual(["talk", "platform.bot"]);
    expect(Object.keys(schema.properties.modules.properties.talk?.properties ?? {})).toEqual([
      "level",
      "voice",
      "enabled",
    ]);
    const back = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
    expect(back.safeParse({ modules: { talk: { level: 2, extra: 1 } } }).success).toBe(true);
    expect(back.safeParse({ modules: { talk: { level: 9 } } }).success).toBe(false);
  });
});
