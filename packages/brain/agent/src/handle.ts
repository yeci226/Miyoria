// Runtime control of the agent: the levels of each place (channel mode, activeness, voice mode,
// language), which voice channel she is in, and the LLM budget state.
//
// The levels live in `place_settings` (plugin `agent`, keys `LEVEL_KEYS`; docs/design/v5-places.md)
// and are read through the module's `PlaceConfig`: a room's own value, then its channel's (a
// thread), then its Space's, then `[modules.agent]` (`channels`, then `default_mode`), then the
// profile. A room of a new server (not established: first seen after servers were told apart),
// with nothing set for it or its server, is `NEW_SPACE_MODE` (she answers who calls her and nothing else).
//
// Before phase 6 the runtime levels were `plugin_state` keys (`channel_mode:<context>`,
// `activeness:<context>`). `migrateLegacy` moves them into `place_settings` once (marker
// `agent:places_v1`); a key whose room identity does not know yet stays in effect from memory and
// is moved at a later start. Without the places services (unit tests, a store without identity)
// the old keys are still what is read and written.

import { errorMessage, getLogger } from "@miyoria/runtime/kernel";
import {
  CONFIG_IMPORT_AUTHOR,
  type PlaceSetting,
  type PlaceSettingFilter,
  type SettingsStore,
} from "@miyoria/store";
import {
  type Clock,
  type ContextKey,
  contextKeyEquals,
  contextKeyString,
  isJsonObject,
  type JsonValue,
  type PlaceConfig,
  type Places,
  type PlatformId,
  type ProfileId,
  serviceKey,
  systemClock,
  toTimestamp,
} from "@miyoria/types";
import {
  type Activeness,
  type AgentConfig,
  activenessFor,
  type ChannelMode,
  LEVEL_KEYS,
  type LevelKey,
  modeFor,
  parseActiveness,
  parseChannelMode,
} from "./config.js";
import type { PersonaHandle } from "./persona.js";
import type { BudgetState } from "./signals.js";

const log = getLogger("agent.handle");

export const MODE_PREFIX = "channel_mode:";
export const ACTIVENESS_PREFIX = "activeness:";
/** `plugin_state` marker of the move of the old keys into `place_settings`. */
export const PLACES_MIGRATION_KEY = "agent:places_v1";
/** The `plugin` of the levels' `place_settings` rows: the agent module's id. */
export const LEVELS_PLUGIN = "agent";
/** Who wrote a place row by copying a file (the config import, `CONFIG_IMPORT_AUTHOR`) or this move. */
const IMPORTED: ReadonlySet<string> = new Set([CONFIG_IMPORT_AUTHOR, "migration"]);

/**
 * Runtime overrides keyed by `ContextKey`'s display form (`<platform>:<scope or dm>:<channel>`).
 * With the places services they hold only what could not be written to a place (a room identity
 * does not know yet); without them, every runtime level.
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

/** The place settings the levels are read from and written to (the store's `PlaceSettings`). */
export interface LevelSettings {
  get(scope: "space" | "room", scopeId: string, plugin: string, key: string): PlaceSetting | null;
  list(filter?: PlaceSettingFilter): PlaceSetting[];
  set(
    scope: "space" | "room",
    scopeId: string,
    plugin: string,
    key: string,
    value: JsonValue | null,
    by: string,
  ): void;
}

/** What the levels need of Core's places (docs/design/v5-places.md). */
export interface LevelPlaces {
  places: Places;
  settings: LevelSettings;
  /** The agent's section per place (`placeConfig(ctx, AgentConfigSchema)`). */
  config: PlaceConfig<AgentConfig>;
}

/** Where a level is set: this room, or the whole Space it is in. */
export type LevelScope = "room" | "space";

export interface SetLevelOptions {
  /** Default `room`. */
  scope?: LevelScope;
  /** Who set it (`discord:<id>`, `panel:<person>`); default `agent`. */
  by?: string;
}

