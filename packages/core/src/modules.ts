// The one place that imports the module packages. Names are the camelCased constructors;
// if a package exported something else, fix it here and nowhere else.
//
// Boot order (after `facts`, which every other module outlives, and `moderation`,
// which is there before anything can say a word): llm, cluster, speech, voice.link, voice, scheduler, agent, commands,
// auth, actions, directive, activity, heart, world, self, memory, arbiter, mind, knowledge, conversation,
// reflect, queue, game, game.chat, sing, watch (opt-in), mcp,
// stage.link, economy, cards, market, exchange, web, sandbox (opt-in), imagegen (opt-in), party, eval, report (opt-in), Discord bot, Admin API, terminal chat, then the
// extension host and one `ext.<id>` per extension. `facts` also writes the raw record (chat lines,
// her decisions, how each turn ended) from the bus.

import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ApiModule, avatarEmotions, EvalModule } from "@miyoria/api";
import { AuthConfigSchema, AuthModule } from "@miyoria/auth";
import { ActivityModule } from "@miyoria/brain/activity";
import { AgentModule, PersonaHandleKey } from "@miyoria/brain/agent";
import { ArbiterConfigSchema, ArbiterModule, type LocalTime } from "@miyoria/brain/arbiter";
import { DirectiveModule } from "@miyoria/brain/directive";
import { ReportModule } from "@miyoria/brain/report";
import { initiativeFromConfig, ScheduleRemindersKey, selfHost } from "@miyoria/brain/selfhost";
import { ClusterModule, execGit, findCheckoutRoot, gitCheckout } from "@miyoria/cluster";
import { CommandsModule } from "@miyoria/commands";
import { DiscordBotModule } from "@miyoria/discord";
import { EconomyModule } from "@miyoria/economy";
import { ActionsModule } from "@miyoria/gate/actions";
import { ModerationModule } from "@miyoria/gate/moderation";
import { MindModule, parseAt } from "@miyoria/heart/mind";
import { HeartModule } from "@miyoria/heart/person";
import { SelfModule } from "@miyoria/heart/self";
import { LiveModule } from "@miyoria/live";
import {
  type LlmConfig,
  LlmConfigSchema,
  LlmModule,
  type ModelRef,
  OpenAiFactory,
  parseModelRef,
} from "@miyoria/llm/llm";
import { FactsConfigSchema, FactsModule } from "@miyoria/memory/facts";
import { ConversationModule, KnowledgeModule, ReflectModule } from "@miyoria/memory/learning";
import { EmbeddingConfigSchema, MemoryModule } from "@miyoria/memory/memory";
import { WorldModule } from "@miyoria/memory/world";
import { CardsModule } from "@miyoria/play/cards";
import { ExchangeModule } from "@miyoria/play/exchange";
import { GameChatModule, GameHandleKey, GameModule } from "@miyoria/play/game";
import { KaraokeModule } from "@miyoria/play/karaoke";
import { MarketModule } from "@miyoria/play/market";
import { PartyModule } from "@miyoria/play/party";
import { QueueModule } from "@miyoria/play/queue";
import * as extHost from "@miyoria/plugin-host/ext-host";
import { McpModule } from "@miyoria/plugin-host/mcp";
import type { Config, Module } from "@miyoria/runtime/kernel";
import type { Profile } from "@miyoria/runtime/profile";
import { SchedulerModule } from "@miyoria/runtime/scheduler";
import { SingModule } from "@miyoria/sing";
import {
  AvatarProfile,
  MIYORIA,
  type ObsPlaceStep,
  type ObsSetupReport,
  type ObsSetupStep,
  ObsWebSocketAdmin,
  overlayUrl,
  parseStageConfig,
  runObsSetup,
  runStage,
  StageLinkModule,
} from "@miyoria/stage";
import { openStore as openStoreBackend, type Store } from "@miyoria/store";
import { isJsonObject } from "@miyoria/types";
import { SpeechConfigSchema, SpeechModule } from "@miyoria/voice/speech";
import { VoiceLinkModule, VoiceModule } from "@miyoria/voice/voice";
import { WatchModule } from "@miyoria/watch";
import { ImageGenModule } from "@miyoria/workspace/imagegen";
import { SandboxModule } from "@miyoria/workspace/sandbox";
import { SkillsModule } from "@miyoria/workspace/skills";
import { WebModule } from "@miyoria/workspace/web";
import {
  buildCoreWith,
  type Core,
  type CoreOptions,
  type ExtensionDiscovery,
  type ModuleCatalog,
  type ModuleDeps,
  STORE_PLUGINS,
} from "./boot.js";
import { clusterContext } from "./cluster-context.js";
import { CLUSTER_GUARDS } from "./cluster-guards.js";
import { clusterLinks } from "./cluster-links.js";
import { clusterComplete } from "./cluster-llm.js";
import { assertStartConfig, validateRevision } from "./config-schema.js";
import { CoreEndpoints, legacyEndpoints } from "./endpoints.js";
import type { ExtensionsCli } from "./ext-cli.js";
import { loadProfile, sqlitePath } from "./settings.js";

