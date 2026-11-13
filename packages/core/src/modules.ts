// The one place that imports the module packages. Names mirror the legacy Rust constructors
// (camelCased); if a package exported something else, fix it here and nowhere else.
//
// Boot order (legacy `boot.rs`, after `facts`, which every other module outlives, and `moderation`,
// which is there before anything can say a word): llm, speech, voice.link, voice, scheduler, agent, commands,
// auth, actions, directive, activity, social, mood, world, self, memory, arbiter, mind, knowledge, conversation,
// reflect, queue, game, game.chat, sing, share (opt-in), watch (opt-in), mcp,
// stage.link, economy, web, sandbox (opt-in), imagegen (opt-in), party, recorder, Discord bot, Admin API, terminal chat, then the
// extension host and one `ext.<id>` per extension.

import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ActionsModule } from "@miyoria/actions";
import { ActivityModule } from "@miyoria/activity";
import { AgentModule, PersonaHandleKey } from "@miyoria/agent";
import { ApiModule, avatarEmotions } from "@miyoria/api";
import { ArbiterModule } from "@miyoria/arbiter";
import { AuthConfigSchema, AuthModule } from "@miyoria/auth";
import { CommandsModule } from "@miyoria/commands";
import { DirectiveModule } from "@miyoria/directive";
import { DiscordBotModule } from "@miyoria/discord";
import { EconomyModule } from "@miyoria/economy";
import * as extHost from "@miyoria/ext-host";
import { FactsModule } from "@miyoria/facts";
import { GameChatModule, GameHandleKey, GameModule } from "@miyoria/game";
import { ImageGenModule } from "@miyoria/imagegen";
import type { Config, Module } from "@miyoria/kernel";
import {
  ConversationModule,
  KnowledgeModule,
  ReflectModule,
  repairEphemeralHandles,
} from "@miyoria/learning";
import { LiveModule } from "@miyoria/live";
import {
  type LlmConfig,
  LlmConfigSchema,
  LlmModule,
  type ModelRef,
  OpenAiFactory,
  parseModelRef,
} from "@miyoria/llm";
import { McpModule } from "@miyoria/mcp";
import { EmbeddingConfigSchema, MemoryModule } from "@miyoria/memory";
import { MindModule } from "@miyoria/mind";
import { ModerationModule } from "@miyoria/moderation";
import { PartyModule } from "@miyoria/party";
import type { Profile } from "@miyoria/profile";
import { QueueModule } from "@miyoria/queue";
import { SandboxModule } from "@miyoria/sandbox";
import { SchedulerModule } from "@miyoria/scheduler";
import { SelfModule } from "@miyoria/self";
import { ShareModule } from "@miyoria/share";
import { SingModule } from "@miyoria/sing";
import { SkillsModule } from "@miyoria/skills";
import { MoodModule, SocialModule } from "@miyoria/social";
import { SpeechConfigSchema, SpeechModule } from "@miyoria/speech";
import {
  AvatarProfile,
  applyObsSetup,
  type ObsSetupStep,
  ObsWebSocketAdmin,
  overlayUrl,
  parseStageConfig,
  planObsSetup,
  runStage,
  SOURCES,
  StageLinkModule,
} from "@miyoria/stage";
import {
  openStore as openStoreBackend,
  type Store,
  type StoredHandleDirectory,
} from "@miyoria/store";
import { isJsonObject, type ProfileId } from "@miyoria/types";
import { VoiceLinkModule, VoiceModule } from "@miyoria/voice";
import { WatchModule } from "@miyoria/watch";
import { WebModule } from "@miyoria/web";
import { WorldModule } from "@miyoria/world";
import {
  buildCoreWith,
  type Core,
  type CoreOptions,
  type ExtensionDiscovery,
  type ModuleCatalog,
  type ModuleDeps,
} from "./boot.js";
import type { ExtensionsCli } from "./ext-cli.js";
import { loadProfile, sqlitePath } from "./settings.js";

/**
 * Opens the store for `url`: `sqlite:<path>` (default, the parent directory is created),
 * `memory://`, or `postgres://...`.
 */
export async function openStore(url: string): Promise<Store> {
  const path = sqlitePath(url);
  if (path !== null && path !== ":memory:") await mkdir(dirname(path), { recursive: true });
  return openStoreBackend(url);
}

