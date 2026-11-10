import { actuatorsFor } from "@miyoria/actions";
import { CommandMount } from "@miyoria/commands";
import { defineManifest, type Module, type ModuleContext } from "@miyoria/kernel";
import type { Profile } from "@miyoria/profile";
import {
  type AccountRef,
  ActivityManagerKey,
  type ContextKey,
  GameResumeKey,
  isLive,
  type PromptContributor,
  type PromptContributors,
  PromptContributorsKey,
  type PromptSection,
  serviceKey,
  type TaskId,
} from "@miyoria/types";
import { gameCapabilities } from "./actions.js";
import { registerCommands } from "./commands.js";
import { GameConfigSchema } from "./config.js";
import { Director, type GameStatus, type Persona, type Placement, View } from "./director.js";
import { LIVE_TOPICS, LiveState } from "./live.js";
import { timeoutValues, timeoutViolations } from "./timeouts.js";

/** Prompt contributor key. */
export const PROMPT_KEY = "game";

/** Read access to the running session (service `GameHandleKey`). */
export class GameHandle {
  readonly #view: View;

  /** @internal */
  constructor(view: View) {
    this.#view = view;
  }

  /** `null` while not playing. */
  status(): GameStatus | null {
    const s = this.#view.current;
    return s ? structuredClone(s) : null;
  }
}

/**
 * Programmatic control of the director (service `GameControlKey`), for the Admin API or tests:
 * the same operations as the commands. Each method resolves with the reply text and rejects
 * with `GameError` (user-facing message) when the request is refused.
 */
export class GameControl {
  readonly #director: Director;

  /** @internal */
  constructor(director: Director) {
    this.#director = director;
  }

  /**
   * Starts a session in `context` (used as-is unless `placement` says otherwise), for `account`.
   * Refuses (`GameError`, with a code) when the game is not running or its adapter is not
   * connected. `task`: the id of the `launch` task when it has to start the game (the
   * ActivityManager passes its own task id, so one id runs end to end).
   */
  async start(
    game: string,
    context: ContextKey,
    account: AccountRef,
    placement: Placement = "here",
    signal?: AbortSignal,
    task: TaskId | null = null,
  ): Promise<string> {
    const checked = await this.#director.preflight(game, context, signal, task);
    const text = this.#director.start(game, placement, context, account);
    return checked.inMenu ? `${text}（遊戲還在主選單，進入世界後她就會開始動。）` : text;
  }

  /** The session running now, if any (`game`, `game_name`, `context`). */
  session(): { game: string; game_name: string; context: ContextKey } | null {
    return this.#director.session();
  }

  /** A voice channel she is in (on `platform` when given), if any. */
  voiceContext(platform: string | null = null): ContextKey | null {
    return this.#director.voiceContext(platform);
  }

  async stop(): Promise<string> {
    return this.#director.stop();
  }

  async goal(text: string, by: string): Promise<string> {
    return this.#director.goal(text, by);
  }

  /** A goal for the session that is still starting (applied once it runs). */
  pendingGoal(text: string, by: string): string {
    return this.#director.pendingGoal(text, by);
  }
}

export const GameHandleKey = serviceKey<GameHandle>("GameHandle");
export const GameControlKey = serviceKey<GameControl>("GameControl");

function prefix(text: string, chars: number): string {
  return [...text].slice(0, chars).join("");
}

class GamePrompt implements PromptContributor {
  readonly key = PROMPT_KEY;

  constructor(
    private readonly view: View,
    private readonly summaryChars: number,
  ) {}

  async contribute(): Promise<PromptSection[]> {
    const s = this.view.current;
    if (!s) return [];
    let body = `你正在直播玩 ${s.game_name},聊天時可以自然提到遊戲裡的狀況。`;
    body += s.goal ? `\n目前目標:${s.goal.text}${s.goal.note}` : "\n目前沒有特定目標。";
    if (s.backlog.length > 0) body += `\n排隊中的觀眾請求:${s.backlog.join("、")}`;
    if (s.recent.length > 0) body += `\n剛剛:${s.recent.slice(-3).join(";")}`;
    if (s.summary !== "") body += `\n遊戲狀態:\n${prefix(s.summary, this.summaryChars)}`;
    return [{ key: PROMPT_KEY, title: "你正在玩的遊戲", body, order: 45 }];
  }
}

interface Running {
  director: Director;
  commands: CommandMount;
  prompts: PromptContributors | null;
  /** Unregisters the `game.*` capabilities. */
  capabilities: (() => void)[];
}

