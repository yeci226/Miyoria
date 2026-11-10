import {
  defineManifest,
  errorMessage,
  interval,
  type Module,
  type ModuleContext,
  presentKeys,
  SerialQueue,
  withTimeout,
} from "@miyoria/kernel";
import {
  PeopleStoreKey,
  RelationshipStoreKey,
  type SettingsStore,
  SettingsStoreKey,
} from "@miyoria/store";
import {
  AFFECT_EVENT_KINDS,
  AFFECT_EVENT_TOPIC,
  type AffectEvent,
  AffectStateKey,
  type Clock,
  circadianEnergy,
  customEvent,
  DRIVE_NAMES,
  type Drives,
  type Event,
  HandleDirectoryKey,
  isJsonObject,
  type JsonValue,
  type Mood,
  MoodSignalsKey,
  type ProfileId,
  SALIENT_TOPIC,
  SelfStateKey,
  SOCIAL_APPRAISAL_TOPIC,
  SOCIAL_EVENT_TOPIC,
  SONG_TOPIC,
  SocialSignalsKey,
  WorldStateKey,
} from "@miyoria/types";
import { AffectService } from "./affect.js";
import { DEPRECATED_SELF_KEYS, type SelfConfig, SelfConfigSchema } from "./config.js";
import { type TemperamentInput, temperament } from "./emotions.js";
import { type Circumstances, IDLE, SelfEngine } from "./engine.js";
import { FeelingsBook } from "./feelings.js";
import { migrateCards } from "./migrate.js";
import { EmotionRules, FEEL_TOPIC } from "./rules.js";
import { SelfService } from "./state.js";

/** Settings key of the persisted state (drives, boredom, policy, agenda). */
export const STATE_KEY = "self:state";
/** Bus topic of drive nudges from games and extensions (`{social?, ..., boredom?, reason}`). */
export const NUDGE_TOPIC = "self.nudge";