/** The `llm` module with the profile's `[llm.purposes]` applied over the global ones. */
export function llmModule(config: Config, profile: Profile): LlmModule {
  const llm: LlmConfig = config.get("llm", LlmConfigSchema);
  const overrides = new Map<string, ModelRef[]>();
  for (const [purpose, chain] of Object.entries(profile.manifest.llm.purposes)) {
    try {
      overrides.set(purpose, chain.map(parseModelRef));
    } catch (error) {
      throw new Error(
        `profile \`${profile.id}\` purpose \`${purpose}\`: ${(error as Error).message}`,
        {
          cause: error,
        },
      );
    }
  }
  return new LlmModule(llm, [new OpenAiFactory()], { purposeOverrides: overrides });
}

/**
 * `[modules.auth] owners`. Owners belong in `[modules.commands] owners`; the auth section is
 * still read so both the RBAC and the fallback permissions see the same owners.
 */
export function authOwners(config: Config): string[] {
  const parsed = AuthConfigSchema.safeParse(config.module(AuthModule.ID).config ?? {});
  return parsed.success ? parsed.data.owners : [];
}

async function coreModules({
  config,
  profile,
  profileId,
  store,
  baseDir,
}: ModuleDeps): Promise<Module[]> {
  return [
    // First, so it stops last: it logs what the others say on their way down.
    new FactsModule(store, profileId, { names: profile.names() }),
    new ModerationModule(),
    llmModule(config, profile),
    SpeechModule.withDefaultFactories(config.get("speech", SpeechConfigSchema)),
    new VoiceLinkModule(),
    new VoiceModule(profileId, profile.voice, profile.names()),
    new SchedulerModule(),
    new AgentModule(profile),
    new CommandsModule({ owners: authOwners(config) }),
    new AuthModule(),
    new ActionsModule(profile.displayName),
    new DirectiveModule(),
    new ActivityModule(),
    SocialModule.fromProfile(profile),
    new MoodModule(profileId, profile.manifest.mood),
    new WorldModule({
      interests: profile.manifest.interests,
      game: (services) => services.get(GameHandleKey)?.status()?.game_name ?? null,
    }),
    new SelfModule(profileId, {
      temperament: profile.manifest.temperament,
      baseline: profile.manifest.mood,
    }),
    new MemoryModule(profileId, config.get("memory.embedding", EmbeddingConfigSchema)),
    // Replaces `initiative` (an old `[modules.initiative]` section is read with a warning).
    new ArbiterModule(profileId, { legacyInitiative: config.module("initiative").config }),
    new MindModule(profileId, {
      name: profile.displayName,
      persona: (services) =>
        services.get(PersonaHandleKey)?.corePrompt() ?? profile.personaPrompt(),
    }),
    new KnowledgeModule(profileId),
    new ConversationModule(profileId),
    new ReflectModule(profileId, {
      name: profile.displayName,
      names: profile.names(),
      persona: (services) =>
        services.get(PersonaHandleKey)?.corePrompt() ?? profile.personaPrompt(),
    }),
    new QueueModule(),
    GameModule.fromProfile(profile),
    new GameChatModule(),
    new SingModule(null, { baseDir }),
    new ShareModule({
      baseDir,
      persona: (services) =>
        services.get(PersonaHandleKey)?.personaPrompt() ?? profile.personaPrompt(),
      owners: () => authOwners(config),
    }),
    new WatchModule({
      persona: (services) =>
        services.get(PersonaHandleKey)?.personaPrompt() ?? profile.personaPrompt(),
    }),
    McpModule.fromAppConfig(config),
    new StageLinkModule(),
    new EconomyModule(profileId),
    new WebModule(),
    new SandboxModule(profileId, { baseDir }),
    new ImageGenModule({ baseDir }),
    new SkillsModule(),
    new LiveModule({ names: profile.names() }),
    new PartyModule(),
  ];
}

async function discoverExtensions(config: Config, baseDir: string): Promise<ExtensionDiscovery> {
  const found = extHost.discover(config, baseDir);
  return { skipped: found.skipped, modules: found.modules };
}

/** Repairs lessons, recaps and agenda text that carry per-call codes (`u1`). */
async function migrateStoredData(
  store: Store,
  profile: ProfileId,
  handles: StoredHandleDirectory | null,
): Promise<void> {
  const people = await store.people.all();
  const handleOf = new Map(people.map((p) => [p.id, handles?.ensurePerson(p) ?? null] as const));
  await repairEphemeralHandles({
    settings: store.settings,
    profile,
    handleOfPerson: (person) => handleOf.get(person) ?? null,
  });
}

