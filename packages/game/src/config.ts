import { REASONING_LEVELS } from "@miyoria/types";
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

/** Defaults of the method guard (methods.ts), whichever name the config used. */
export const METHOD_DEFAULTS = { method_repeat_limit: 2, method_hold_secs: 600 } as const;

/**
 * `[modules.game]`. All fields have defaults; durations are in seconds.
 *
 * ```toml
 * [modules.game]
 * decide_secs = 20
 * stream_context = { platform = "discord", scope = "123", channel = "456", kind = "voice" }
 * ```
 */
const GameConfigFields = z.object({
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
  /**
   * Failed tasks (or refused starts, or tasks that ended without progress) before a goal counts
   * as failed. Her own goals too: until 2026-11-08 one failure ended them, and four seconds later
   * she proposed the same goal again.
   */
  max_attempts: z.number().default(3),
  /** Tasks one goal may start before it counts as failed (`timeout`): its step budget. */
  max_goal_steps: z.number().int().positive().default(8),
  /** Attempts (an action and how it ended) her record keeps and shows each decision. */
  record_attempts: z.number().int().positive().default(10),
  /**
   * The same method (an action with its item, `obtain:bread`) failing this many times in a row
   * with the same code is held for `method_hold_secs`; one `invalid` holds an item method for the
   * rest of the session. A goal that runs out of attempts holds its item the same way. 0 turns it
   * off. Defaults 2 and 600 (`METHOD_DEFAULTS`); `repeat_failure_limit` / `repeat_guard_secs`
   * are older names of the two (see below).
   */
  method_repeat_limit: z.number().int().nonnegative().optional(),
  method_hold_secs: z.number().nonnegative().optional(),
  /**
   * Older names of `method_repeat_limit` / `method_hold_secs`, from a goal guard written beside
   * this one (PR 8, keyed by the action's parameter string and released after a fixed time). The
   * method guard took its place; a config that sets these still sets the method guard, unless the
   * new name is set too.
   */
  repeat_failure_limit: z.number().int().nonnegative().optional(),
  repeat_guard_secs: z.number().nonnegative().optional(),
  /**
   * When a held method may come back (methods.ts). `changed`: only once something changed (an item
   * the failure said was missing is in her inventory now, another method got her somewhere), and
   * a failure after that holds it again at once; the same method failing twice in a row holds it
   * whatever the codes. `time`: after `method_hold_secs`, whatever happened, and only the same
   * code twice holds (the guard before 2026-11-10, for rollback): on the replay of 11-08 it still
   * let `obtain bread` fail 9 times, two per hold.
   */
  method_release: z.enum(["changed", "time"]).default("changed"),
  /**
   * The director's decisions are steps of one work-lane task per session (v4 §11.2 item 1), with
   * its own transcript: what it saw, what it decided, what came of it. `false`: every decision is
   * its own call, as before (rollback); also what happens when the agent's work lane is not there.
   */
  director_lane: z.boolean().default(true),
  /** Decisions that task's transcript keeps (older ones fall out; her record still has them). */
  director_steps: z.number().int().positive().default(6),
  /**
   * Skills she learned in a game are kept across restarts (§11.2 item 8): in her skill store when
   * the `skills` module runs (one skill per game), else in the settings store.
   */
  keep_skills: z.boolean().default(true),
  /**
   * Survival goals the director starts by itself, when the adapter offers them: `night_action`
   * when night falls (`night_started`), `death_action` `death_action_delay_secs` after she died
   * (she respawns first). The goal she had waits and comes back when it ends. `null` turns one
   * off.
   */
  night_action: z.string().nullable().default("shelter"),
  death_action: z.string().nullable().default("recover"),
  death_action_delay_secs: z.number().nonnegative().default(5),
  /** Reasoning of the decision model (`null`: what `[llm.reasoning]` says for `purpose`). */
  reasoning: z.enum(REASONING_LEVELS).nullable().default("low"),
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
  /**
   * Actions that never replace the current goal and whose success is nobody's progress. `stop`
   * is one: on 2026-11-08 it became a goal 64 times and counted as reached 19 times.
   */
  instant_actions: z
    .array(z.string())
    .default(["chat", "look", "attack", "use", "select", "place", "respawn", "stop"]),
  /**
   * Game event types that trigger an early decision (a goal's task ending always does: its
   * `game.<id>.task.done|failed` event, not one of these). Not `hostile_near` or `reflex_end`:
   * the reflexes deal with those, and on 2026-11-08 57 enemy sightings and 55 reflexes kept
   * waking her to re-plan what was still running.
   */
  trigger_events: z
    .array(z.string())
    .default(["death", "low_health", "advancement", "chat", "connected"]),
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

/** `[modules.game]`, with the method guard's older key names read as its own. */
export const GameConfigSchema = GameConfigFields.transform(
  ({ repeat_failure_limit, repeat_guard_secs, ...cfg }) => ({
    ...cfg,
    method_repeat_limit:
      cfg.method_repeat_limit ?? repeat_failure_limit ?? METHOD_DEFAULTS.method_repeat_limit,
    method_hold_secs: cfg.method_hold_secs ?? repeat_guard_secs ?? METHOD_DEFAULTS.method_hold_secs,
  }),
);
export type GameConfig = z.output<typeof GameConfigSchema>;

/** Defaults of every field (the Rust `Default` impl). */
export function defaultGameConfig(): GameConfig {
  return GameConfigSchema.parse({});
}