/**
 * Opens the store for `url`: `sqlite:<path>` (default, the parent directory is created) or
 * `memory://`, with the installed plugins' tables (`STORE_PLUGINS`) and config revisions checked
 * by the root schema. Any other scheme fails with a message that names the supported ones.
 */
export async function openStore(url: string): Promise<Store> {
  const path = sqlitePath(url);
  if (path !== null && path !== ":memory:") await mkdir(dirname(path), { recursive: true });
  return openStoreBackend(url, {
    // A config revision Core would not start with is refused, as the file would be.
    sqlite: { plugins: STORE_PLUGINS, config: { validate: validateRevision } },
  });
}

/**
 * The `llm` module with the profile's `[llm.purposes]` applied over the global ones; `baseDir`
 * is what a relative `[llm.call_log] dir` is resolved against (the config file's directory).
 */
export function llmModule(config: Config, profile: Profile, baseDir?: string): LlmModule {
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
  return new LlmModule(llm, [new OpenAiFactory()], {
    purposeOverrides: overrides,
    ...(baseDir === undefined ? {} : { baseDir }),
  });
}

/**
 * `[modules.auth] owners`. Owners belong in `[modules.commands] owners`; the auth section is
 * still read so both the RBAC and the fallback permissions see the same owners.
 */
export function authOwners(config: Config): string[] {
  const parsed = AuthConfigSchema.safeParse(config.module(AuthModule.ID).config ?? {});
  return parsed.success ? parsed.data.owners : [];
}

/** `[modules.arbiter]`'s clock: the quiet hours the text runner's guard keeps. */
export function arbiterClock(config: Config): LocalTime | null {
  const parsed = ArbiterConfigSchema.safeParse(config.module(ArbiterModule.ID).config ?? {});
  return parsed.success ? parsed.data : null;
}

/**
 * The checkout Core's own code runs from, for the commit a remote update of a host names
 * (v5-hostd §14); `null` for a packaged install, which has none.
 */
function coreCheckout() {
  const root = findCheckoutRoot(dirname(fileURLToPath(import.meta.url)));
  return root === null ? null : gitCheckout({ exec: execGit(root) });
}

