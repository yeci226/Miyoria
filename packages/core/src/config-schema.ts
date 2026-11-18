// The one schema of `miyoria.toml` (docs/TS-CONVENTIONS.md §6). Core composes it because Core is
// what knows every module: each module's `configSchema` under `modules.<id>`, and the schema of
// each top-level section, which lives with the code that reads it. The CLI adds the two sections
// only it reads (`[stack]`, `[machine]`) through `sections`.
//
// The schema says what is right; `startPolicy` says what Core does today with what is not, so
// checking a file at start never refuses one that loads now:
//
// | where                            | today                                   | the check  |
// |----------------------------------|-----------------------------------------|------------|
// | `[llm]`, `[speech]`, `[mcp]`,    | the reader throws `ConfigError` while   | error      |
// | `[memory.embedding]`             | Core is built: Core does not start      |            |
// | `[modules.<id>]`, module on      | the module fails its start (and is      | warning    |
// |                                  | retried); the rest runs                 |            |
// | `[modules.<id>]`, module off, or | never read (an empty token disables the | ignored    |
// | its token is empty               | module, with a warning of its own)      |            |
// | `[modules.<id>]` not a table     | the module runs with its defaults       | ignored    |
// | `modules.<id>.enabled`, not bool | counts as unset                         | ignored    |
// | `[extensions."<id>"]` env,       | extension discovery fails (a warning)   | warning    |
// | env_pass, permissions            |                                         |            |
// | `[core]`                         | a key that is not a string is unset     | ignored    |
// | `[stage]`, `[stack]`, `[machine]`| not read by Core                        | ignored    |
// | a section or key nobody names    | not read                                | let through|

import { ApiConfigSchema, ApiModule, EvalConfigSchema, EvalModule } from "@miyoria/api";
import { AuthConfigSchema, AuthModule } from "@miyoria/auth";
import { ActivityConfigSchema, ActivityModule } from "@miyoria/brain/activity";
import { AgentConfigSchema, AgentModule } from "@miyoria/brain/agent";
import { ArbiterConfigSchema, ArbiterModule } from "@miyoria/brain/arbiter";
import { DirectiveConfigSchema, DirectiveModule } from "@miyoria/brain/directive";
import { ClusterConfigSchema, ClusterModule } from "@miyoria/cluster";
import { CommandsConfigSchema, CommandsModule } from "@miyoria/commands";
import { DiscordBotModule, DiscordConfigSchema } from "@miyoria/discord";
import { EconomyConfigSchema, EconomyModule } from "@miyoria/economy";
import { ActionsConfigSchema, ActionsModule } from "@miyoria/gate/actions";
import { ModerationConfigSchema, ModerationModule } from "@miyoria/gate/moderation";
import { MindConfigSchema, MindModule } from "@miyoria/heart/mind";
import { HeartConfigSchema, HeartModule } from "@miyoria/heart/person";
import { SelfConfigSchema, SelfModule } from "@miyoria/heart/self";
import { LiveConfigSchema, LiveModule } from "@miyoria/live";
import { LlmConfigSchema, LlmModule } from "@miyoria/llm/llm";
import { FactsConfigSchema, FactsModule } from "@miyoria/memory/facts";
import {
  ConversationConfigSchema,
  ConversationModule,
  KnowledgeConfigSchema,
  KnowledgeModule,
  ReflectConfigSchema,
  ReflectModule,
} from "@miyoria/memory/learning";
import { EmbeddingConfigSchema, MemoryConfigSchema, MemoryModule } from "@miyoria/memory/memory";
import { WorldConfigSchema, WorldModule } from "@miyoria/memory/world";
import { CardsConfigSchema, CardsModule } from "@miyoria/play/cards";
import {
  GameChatConfigSchema,
  GameChatModule,
  GameConfigSchema,
  GameModule,
} from "@miyoria/play/game";
import { KaraokeConfigSchema, KaraokeModule } from "@miyoria/play/karaoke";
import { MarketConfigSchema, MarketModule } from "@miyoria/play/market";
import { PartyConfigSchema, PartyModule } from "@miyoria/play/party";
import { QueueConfigSchema, QueueModule } from "@miyoria/play/queue";
import {
  ExtensionsModule,
  ExtensionsSectionSchema,
  HostConfigSchema,
} from "@miyoria/plugin-host/ext-host";
import { McpConfigSchema, McpModule } from "@miyoria/plugin-host/mcp";
import {
  Config,
  type ConfigPolicy,
  type ConfigProblem,
  type ConfigSchema,
  type ConfigSection,
  CoreSectionSchema,
  checkConfig,
  composeConfigSchema,
  configProblemsError,
  describeProblem,
  errorMessage,
  getLogger,
} from "@miyoria/runtime/kernel";
import { ReplayConfigSchema, ReplayRecorderModule } from "@miyoria/runtime/replay-log";
import { SchedulerConfigSchema, SchedulerModule } from "@miyoria/runtime/scheduler";
import { SingConfigSchema, SingModule } from "@miyoria/sing";
import { StageConfigSchema, StageLinkConfigSchema, StageLinkModule } from "@miyoria/stage";
import { isJsonObject, type JsonObject } from "@miyoria/types";
import { SpeechConfigSchema, SpeechModule } from "@miyoria/voice/speech";
import {
  VoiceConfigSchema,
  VoiceLinkConfigSchema,
  VoiceLinkModule,
  VoiceModule,
} from "@miyoria/voice/voice";
import { ImageGenConfigSchema, ImageGenModule } from "@miyoria/workspace/imagegen";
import { SandboxConfigSchema, SandboxModule } from "@miyoria/workspace/sandbox";
import { SkillsConfigSchema, SkillsModule } from "@miyoria/workspace/skills";
import { WebConfigSchema, WebModule } from "@miyoria/workspace/web";
import { CliPlatform } from "./cli-platform.js";
import { moduleEnabled, NEEDS_TOKEN } from "./module-ids.js";
import { warnRemovedKeys } from "./removed-config.js";

