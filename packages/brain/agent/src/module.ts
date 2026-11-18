import { actuatorsFor } from "@miyoria/gate/actions";
import { LlmRouterKey } from "@miyoria/llm/llm";
import { ToolRegistry, ToolRegistryKey } from "@miyoria/llm/tools";
import {
  defineManifest,
  errorMessage,
  type Module,
  type ModuleContext,
} from "@miyoria/runtime/kernel";
import type { Profile } from "@miyoria/runtime/profile";
import { SettingsStoreKey } from "@miyoria/store";
import {
  MouthKey,
  PromiseBookKey,
  PromptContributorsKey,
  SelfStateKey,
  TurnFocusViewKey,
  TurnSilencerKey,
  WorkLaneKey,
} from "@miyoria/types";

import { activenessCapability } from "./actions.js";
import { AgentCommands } from "./commands.js";
import { SavedPromptsKey } from "./compiler.js";
import { AgentConfigSchema } from "./config.js";
import {
  AgentHandle,
  AgentHandleKey,
  type BudgetBox,
  newOverrides,
  type Overrides,
  type VoiceRooms,
} from "./handle.js";
import { WorkingNotes } from "./notes.js";
import { PersonaHandle, PersonaHandleKey } from "./persona.js";
import { Agent, type TextRunner, type TextRunnerFactory } from "./runtime.js";
import { DropNoteTool, KeepNoteTool, ReactTool } from "./tools.js";
import { TimeoutError, timeout } from "./util.js";
import type { FetchLike } from "./vision.js";
import { WorkLaneService } from "./worklane/lane.js";

/** Loading persisted settings must not hold up startup for long. */
const SETTINGS_LOAD_TIMEOUT_MS = 5_000;

/**
 * Module `agent`: requires `llm` and `scheduler`, optionally uses `commands`.
 *
 * Hands `platform.*` and `voice.*` events to the conversations' runner Core installs
 * (`withTextRunner`, `@miyoria/brain/selfhost`), after the checks every line goes through, and
 * keeps what it and the other modules share: the persona, the channels' levels, who is in each
 * voice channel she is in, and the mouth (`MouthKey`, mainline/main.ts) every line of hers goes
 * through.
 *
 * Provides `PersonaHandleKey` and `AgentHandleKey`. Uses the `ToolRegistryKey` service when the
 * app provides one at start; otherwise it provides its own (which keeps tools registered by
 * other modules across agent restarts). Either way the built-in `react`, `keep_note` and
 * `drop_note` tools are registered while running, and the capability `channel.activeness` (her
 * talkativeness here for a while, offered as the `channel_activeness` tool) in the actuator
 * registry. Provides `TurnFocusViewKey` (whom each turn in flight answers, for voice barge-in),
 * `SavedPromptsKey` (the prompt archive the panel reads), `TurnSilencerKey` (the emergency stop),
 * `PromiseBookKey` (her commitments, which the memory's segment pass records) and, with `[modules.agent.work] enabled`, `WorkLaneKey`: the game director's driven tasks.
 */
export class AgentModule implements Module {
  static readonly ID = "agent";

  readonly manifest = defineManifest(AgentModule.ID, "Agent", {
    icon: "bot",
    category: "her",
    description: "Conversations: what reaches her, and the mouth her lines leave through",
    requires: ["llm", "scheduler"],
    // `facts`: the main line follows the log from the start.
    optional: ["commands", "facts"],
    configSchema: AgentConfigSchema,
  });

  readonly #persona: PersonaHandle;
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
  #lane: WorkLaneService | null = null;
  #textRunners: TextRunnerFactory | null = null;
  #textRunner: TextRunner | null = null;

  constructor(profile: Profile) {
    this.#persona = new PersonaHandle(profile);
    this.#tools = this.#ownTools;
  }

  /** What answers text and voice conversations (Core installs `@miyoria/brain/selfhost`). */
  withTextRunner(factory: TextRunnerFactory): this {
    this.#textRunners = factory;
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
    // What she keeps from a run's tool results for the rest of the conversation (notes.ts).
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

    const events = ctx.subscribe(Agent.topics());
    ctx.provide(PersonaHandleKey, this.#persona);
    ctx.provide(AgentHandleKey, handle);
    if (own) ctx.provide(ToolRegistryKey, tools);
    this.#commands.install(ctx.services, handle, this.#persona);
    const agent = new Agent(
      ctx,
      config,
      this.#persona,
      handle,
      tools,
      this.#commands,
      this.#fetchImage,
    );
    ctx.provide(TurnSilencerKey, agent);
    ctx.provide(TurnFocusViewKey, agent.focusBoard);
    ctx.provide(SavedPromptsKey, agent.prompts);
    this.#agent = agent;
    if (config.work.enabled) this.#startLane(ctx);
    ctx.provide(MouthKey, agent.mainline);
    // Her promises from conversation are recorded by the memory's segment pass.
    ctx.provide(PromiseBookKey, agent.mainline.commitments);
    await agent.mainline.start();
    if (this.#textRunners === null) {
      ctx.log.warn("no text runner is installed: nothing answers her conversations");
    } else {
      this.#textRunner = this.#textRunners(agent);
      agent.textRunner = this.#textRunner;
    }
    ctx.spawn("events", () => agent.run(events));
  }

  /**
   * The work lane (v4 §4.3), provided as `WorkLaneKey`: the game director drives its tasks there
   * step by step and keeps what it learned in it. Her own long tasks are the new runner's
   * sub-agent jobs (`delegate`).
   */
  #startLane(ctx: ModuleContext): void {
    const persona = this.#persona;
    const lane = new WorkLaneService({
      config: ctx.config(AgentConfigSchema).work,
      now: () => ctx.clock.now(),
      router: () => ctx.services.get(LlmRouterKey) ?? null,
      publish: ctx.publisher,
      store: () => ctx.services.get(SettingsStoreKey) ?? null,
      profile: () => persona.read((p) => p.id),
      log: ctx.log,
    });
    this.#lane = lane;
    ctx.provide(WorkLaneKey, lane);
    ctx.spawn("work-recover", async () => {
      const n = await lane.recover();
      if (n > 0) ctx.log.info({ count: n }, "work tasks a restart cut were ended");
    });
  }

  async stop(): Promise<void> {
    this.#textRunner?.stop();
    this.#textRunner = null;
    this.#lane?.close();
    this.#lane = null;
    this.#commands.uninstall();
    this.#agent?.mainline.stop();
    this.#agent = null;
    this.#tools.unregister(ReactTool.NAME);
    this.#tools.unregister(KeepNoteTool.NAME);
    this.#tools.unregister(DropNoteTool.NAME);
    for (const unregister of this.#unregister.splice(0)) unregister();
  }
}