/** A level could not be kept in `place_settings`: identity does not know the place yet. */
export class UnknownPlaceError extends Error {
  override readonly name = "UnknownPlaceError";
}

/** `[platform, guild]` of a voice context (the channel for calls outside a guild). */
export function voiceScope(context: ContextKey): [PlatformId, string] {
  return [context.platform, context.scope ?? context.channel];
}

function roomKey(platform: PlatformId, scope: string): string {
  return JSON.stringify([platform, scope]);
}

/** `contextKeyString`'s form back into a context (`platform:scope|dm:[voice:]channel`). */
export function parseContextDisplay(text: string): ContextKey | null {
  const parts = text.split(":");
  if (parts.length < 3) return null;
  const [platform, scope, ...rest] = parts as [string, string, ...string[]];
  const voice = rest[0] === "voice" && rest.length > 1;
  const channel = (voice ? rest.slice(1) : rest).join(":");
  if (platform === "" || scope === "" || channel === "") return null;
  if (scope === "dm") return { platform, scope: null, channel, kind: voice ? "voice" : "dm" };
  return { platform, scope, channel, kind: voice ? "voice" : "channel" };
}

/** The key of a level for `context`: voice contexts have their own. */
function modeKey(context: ContextKey): LevelKey {
  return context.kind === "voice" ? LEVEL_KEYS.voiceMode : LEVEL_KEYS.mode;
}

function activenessKey(context: ContextKey): LevelKey {
  return context.kind === "voice" ? LEVEL_KEYS.voiceActiveness : LEVEL_KEYS.activeness;
}

/** A level key's value in a parsed section. */
function valueAt(config: AgentConfig, key: LevelKey): string | null {
  switch (key) {
    case LEVEL_KEYS.mode:
      return config.mode;
    case LEVEL_KEYS.activeness:
      return config.activeness_level;
    case LEVEL_KEYS.voiceMode:
      return config.voice.mode;
    case LEVEL_KEYS.voiceActiveness:
      return config.voice.activeness_level;
    case LEVEL_KEYS.language:
      return config.language;
  }
}

function tryParse<T>(parse: (s: string) => T, value: unknown): T | null {
  if (typeof value !== "string") return null;
  try {
    return parse(value);
  } catch {
    return null;
  }
}

function parseLanguage(value: string): string {
  const v = value.trim();
  if (v === "") throw new Error("empty language");
  return v;
}

/**
 * Provided as the `AgentHandleKey` service by the agent module.
 *
 * With the places services (`LevelPlaces`) the levels are `place_settings` rows; without them,
 * runtime overrides persisted per profile under `channel_mode:<context>` / `activeness:<context>`
 * (when a `SettingsStore` is there) take precedence over `[modules.agent]` and the profile.
 */
export class AgentHandle {
  readonly #config: AgentConfig;
  readonly #persona: PersonaHandle;
  readonly #overrides: Overrides;
  readonly #voiceRooms: VoiceRooms;
  readonly #budget: BudgetBox;
  readonly #store: SettingsStore | null;
  readonly #clock: Clock;
  readonly #places: LevelPlaces | null;

  /** @internal Created by the agent module. */
  constructor(
    config: AgentConfig,
    persona: PersonaHandle,
    overrides: Overrides,
    voiceRooms: VoiceRooms,
    budget: BudgetBox,
    store: SettingsStore | null,
    clock: Clock = systemClock,
    places: LevelPlaces | null = null,
  ) {
    this.#config = config;
    this.#persona = persona;
    this.#overrides = overrides;
    this.#voiceRooms = voiceRooms;
    this.#budget = budget;
    this.#store = store;
    this.#clock = clock;
    this.#places = places;
  }

  /** Whether the levels are kept per place (`place_settings`). */
  get perPlace(): boolean {
    return this.#places !== null;
  }