async function coreModules({
  config,
  profile,
  profileId,
  store,
  baseDir,
  machines,
}: ModuleDeps): Promise<Module[]> {
  // Where the modules' workers are: the cluster module's registry, with the address keys of the
  // modules' own sections added as static entries (endpoints.ts).
  const endpoints = new CoreEndpoints(legacyEndpoints(config)).option;
  // Where the voice and stage links listen, for the hosts whose nodes dial them (cluster.links).
  const links = clusterLinks(config);
  return [
    // First, so it stops last: it logs what the others say on their way down.
    new FactsModule(store, profileId, { names: profile.names() }),
    new ModerationModule(),
    llmModule(config, profile, baseDir),
    // Before the modules that will ask its registry where their services are.
    new ClusterModule({
      guards: CLUSTER_GUARDS,
      complete: clusterComplete,
      links: () => links,
      checkout: coreCheckout(),
      // The install's machines, whichever profile runs (docs/design/v5-profiles.md §7).
      ...(machines === undefined ? {} : { machines }),
    }),
    SpeechModule.withDefaultFactories(config.get("speech", SpeechConfigSchema), { endpoints }),
    new VoiceLinkModule(),
    new VoiceModule(profileId, profile.voice, profile.names(), { endpoints }),
    new SchedulerModule(),
    // Text and voice conversations, her own starts and her helpers run on the new turn runner.
    new AgentModule(profile).withTextRunner(
      selfHost({
        quiet: arbiterClock(config),
        initiative: { settings: initiativeFromConfig(config), parseAt },
      }),
    ),
    new CommandsModule({ owners: authOwners(config) }),
    new AuthModule(),
    new ActionsModule(profile.displayName),
    new DirectiveModule(),
    new ActivityModule(),
    // Her numbers and words for each person (`heart_person`) and who people are: her `feel`, the
    // lines people say, evidence, the daily pass, `/me` and `/admin person`.
    HeartModule.fromProfile(profile),
    new WorldModule({
      interests: profile.manifest.interests,
      game: (services) => services.get(GameHandleKey)?.status()?.game_name ?? null,
    }),
    new SelfModule(profileId, {
      temperament: profile.manifest.temperament,
      baseline: profile.manifest.mood,
    }),
    new MemoryModule(profileId, config.get("memory.embedding", EmbeddingConfigSchema)),
    new ArbiterModule(profileId),
    new MindModule(profileId, {
      name: profile.displayName,
      reminders: (services) => services.get(ScheduleRemindersKey) ?? null,
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
    // Who listens goes to the song worker and, through the cluster, to the hosts' GPU arbiters.
    new SingModule(null, { baseDir, endpoints, context: clusterContext }),
    new WatchModule({
      persona: (services) =>
        services.get(PersonaHandleKey)?.corePrompt() ?? profile.personaPrompt(),
    }),
    McpModule.fromAppConfig(config),
    new StageLinkModule(),
    new EconomyModule(profileId),
    // Her cards for each person: the daily card, the odds, the pity, the dex and wishlists.
    new CardsModule(),
    // The weekly market: the song priority ticket, the weekly auction and the weekly lottery.
    new MarketModule(),
    // The deep-sea exchange: off until the owner turns `[modules.exchange] enabled` on. Its local
    // stocks count songs from ambient observations, which the facts module folds after this long.
    new ExchangeModule({ ambientDays: factsFoldDays(config) }),
    // Karaoke on the member page: songs prepared on the song workers, scored again by Core.
    new KaraokeModule({ baseDir }),
    new WebModule(),
    new SandboxModule(profileId, { baseDir }),
    new ImageGenModule({ baseDir, endpoints }),
    new SkillsModule(),
    new LiveModule({ names: profile.names() }),
    new PartyModule(),
    new EvalModule({ baseDir }),
    // Problem reports members make through her, for GitHub issues (opt-in).
    new ReportModule(),
  ];
}

/** `[modules.facts] fold_after_days`: how long ambient observations stay whole on the event log. */
function factsFoldDays(config: Config): number {
  const parsed = FactsConfigSchema.safeParse(config.module(FactsModule.ID).config ?? {});
  return parsed.success ? parsed.data.fold_after_days : FactsConfigSchema.parse({}).fold_after_days;
}

async function discoverExtensions(config: Config, baseDir: string): Promise<ExtensionDiscovery> {
  const found = extHost.discover(config, baseDir);
  return { skipped: found.skipped, modules: found.modules };
}

export const defaultCatalog: ModuleCatalog = {
  openStore,
  coreModules,
  discord: () => new DiscordBotModule(),
  api: (deps) => new ApiModule({ emotions: avatarEmotions(deps.profile.avatar) }),
  discoverExtensions,
};

/**
 * Builds a core node from `config` with every module package, once the whole file fits the root
 * schema (`assertStartConfig`: every problem that would stop the start, at once).
 */
export async function buildCore(config: Config, options: CoreOptions = {}): Promise<Core> {
  assertStartConfig(config);
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

/** What `setupStageObs` did, and what `[stage.obs]` says now. */
export interface StageObsSetupResult extends ObsSetupReport {
  /** `[stage.obs] collection` / `profile` as the config has them. */
  configured: { collection: string | null; profile: string | null };
}

/**
 * `miyoria stage obs-setup`: in the OBS of `[stage.obs]`, creates or switches to Miyoria's scene
 * collection and profile (`collection` / `profile`: `undefined` = `[stage.obs]`'s, else
 * `Miyoria`; `null` = keep the current one), then plans Miyoria's layout there and, unless
 * `dryRun`, applies it. Each step also goes to `onStep` as it runs.
 */
export async function setupStageObs(
  config: Config,
  options: {
    baseDir?: string;
    dryRun?: boolean;
    relayout?: boolean;
    collection?: string | null;
    profile?: string | null;
    profileSettings?: boolean;
    onStep?: (step: ObsSetupStep | ObsPlaceStep) => void;
  } = {},
): Promise<StageObsSetupResult> {
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
    const report = await runObsSetup(
      admin,
      {
        layout: {
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
        },
        place: {
          collection:
            options.collection === undefined
              ? (stage.obs.collection ?? MIYORIA)
              : options.collection,
          profile: options.profile === undefined ? (stage.obs.profile ?? MIYORIA) : options.profile,
          profileSettings: options.profileSettings ?? false,
        },
        dryRun: options.dryRun ?? false,
      },
      options.onStep ? { onStep: options.onStep } : {},
    );
    return {
      ...report,
      configured: { collection: stage.obs.collection, profile: stage.obs.profile },
    };
  } finally {
    await admin.close().catch(() => {});
  }
}

/** Offline extension tools for `miyoria ext ...`. */
export const extensionsCli: ExtensionsCli = {
  newExtension: async (parent, name, options) => extHost.newExtension(parent, name, options),
  list: async (config, base) => extHost.list(config, base),
  install: async (config, base, source) => extHost.install(config, base, source),
  validate: async (dir) => extHost.validate(dir),
};