const log = getLogger("core.config");

/**
 * Each module's `configSchema` (the very object its manifest holds: a test builds the real
 * catalog and compares), by id; `null` for a module without one, whose section only has
 * `enabled`. Extensions (`ext.<id>`) are not here: their config is `[extensions."<id>"]`.
 */
export const MODULE_CONFIG_SCHEMAS: ReadonlyMap<string, ConfigSchema | null> = new Map<
  string,
  ConfigSchema | null
>([
  [FactsModule.ID, FactsConfigSchema],
  [ModerationModule.ID, ModerationConfigSchema],
  [LlmModule.ID, null],
  [ClusterModule.ID, ClusterConfigSchema],
  [SpeechModule.ID, null],
  [VoiceLinkModule.ID, VoiceLinkConfigSchema],
  [VoiceModule.ID, VoiceConfigSchema],
  [SchedulerModule.ID, SchedulerConfigSchema],
  [AgentModule.ID, AgentConfigSchema],
  [CommandsModule.ID, CommandsConfigSchema],
  [AuthModule.ID, AuthConfigSchema],
  [ActionsModule.ID, ActionsConfigSchema],
  [DirectiveModule.ID, DirectiveConfigSchema],
  [ActivityModule.ID, ActivityConfigSchema],
  [WorldModule.ID, WorldConfigSchema],
  [SelfModule.ID, SelfConfigSchema],
  [HeartModule.ID, HeartConfigSchema],
  [MemoryModule.ID, MemoryConfigSchema],
  [ArbiterModule.ID, ArbiterConfigSchema],
  [MindModule.ID, MindConfigSchema],
  [KnowledgeModule.ID, KnowledgeConfigSchema],
  [ConversationModule.ID, ConversationConfigSchema],
  [ReflectModule.ID, ReflectConfigSchema],
  [QueueModule.ID, QueueConfigSchema],
  [GameModule.ID, GameConfigSchema],
  [GameChatModule.ID, GameChatConfigSchema],
  [SingModule.ID, SingConfigSchema],
  [McpModule.ID, null],
  [StageLinkModule.ID, StageLinkConfigSchema],
  [EconomyModule.ID, EconomyConfigSchema],
  [CardsModule.ID, CardsConfigSchema],
  [MarketModule.ID, MarketConfigSchema],
  [KaraokeModule.ID, KaraokeConfigSchema],
  [WebModule.ID, WebConfigSchema],
  [SandboxModule.ID, SandboxConfigSchema],
  [ImageGenModule.ID, ImageGenConfigSchema],
  [SkillsModule.ID, SkillsConfigSchema],
  [LiveModule.ID, LiveConfigSchema],
  [PartyModule.ID, PartyConfigSchema],
  [EvalModule.ID, EvalConfigSchema],
  [ExtensionsModule.ID, HostConfigSchema],
  [DiscordBotModule.ID, DiscordConfigSchema],
  [ReplayRecorderModule.ID, ReplayConfigSchema],
  [ApiModule.ID, ApiConfigSchema],
  [CliPlatform.ID, null],
]);

/**
 * The top-level sections Core and the module packages read, by name, each schema from the
 * package whose code reads it: `[core]` (`settings.ts` here), `[llm]` (`@miyoria/llm`),
 * `[speech]` (`@miyoria/voice/speech`), `[memory.embedding]` (`@miyoria/memory/memory`, read by
 * `modules.ts` here), `[mcp]` (`@miyoria/plugin-host/mcp`), `[extensions]`
 * (`@miyoria/plugin-host/ext-host`), `[stage]` (`@miyoria/stage`, read by the stage node).
 */
export const CONFIG_SECTIONS: Readonly<Record<string, ConfigSection>> = {
  core: CoreSectionSchema,
  llm: LlmConfigSchema,
  speech: SpeechConfigSchema,
  memory: { embedding: EmbeddingConfigSchema },
  mcp: McpConfigSchema,
  extensions: ExtensionsSectionSchema,
  stage: StageConfigSchema,
};

