import { ActuatorRegistryKey, actuatorsFor } from "@miyoria/actions";
import { defineManifest, errorMessage, type Module, type ModuleContext } from "@miyoria/kernel";
import type { Profile } from "@miyoria/profile";
import { SettingsStoreKey } from "@miyoria/store";
import { ToolRegistry, ToolRegistryKey } from "@miyoria/tools";
import {
  ImpulseHostKey,
  IntentSinkKey,
  MouthKey,
  PromptContributorsKey,
  ProposalBoardKey,
  pipelineOf,
  SelfStateKey,
  TurnFocusViewKey,
  TurnSilencerKey,
} from "@miyoria/types";

import { activenessCapability, chatCapabilities } from "./actions.js";
import { type RandomSource, SeededRandom } from "./attention.js";
import { AgentCommands } from "./commands.js";
import { SavedPromptsKey } from "./compiler.js";
import { AgentConfigSchema, deprecatedAgentKeys } from "./config.js";
import {
  AgentHandle,
  AgentHandleKey,
  type BudgetBox,
  newOverrides,
  type Overrides,
  type VoiceRooms,
} from "./handle.js";
import { AgentIntents } from "./intents.js";
import { WorkingNotes } from "./notes.js";
import { PersonaHandle, PersonaHandleKey } from "./persona.js";
import { Agent } from "./runtime.js";
import { DropNoteTool, KeepNoteTool, ReactTool } from "./tools.js";
import { TimeoutError, timeout } from "./util.js";
import type { FetchLike } from "./vision.js";

/** Loading persisted settings must not hold up startup for long. */
const SETTINGS_LOAD_TIMEOUT_MS = 5_000;

/**
 * Module `agent`: requires `llm` and `scheduler`, optionally uses `commands`.
 *
 * Turns `platform.*` and `voice.*` events into replies: each conversation context (text
 * channel, DM or voice channel) keeps a `Session`, a coordinator debounces messages into turns,
 * attention decides whether to respond, and the reply is generated through the `chat` LLM
 * purpose (with an optional tool loop), parsed by the expression parser and submitted to the
 * scheduler. In voice channels the reply is cut into sentences that are spoken (`speak`
 * actions) while the model is still generating.
 *
 * Provides `PersonaHandleKey` and `AgentHandleKey`. Uses the `ToolRegistryKey` service when the
 * app provides one at start; otherwise it provides its own (which keeps tools registered by
 * other modules across agent restarts). Either way the built-in `react` tool is registered
 * while running, and the capabilities `channel.activeness` (her talkativeness here for a while,
 * offered as the `channel_activeness` tool), `chat.start` and `chat.dm` (talking on her own) in
 * the actuator registry. Provides `IntentSinkKey`: her mind loop's intents become turns she
 * starts herself (principal `self`, with tools). Provides `ImpulseHostKey`: the Arbiter's
 * accepted impulses open her turns here (and her intents go through the Arbiter while it runs).
 * Under `pipeline = "v3"` her turns are turns of the main line (mainline/main.ts), which also
 * provides `MouthKey` and `ProposalBoardKey`.
 * Provides `TurnFocusViewKey` (whom each turn in
 * flight answers, for voice barge-in) and `SavedPromptsKey` (compressed prompts of recent turns,
 * also published as `agent.prompt`); every turn ends with an `agent.turn.outcome`.
 *
 * Uses the optional services `SettingsStoreKey` (persisting runtime settings), `AuthorizerKey`
 * (tool permissions), `CommandRegistryKey`, `PromptContributorsKey` (per-turn context),
 * `SocialSignalsKey` and `MoodSignalsKey`; they are looked up per turn, so they may come and
 * go. `llm.budget` events make her save tokens (see `BudgetState`). `PlatformHistoriesKey`
 * (else `MessageLogKey`) fills cold sessions and reply chains, `PlatformSinksKey` turns her
 * `@name` into mentions; images are downloaded only when the chat model takes them.
 */
export class AgentModule implements Module {
  static readonly ID = "agent";

  readonly manifest = defineManifest(AgentModule.ID, "Agent", {
    description: "Attention, conversation and reply generation",
    requires: ["llm", "scheduler"],
    // `facts`: the main line follows the log from the start.
    optional: ["commands", "facts"],
    configSchema: AgentConfigSchema,
  });

  readonly #persona: PersonaHandle;
  #random: RandomSource | null = null;
  #fetchImage: FetchLike | undefined;
  /** Used when the app provides no registry. */
  readonly #ownTools = new ToolRegistry();
  /** The registry in use. */
  #tools: ToolRegistry;
  readonly #budget: BudgetBox = { state: "ok" };
  readonly #overrides: Overrides = newOverrides();
  readonly #voiceRooms: VoiceRooms = new Map();
  readonly #commands = new AgentCommands();
  #unregister: (() => void)[] = [];
  #agent: Agent | null = null;

