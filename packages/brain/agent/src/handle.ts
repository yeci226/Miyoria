// Runtime control of the agent: per-context channel mode and activeness, which voice channel
// she is in, and the LLM budget state.

import { errorMessage, getLogger } from "@miyoria/runtime/kernel";
import type { SettingsStore } from "@miyoria/store";
import {
  type Clock,
  type ContextKey,
  contextKeyEquals,
  contextKeyString,
  type JsonValue,
  type PlatformId,
  type ProfileId,
  serviceKey,
  systemClock,
} from "@miyoria/types";
import {
  type Activeness,
  type AgentConfig,
  activenessFor,
  type ChannelMode,
  modeFor,
  parseActiveness,
  parseChannelMode,
} from "./config.js";
import type { PersonaHandle } from "./persona.js";
import type { BudgetState } from "./signals.js";

const log = getLogger("agent.handle");

export const MODE_PREFIX = "channel_mode:";
export const ACTIVENESS_PREFIX = "activeness:";

/**
 * Runtime overrides keyed by `ContextKey`'s display form (`<platform>:<scope or dm>:<channel>`).
 * Owned by the module so they survive restarts.
 */
export interface Overrides {
  modes: Map<string, ChannelMode>;
  activeness: Map<string, Activeness>;
  /**
   * Activeness she set herself for a while (`channel.activeness`), with its end (clock ms).
   * Wins over everything until it expires; kept in memory only.
   */
  temporary: Map<string, TemporaryActiveness>;
}

export interface TemporaryActiveness {
  level: Activeness;
  /** Clock ms. */
  until: number;
}

export function newOverrides(): Overrides {
  return { modes: new Map(), activeness: new Map(), temporary: new Map() };
}

/** The voice context she is in, keyed by `voiceScopeKey`. */
export type VoiceRooms = Map<string, ContextKey>;

/** The LLM budget state, shared between restarts. */
export interface BudgetBox {
  state: BudgetState;
}

/** `[platform, guild]` of a voice context (the channel for calls outside a guild). */
export function voiceScope(context: ContextKey): [PlatformId, string] {
  return [context.platform, context.scope ?? context.channel];
}

function roomKey(platform: PlatformId, scope: string): string {
  return JSON.stringify([platform, scope]);
}

/**
 * Provided as the `AgentHandleKey` service by the agent module.
 *
 * Runtime overrides take precedence over `[modules.agent]` config, which takes precedence over
 * the profile. When a `SettingsStore` service is available at start, overrides are persisted
 * per profile under `channel_mode:<context>` / `activeness:<context>` and reloaded on start.
 */
export class AgentHandle {
  readonly #config: AgentConfig;
  readonly #persona: PersonaHandle;
  readonly #overrides: Overrides;
  readonly #voiceRooms: VoiceRooms;
  readonly #budget: BudgetBox;
  readonly #store: SettingsStore | null;
  readonly #clock: Clock;

  /** @internal Created by the agent module. */
  constructor(
    config: AgentConfig,
    persona: PersonaHandle,
    overrides: Overrides,
    voiceRooms: VoiceRooms,
    budget: BudgetBox,
    store: SettingsStore | null,
    clock: Clock = systemClock,
  ) {
    this.#config = config;
    this.#persona = persona;
    this.#overrides = overrides;
    this.#voiceRooms = voiceRooms;
    this.#budget = budget;
    this.#store = store;
    this.#clock = clock;
  }

  /** The LLM budget state last reported on `llm.budget` (`ok` until then). */
  llmBudget(): BudgetState {
    return this.#budget.state;
  }

  /** @internal Returns the previous state. */
  setLlmBudget(state: BudgetState): BudgetState {
    const before = this.#budget.state;
    this.#budget.state = state;
    return before;
  }

  /**
   * The voice channel she is currently in on `platform` in guild `scope` (as a `voice`
   * context), if any.
   */
  voiceContext(platform: PlatformId, scope: string): ContextKey | null {
    return this.#voiceRooms.get(roomKey(platform, scope)) ?? null;
  }

  /** @internal Records that she is (`true`) or no longer is in the voice `context`. */
  setVoiceRoom(context: ContextKey, joined: boolean): void {
    const key = roomKey(...voiceScope(context));
    if (joined) {
      this.#voiceRooms.set(key, context);
    } else {
      const current = this.#voiceRooms.get(key);
      if (current && contextKeyEquals(current, context)) this.#voiceRooms.delete(key);
    }
  }

  /** Settings key of the channel mode override for `context`. */
  static modeKey(context: ContextKey): string {
    return `${MODE_PREFIX}${contextKeyString(context)}`;
  }

  /** Settings key of the activeness override for `context`. */
  static activenessKey(context: ContextKey): string {
    return `${ACTIVENESS_PREFIX}${contextKeyString(context)}`;
  }

  /** Effective channel mode: runtime override, then config, then profile. */
  channelMode(context: ContextKey): ChannelMode {
    return this.channelModeOverride(context) ?? this.configuredChannelMode(context);
  }