  /**
   * `[modules.agent]` at `context`: a room's own values, its channel's, its Space's, then the
   * cluster's (docs/design/v5-places.md), for the fields marked `scope: "room"`. Without the places
   * services, or when the place cannot be read: the cluster's.
   */
  configAt(context: ContextKey): AgentConfig {
    const p = this.#places;
    if (p === null) return this.#config;
    try {
      return p.config.for(context);
    } catch (error) {
      log.debug({ err: errorMessage(error) }, "cannot read the config of a place");
      return this.#config;
    }
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

  /** Settings key of the old channel mode override for `context`. */
  static modeKey(context: ContextKey): string {
    return `${MODE_PREFIX}${contextKeyString(context)}`;
  }

  /** Settings key of the old activeness override for `context`. */
  static activenessKey(context: ContextKey): string {
    return `${ACTIVENESS_PREFIX}${contextKeyString(context)}`;
  }

  // ---- where a context is ------------------------------------------------------------------------

  /** The Space of `context` (identity's id); `null` for a DM or a server identity does not know. */
  spaceOf(context: ContextKey): string | null {
    const p = this.#places;
    if (p === null || context.scope === null) return null;
    try {
      return (
        p.places.at(context)?.space_id ??
        p.places.ofGuild(context.platform, context.scope)?.id ??
        null
      );
    } catch (error) {
      log.debug({ err: errorMessage(error) }, "cannot find a context's space");
      return null;
    }
  }

  /**
   * Whether `context` is in a new server: one she was not already in when servers were told apart
   * (not established, `SpaceRef.established`), or one she has no record of. The primary and every
   * other established server are not new. `false` without the places services, in a DM, and while
   * she knows no server at all.
   */
  inNewSpace(context: ContextKey): boolean {
    const p = this.#places;
    if (p === null || context.scope === null) return false;
    try {
      const space = p.places.ofGuild(context.platform, context.scope);
      if (space !== null) return !space.established;
      return p.places.spaces().length > 0;
    } catch (error) {
      log.debug({ err: errorMessage(error) }, "cannot tell whether a server is new");
      return false;
    }
  }

  /** The value set for `context` at its own layers (its room, its channel, its Space), or `null`. */
  #placeValue(context: ContextKey, key: LevelKey): string | null {
    const p = this.#places;
    if (p === null) return null;
    try {
      if (context.scope === null) return this.#row(context, key, "room");
      const value = valueAt(p.config.for(context), key);
      // The cluster's own value (the file, the panel's layer) is one of the fallbacks below.
      return value !== null && value !== valueAt(p.config.base(), key) ? value : null;
    } catch (error) {
      log.debug({ err: errorMessage(error) }, "cannot read a place level");
      return null;
    }
  }

