import {
  defineManifest,
  errorMessage,
  interval,
  type Module,
  type ModuleContext,
  type ServiceLookup,
  withTimeout,
} from "@miyoria/kernel";
import { SettingsStoreKey } from "@miyoria/store";
import {
  type AccountRef,
  ActivityManagerKey,
  type ActivitySnapshot,
  type Clock,
  customEvent,
  type Event,
  type JsonValue,
  MEMBER_TOPIC,
  type PersonId,
  type PersonPresence,
  PRESENCE_TOPIC,
  PresencePrivacyKey,
  type PromptContributors,
  PromptContributorsKey,
  SALIENT_TOPIC,
  SocialSignalsKey,
  VOICE_STATE_TOPIC,
  type WorldSnapshot,
  type WorldState,
  WorldStateKey,
  type WorldSummaryOptions,
} from "@miyoria/types";
import { WorldConfigSchema } from "./config.js";
import { NO_SIGNALS, type Signals, WorldEngine } from "./engine.js";
import {
  parseGolive,
  parseMember,
  parsePresence,
  parseStageStatus,
  parseVoiceState,
} from "./parse.js";
import { PrivacyBook } from "./privacy.js";
import { WorldPrompt } from "./prompt.js";
import { type Candidate, Salience } from "./salience.js";

/** Topic of Stage node status changes (`@miyoria/stage`). */
const STAGE_STATUS_TOPIC = "stage.status";
/** Topic of Go Live state changes (`@miyoria/voice`). */
const GOLIVE_TOPIC = "voice.golive";

const STORE_TIMEOUT_MS = 5_000;

export interface WorldModuleOptions {
  /** The profile's `interests` (games she likes to hear about). */
  interests?: readonly string[];
  /** Name of the game she is playing; the core wires it to the game module. */
  game?: (services: ServiceLookup) => string | null;
  /** Replaces the time source (default: the module context's clock). */
  clock?: Clock;
}

/** The `WorldStateKey` service: the engine read at the moment of the call. */
export class WorldView implements WorldState {
  constructor(
    private readonly engine: WorldEngine,
    private readonly signals: () => Signals,
    private readonly clock: Clock,
    private readonly game: () => string | null,
    /** The ActivityManager's snapshot, when it runs (her own situation comes from it). */
    private readonly activity: () => ActivitySnapshot | null = () => null,
  ) {}

  snapshot(): WorldSnapshot {
    return this.engine.snapshot(this.clock.now(), this.signals(), this.game(), this.activity());
  }

  person(account: AccountRef): PersonPresence | null {
    return this.engine.person(account, this.signals());
  }

  personById(person: PersonId): PersonPresence | null {
    const sig = this.signals();
    let found: PersonPresence | null = null;
    for (const account of this.engine.accounts()) {
      if (sig.attitude(account)?.person !== person) continue;
      const p = this.engine.person(account, sig);
      if (!p) continue;
      // Prefer the account with something to say (online or in voice).
      if (!found || (found.status === null && found.voice === null)) found = p;
    }
    return found;
  }

  summary(options: WorldSummaryOptions = {}): string {
    return this.engine.summary(this.snapshot(), options);
  }
}

interface Running {
  contributors: PromptContributors | undefined;
}

/**
 * Module `world`: what she perceives. Consumes platform presence / voice state / member events,
 * messages, voice utterances (voice conversation counts as activity), her turns, voice, Stage
 * and Go Live state; provides `WorldStateKey` and
 * `PresencePrivacyKey` (which `/me privacy presence` writes), the `world` prompt section; publishes
 * `world.salient`.
 */
export class WorldModule implements Module {
  static readonly ID = "world";
  readonly manifest = defineManifest(WorldModule.ID, "World", {
    description: "What she perceives: who is online, in voice and doing what; salient changes",
    optional: ["social"],
    configSchema: WorldConfigSchema,
  });
  readonly #options: WorldModuleOptions;
  #running: Running | null = null;

