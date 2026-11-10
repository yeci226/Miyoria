// What the manager sees of the outside world, from the bus: where her voice account is, the Go
// Live and OBS state, the game session and the song. Only the manager's state machines read
// these; everyone else reads the `ActivitySnapshot` built from them.

import {
  type ContextKey,
  type Envelope,
  isJsonObject,
  isTaskFailureCode,
  type JsonObject,
  parseSongCue,
  SONG_TOPIC,
  type TaskFailureCode,
  type TurnId,
} from "@miyoria/types";

/** `voice.golive` (published by `@miyoria/voice`). */
export const GOLIVE_TOPIC = "voice.golive";
/** `stage.status` (published by `stage.link`). */
export const STAGE_STATUS_TOPIC = "stage.status";
/** `game.director.session` (published by the game director). */
export const GAME_SESSION_TOPIC = "game.director.session";

/** Every topic the manager follows. */
export const FACT_TOPICS = [
  "voice.joined",
  "voice.left",
  "voice.participants",
  GOLIVE_TOPIC,
  STAGE_STATUS_TOPIC,
  GAME_SESSION_TOPIC,
  SONG_TOPIC,
  "agent.turn.started",
  "agent.turn.completed",
] as const;

/**
 * Where executors publish their task events (`game.<id>.task.*`, `ext.<id>.task.*`): the manager
 * follows them to know which tasks are live and how a steer went.
 */
export const TASK_EVENT_TOPICS = ["game.*", "ext.*"] as const;

export type GoLiveFact = "starting" | "live" | "stopped" | "failed";

export interface GoLiveState {
  state: GoLiveFact;
  error: string | null;
  reason: string | null;
}

export interface StageFact {
  connected: boolean;
  obs: boolean;
  streaming: boolean;
  scene: string | null;
}

export interface SessionFact {
  game: string;
  name: string;
  context: ContextKey | null;
}

/**
 * The session a `game.start` step's result says it started (`data.session`: `game`,
 * `game_name`, `context`), or `null`.
 */
export function startedSession(data: unknown): SessionFact | null {
  if (!isJsonObject(data)) return null;
  const session = data.session;
  if (!isJsonObject(session)) return null;
  const game = str(session.game);
  if (game === null) return null;
  return { game, name: str(session.game_name) ?? game, context: contextOf(session.context) };
}

/** How the last session ended (when the director said why). */
export interface SessionEnd {
  game: string;
  name: string;
  code: TaskFailureCode | null;
  reason: string | null;
}

const TURN_MEMORY = 200;

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function contextOf(value: unknown): ContextKey | null {
  if (!isJsonObject(value)) return null;
  const { platform, scope, channel, kind } = value;
  if (typeof platform !== "string" || typeof channel !== "string") return null;
  if (kind !== "channel" && kind !== "thread" && kind !== "dm" && kind !== "voice") return null;
  return { platform, scope: typeof scope === "string" ? scope : null, channel, kind };
}

/** The observed facts, updated from bus events. */
export class Facts {
  /** Her voice channel per guild (normally one). */
  readonly voice = new Map<string, ContextKey>();
  readonly golive = new Map<string, GoLiveState>();
  /** The last Go Live state per guild, including `stopped` / `failed` (for waiters). */
  readonly goliveLast = new Map<string, GoLiveState>();
  stage: StageFact = { connected: false, obs: false, streaming: false, scene: null };
  session: SessionFact | null = null;
  /** Set by the `stopped` session event (read and cleared by the manager). */
  sessionEnd: SessionEnd | null = null;
  song: string | null = null;
  readonly #turns = new Map<TurnId, "running" | "done">();

  /** Applies one event; returns whether a fact changed. */
  apply(env: Envelope): boolean {
    const event = env.event;
    switch (event.type) {
      case "voice_joined":
      case "voice_participants": {
        const c = event.data.context;
        if (c.scope === null) return false;
        const before = this.voice.get(c.scope);
        if (before?.channel === c.channel && before.platform === c.platform) return false;
        this.voice.set(c.scope, { ...c, kind: "voice" });
        return true;
      }
      case "voice_left": {
        const c = event.data.context;
        if (c.scope === null) return false;
        return this.voice.delete(c.scope);
      }
      case "agent_turn_started":
        this.#turn(event.data.turn, "running");
        return false;
      case "agent_turn_completed":
        this.#turn(event.data.turn, "done");
        return true;
      case "custom":
        return this.#custom(event.data.topic, event.data.payload);
      default:
        return false;
    }
  }

  #custom(topic: string, payload: unknown): boolean {
    const data: JsonObject = isJsonObject(payload as never) ? (payload as JsonObject) : {};
    switch (topic) {
      case GOLIVE_TOPIC: {
        const state = data.state;
        if (state !== "starting" && state !== "live" && state !== "stopped" && state !== "failed") {
          return false;
        }
        const guild = str(data.guild) ?? "";
        const fact: GoLiveState = { state, error: str(data.error), reason: str(data.reason) };
        this.goliveLast.set(guild, fact);
        if (state === "stopped" || state === "failed") this.golive.delete(guild);
        else this.golive.set(guild, fact);
        return true;
      }
      case STAGE_STATUS_TOPIC: {
        if (data.connected !== true) {
          // Without the node the stream state is unknown: keep `streaming`, lose OBS.
          this.stage = { ...this.stage, connected: false, obs: false, scene: null };
          return true;
        }
        const obs = data.obs === true;
        this.stage = {
          connected: true,
          obs,
          // Without OBS the streaming state is unknown; keep the last one.
          streaming: obs ? data.streaming === true : this.stage.streaming,
          scene: str(data.scene),
        };
        return true;
      }
      case GAME_SESSION_TOPIC: {
        const game = str(data.game);
        if (game === null) return false;
        const name = str(data.game_name) ?? game;
        if (data.state === "started") {
          this.session = { game, name, context: contextOf(data.context) };
          this.sessionEnd = null;
        } else if (data.state === "stopped") {
          this.session = null;
          const code = isTaskFailureCode(data.code) ? data.code : null;
          this.sessionEnd = { game, name, code, reason: str(data.reason) };
        } else {
          return false;
        }
        return true;
      }
      case SONG_TOPIC: {
        const cue = parseSongCue(payload as never);
        if (cue?.state === "started") this.song = cue.title || cue.song;
        else if (cue?.state === "ended") this.song = null;
        else return false;
        return true;
      }
      default:
        return false;
    }
  }

  #turn(turn: TurnId, state: "running" | "done"): void {
    this.#turns.delete(turn);
    this.#turns.set(turn, state);
    while (this.#turns.size > TURN_MEMORY) {
      const oldest = this.#turns.keys().next().value;
      if (oldest === undefined) break;
      this.#turns.delete(oldest);
    }
  }

  /** The turn is known to be still running (started, not completed). */
  turnRunning(turn: TurnId): boolean {
    return this.#turns.get(turn) === "running";
  }

  /** Her voice channel (the last one joined when there are several). */
  voiceChannel(): ContextKey | null {
    let last: ContextKey | null = null;
    for (const c of this.voice.values()) last = c;
    return last;
  }

  /** Go Live is starting or live in some guild: that guild. */
  liveGuild(): string | null {
    for (const [guild, s] of this.golive) {
      if (s.state === "starting" || s.state === "live") return guild;
    }
    return null;
  }
}