const STORE_TIMEOUT_MS = 5_000;

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
  event: Event,
  config: SelfConfig,
  isSelf: (id: string) => boolean,
): { delta: Partial<Drives> & { boredom?: number }; reason: string } | null {
  const s = config.satisfy;
  switch (event.type) {
    case "agent_turn_completed":
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
    case "platform_message_created": {
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
    case "voice_utterance":
      if (event.data.speaker.is_bot || isSelf(event.data.speaker.account.id)) return null;
      return { delta: { boredom: -s.ambient_boredom }, reason: "voice" };
    case "custom": {
      const { topic, payload } = event.data;
      if (topic === SALIENT_TOPIC) {
        return {
          delta: { boredom: -s.salient_boredom, curiosity: -s.salient_curiosity },
          reason: "salient",
        };
      }
      if (topic === NUDGE_TOPIC && isJsonObject(payload)) {
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
    default:
      return null;
  }
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
 * boredom, the mood derived from them, self-set policy, agenda and feelings about people. Provides
 * `AffectStateKey`, `SelfStateKey`, `MoodSignalsKey` and the `self` and `emotion` prompt sections.
 * Uses `SettingsStoreKey` to persist, `WorldStateKey` (playing / live / who is in her voice
 * channel) and `SocialSignalsKey` (who someone is, how much she likes them) when present. It
 * starts before the `mood` module, which then stays idle.
 */
export class SelfModule implements Module {
  static readonly ID = "self";
  readonly manifest = defineManifest(SelfModule.ID, "Self", {
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
    const gone = presentKeys(ctx.rawConfig, DEPRECATED_SELF_KEYS);
    if (gone.length > 0) {
      ctx.log.warn(
        { keys: gone },
        "[modules.self] keys are deprecated and ignored: the agent renders her state in its prompt itself",
      );
    }
    const clock = this.#options.clock ?? ctx.clock;
    const profile = this.#profile;
    const temper = temperament(this.#options.temperament);
    if (temper.unknown.length > 0) {
      ctx.log.warn({ names: temper.unknown }, "temperament names unknown emotions; ignored");
    }
    const engine = new SelfEngine(config, clock.now(), temper.temperament);
    const store: SettingsStore | null = ctx.services.get(SettingsStoreKey) ?? null;
    const persist = config.persist ? store : null;
    const feelings = new FeelingsBook(store, profile, config.max_feeling_chars);
    if (store) {
      try {
        const loaded = await withTimeout(
          (async () => {
            await feelings.load();
            return persist ? await persist.get(profile, STATE_KEY) : null;
          })(),
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

    // One person card per person: fill them in from the older places (once, idempotent).
    if (store) {
      try {
        const names = new Map<string, string>();
        const people = ctx.services.get(PeopleStoreKey);
        if (people) for (const p of await people.all()) names.set(p.id, p.display_name);
        const report = await withTimeout(
          migrateCards({
            store,
            profile,
            feelings,
            hearts: engine.hearts,
            relationships: ctx.services.get(RelationshipStoreKey) ?? null,
            handleOf: (person) => directory()?.ofPerson(person) ?? null,
            names,
            persist: async () => {
              if (persist) await persist.set(profile, STATE_KEY, engine.toJson());
            },
            now: clock.now(),
          }),
          STORE_TIMEOUT_MS,
        );
        if (report !== undefined && report.migrated > 0) {
          ctx.log.info(report, "person cards filled in from the older records");
        }
      } catch (error) {
        ctx.log.warn({ err: errorMessage(error) }, "cannot migrate person cards");
      }
    }

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
      if (!her) return { ...IDLE, energy };
      // Her crush is with her when they are in her voice channel (the engine's own crush:
      // asking the service would advance it again).
      const crush = engine.hearts.crush(clock.now())?.person ?? null;
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
    const save = async () => {
      if (!persist || !dirty) return;
      dirty = false;
      try {
        await persist.set(profile, STATE_KEY, engine.toJson());
      } catch (error) {
        dirty = true;
        ctx.log.warn({ err: errorMessage(error) }, "cannot persist her inner state");
      }
    };
    const service: SelfService = new SelfService({
      engine,
      feelings,
      clock,
      config,
      circumstances,
      mood: () => affect.mood(),
      audience,
      attitudeOf: (person) => social()?.attitudeOf?.(person) ?? null,
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
      publish: (topic, payload) => ctx.publish(customEvent(topic, payload)),
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
      "platform.ready",
      "platform.message.created",
      "voice.utterance",
      "agent.turn.completed",
      SALIENT_TOPIC,
      NUDGE_TOPIC,
      FEEL_TOPIC,
      SOCIAL_EVENT_TOPIC,
      SOCIAL_APPRAISAL_TOPIC,
      SONG_TOPIC,
      "llm.budget",
      "game.*",
      "voice.playback",
      "activity.done",
      "activity.failed",
      AFFECT_EVENT_TOPIC,
    ]);
    ctx.spawn("events", async () => {
      for await (const env of sub) {
        const event = env.event;
        if (event.type === "platform_ready") {
          selfIds.add(event.data.self_account.id);
          continue;
        }
        try {
          if (event.type === "custom" && event.data.topic === AFFECT_EVENT_TOPIC) {
            // Rule events other modules publish (the Arbiter's `topic_ignored` and the like).
            const ev = parseAffectEvent(event.data.payload);
            if (ev) {
              affect.applyEvent(ev);
              dirty = true;
            }
          } else if (rules.handle(event, clock.now())) dirty = true;
          affect.publishIfChanged();
        } catch (error) {
          ctx.log.warn(
            {
              err: errorMessage(error),
              event: event.type === "custom" ? event.data.topic : event.type,
            },
            "her emotions could not take an event",
          );
        }
        const effect = eventDelta(event, config, (id) => selfIds.has(id));
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
        dirty = true;
        await saves.run(save);
        affect.publishIfChanged();
        await affect.syncSnapshots().catch(() => 0);
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
