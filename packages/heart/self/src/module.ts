import {
  defineManifest,
  errorMessage,
  interval,
  type Module,
  type ModuleContext,
  SerialQueue,
  withTimeout,
} from "@miyoria/runtime/kernel";
import { type SettingsStore, SettingsStoreKey, StoreKey } from "@miyoria/store";
import {
  AFFECT_EVENT_KINDS,
  type AffectEvent,
  AffectStateKey,
  type BusEvent,
  type Clock,
  circadianEnergy,
  DRIVE_NAMES,
  type Drives,
  Events,
  HandleDirectoryKey,
  HeartKey,
  is,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type Mood,
  MoodSignalsKey,
  type ProfileId,
  SelfStateKey,
  SocialSignalsKey,
  WorldStateKey,
} from "@miyoria/types";
import { type HeartSelfStore, heartTables } from "../../person/src/store.js";
import { AffectService } from "./affect.js";
import { type SelfConfig, SelfConfigSchema } from "./config.js";
import { type TemperamentInput, temperament } from "./emotions.js";
import { type Circumstances, IDLE, SelfEngine } from "./engine.js";
import { EmotionRules } from "./rules.js";
import { SelfService } from "./state.js";

/**
 * Settings key where her state was kept before `heart_self` (read once, when `heart_self` is still
 * empty; never written again).
 */
export const STATE_KEY = "self:state";

const STORE_TIMEOUT_MS = 5_000;
/** At most this many people she cares about are looked through for the one she misses most. */
const CARED_POOL = 10;

export interface SelfModuleOptions {
  /** Replaces the time source (default: the module context's clock). */
  clock?: Clock;
  /** The profile's `[temperament]` (display rules, how fast each emotion rises and fades). */
  temperament?: TemperamentInput;
  /** The profile's resting mood (`manifest.mood`): the mood is derived from it. */
  baseline?: Mood;
}

/** The resting mood when the profile gives none. */
const DEFAULT_BASELINE: Mood = { valence: 0, arousal: 0.5, energy: 0.7 };

/** The satisfaction an event causes (negative deltas), if any. */
export function eventDelta(
  event: BusEvent,
  config: SelfConfig,
  isSelf: (id: string) => boolean,
): { delta: Partial<Drives> & { boredom?: number }; reason: string } | null {
  const s = config.satisfy;
  if (is(Events.AgentTurnCompleted, event)) {
    if (event.data.text.trim() === "") return null;
    return {
      delta: {
        social: -s.turn_social,
        attention: -s.turn_attention,
        hunger: -s.turn_hunger,
        boredom: -s.turn_boredom,
      },
      reason: "turn",
    };
  }
  if (is(Events.PlatformMessageCreated, event)) {
    const m = event.data;
    if (m.author.is_bot || isSelf(m.author.account.id)) return null;
    const direct = m.mentions_self || m.reply_to_self || m.id.context.kind === "dm";
    return direct
      ? {
          delta: { attention: -s.addressed_attention, boredom: -2 * s.ambient_boredom },
          reason: "addressed",
        }
      : { delta: { boredom: -s.ambient_boredom }, reason: "ambient" };
  }
  if (is(Events.VoiceUtteranceEvent, event)) {
    if (event.data.speaker.is_bot || isSelf(event.data.speaker.account.id)) return null;
    return { delta: { boredom: -s.ambient_boredom }, reason: "voice" };
  }
  const payload = event.data as JsonValue;
  if (event.type === Events.WorldSalient.type) {
    return {
      delta: { boredom: -s.salient_boredom, curiosity: -s.salient_curiosity },
      reason: "salient",
    };
  }
  if (event.type === Events.SelfNudge.type && isJsonObject(payload)) {
    const delta: Partial<Drives> & { boredom?: number } = {};
    for (const key of [...DRIVE_NAMES, "boredom"] as const) {
      const v = payload[key];
      // One nudge moves a drive at most 0.5.
      if (typeof v === "number" && Number.isFinite(v)) {
        delta[key] = Math.min(Math.max(v, -0.5), 0.5);
      }
    }
    const reason = typeof payload.reason === "string" ? payload.reason : "nudge";
    return { delta, reason };
  }
  return null;
}

/** An `affect.event` payload that is a well-formed rule event, or `null`. */
export function parseAffectEvent(payload: JsonValue): AffectEvent | null {
  if (!isJsonObject(payload)) return null;
  const kind = payload.kind;
  if (typeof kind !== "string" || !(AFFECT_EVENT_KINDS as readonly string[]).includes(kind)) {
    return null;
  }
  const str = (v: JsonValue | undefined) => (typeof v === "string" && v !== "" ? v : null);
  return {
    kind: kind as AffectEvent["kind"],
    person: str(payload.person),
    handle: str(payload.handle),
    context: null,
    detail: typeof payload.detail === "string" ? payload.detail : "",
    key: typeof payload.key === "string" && payload.key !== "" ? payload.key : kind,
    at: typeof payload.at === "string" ? payload.at : new Date(0).toISOString(),
  };
}