/**
 * Module `game`: the game director. A game adapter extension registers the task executor of
 * `game.<id>` (`TaskExecutorsKey`) and publishes `game.<id>.*` events; while a session runs
 * (`game start`) the director observes through the executor, asks the `game` LLM purpose for
 * goals, starts each one as a task (id + budget) and follows its `game.<id>.task.*` events,
 * comments live (`agent.initiative`, reason `game`), nudges the mood and consumes
 * `queue.item_activated` items of kind `game_goal`.
 *
 * Services used: `TaskExecutors` (required to play), `LlmRouter`, `RequestQueue`,
 * `CommandRegistry`, `PromptContributors` (all optional). Provides `GameHandleKey` and
 * `GameControlKey`.
 */
export class GameModule implements Module {
  static readonly ID = "game";
  readonly manifest = defineManifest(GameModule.ID, "Game director", {
    description: "Slow loop: picks game goals, acts through game adapters, comments live",
    optional: ["llm", "commands", "queue", "extensions"],
    configSchema: GameConfigSchema,
  });
  readonly #persona: Persona;
  #running: Running | null = null;

  /** `name` and `persona` flavour the decisions (the persona is cut to `persona_chars`). */
  constructor(name: string, persona: string) {
    this.#persona = { profile: name, name, text: persona };
  }

  /** Profile id used in the LLM session ids (default: the display name). */
  withProfileId(id: string): this {
    this.#persona.profile = id;
    return this;
  }

  static fromProfile(profile: Profile): GameModule {
    return new GameModule(profile.displayName, profile.personaPrompt()).withProfileId(
      String(profile.id),
    );
  }

  async start(ctx: ModuleContext): Promise<void> {
    const cfg = ctx.config(GameConfigSchema);
    for (const problem of timeoutViolations(timeoutValues(cfg))) {
      ctx.log.warn(
        { problem },
        "game timeouts are out of order (see packages/game/src/timeouts.ts)",
      );
    }
    const view = new View();
    const persona: Persona = {
      ...this.#persona,
      text: prefix(this.#persona.text, cfg.persona_chars),
    };
    const actuators = actuatorsFor(ctx);
    const director = new Director(cfg, ctx, persona, view, actuators);
    const control = new GameControl(director);
    const live = new LiveState();
    // The ActivityManager's broadcast when it runs (one copy of "is she live"), else the bus.
    const isStreaming = (): boolean => {
      const manager = ctx.services.get(ActivityManagerKey);
      return manager ? isLive(manager.snapshot()) : live.live();
    };
    const capabilities = gameCapabilities({
      control,
      defaultGame: cfg.default_game,
      permissions: cfg.permissions,
      toolTimeoutMs: cfg.tool_timeout_secs * 1000,
      taskBudgetSecs: cfg.task_budget_secs,
      maxBudgetSecs: cfg.max_goal_secs,
      actuators,
      live: isStreaming,
    }).map((c) => actuators.register(c));

    let paths: string[] = [];
    const commands = new CommandMount(
      "game",
      (registry) => {
        paths = registerCommands(registry, cfg.permissions, cfg.default_game, actuators, view);
      },
      (registry) => {
        for (const path of paths) registry.unregister(path);
      },
    );
    commands.attach(ctx);
    const prompts = ctx.services.get(PromptContributorsKey) ?? null;
    prompts?.register(new GamePrompt(view, cfg.prompt_summary_chars));
    ctx.provide(GameHandleKey, new GameHandle(view));
    ctx.provide(GameControlKey, control);
    ctx.provide(GameResumeKey, director);

    const events = ctx.subscribe([
      "game.*",
      "queue.item_activated",
      "voice.joined",
      "voice.left",
      "voice.participants",
      LIVE_TOPICS.golive,
      LIVE_TOPICS.stage,
      "system.module.state",
    ]);
    ctx.spawn("director", async () => {
      try {
        for await (const env of events) {
          live.onEvent(env);
          director.onEvent(env);
        }
      } finally {
        director.close();
      }
    });
    this.#running = { director, commands, prompts, capabilities };
  }

  async stop(): Promise<void> {
    const running = this.#running;
    this.#running = null;
    if (!running) return;
    running.director.close();
    running.commands.detach();
    running.prompts?.unregister(PROMPT_KEY);
    for (const unregister of running.capabilities) unregister();
  }
}