  channelModeOverride(context: ContextKey): ChannelMode | null {
    return this.#overrides.modes.get(contextKeyString(context)) ?? null;
  }

  /** Every runtime mode override, keyed by `contextKeyString`. */
  channelModeOverrides(): [string, ChannelMode][] {
    return [...this.#overrides.modes.entries()];
  }

  /** Mode from config and profile only (what `reset` goes back to). */
  configuredChannelMode(context: ContextKey): ChannelMode {
    const raw = this.#persona.read((p) => p.manifest.behavior.default_channel_mode);
    let profile: ChannelMode;
    try {
      profile = parseChannelMode(raw);
    } catch (error) {
      log.warn(
        { error: errorMessage(error) },
        "invalid default_channel_mode in profile, using mention-only",
      );
      profile = "mention-only";
    }
    return modeFor(this.#config, context, profile);
  }

  /**
   * Sets (a mode) or clears (`null`) the runtime override. It applies immediately; a rejection
   * means it could not be persisted.
   */
  async setChannelMode(context: ContextKey, mode: ChannelMode | null): Promise<void> {
    const key = contextKeyString(context);
    if (mode === null) this.#overrides.modes.delete(key);
    else this.#overrides.modes.set(key, mode);
    await this.#persist(AgentHandle.modeKey(context), mode);
  }

  /**
   * Effective activeness: her own temporary choice, then the runtime override, then config,
   * then `behavior.initiative`.
   */
  activeness(context: ContextKey): Activeness {
    return (
      this.temporaryActiveness(context)?.level ??
      this.activenessOverride(context) ??
      this.configuredActiveness(context)
    );
  }

  /** Her temporary activeness in `context`, unless it expired (then it is forgotten). */
  temporaryActiveness(context: ContextKey): TemporaryActiveness | null {
    const key = contextKeyString(context);
    const entry = this.#overrides.temporary.get(key);
    if (!entry) return null;
    if (this.#clock.now() >= entry.until) {
      this.#overrides.temporary.delete(key);
      return null;
    }
    return { ...entry };
  }

  /** Sets her own activeness in `context` until `until` (clock ms); then it reverts. */
  setTemporaryActiveness(context: ContextKey, level: Activeness, until: number): void {
    this.#overrides.temporary.set(contextKeyString(context), { level, until });
  }

  activenessOverride(context: ContextKey): Activeness | null {
    return this.#overrides.activeness.get(contextKeyString(context)) ?? null;
  }

  configuredActiveness(context: ContextKey): Activeness {
    const raw = this.#persona.read((p) => p.manifest.behavior.initiative);
    let profile: Activeness;
    try {
      profile = parseActiveness(raw);
    } catch (error) {
      log.warn(
        { error: errorMessage(error) },
        "invalid behavior.initiative in profile, using medium",
      );
      profile = "medium";
    }
    return activenessFor(this.#config, context, profile);
  }

  /** Like `setChannelMode`, for activeness. */
  async setActiveness(context: ContextKey, level: Activeness | null): Promise<void> {
    const key = contextKeyString(context);
    if (level === null) this.#overrides.activeness.delete(key);
    else this.#overrides.activeness.set(key, level);
    await this.#persist(AgentHandle.activenessKey(context), level);
  }

  #profile(): ProfileId {
    return this.#persona.read((p) => p.id);
  }

  async #persist(key: string, value: string | null): Promise<void> {
    if (this.#store === null) return;
    await this.#store.set(this.#profile(), key, value);
  }

  /** @internal Loads persisted overrides; returns how many were applied. */
  async load(): Promise<number> {
    if (this.#store === null) return 0;
    const profile = this.#profile();
    const modes = await this.#store.list(profile, MODE_PREFIX);
    const levels = await this.#store.list(profile, ACTIVENESS_PREFIX);
    let n = 0;
    for (const [key, value] of modes) {
      const entry = parseEntry(key, MODE_PREFIX, value, parseChannelMode);
      if (entry) {
        this.#overrides.modes.set(entry[0], entry[1]);
        n++;
      } else {
        log.warn({ key, value }, "ignoring invalid stored channel mode");
      }
    }
    for (const [key, value] of levels) {
      const entry = parseEntry(key, ACTIVENESS_PREFIX, value, parseActiveness);
      if (entry) {
        this.#overrides.activeness.set(entry[0], entry[1]);
        n++;
      } else {
        log.warn({ key, value }, "ignoring invalid stored activeness");
      }
    }
    return n;
  }
}

function parseEntry<T>(
  key: string,
  prefix: string,
  value: JsonValue,
  parse: (s: string) => T,
): [string, T] | null {
  if (!key.startsWith(prefix)) return null;
  const context = key.slice(prefix.length);
  if (context === "" || typeof value !== "string") return null;
  try {
    return [context, parse(value)];
  } catch {
    return null;
  }
}

/** Service key of the `AgentHandle`. */
export const AgentHandleKey = serviceKey<AgentHandle>("AgentHandle");