interface Running {
  save: () => Promise<void>;
}

/**
 * Module `self`, her Affect module (docs/design/v3-architecture.md §12): her emotions, drives,
 * boredom, the mood derived from them, self-set policy and agenda. Provides `AffectStateKey`,
 * `SelfStateKey` and `MoodSignalsKey`. Persists to `heart_self` (the store's `heart` plugin) only
 * when something changed; reads `WorldStateKey` (playing / live / who is in her voice channel),
 * `SocialSignalsKey` (who an account is) and `HeartKey` (在意, the one she cares about most,
 * longing) when present.
 */
export class SelfModule implements Module {
  static readonly ID = "self";
  readonly manifest = defineManifest(SelfModule.ID, "Self", {
    icon: "smile",
    category: "her",
    description: "Her inner state: drives, boredom, her own policy, agenda and feelings",
    optional: ["world"],
    configSchema: SelfConfigSchema,
  });
  readonly #profile: ProfileId;
  readonly #options: SelfModuleOptions;
  #running: Running | null = null;

  constructor(profile: ProfileId, options: SelfModuleOptions = {}) {
    this.#profile = profile;
    this.#options = options;
  }

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(SelfConfigSchema);
    const clock = this.#options.clock ?? ctx.clock;
    const profile = this.#profile;
    const temper = temperament(this.#options.temperament);
    if (temper.unknown.length > 0) {
      ctx.log.warn({ names: temper.unknown }, "temperament names unknown emotions; ignored");
    }
    const engine = new SelfEngine(config, clock.now(), temper.temperament);
    const settings: SettingsStore | null = ctx.services.get(SettingsStoreKey) ?? null;
    let kept: HeartSelfStore | null = null;
    try {
      kept = config.persist ? (ctx.services.get(StoreKey)?.plugin(heartTables).self ?? null) : null;
    } catch (error) {
      ctx.log.warn({ err: errorMessage(error) }, "no heart_self: her inner state is not kept");
    }
    if (config.persist && (kept !== null || settings !== null)) {
      try {
        const loaded = await withTimeout(
          (async () => kept?.get() ?? (settings ? await settings.get(profile, STATE_KEY) : null))(),
          STORE_TIMEOUT_MS,
        );
        if (loaded === undefined) ctx.log.warn("loading her inner state timed out");
        else if (loaded !== null && !engine.restore(loaded, clock.now())) {
          ctx.log.warn("saved inner state is unreadable; starting fresh");
        }
      } catch (error) {
        ctx.log.warn({ err: errorMessage(error) }, "cannot load her inner state");
      }
    }
    const baseline = this.#options.baseline ?? DEFAULT_BASELINE;
    const directory = () => ctx.services.get(HandleDirectoryKey);

    const social = () => ctx.services.get(SocialSignalsKey);
    const circumstances = (): Circumstances => {
      const world = ctx.services.get(WorldStateKey)?.snapshot() ?? null;
      const her = world?.her ?? null;
      // Tiredness follows the hour (the mood is derived from the drives, not the other way).
      const energy = circadianEnergy(
        baseline.energy,
        clock.now(),
        config.utc_offset_minutes,
        config.mood.night_dip,
      );
      // The one she cares about most (H5) and the one she misses most, from the heart.
      const heart = ctx.services.get(HeartKey);
      const cared = heart?.mostCared() ?? null;
      let missed: { person: string; longing: number } | null = null;
      for (const c of heart?.caredAbout(CARED_POOL) ?? []) {
        const longing = heart?.view(c.person)?.longing ?? 0;
        if (longing > (missed?.longing ?? 0)) missed = { person: c.person, longing };
      }
      if (!her) return { ...IDLE, energy, cared, missed };
      const crush = cared?.person ?? null;
      const voice = her.voice ?? null;
      const members =
        voice === null
          ? []
          : (world?.voice_channels.find(
              (v) => v.channel === voice.channel && v.guild === voice.scope,
            )?.members ?? []);
      const signals = social();
      const crushTogether =
        crush !== null &&
        members.some((m) => !m.is_self && signals?.attitude(m.account)?.person === crush);
      return {
        energy,
        playing: her.game !== null && her.game !== undefined,
        streaming: her.streaming || her.golive === "live",
        crushTogether,
        cared,
        missed,
      };
    };
    /** Who she is with (for what she shows): the people in her voice channel. */
    const audience = () => {
      const world = ctx.services.get(WorldStateKey)?.snapshot() ?? null;
      const voice = world?.her.voice ?? null;
      if (!world || voice === null) return undefined;
      const members = (
        world.voice_channels.find((v) => v.channel === voice.channel && v.guild === voice.scope)
          ?.members ?? []
      ).filter((m) => !m.is_self);
      if (members.length === 0) return undefined;
      let care = 0;
      for (const m of members) {
        const person = social()?.attitude(m.account)?.person;
        if (person !== undefined) care = Math.max(care, service.care(person));
      }
      return { care, people: members.length };
    };
    const saves = new SerialQueue();
    let dirty = false;
    // Only what changed is written: something happened since the last save (drift alone is not a
    // change; it is worked out again from the saved time on restore), and `heart_self` itself
    // skips a state equal to the stored one.
    const save = async () => {
      if (kept === null || !dirty) return;
      dirty = false;
      try {
        const state = engine.toJson();
        if (isJsonObject(state)) kept.save(state as JsonObject, { now: clock.now() });
      } catch (error) {
        dirty = true;
        ctx.log.warn({ err: errorMessage(error) }, "cannot persist her inner state");
      }
    };
    const nameOf = (person: string) => social()?.attitudeOf?.(person)?.display_name ?? null;
    const service: SelfService = new SelfService({
      engine,
      clock,
      config,
      circumstances,
      mood: () => affect.mood(),
      audience,
      heart: () => ctx.services.get(HeartKey) ?? null,
      nameOf,
      changed: (reason) => {
        dirty = true;
        ctx.log.debug({ reason }, "inner state changed");
        // Policy and agenda changes are saved right away; drift waits for the tick.
        if (reason !== "event") void saves.run(save).catch(() => undefined);
      },
    });
    const affect: AffectService = new AffectService({
      self: service,
      baseline,
      handleOf: (person) => directory()?.ofPerson(person) ?? null,
      personOfHandle: (handle) => directory()?.resolve(handle)?.person ?? null,
      publish: ctx.publisher,
      heart: () => ctx.services.get(HeartKey) ?? null,
      nameOf,
    });
    ctx.provide(SelfStateKey, service);
    ctx.provide(AffectStateKey, affect);
    ctx.provide(MoodSignalsKey, affect);
    this.#running = { save: () => saves.run(save) };

    const selfIds = new Set<string>();
    const rules = new EmotionRules({
      self: service,
      affect,
      config,
      personOf: (account) => social()?.attitude(account)?.person ?? null,
      isSelf: (id) => selfIds.has(id),
      herVoice: () => ctx.services.get(WorldStateKey)?.snapshot().her.voice ?? null,
    });
    const sub = ctx.subscribe([
      Events.PlatformReady.type,
      Events.PlatformMessageCreated.type,
      Events.VoiceUtteranceEvent.type,
      Events.AgentTurnCompleted.type,
      Events.WorldSalient.type,
      Events.SelfNudge.type,
      Events.SelfFeel.type,
      Events.SocialEvent.type,
      Events.SingCue.type,
      Events.LlmBudget.type,
      "game.*",
      Events.VoicePlaybackEvent.type,
      Events.ActivityDone.type,
      Events.ActivityFailed.type,
      Events.AffectEvent.type,
    ]);
    ctx.spawn("events", async () => {
      for await (const env of sub) {
        if (is(Events.PlatformReady, env)) {
          selfIds.add(env.data.self_account.id);
          continue;
        }
        try {
          if (is(Events.AffectEvent, env)) {
            // Rule events other modules publish (the Arbiter's `topic_ignored` and the like).
            const ev = parseAffectEvent(env.data as JsonValue);
            if (ev) {
              affect.applyEvent(ev);
              dirty = true;
            }
          } else if (rules.handle(env, clock.now())) dirty = true;
          affect.publishIfChanged();
        } catch (error) {
          ctx.log.warn(
            { err: errorMessage(error), event: env.type },
            "her emotions could not take an event",
          );
        }
        const effect = eventDelta(env, config, (id) => selfIds.has(id));
        if (!effect) continue;
        service.now();
        engine.adjust(effect.delta);
        dirty = true;
      }
    });
    ctx.spawn("tick", async (signal) => {
      for await (const _ of interval(Math.max(config.tick_secs, 1) * 1000, signal)) {
        service.now();
        service.sample();
        await saves.run(save);
        affect.publishIfChanged();
      }
    });
  }

  async stop(): Promise<void> {
    const running = this.#running;
    this.#running = null;
    if (!running) return;
    await running.save();
  }
}