/**
 * The schema of the whole file. `sections` adds the sections other programs read from the same
 * file (the CLI's `[stack]` and `[machine]`); they may not replace one of Core's.
 */
export function rootConfigSchema(
  sections: Readonly<Record<string, ConfigSection>> = {},
): ConfigSchema {
  for (const name of Object.keys(sections)) {
    if (name === "modules" || Object.hasOwn(CONFIG_SECTIONS, name)) {
      throw new Error(`config section \`${name}\` already has a schema`);
    }
  }
  return composeConfigSchema({
    sections: { ...CONFIG_SECTIONS, ...sections },
    modules: MODULE_CONFIG_SCHEMAS,
  });
}

let root: ConfigSchema | undefined;

/** Core's own root schema (without other programs' sections), built once. */
function coreRoot(): ConfigSchema {
  root ??= rootConfigSchema();
  return root;
}

/** Sections whose reader throws while Core is built, so a problem there stops the start. */
const FATAL_SECTIONS = new Set(["llm", "speech", "mcp"]);

/**
 * Whether the file lets module `id` start: enabled, and with a token when it needs one (Core
 * disables one whose token is empty, with a warning of its own).
 */
function moduleRuns(config: Config, id: string): boolean {
  if (!moduleEnabled(config, id)) return false;
  if (!NEEDS_TOKEN.includes(id)) return true;
  const section = config.module(id).config;
  const token = isJsonObject(section) ? section.token : undefined;
  return typeof token === "string" && token !== "";
}

/** What Core does at start with a problem at `keys` of `config` (see the table at the top). */
export function startPolicy(config: Config): ConfigPolicy {
  return (keys) => {
    const [top, second, third] = keys;
    if (typeof top !== "string") return "ignore";
    if (FATAL_SECTIONS.has(top)) return "error";
    if (top === "memory") return second === "embedding" ? "error" : "ignore";
    if (top === "extensions") {
      // Not a table, or `enabled`: the reader takes it as unset.
      return keys.length <= 2 || third === "enabled" ? "ignore" : "warning";
    }
    if (top === "modules") {
      if (typeof second !== "string" || keys.length <= 2) return "ignore";
      if (keys.length === 3 && third === "enabled") return "ignore";
      return moduleRuns(config, second) ? "warning" : "ignore";
    }
    return "ignore";
  };
}

/** The problems of a check, split by what they do. */
export interface ConfigCheck {
  errors: ConfigProblem[];
  warnings: ConfigProblem[];
  ignored: ConfigProblem[];
}

function split(problems: readonly ConfigProblem[]): ConfigCheck {
  return {
    errors: problems.filter((p) => p.severity === "error"),
    warnings: problems.filter((p) => p.severity === "warning"),
    ignored: problems.filter((p) => p.severity === "ignore"),
  };
}

/** Checks the loaded file (env references expanded) against the root schema with `startPolicy`. */
export function checkStartConfig(config: Config): ConfigCheck {
  return split(checkConfig(coreRoot(), config.raw, { policy: startPolicy(config) }));
}

/**
 * Runs a check; a schema that throws instead of reporting an issue (a transform that throws) is
 * logged and lets the document through, as the readers alone would have until that module ran.
 */
function tryCheck(check: () => ConfigCheck): ConfigCheck | null {
  try {
    return check();
  } catch (error) {
    log.warn({ err: errorMessage(error) }, "cannot check the config against its schema");
    return null;
  }
}

/**
 * Core's check when it loads the file, before anything is opened or started: logs each warning
 * (a module that will not start, an extension setting) and throws one `ConfigError` naming every
 * error with its path and what was expected.
 */
export function assertStartConfig(config: Config): void {
  const found = tryCheck(() => checkStartConfig(config));
  if (found === null) return;
  const { errors, warnings, ignored } = found;
  for (const p of ignored) {
    log.debug({ path: p.path }, `config value not used as written: ${p.expected}`);
  }
  for (const p of warnings) {
    const id = p.keys[0] === "modules" ? p.keys[1] : undefined;
    log.warn(
      { path: p.path, ...(id === undefined ? {} : { module: id }) },
      `invalid config ${describeProblem(p)}`,
    );
  }
  if (errors.length > 0) throw configProblemsError(errors);
  warnRemovedKeys(config, (message) => log.warn(message));
}

/**
 * The `validate` hook of the store's config revisions (docs/design/v5-data.md §6): a revision is
 * refused, with the same `ConfigError` as at start, when Core would not start with it. A revision
 * holds `${NAME}` references unexpanded, so strings holding one are not checked.
 */
export function validateRevision(doc: JsonObject): JsonObject {
  const config = Config.fromValue(doc);
  const found = tryCheck(() =>
    split(checkConfig(coreRoot(), doc, { policy: startPolicy(config), skipEnvRefs: true })),
  );
  const errors = found?.errors ?? [];
  if (errors.length > 0) throw configProblemsError(errors);
  return doc;
}