export const defaultCatalog: ModuleCatalog = {
  openStore,
  coreModules,
  discord: () => new DiscordBotModule(),
  api: (deps) => new ApiModule({ emotions: avatarEmotions(deps.profile.avatar) }),
  discoverExtensions,
  migrateStoredData,
};

/** Builds a core node from `config` with every module package. */
export function buildCore(config: Config, options: CoreOptions = {}): Promise<Core> {
  return buildCoreWith(defaultCatalog, config, options);
}

/** `miyoria stage`: runs the stage node (VTube Studio, OBS, overlay) until `signal` aborts. */
export async function runStageNode(
  config: Config,
  options: {
    baseDir?: string;
    signal?: AbortSignal;
    /** Overlay build to serve when `[stage] overlay_dir` is not set (e.g. the npm bundle's). */
    overlayDir?: string;
  } = {},
): Promise<void> {
  const baseDir = options.baseDir ?? process.cwd();
  const profile = await loadProfile(config, baseDir);
  const avatar =
    profile.avatar !== null
      ? AvatarProfile.load(join(profile.dir, "avatar.toml"))
      : new AvatarProfile();
  const section = config.section("stage") ?? {};
  const explicit = isJsonObject(section) && typeof section.overlay_dir === "string";
  const stage = parseStageConfig(
    explicit || options.overlayDir === undefined
      ? section
      : { ...(isJsonObject(section) ? section : {}), overlay_dir: options.overlayDir },
    avatar,
  );
  await runStage(stage, options.signal ? { signal: options.signal } : {});
}

/** Default scene names when `[modules."stage.link".scenes] roles` names none. */
const DEFAULT_SCENES = { sing: "唱歌", chat: "聊天" } as const;

/**
 * `miyoria stage obs-setup`: plans Miyoria's OBS layout against the OBS of `[stage.obs]` and,
 * unless `dryRun`, applies it. Returns the steps (each also goes to `onStep` as it runs).
 */
export async function setupStageObs(
  config: Config,
  options: {
    baseDir?: string;
    dryRun?: boolean;
    relayout?: boolean;
    onStep?: (step: ObsSetupStep) => void;
  } = {},
): Promise<ObsSetupStep[]> {
  const baseDir = options.baseDir ?? process.cwd();
  const stage = parseStageConfig(config.section("stage") ?? {});
  const link = config.module("stage.link").config;
  const scenesSection = isJsonObject(link) && isJsonObject(link.scenes) ? link.scenes : {};
  const roles = isJsonObject(scenesSection.roles) ? scenesSection.roles : {};
  const role = (name: string) => (typeof roles[name] === "string" ? (roles[name] as string) : null);
  const url = overlayUrl(stage.overlay_bind);
  if (url === null) throw new Error(`[stage] overlay_bind 不是有效的位址:${stage.overlay_bind}`);
  const admin = await ObsWebSocketAdmin.connect(stage.obs);
  try {
    const steps = planObsSetup(await admin.snapshot(SOURCES.frame), {
      overlayUrl: url,
      videoSource: stage.obs.song_video_source ?? "Miyoria 歌曲影片",
      maskPath: resolve(baseDir, stage.data_dir, "mask-video-rounded.png"),
      scenes: {
        sing: role("sing") ?? DEFAULT_SCENES.sing,
        chat: role("chat") ?? DEFAULT_SCENES.chat,
        game: role("game"),
        threads: role("threads"),
      },
      relayout: options.relayout ?? false,
    });
    if (options.dryRun) {
      for (const step of steps) options.onStep?.(step);
    } else {
      await applyObsSetup(admin, steps, options.onStep);
    }
    return steps;
  } finally {
    await admin.close().catch(() => {});
  }
}

/** Offline extension tools for `miyoria ext ...` (legacy `miyoria_ext_host::cli`). */
export const extensionsCli: ExtensionsCli = {
  newExtension: async (parent, name, options) => extHost.newExtension(parent, name, options),
  list: async (config, base) => extHost.list(config, base),
  install: async (config, base, source) => extHost.install(config, base, source),
  validate: async (dir) => extHost.validate(dir),
};