  /** The row of `key` at exactly one layer of `context`: its room, its channel, or its Space. */
  #row(context: ContextKey, key: LevelKey, layer: LevelScope | "parent"): string | null {
    const p = this.#places;
    if (p === null) return null;
    try {
      let id: string | null;
      if (layer === "space") id = this.spaceOf(context);
      else {
        const at = p.places.at(context);
        id = layer === "room" ? (at?.room_id ?? null) : (at?.parent_room_id ?? null);
      }
      if (id === null) return null;
      const row = p.settings.get(layer === "space" ? "space" : "room", id, LEVELS_PLUGIN, key);
      if (row === null) return null;
      const parse =
        key === LEVEL_KEYS.language
          ? parseLanguage
          : key === LEVEL_KEYS.mode || key === LEVEL_KEYS.voiceMode
            ? parseChannelMode
            : parseActiveness;
      return tryParse(parse, row.value);
    } catch (error) {
      log.debug({ err: errorMessage(error) }, "cannot read a place level row");
      return null;
    }
  }

  // ---- the mode ----------------------------------------------------------------------------------

  /** Effective channel mode: the place's, then config, then profile. */
  channelMode(context: ContextKey): ChannelMode {
    return (
      this.#overrides.modes.get(contextKeyString(context)) ??
      (this.#placeValue(context, modeKey(context)) as ChannelMode | null) ??
      this.#fallbackMode(context)
    );
  }

  /** The mode set for this room itself (`null`: it takes its channel's or its Space's). */
  channelModeOverride(context: ContextKey): ChannelMode | null {
    const memory = this.#overrides.modes.get(contextKeyString(context));
    if (memory !== undefined || this.#places === null) return memory ?? null;
    return this.#row(context, modeKey(context), "room") as ChannelMode | null;
  }

  /** The mode set for the whole Space `context` is in (`null`: none). */
  spaceChannelMode(context: ContextKey): ChannelMode | null {
    return this.#row(context, modeKey(context), "space") as ChannelMode | null;
  }

  /**
   * Every room with a mode of its own, keyed by `contextKeyString` (text contexts for text rooms,
   * voice contexts for voice modes); in one Space when `space` (identity's id) is given.
   */
  channelModeOverrides(space?: string | null): [string, ChannelMode][] {
    const out = new Map<string, ChannelMode>();
    const p = this.#places;
    if (p !== null) {
      for (const row of p.settings.list({ plugin: LEVELS_PLUGIN, scope: "room" })) {
        if (row.key !== LEVEL_KEYS.mode && row.key !== LEVEL_KEYS.voiceMode) continue;
        const mode = tryParse(parseChannelMode, row.value);
        const context = mode === null ? null : this.#contextOfRoom(row.scope_id, row.key);
        if (mode === null || context === null) continue;
        if (space != null && this.spaceOf(context) !== space) continue;
        out.set(contextKeyString(context), mode);
      }
    }
    for (const [key, mode] of this.#overrides.modes) {
      const context = parseContextDisplay(key);
      if (space != null && (context === null || this.spaceOf(context) !== space)) continue;
      out.set(key, mode);
    }
    return [...out.entries()];
  }

  /** The context of a room row, as the levels are read for it. */
  #contextOfRoom(roomId: string, key: string): ContextKey | null {
    const p = this.#places;
    const room = p?.places.room(roomId) ?? null;
    if (p === null || room === null) return null;
    const voice = key === LEVEL_KEYS.voiceMode || key === LEVEL_KEYS.voiceActiveness;
    if (room.space_id === null) {
      return { platform: room.platform, scope: null, channel: room.external_id, kind: "dm" };
    }
    const space = p.places.space(room.space_id);
    if (space === null) return null;
    return {
      platform: room.platform,
      scope: space.external_id,
      channel: room.external_id,
      kind: voice ? "voice" : room.kind === "thread" ? "thread" : "channel",
    };
  }

  /** Mode from below this room (its channel, its Space, config and profile): what resetting it goes back to. */
  configuredChannelMode(context: ContextKey): ChannelMode {
    const key = modeKey(context);
    return (
      (this.#row(context, key, "parent") as ChannelMode | null) ??
      (this.#row(context, key, "space") as ChannelMode | null) ??
      this.#fallbackMode(context)
    );
  }

  /** Mode from config and profile only: what resetting the Space goes back to. */
  configuredSpaceMode(context: ContextKey): ChannelMode {
    return this.#fallbackMode(context);
  }

  #fallbackMode(context: ContextKey): ChannelMode {
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
    return modeFor(this.#config, context, profile, { newSpace: this.inNewSpace(context) });
  }

  /**
   * Sets (a mode) or clears (`null`) the mode of this room, or of its whole Space. It applies
   * immediately; a rejection means it could not be kept (`UnknownPlaceError`: it holds until a
   * restart).
   */
  async setChannelMode(
    context: ContextKey,
    mode: ChannelMode | null,
    options: SetLevelOptions = {},
  ): Promise<void> {
    await this.#write(context, modeKey(context), mode, options, this.#overrides.modes);
  }

  // ---- activeness --------------------------------------------------------------------------------

  /**
   * Effective activeness: her own temporary choice, then the place's, then config, then
   * `behavior.initiative`.
   */
  activeness(context: ContextKey): Activeness {
    return (
      this.temporaryActiveness(context)?.level ??
      this.#overrides.activeness.get(contextKeyString(context)) ??
      (this.#placeValue(context, activenessKey(context)) as Activeness | null) ??
      this.#fallbackActiveness(context)
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

  /** The activeness set for this room itself. */
  activenessOverride(context: ContextKey): Activeness | null {
    const memory = this.#overrides.activeness.get(contextKeyString(context));
    if (memory !== undefined || this.#places === null) return memory ?? null;
    return this.#row(context, activenessKey(context), "room") as Activeness | null;
  }

  /** The activeness set for the whole Space `context` is in. */
  spaceActiveness(context: ContextKey): Activeness | null {
    return this.#row(context, activenessKey(context), "space") as Activeness | null;
  }

  /** Activeness from below this room: what resetting it goes back to. */
  configuredActiveness(context: ContextKey): Activeness {
    const key = activenessKey(context);
    return (
      (this.#row(context, key, "parent") as Activeness | null) ??
      (this.#row(context, key, "space") as Activeness | null) ??
      this.#fallbackActiveness(context)
    );
  }

  /** Activeness from config and profile only: what resetting the Space goes back to. */
  configuredSpaceActiveness(context: ContextKey): Activeness {
    return this.#fallbackActiveness(context);
  }

  #fallbackActiveness(context: ContextKey): Activeness {
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
    return activenessFor(this.#config, context, profile, { newSpace: this.inNewSpace(context) });
  }

  /** Like `setChannelMode`, for activeness. */
  async setActiveness(
    context: ContextKey,
    level: Activeness | null,
    options: SetLevelOptions = {},
  ): Promise<void> {
    await this.#write(context, activenessKey(context), level, options, this.#overrides.activeness);
  }

  // ---- language ----------------------------------------------------------------------------------

  /** The language she talks in at `context`, when one is set there (or for the cluster). */
  language(context: ContextKey): string | null {
    return this.#placeValue(context, LEVEL_KEYS.language) ?? this.#config.language ?? null;
  }

  // ---- writing -----------------------------------------------------------------------------------

  async #write<T extends string>(
    context: ContextKey,
    key: LevelKey,
    value: T | null,
    options: SetLevelOptions,
    memory: Map<string, T>,
  ): Promise<void> {
    const text = contextKeyString(context);
    const scope = options.scope ?? "room";
    const p = this.#places;
    if (p === null) {
      if (scope === "space") throw new UnknownPlaceError("levels per server need the places");
      if (value === null) memory.delete(text);
      else memory.set(text, value);
      const legacy =
        key === LEVEL_KEYS.mode || key === LEVEL_KEYS.voiceMode
          ? AgentHandle.modeKey(context)
          : AgentHandle.activenessKey(context);
      await this.#persist(legacy, value);
      return;
    }
    let id: string | null;
    if (scope === "space") id = this.spaceOf(context);
    else {
      try {
        id = p.places.at(context)?.room_id ?? null;
      } catch {
        id = null;
      }
    }
    if (id === null) {
      if (scope === "space") throw new UnknownPlaceError("she does not know this server yet");
      // A room nobody has written in yet: it holds from memory until a restart.
      if (value === null) memory.delete(text);
      else memory.set(text, value);
      throw new UnknownPlaceError("she does not know this channel yet");
    }
    p.settings.set(scope, id, LEVELS_PLUGIN, key, value, options.by ?? LEVELS_PLUGIN);
    if (scope === "room") memory.delete(text);
  }

  #profile(): ProfileId {
    return this.#persona.read((p) => p.id);
  }

  async #persist(key: string, value: string | null): Promise<void> {
    if (this.#store === null) return;
    await this.#store.set(this.#profile(), key, value);
  }

  // ---- starting ----------------------------------------------------------------------------------

  /**
   * @internal Loads what the module starts with; returns how many levels were applied. With the
   * places services that is the move of the old keys (`migrateLegacy`: the ones still waiting for
   * their room are held in memory); without, the old keys themselves.
   */
  async load(): Promise<number> {
    if (this.#store === null) return 0;
    if (this.#places !== null) {
      const { moved, pending } = await this.migrateLegacy();
      return moved + pending.length;
    }
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

  /**
   * Moves the old `channel_mode:` / `activeness:` keys of this profile into `place_settings`
   * (`updated_by = "migration"`), once: the marker `agent:places_v1` says it ran and which keys
   * still wait for their room. A key whose room identity does not know is logged, held in memory
   * and tried again at the next start; a room that has a value already keeps it. The old keys stay
   * where they are and are not read again once moved.
   */
  async migrateLegacy(): Promise<{ moved: number; pending: string[] }> {
    const p = this.#places;
    const store = this.#store;
    if (p === null || store === null) return { moved: 0, pending: [] };
    const profile = this.#profile();
    const marker = await store.get(profile, PLACES_MIGRATION_KEY);
    let wanted: Set<string> | null = null;
    if (isJsonObject(marker)) {
      const pending = Array.isArray(marker.pending)
        ? marker.pending.filter((k): k is string => typeof k === "string")
        : [];
      if (pending.length === 0) return { moved: 0, pending: [] };
      wanted = new Set(pending);
    }
    const kinds: [string, (s: string) => string, Map<string, string>][] = [
      [MODE_PREFIX, parseChannelMode, this.#overrides.modes as Map<string, string>],
      [ACTIVENESS_PREFIX, parseActiveness, this.#overrides.activeness as Map<string, string>],
    ];
    let moved = 0;
    const pending: string[] = [];
    for (const [prefix, parse, memory] of kinds) {
      for (const [key, value] of await store.list(profile, prefix)) {
        if (wanted !== null && !wanted.has(key)) continue;
        const entry = parseEntry(key, prefix, value, parse);
        const context = entry === null ? null : parseContextDisplay(entry[0]);
        if (entry === null || context === null) {
          log.warn({ key }, "an old channel level is not readable; left as it is");
          continue;
        }
        const placeKey =
          prefix === MODE_PREFIX
            ? context.kind === "voice"
              ? LEVEL_KEYS.voiceMode
              : LEVEL_KEYS.mode
            : context.kind === "voice"
              ? LEVEL_KEYS.voiceActiveness
              : LEVEL_KEYS.activeness;
        let room: string | null = null;
        try {
          room = p.places.at(context)?.room_id ?? null;
        } catch {
          room = null;
        }
        if (room === null) {
          log.warn({ key }, "an old channel level's room is not known yet; kept for a later start");
          memory.set(entry[0], entry[1]);
          pending.push(key);
          continue;
        }
        try {
          // A runtime level won over the file before, so it wins over the file's imported copy
          // too; a level someone set since (the panel, a command) stays.
          const there = p.settings.get("room", room, LEVELS_PLUGIN, placeKey);
          if (there === null || IMPORTED.has(there.updated_by)) {
            p.settings.set("room", room, LEVELS_PLUGIN, placeKey, entry[1], "migration");
          }
          moved++;
        } catch (error) {
          log.warn({ key, err: errorMessage(error) }, "cannot move an old channel level");
          memory.set(entry[0], entry[1]);
          pending.push(key);
        }
      }
    }
    const done = {
      v: 1,
      at: toTimestamp(this.#clock.now()),
      moved,
      pending,
    };
    await store.set(profile, PLACES_MIGRATION_KEY, done);
    if (moved > 0 || pending.length > 0) {
      log.info({ moved, pending: pending.length }, "moved the old channel levels to the places");
    }
    return { moved, pending };
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