  constructor(profile: Profile) {
    this.#persona = new PersonaHandle(profile);
    this.#tools = this.#ownTools;
  }

  /** Replaces the decision sampler (default: seeded from config or entropy). */
  withRandom(random: RandomSource): this {
    this.#random = random;
    return this;
  }

  /** Replaces how images are downloaded (tests; default: `fetch`). */
  withImageFetch(fetchImage: FetchLike): this {
    this.#fetchImage = fetchImage;
    return this;
  }

  persona(): PersonaHandle {
    return this.#persona;
  }

  /**
   * The tool registry in use: the app's (once started, if it provides one) or the module's
   * own. Tools registered here before start are carried over into an app-provided registry.
   */
  tools(): ToolRegistry {
    return this.#tools;
  }

  /** The app's registry if it provides one (pre-start registrations carried over), else own. */
  #resolveTools(ctx: ModuleContext): [ToolRegistry, boolean] {
    const app = ctx.services.get(ToolRegistryKey);
    if (app && app !== this.#ownTools) {
      for (const name of this.#ownTools.names()) {
        const tool = this.#ownTools.get(name);
        if (tool && app.get(name) === undefined) app.register(tool);
      }
      return [app, false];
    }
    return [this.#ownTools, true];
  }

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(AgentConfigSchema);
    const gone = deprecatedAgentKeys(ctx.rawConfig);
    if (gone.length > 0) {
      ctx.log.warn(
        { keys: gone },
        "[modules.agent] keys are deprecated and ignored: attention cooldowns and multipliers are gone (when she starts something on her own is [modules.arbiter])",
      );
    }
    const random =
      this.#random ??
      (config.seed !== null ? new SeededRandom(config.seed) : SeededRandom.fromEntropy());
    const store = ctx.services.get(SettingsStoreKey) ?? null;
    const handle = new AgentHandle(
      config,
      this.#persona,
      this.#overrides,
      this.#voiceRooms,
      this.#budget,
      store,
      ctx.clock,
    );
    try {
      const n = await timeout(SETTINGS_LOAD_TIMEOUT_MS, ctx.signal, () => handle.load());
      if (n > 0) ctx.log.info({ count: n }, "loaded runtime channel settings");
    } catch (error) {
      if (error instanceof TimeoutError) ctx.log.warn("loading runtime settings timed out");
      else ctx.log.warn({ error: errorMessage(error) }, "could not load runtime settings");
    }
    const [tools, own] = this.#resolveTools(ctx);
    if (!own) ctx.log.info("using the app's tool registry");
    this.#tools = tools;
    tools.register(new ReactTool(ctx));
    // What she keeps from a turn's tool results for the rest of the conversation (notes.ts).
    const notes = new WorkingNotes(() => ctx.clock.now());
    tools.register(new KeepNoteTool(notes));
    tools.register(new DropNoteTool(notes));
    const contributors = ctx.services.get(PromptContributorsKey);
    const contributor = notes.contributor();
    contributors?.register(contributor);
    this.#unregister.push(() => contributors?.unregister(contributor.key));
    const actuators = actuatorsFor(ctx);
    this.#unregister.push(
      actuators.register(
        activenessCapability(handle, ctx.clock, () => ctx.services.get(SelfStateKey)),
      ),
    );

    const events = ctx.subscribe(Agent.topics(pipelineOf(ctx.services) === "v3"));
    ctx.provide(PersonaHandleKey, this.#persona);
    ctx.provide(AgentHandleKey, handle);
    if (own) ctx.provide(ToolRegistryKey, tools);
    this.#commands.install(ctx.services, handle, this.#persona);
    const agent = new Agent(
      ctx,
      config,
      this.#persona,
      random,
      handle,
      tools,
      this.#commands,
      this.#fetchImage,
    );
    const intents = new AgentIntents(
      agent,
      () => ctx.services.get(ActuatorRegistryKey) ?? actuators,
    );
    for (const capability of chatCapabilities(agent, intents)) {
      this.#unregister.push(actuators.register(capability));
    }
    ctx.provide(IntentSinkKey, intents);
    ctx.provide(ImpulseHostKey, intents);
    ctx.provide(TurnSilencerKey, agent);
    ctx.provide(TurnFocusViewKey, agent.focusBoard);
    ctx.provide(SavedPromptsKey, agent.prompts);
    this.#agent = agent;
    if (agent.mainline !== null) {
      ctx.provide(MouthKey, agent.mainline);
      ctx.provide(ProposalBoardKey, agent.mainline.proposals);
      await agent.mainline.start();
    }
    ctx.spawn("events", () => agent.run(events));
  }

  async stop(): Promise<void> {
    this.#commands.uninstall();
    this.#agent?.mainline?.stop();
    this.#agent = null;
    this.#tools.unregister(ReactTool.NAME);
    this.#tools.unregister(KeepNoteTool.NAME);
    this.#tools.unregister(DropNoteTool.NAME);
    for (const unregister of this.#unregister.splice(0)) unregister();
  }
}