  constructor(options: WorldModuleOptions = {}) {
    this.#options = options;
  }

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(WorldConfigSchema);
    const clock = this.#options.clock ?? ctx.clock;
    const store = ctx.services.get(SettingsStoreKey) ?? null;
    const book = new PrivacyBook(store);
    if ((await withTimeout(book.load(), STORE_TIMEOUT_MS)) === undefined) {
      ctx.log.warn("loading privacy settings timed out; ignoring presence until it works");
    }
    const engine = new WorldEngine(config, this.#options.interests ?? [], (a) =>
      book.presenceAllowed(a),
    );
    const salience = new Salience(config);
    const signals = (): Signals => ctx.services.get(SocialSignalsKey) ?? NO_SIGNALS;
    const gameOf = this.#options.game;
    const game = () => {
      try {
        return gameOf ? gameOf(ctx.services) : null;
      } catch {
        return null;
      }
    };
    const view = new WorldView(
      engine,
      signals,
      clock,
      game,
      () => ctx.services.get(ActivityManagerKey)?.snapshot() ?? null,
    );
    ctx.provide(WorldStateKey, view);
    ctx.provide(PresencePrivacyKey, {
      get loaded() {
        return book.loaded;
      },
      presenceAllowed: (account) => book.presenceAllowed(account),
      async setPresence(account, allowed) {
        await book.setPresence(account, allowed);
        if (!allowed) engine.forgetPresence(account);
      },
    });

    const contributors = ctx.services.get(PromptContributorsKey);
    if (config.prompt) contributors?.register(new WorldPrompt(view));
    this.#running = { contributors };

    const offer = (candidates: Candidate[]) => {
      const now = clock.now();
      for (const c of candidates) salience.offer(c, now);
    };
    const flush = () => {
      for (const e of salience.due(clock.now())) {
        ctx.log.debug({ kind: e.kind, key: e.key, count: e.count }, "salient change");
        ctx.publish(customEvent(SALIENT_TOPIC, e as unknown as JsonValue));
      }
    };

    const sub = ctx.subscribe([
      "platform.ready",
      "platform.message.created",
      PRESENCE_TOPIC,
      VOICE_STATE_TOPIC,
      MEMBER_TOPIC,
      "agent.turn.completed",
      "voice.joined",
      "voice.left",
      "voice.utterance",
      "voice.playback",
      STAGE_STATUS_TOPIC,
      GOLIVE_TOPIC,
    ]);
    ctx.spawn("events", async () => {
      for await (const env of sub) {
        try {
          offer(handle(engine, env.event, clock.now(), signals()));
        } catch (error) {
          ctx.log.warn({ err: errorMessage(error) }, "cannot apply a world event");
        }
        // Without a coalescing delay there is nothing to wait for.
        if (config.coalesce_ms === 0) flush();
      }
    });
    ctx.spawn("tick", async (signal) => {
      for await (const _ of interval(Math.max(config.tick_secs, 1) * 1000, signal)) {
        if (!book.loaded) await withTimeout(book.load(), STORE_TIMEOUT_MS);
        offer(engine.tick(clock.now()));
        flush();
      }
    });
    ctx.log.info("world module running");
  }

  async stop(): Promise<void> {
    const running = this.#running;
    this.#running = null;
    if (!running) return;
    running.contributors?.unregister(WorldPrompt.KEY);
  }
}

/** Applies one bus event to the engine; returns the salient candidates it caused. */
export function handle(engine: WorldEngine, event: Event, now: number, sig: Signals): Candidate[] {
  switch (event.type) {
    case "platform_ready":
      engine.addSelf(event.data.self_account);
      return [];
    case "platform_message_created":
      return engine.message(event.data, now, sig);
    case "agent_turn_completed":
      engine.herSpoke(event.data.context, now);
      return [];
    case "voice_joined":
      engine.voiceJoined(event.data.context);
      return [];
    case "voice_left":
      engine.voiceLeft(event.data.context);
      return [];
    case "voice_utterance":
      if (event.data.text.trim() !== "") {
        engine.utterance(event.data.context, event.data.speaker, now);
      }
      return [];
    case "voice_playback":
      // Her own speech: when she last spoke there, not conversation.
      if (event.data.state === "started") engine.herSpoke(event.data.context, now);
      return [];
    case "custom":
      break;
    default:
      return [];
  }
  const { topic, payload } = event.data;
  switch (topic) {
    case PRESENCE_TOPIC: {
      const u = parsePresence(payload);
      return u ? engine.presence(u, now, sig) : [];
    }
    case VOICE_STATE_TOPIC: {
      const u = parseVoiceState(payload);
      return u ? engine.voiceState(u, now, sig) : [];
    }
    case MEMBER_TOPIC: {
      const u = parseMember(payload);
      if (u) engine.member(u);
      return [];
    }
    case STAGE_STATUS_TOPIC: {
      const s = parseStageStatus(payload);
      if (s) engine.stageStatus(s);
      return [];
    }
    case GOLIVE_TOPIC: {
      const g = parseGolive(payload);
      if (g) engine.golive(g.guild, g.state);
      return [];
    }
    default:
      return [];
  }
}
