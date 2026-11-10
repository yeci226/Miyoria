import { z } from "zod";

/** Permission nodes of the `game` commands. */
export const GamePermissionsSchema = z.object({
  start: z.string().default("game.start"),
  stop: z.string().default("game.stop"),
  goal: z.string().default("game.goal"),
  status: z.string().default("game.status"),
});
export type GamePermissions = z.output<typeof GamePermissionsSchema>;

const ContextKeySchema = z.object({
  platform: z.string(),
  scope: z.string().nullable(),
  channel: z.string(),
  kind: z.enum(["channel", "thread", "dm", "voice"]),
});

/**
 * `[modules.game]`. All fields have defaults; durations are in seconds.
 *
 * ```toml
 * [modules.game]
 * decide_secs = 20
 * stream_context = { platform = "discord", scope = "123", channel = "456", kind = "voice" }
 * ```
 */
export const GameConfigSchema = z.object({
  /** Game id used when `game start` names none. */
  default_game: z.string().default("minecraft"),
  /** Regular decision interval while playing. */
  decide_secs: z.number().default(20),
  /** Event-triggered decisions happen at most this often. */
  min_decide_secs: z.number().default(4),
  /**
   * A goal is kept at least this long unless it finished, failed, the bot went idle or
   * something important happened.
   */
  min_goal_secs: z.number().default(45),
  /** A goal still running after this long is given up (code `timeout`; see `timeouts.ts`). */
  max_goal_secs: z.number().default(600),
  /**
   * Budget of a goal's task when its executor suggests none (capped at `max_goal_secs`); the
   * executor ends the task with `timeout` when it runs out.
   */
  task_budget_secs: z.number().positive().default(240),
  /** Failed tasks (or refused starts) before a requested goal counts as failed. */
  max_attempts: z.number().default(3),
  /** Minimum time between regular commentary requests. */
  commentary_min_secs: z.number().default(15),
  /** Minimum time between important ones that are still narration (an advancement, a creeper). */
  urgent_commentary_min_secs: z.number().default(3),
  /**
   * Narration about one thing (`game:craft:stone_pickaxe`) does not ask to be said again for this
   * long after it was said; a later occurrence counts as new. The game state stays in her context
   * meanwhile, it only does not ask her to speak.
   */
  narration_repeat_mins: z.number().positive().default(45),
  /** The same for `hazard_events`: a second zombie a few minutes later is a new encounter. */
  hazard_repeat_secs: z.number().positive().default(120),
  /** Event types (`kind`, or `kind:subject`) that come and go instead of happening once. */
  hazard_events: z.array(z.string()).default(["damage", "hostile_near", "reflex"]),
  /**
   * Event types (`kind`, or `kind:subject`) she always reacts to: no dedupe, no `max_unanswered`.
   * A session ending (`end_events`) is not here: the ActivityManager's notice tells that one.
   */
  urgent_events: z
    .array(z.string())
    .default([
      "death",
      "low_health",
      "reflex:lava",
      "reflex:drowning",
      "reflex:suffocation",
      "reflex:flee",
    ]),
  /** LLM purpose of the decisions. */
  purpose: z.string().default("game"),
  temperature: z.number().default(0.7),
  max_tokens: z.number().default(2000),
  llm_timeout_secs: z.number().default(30),
  /**
   * One control call to the game's executor (observe, start, cancel): longer than one request to
   * the game, shorter than the host's RPC timeout (see `timeouts.ts`).
   */
  tool_timeout_secs: z.number().default(20),
  /** How much of the persona prompt goes into the decision prompt. */
  persona_chars: z.number().default(600),
  /** Recent game events remembered for prompts. */
  recent_events: z.number().default(12),
  /** Characters of the observation summary in the chat prompt section. */
  prompt_summary_chars: z.number().default(500),
  /**
   * Where commentary goes when `game start` is not run from a voice channel she is in (e.g. the
   * stream's voice channel).
   */
  stream_context: ContextKeySchema.nullable().default(null),
  /** Request queue item kind consumed as goals. */
  queue_kind: z.string().default("game_goal"),
  /** Actions that never replace the current goal. */
  instant_actions: z
    .array(z.string())
    .default(["chat", "look", "attack", "use", "select", "place", "respawn"]),
  /**
   * Game event types that trigger an early decision (a goal's task ending always does: its
   * `game.<id>.task.done|failed` event, not one of these).
   */
  trigger_events: z
    .array(z.string())
    .default([
      "death",
      "low_health",
      "hostile_near",
      "advancement",
      "chat",
      "connected",
      "reflex_end",
    ]),
  /**
   * Event types meaning the game went away (`disconnected`): the session ends at once (the
   * scene switches back, the ActivityManager shows `failed(disconnected)`), it is not commentary.
   */
  end_events: z.array(z.string()).default(["disconnected"]),
  /**
   * Games the director plays: the adapter's executor has goals (Minecraft). Others (Threads,
   * which has no goals and stays disabled, v2 §3.8) are refused by `game start`; when they come
   * back they get their own activity loop instead of the director.
   */
  directed_games: z.array(z.string()).default(["minecraft"]),
  /**
   * `game start` first checks (observing through the executor) that the game is running and its
   * adapter connected, and refuses otherwise so she can tell the owner. In the main menu is fine.
   */
  require_connected: z.boolean().default(true),
  /**
   * When the game is not running but its adapter can start it (`state.launch.available`),
   * `game start` runs the executor's `launch` task (through the gate) and waits for its end.
   */
  auto_launch: z.boolean().default(true),
  /** Budget of the `launch` task: the game connects (and loads the world) within this. */
  launch_wait_secs: z.number().default(240),
  /** `game stop` also runs `quit` (the adapter decides whether it really closes the game). */
  close_on_stop: z.boolean().default(true),
  /** Adapter actions only `game start` / `stop` use; the decision loop never runs them. */
  session_actions: z.array(z.string()).default(["launch", "quit"]),
  /**
   * After a task fails (or its start is refused), `guarded_actions` are withheld this long so she
   * changes method or goal instead of retrying; another action that succeeds ends it early.
   * 0 turns the guard off.
   */
  failure_guard_secs: z.number().default(45),
  /** The low-level move / mine actions the failure guard withholds. */
  guarded_actions: z.array(z.string()).default(["goto", "mine", "look", "attack"]),
  /** Largest mood change the model may ask for per decision. */
  max_llm_nudge: z.number().default(0.1),
  permissions: GamePermissionsSchema.prefault({}),
});
export type GameConfig = z.output<typeof GameConfigSchema>;

/** Defaults of every field (the Rust `Default` impl). */
export function defaultGameConfig(): GameConfig {
  return GameConfigSchema.parse({});
}
